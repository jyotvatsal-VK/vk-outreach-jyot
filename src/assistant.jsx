/* ══════════════════════════════════════════════════════════════════
   GUEST INFO & ASK AI
   1. Guest profile — everything the app holds about one guest, gathered from every module.
      No AI, nothing leaves the app.
   2. Ask AI (permission ai.ask) — questions over the event's data. Before anything is sent,
      guests become G1, G2…, volunteers V1…, hotels H1…, and names, phones, emails, PNRs and
      flight numbers are left out. The answer comes back in codes and the real names are put back here.
   3. Look up online (permission ai.lookup) — sends ONLY name, organisation and designation to
      Google Search (via Gemini). The "same person?" check is done here, against our own data.
══════════════════════════════════════════════════════════════════ */
import React, { useState, useMemo } from 'react';
import { useAuth } from './auth';
import { hasPermission } from './permissions';
import { saveItem } from './data';
import { displayName, shortDate, fmtDate, todayISO } from './schedule';
import { Empty, useToast } from './ui';
import { auth } from './firebase';
import { getTravelCfg, travelPlan, travelWarnings, sourceLabel, samePlace } from './travel';

/* ── shared helpers ── */
const tMin = t => { if (!t) return 0; const [h, m] = String(t).split(':'); return (parseInt(h, 10) || 0) * 60 + (parseInt(m, 10) || 0); };
const hhmm = m => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function pickLogistics(logi, cid) {
  const m = logi.filter(x => x.contactId === cid);
  if (!m.length) return { contactId: cid };
  if (m.length === 1) return m[0];
  const score = r => Object.values(r).filter(Boolean).length;
  return m.reduce((a, b) => (score(b) > score(a) ? b : a));
}

/* POC needs per day, from Personalised Schedule rows ticked "POC Required" (same rule as POC Allocation) */
function pocNeeds(rows, cid) {
  const mine = rows.filter(r => r.contactId === cid && !r.deleted && r.date && r.time);
  const out = {};
  [...new Set(mine.filter(r => r.pocRequired).map(r => r.date))].forEach(d => {
    const day = mine.filter(r => r.date === d).sort((a, b) => tMin(a.time) - tMin(b.time));
    const ticked = day.filter(r => r.pocRequired);
    const last = ticked[ticked.length - 1];
    const next = day.find(r => tMin(r.time) > tMin(last.time));
    out[d] = { from: ticked[0].time, to: next ? next.time : hhmm(tMin(last.time) + 60) };
  });
  return out;
}

function pendingFor(L) {
  const p = [];
  if (L.flightReq !== 'not_required' && !L.arrivalFlightNo && !L.departureFlightNo) p.push('flight details');
  if (L.carReq !== 'not_required' && !L.carVendorId) p.push('car');
  if (L.accomReq !== 'not_required' && !L.hotelName) p.push('hotel');
  if (!L.arrivalDate) p.push('arrival date');
  return p;
}

/* ══ Coding: names → codes before anything goes to the AI, and back after ══ */
function buildCoder(store) {
  const contacts = [...(store.contacts || [])].sort((a, b) => displayName(a).localeCompare(displayName(b)));
  const vols = [...(store.volunteers || [])].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  const logi = store.logistics || [];
  const gCode = new Map(), vCode = new Map(), hCode = new Map();
  const label = {};                       // code → real name (for showing answers)
  contacts.forEach((c, i) => { gCode.set(c.id, `G${i + 1}`); label[`G${i + 1}`] = displayName(c); });
  vols.forEach((v, i) => { vCode.set(v.id, `V${i + 1}`); label[`V${i + 1}`] = v.name || `Volunteer ${i + 1}`; });
  const hotels = [...new Set(logi.map(L => (L.hotelName || '').trim()).filter(Boolean))].sort();
  hotels.forEach((h, i) => { hCode.set(h.toLowerCase(), `H${i + 1}`); label[`H${i + 1}`] = h; });

  // Every name we know, longest first, each with its code. First names only when unique.
  const pairs = [];
  contacts.forEach(c => {
    const code = gCode.get(c.id);
    [displayName(c), c.name, [c.honor, c.name].filter(Boolean).join(' ')].filter(Boolean).forEach(n => pairs.push([n, code]));
  });
  vols.forEach(v => { if (v.name) pairs.push([v.name, vCode.get(v.id)]); });
  hotels.forEach(h => pairs.push([h, hCode.get(h.toLowerCase())]));
  // (Full names only. A lone first name is never swapped: "Dr Arun Kumar Singh" must not become volunteer "Arun Bansal".)
  pairs.sort((a, b) => b[0].length - a[0].length);
  const res = pairs.filter(([n]) => n && n.trim().length >= 3).map(([n, code]) => [new RegExp(`(^|[^A-Za-z0-9])${escRe(n.trim())}(?=$|[^A-Za-z0-9])`, 'gi'), code]);
  const scrub = str => {
    let s = String(str ?? '');
    res.forEach(([re, code]) => { s = s.replace(re, (m0, pre) => pre + code); });
    // anything that still looks like a phone number or email never goes out
    return s.replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[email]').replace(/(?<!\d)(?:\+?\d[\s-]?){9,13}\d(?!\d)/g, '[number]');   // 10+ digits; dates have only 8
  };
  const people = [
    ...contacts.map(c => ({ kind: 'guest', id: c.id, code: gCode.get(c.id), name: displayName(c), sub: [c.desig, c.org].filter(Boolean).join(' · '), words: nameWords(c.name) })),
    ...vols.map(v => ({ kind: 'volunteer', id: v.id, code: vCode.get(v.id), name: v.name || '', sub: 'Volunteer', words: nameWords(v.name) })),
  ].filter(p => p.words.length);
  return { gCode, vCode, hCode, label, scrub, contacts, vols, people };
}

/* ══ Finding people in a question — done here, before anything is sent ══
   A person matches when at least two of their name words appear close together in the question
   ("arun singh" finds "Dr. Arun Kumar Singh"; titles and initials are ignored).
   A single word matches only if it is someone's full name (one-word names). */
const TITLES = new Set(['dr', 'prof', 'professor', 'mr', 'mrs', 'ms', 'miss', 'shri', 'smt', 'sri', 'ji', 'sir', 'madam', 'adv', 'hon', 'justice', 'col', 'capt', 'gen', 'maj', 'pujya', 'sant']);
function nameWords(n) { return String(n || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 1 && !TITLES.has(w)); }
function lev(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length; if (!m || !n) return m || n;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}
const wordSim = (a, b) => 1 - lev(a, b) / Math.max(a.length, b.length);
// Words that are never part of a name — used to spot a name we could NOT match
const COMMON = new Set(('a an the of for to in on at by and or is are was were be been am do does did has have had will would can could should shall may ' +
  'what when where who whom whose which why how all any each every some many much more most no not only also just than then there their them they ' +
  'this that these those it its his her him he she we you your our me my i details detail info information everything profile about tell show give list ' +
  'arrive arrives arriving arrival reach reaches reaching depart departs leaving leave leaves departure flight flights hotel car pickup drop poc ' +
  'session sessions meeting sahebji schedule today tomorrow yesterday day days date time morning evening afternoon night before after between ' +
  'guest guests volunteer volunteers panelist panelists vip delegate speaker speakers event venue airport please need want know find get ' +
  'confirmed pending declined status assigned assign free busy available availability with without from into out up down please kindly').split(' '));
const TRIGGER = new Set(['of', 'about', 'for', 'is', 'does', 'did', 'will', 'dr', 'prof', 'mr', 'mrs', 'ms', 'shri', 'smt', 'sri']);

function findPeople(question, people) {
  const toks = [...String(question).matchAll(/[A-Za-z0-9]+/g)].map(m => ({ w: m[0].toLowerCase(), start: m.index, end: m.index + m[0].length }));
  const hits = [];
  people.forEach(p => {
    const idx = toks.map((t, i) => (p.words.includes(t.w) ? i : -1)).filter(i => i >= 0);
    const distinct = new Set(idx.map(i => toks[i].w));
    const need = p.words.length === 1 ? 1 : 2;
    if (distinct.size < need) return;
    // the matched words must sit together (at most one other word between them)
    for (let a = 0; a < idx.length; a++) {
      let b = a;
      while (b + 1 < idx.length && idx[b + 1] - idx[b] <= 2) b++;
      const grp = idx.slice(a, b + 1);
      const words = new Set(grp.map(i => toks[i].w));
      if (words.size >= need) hits.push({ p, from: grp[0], to: grp[grp.length - 1], score: words.size + words.size / p.words.length });
      a = b;
    }
  });
  // Best match per stretch of the question; ties on the same stretch = ambiguous
  hits.sort((x, y) => y.score - x.score);
  const taken = [], matched = [], ambiguous = [];
  hits.forEach(h => {
    if (taken.some(t => !(h.to < t.from || h.from > t.to))) return;
    const same = hits.filter(o => o !== h && o.score === h.score && !(o.to < h.from || o.from > h.to));
    taken.push(h);
    if (same.length) ambiguous.push({ text: question.slice(toks[h.from].start, toks[h.to].end), options: [h.p, ...same.map(o => o.p)] });
    else matched.push(h);
  });
  // A single name word on its own ("details of raj"): one person → them; several → ask which.
  // Skipped when it sits next to other unknown name words ("arun kumar singh" is someone else, not volunteer Arun).
  const used = new Set(); taken.forEach(t => { for (let i = t.from; i <= t.to; i++) used.add(i); });
  const nameish = i => i >= 0 && i < toks.length && !used.has(i) && !COMMON.has(toks[i].w) && !TITLES.has(toks[i].w) && !/\d/.test(toks[i].w);
  toks.forEach((t, i) => {
    if (!nameish(i) || nameish(i - 1) || nameish(i + 1) || t.w.length < 3) return;
    const who = people.filter(p => p.words.includes(t.w));
    if (!who.length) return;
    const h = { p: who[0], from: i, to: i, score: 1 };
    if (who.length === 1) matched.push(h);
    else ambiguous.push({ text: question.slice(t.start, t.end), options: who.slice(0, 8) });
    used.add(i);
  });
  // Name-like words we could not match (after "of", "about", "Dr"…, or the whole question)
  const unknown = [];
  for (let i = 0; i < toks.length; i++) {
    if (used.has(i) || COMMON.has(toks[i].w) || TITLES.has(toks[i].w) || /\d/.test(toks[i].w)) continue;
    let j = i; while (j + 1 < toks.length && !used.has(j + 1) && !COMMON.has(toks[j + 1].w) && !TITLES.has(toks[j + 1].w) && !/\d/.test(toks[j + 1].w)) j++;
    const prev = toks[i - 1]?.w;
    const isName = j > i && (i === 0 || TRIGGER.has(prev) || (i > 0 && TITLES.has(prev)));
    if (isName) {
      const text = question.slice(toks[i].start, toks[j].end);
      const qw = toks.slice(i, j + 1).map(t => t.w);
      const sim = p => qw.reduce((sum, w) => sum + Math.max(0, ...p.words.map(pw => wordSim(w, pw))), 0) / qw.length;
      const suggestions = people.map(p => ({ p, s: sim(p) })).filter(x => x.s >= 0.6).sort((a, b) => b.s - a.s).slice(0, 4).map(x => x.p);
      unknown.push({ text, suggestions });
    }
    i = j;
  }
  // Question with matched people swapped for their codes (titles just before a name go too)
  let coded = '', pos = 0;
  [...matched].sort((a, b) => a.from - b.from).forEach(h => {
    let f = h.from; while (f > 0 && TITLES.has(toks[f - 1].w)) f--;
    coded += question.slice(pos, toks[f].start) + h.p.code; pos = toks[h.to].end;
  });
  coded += question.slice(pos);
  return { matched: matched.map(h => h.p), ambiguous, unknown, coded };
}
const DETAILS_RE = /^\s*(all\s+)?(details?|info|information|everything|profile|who\s+is)\b|\b(details?|everything|all\s+info|information|profile)\s+(of|about|on|for)\b/i;

function buildContext(store, activeEventId, coder) {
  const cfg = getTravelCfg(store, activeEventId);
  const logi = store.logistics || [];
  const sessions = [...(store.sessions || [])].sort((a, b) => `${a.date}${a.start}` > `${b.date}${b.start}` ? 1 : -1);
  const sCode = new Map(sessions.map((s, i) => [s.id, `S${i + 1}`]));
  const assigns = store.assignments || [];
  const founder = store.founder || [];
  const poc = (store.poc || []).filter(p => p.eventId === activeEventId);
  const rows = store.personalisedSchedule || [];
  const avail = store.availability || [];
  const depts = store.departments || [];
  const hotel = name => coder.hCode.get(String(name || '').trim().toLowerCase()) || (name ? 'a hotel' : '');
  const place = (txt, L) => {
    if (!txt) return '';
    if (L.hotelName && samePlace(txt, L.hotelName)) return hotel(L.hotelName);
    return coder.scrub(txt);
  };
  const by = (L, k) => L[`${k}Override`] ? 'typed by hand' : ({ flight: 'flight', car: 'car' })[L[`${k}Source`]] || 'planned';
  const ev = (store.events || []).find(e => e.id === activeEventId) || {};

  const guests = coder.contacts.map(c => {
    const L = pickLogistics(logi, c.id);
    const plan = travelPlan(L, cfg);
    const m = founder.find(f => f.contactId === c.id);
    const pocDays = {};
    poc.filter(p => p.contactId === c.id).forEach(p => { pocDays[p.day] = { vol: coder.vCode.get(p.volunteerId) || 'unknown', from: p.fromTime || '', to: p.toTime || '', ...(p.frozen ? { frozen: true } : {}) }; });
    const g = {
      code: coder.gCode.get(c.id), type: c.type || '', status: c.status || '', field: coder.scrub(c.field || ''),
      arrival: L.arrivalDate ? { date: L.arrivalDate, time: L.arrivalTime || '', at: place(L.arrivalLocation, L), by: by(L, 'arrival') } : null,
      departure: L.departureDate ? { date: L.departureDate, time: L.departureTime || '', at: place(L.departureLocation, L), by: by(L, 'departure') } : null,
      flight: L.flightReq === 'not_required' ? 'not needed' : (L.arrivalFlightDate || L.departureFlightDate ? 'booked' : 'not booked yet'),
      stay: L.accomReq === 'not_required' ? 'not needed' : (L.hotelName ? { hotel: hotel(L.hotelName), checkIn: L.checkinDate || '', checkOut: L.checkoutDate || '' } : 'hotel not set'),
      car: L.carReq === 'not_required' ? 'not needed' : { booked: !!L.carVendorId, pickup: [L.carPickupDate, L.carPickupTime].filter(Boolean).join(' '), drop: [L.carDepartureDate, L.carDepartureTime].filter(Boolean).join(' ') },
      plan: plan.steps.map(s => ({ step: s.key, date: s.date, time: s.time })),
      sessions: assigns.filter(a => a.contactId === c.id).map(a => sCode.get(a.sessionId)).filter(Boolean),
      sahebji: m && (m.date || m.durationReq === 'not_required') ? (m.durationReq === 'not_required' ? 'not required' : { date: m.date || '', time: m.time || '', minutes: parseInt(m.duration, 10) || 30, ...(m.frozen ? { frozen: true } : {}) }) : null,
      poc: pocDays,
      pocNeeded: pocNeeds(rows, c.id),
      pending: pendingFor(L),
      warnings: travelWarnings(L, cfg).map(w => coder.scrub(w.text)),
    };
    Object.keys(g).forEach(k => { const v = g[k]; if (v === null || v === '' || (Array.isArray(v) && !v.length) || (v && typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length)) delete g[k]; });
    return g;
  });

  const deptName = id => depts.find(d => d.id === id)?.name;
  const volunteers = coder.vols.map(v => {
    const a = {};
    avail.filter(x => x.volId === v.id && x.eventId === activeEventId && x.checked && /^\d{4}-/.test(x.day || '')).forEach(x => {
      a[x.day] = x.fullDay ? 'full' : (Array.isArray(x.slots) && x.slots.length ? x.slots.filter(sl => sl.start && sl.end).map(sl => `${sl.start}-${sl.end}`) : (x.start && x.end ? [`${x.start}-${x.end}`] : 'available'));
    });
    const dRec = avail.find(x => x.volId === v.id && x.day === 'depts' && x.eventId === activeEventId);
    const out = { code: coder.vCode.get(v.id), departments: (dRec?.deptIds || []).map(deptName).filter(Boolean), availability: a };
    if (!Object.keys(a).length) delete out.availability;
    if (!out.departments.length) delete out.departments;
    return out;
  });

  return {
    event: { name: coder.scrub(ev.name || ''), start: ev.startDate || '', end: ev.endDate || '' },
    guests,
    sessions: sessions.map(s => ({ id: sCode.get(s.id), title: coder.scrub(s.title || ''), type: s.type || '', date: s.date || '', start: s.start || '', end: s.end || '', venue: coder.scrub(s.venue || '') })),
    volunteers,
  };
}

async function postJson(url, body) {
  const token = await auth?.currentUser?.getIdToken?.();
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 65_000);
  try {
    const r = await fetch(url, { method: 'POST', signal: ctl.signal, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    const out = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(out.error || (r.status === 404 ? 'This feature isn’t on the server yet — deploy the latest version.' : r.status === 504 ? 'The server timed out. Try again.' : `Server error (${r.status})`));
    return out;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('It took too long. Try again, or ask a narrower question.');
    throw e;
  } finally { clearTimeout(t); }
}

/* ── words overlap for the "same person?" check ── */
const STOP = new Set(['the', 'of', 'and', 'for', 'in', 'at', 'ltd', 'limited', 'pvt', 'private', 'inc', 'india', 'university', 'institute', 'dr', 'prof', 'mr', 'mrs', 'ms']);
function overlap(a, b) {
  const x = norm(a).split(' ').filter(t => t.length > 2 && !STOP.has(t));
  const y = norm(b).split(' ').filter(t => t.length > 2 && !STOP.has(t));
  if (!x.length || !y.length) return null;            // nothing to compare
  const hit = x.filter(t => y.includes(t)).length;
  return hit / Math.min(x.length, y.length) >= 0.5;
}

/* ══ Screen ══ */
export function Assistant({ store, activeEventId }) {
  const { profile } = useAuth();
  const toast = useToast();
  const can = k => hasPermission(profile, k);
  const contacts = store.contacts || [];
  const [q, setQ] = useState('');
  const [selId, setSelId] = useState(null);
  const sel = contacts.find(c => c.id === selId) || null;

  const matches = useMemo(() => {
    const t = norm(q);
    if (!t) return [];
    return contacts.filter(c => norm([displayName(c), c.org, c.desig, c.phone, c.field].join(' ')).includes(t)).slice(0, 30);
  }, [q, contacts]);

  return (
    <>
      <div className="page-head"><div className="ph-txt"><h1>Guest info & Ask AI</h1>
        <p>Find everything about a guest in one place{can('ai.ask') ? ', or ask a question about the event' : ''}.</p></div></div>

      {can('ai.ask') && <AskAI store={store} activeEventId={activeEventId} canOpen={can('assistant.view')}
        onOpenGuest={id => { setSelId(id); setQ(''); setTimeout(() => document.getElementById('guest-profile')?.scrollIntoView({ behavior: 'smooth' }), 50); }} />}

      {!can('assistant.view') && !can('ai.ask') && (
        <div className="panel" style={{ padding: 16 }}><Empty title="No access" sub="Ask the Master admin for 'View guest profiles' or 'Ask AI questions'." /></div>
      )}
      {can('assistant.view') && <div className="panel" id="guest-profile">
        <div className="panel-head"><h2>Guest profile</h2><div className="desc">Everything the app holds about one guest</div></div>
        <div className="gp-search">
          <input className="input" value={q} onChange={e => { setQ(e.target.value); setSelId(null); }} placeholder="Search by name, organisation, phone…" />
          {sel && <button className="btn ghost sm" onClick={() => setSelId(null)}>Clear</button>}
        </div>
        {!sel && q && (
          <div className="gp-matches">
            {matches.map(c => (
              <button key={c.id} className="gp-match" onClick={() => setSelId(c.id)}>
                <b>{displayName(c)}</b>
                <span className="muted-sm">{[c.desig, c.org].filter(Boolean).join(' · ') || '—'}</span>
                <span className={'badge b-' + (c.status || '').toLowerCase()}>{c.status}</span>
              </button>
            ))}
            {!matches.length && <div className="muted-sm" style={{ padding: 12 }}>No guest matches “{q}”.</div>}
            {matches.length > 1 && <div className="muted-sm" style={{ padding: '6px 12px' }}>{matches.length} matches — pick the right person by organisation.</div>}
          </div>
        )}
        {!sel && !q && <div style={{ padding: 16 }}><Empty title="Search for a guest" sub="Type part of a name, organisation or phone number." /></div>}
        {sel && <GuestProfile c={sel} store={store} activeEventId={activeEventId} canLookup={can('ai.lookup')} toast={toast} />}
      </div>}
    </>
  );
}

/* ══ Ask AI ══ */
function AskAI({ store, activeEventId, onOpenGuest, canOpen }) {
  const [question, setQuestion] = useState('');
  const [turns, setTurns] = useState([]);     // { q, a, qCoded, aCoded, error, busy, guests }
  const busy = turns.some(t => t.busy);
  const coderRef = React.useRef(null);

  async function ask(e) {
    e?.preventDefault?.();
    const text = question.trim();
    if (!text || busy) return;
    const coder = buildCoder(store);
    coderRef.current = coder;
    const found = findPeople(text, coder.people);
    setQuestion('');
    // Answered here, nothing sent: a name we can't place, or a name that fits several people
    if (found.ambiguous.length || (found.unknown.length && !found.matched.length)) {
      setTurns(t => [...t, { q: text, local: { ambiguous: found.ambiguous, unknown: found.ambiguous.length ? [] : found.unknown } }]);
      return;
    }
    const guests = [...new Set(found.matched.filter(p => p.kind === 'guest').map(p => p.code))];
    // "details of X" → the guest's profile is the exact answer, no AI needed
    if (canOpen && DETAILS_RE.test(text) && guests.length === 1 && found.matched.length === 1) {
      const gid = found.matched[0].id;
      setTurns(t => [...t, { q: text, local: { opened: found.matched[0].name } }]);
      onOpenGuest(gid);
      return;
    }
    const qCoded = coder.scrub(found.coded);
    const idx = turns.length;
    setTurns(t => [...t, { q: text, qCoded, busy: true, guests }]);
    try {
      const context = buildContext(store, activeEventId, coder);
      const history = turns.filter(t => t.aCoded).slice(-4).map(t => ({ q: t.qCoded, a: t.aCoded }));
      const out = await postJson('/api/ask', { question: qCoded, context, history, today: todayISO() });
      setTurns(t => t.map((x, i) => i === idx ? { ...x, busy: false, aCoded: out.answer } : x));
    } catch (err) {
      setTurns(t => t.map((x, i) => i === idx ? { ...x, busy: false, error: err.message || String(err) } : x));
    }
  }

  const coder = coderRef.current;
  const idByCode = code => { if (!coder) return null; for (const [id, c] of coder.gCode) if (c === code) return id; return null; };
  // Put real names back; guest codes become links to their profile
  const render = text => String(text || '').split(/\b([GVH]\d+)\b/g).map((part, i) => {
    if (i % 2 === 0) return <React.Fragment key={i}>{part}</React.Fragment>;
    const name = coder?.label?.[part];
    if (!name) return <React.Fragment key={i}>{part}</React.Fragment>;
    const gid = canOpen && part.startsWith('G') ? idByCode(part) : null;
    return gid ? <button key={i} type="button" className="ai-name" onClick={() => onOpenGuest(gid)}>{name}</button> : <b key={i}>{name}</b>;
  });

  return (
    <div className="panel ai-panel">
      <div className="panel-head"><h2>✨ Ask AI</h2><div className="desc">About this event's guests, travel, sessions and POCs</div></div>
      <div className="ai-body">
        {turns.map((t, i) => (
          <div key={i} className="ai-turn">
            <div className="ai-q">{t.q}</div>
            {canOpen && t.guests?.length > 0 && coder && (
              <div className="ai-chips">{t.guests.map(code => { const gid = idByCode(code); return gid ? <button key={code} className="btn xs" onClick={() => onOpenGuest(gid)}>Open profile: {coder.label[code]}</button> : null; })}</div>
            )}
            {t.local?.opened && <div className="ai-a">Opened <b>{t.local.opened}</b>’s full profile below — it shows everything the app holds. Ask a follow-up here for anything specific.</div>}
            {t.local?.ambiguous?.map((a, k) => (
              <div key={'a' + k} className="ai-a">“{a.text}” could be more than one person. Which one?
                <div className="ai-chips" style={{ marginTop: 6 }}>{a.options.map(p => (
                  <button key={p.code} className="btn xs" onClick={() => { if (p.kind === 'guest' && canOpen) onOpenGuest(p.id); else setQuestion(t.q.replace(a.text, p.name)); }}>{p.name}{p.sub ? ` · ${p.sub}` : ''}</button>
                ))}</div>
              </div>
            ))}
            {t.local?.unknown?.map((u, k) => (
              <div key={'u' + k} className="ai-a">There is no guest or volunteer called “{u.text}” in this event. Nothing was sent to the AI.
                {u.suggestions.length > 0 ? <>
                  {' '}Did you mean:
                  <div className="ai-chips" style={{ marginTop: 6 }}>{u.suggestions.map(p => (
                    <button key={p.code} className="btn xs" onClick={() => setQuestion(t.q.replace(u.text, p.name))}>{p.name}{p.sub ? ` · ${p.sub}` : ''}</button>
                  ))}</div>
                </> : ' Check the spelling, or whether they were added to a different event.'}
              </div>
            ))}
            {t.busy && <div className="ai-a muted-sm">Thinking…</div>}
            {t.error && <div className="av-err">{t.error}</div>}
            {t.aCoded && <div className="ai-a">{t.aCoded.split(/\n{2,}/).map((para, j) => <p key={j}>{para.split('\n').map((line, k) => <React.Fragment key={k}>{k > 0 && <br />}{render(line.replace(/^\s*[-*]\s+/, '• ').replace(/\*\*/g, ''))}</React.Fragment>)}</p>)}</div>}
          </div>
        ))}
        <form className="ai-ask" onSubmit={ask}>
          <input className="input" value={question} onChange={e => setQuestion(e.target.value)} disabled={busy}
            placeholder={turns.length ? 'Ask a follow-up…' : 'e.g. When does Anjali Sharma reach the venue?  ·  Who arrives tomorrow before noon?'} />
          <button className="btn primary sm" type="submit" disabled={busy || !question.trim()}>{busy ? 'Asking…' : 'Ask'}</button>
          {turns.length > 0 && !busy && <button type="button" className="btn ghost sm" onClick={() => setTurns([])}>Clear</button>}
        </form>
        <div className="muted-sm ai-privacy">🔒 Names, phone numbers, emails, PNRs, flight numbers and hotel names are not sent — the AI sees guests as codes and the names are put back here. Answers can be wrong: check the guest's profile for anything important.</div>
      </div>
    </div>
  );
}

/* ══ Guest profile ══ */
function GuestProfile({ c, store, activeEventId, canLookup, toast }) {
  const cfg = getTravelCfg(store, activeEventId);
  const L = pickLogistics(store.logistics || [], c.id);
  const vols = store.volunteers || [];
  const vendors = store.carVendors || [];
  const vName = id => vols.find(v => v.id === id)?.name || '—';
  const plan = travelPlan(L, cfg);
  const warns = travelWarnings(L, cfg);
  const sessions = (store.assignments || []).filter(a => a.contactId === c.id)
    .map(a => (store.sessions || []).find(s => s.id === a.sessionId)).filter(Boolean)
    .sort((a, b) => `${a.date}${a.start}` > `${b.date}${b.start}` ? 1 : -1);
  const m = (store.founder || []).find(f => f.contactId === c.id);
  const pocs = (store.poc || []).filter(p => p.contactId === c.id && p.eventId === activeEventId).sort((a, b) => a.day > b.day ? 1 : -1);
  const notes = (store.contact_notes || []).filter(n => n.contactId === c.id).sort((a, b) => ((b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0)));
  const manual = (store.personalisedSchedule || []).filter(r => r.contactId === c.id && !r.auto && !r.deleted && !r.override && r.date && r.time && !(r.event || '').startsWith('__session__'));
  const vendor = vendors.find(v => v.id === L.carVendorId);
  const driver = vendor?.drivers?.find(d => d.id === L.carDriverId);
  const pending = pendingFor(L);

  // Day-by-day: arrival, travel steps, sessions, Sahebji, POC, manual rows
  const items = [];
  if (L.arrivalDate && L.arrivalTime) items.push({ date: L.arrivalDate, time: L.arrivalTime, text: `Arrival${L.arrivalLocation ? ' at ' + L.arrivalLocation : ''}`, kind: 'travel' });
  plan.steps.filter(s => s.key !== 'land').forEach(s => items.push({ date: s.date, time: s.time, text: s.label, kind: 'travel' }));
  sessions.forEach(s => items.push({ date: s.date, time: s.start || '', text: `${s.title}${s.venue ? ' · ' + s.venue : ''}`, kind: 'session' }));
  if (m?.date && m?.time) items.push({ date: m.date, time: m.time, text: `One-on-one with Sahebji (${m.duration || 30} min)${m.frozen ? ' 🔒' : ''}`, kind: 'sahebji' });
  pocs.forEach(p => items.push({ date: p.day, time: p.fromTime || '', text: `POC: ${vName(p.volunteerId)}${p.fromTime ? ` (${p.fromTime}–${p.toTime})` : ''}`, kind: 'poc' }));
  manual.forEach(r => items.push({ date: r.date, time: r.time, text: r.event, kind: 'manual' }));
  const days = [...new Set(items.map(i => i.date))].sort();

  const Row = ({ k, v }) => v ? <div className="gp-kv"><span>{k}</span><div>{v}</div></div> : null;
  const arr = sourceLabel(L, 'arrival'), dep = sourceLabel(L, 'departure');
  return (
    <div className="gp">
      <div className="gp-head">
        <div style={{ flex: 1, minWidth: 220 }}>
          <div className="gp-name">{displayName(c)}</div>
          <div className="muted-sm">{[c.desig, c.org].filter(Boolean).join(' · ')}</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
            {c.status && <span className={'badge b-' + c.status.toLowerCase()}>{c.status}</span>}
            {c.type && <span className="badge b-type">{c.type}</span>}
            {(c.tags || []).map(t => <span key={t} className="badge">{t}</span>)}
          </div>
        </div>
        {pending.length > 0 && <div className="src-warn" style={{ maxWidth: 260 }}>⚠ Still missing: {pending.join(', ')}</div>}
      </div>

      <div className="gp-grid">
        <section>
          <h3>Contact</h3>
          <Row k="Field" v={c.field} />
          <Row k="Phone" v={c.phone && <a href={`tel:${c.phone}`}>{c.phone}</a>} />
          <Row k="Email" v={c.email && <a href={`mailto:${c.email}`}>{c.email}</a>} />
          <Row k="Liaison" v={[c.liaisonName, c.liaisonPhone].filter(Boolean).join(' · ')} />
          <Row k="Event role" v={c.eventRole} />
          <Row k="Event notes" v={c.eventNotes} />
          <Row k="Remark" v={c.remark} />
        </section>
        <section>
          <h3>Travel & stay</h3>
          <Row k="Arrival" v={L.arrivalDate && <>{shortDate(L.arrivalDate)} {L.arrivalTime} {L.arrivalLocation && `· ${L.arrivalLocation}`} <span className={'src-tag ' + arr.cls}>{arr.t}</span></>} />
          <Row k="Departure" v={L.departureDate && <>{shortDate(L.departureDate)} {L.departureTime} {L.departureLocation && `· ${L.departureLocation}`} <span className={'src-tag ' + dep.cls}>{dep.t}</span></>} />
          <Row k="Flights" v={L.flightReq === 'not_required' ? 'Not required' : (L.arrivalFlightNo || L.departureFlightNo) ? <>
            {L.arrivalFlightNo && <div>In: {L.arrivalFlightNo} · {L.arrivalFrom} → {L.arrivalTo} · lands {shortDate(L.arrivalFlightDate)} {L.arrivalFlightTime}{L.arrivalPnr ? ` · PNR ${L.arrivalPnr}` : ''}</div>}
            {L.departureFlightNo && <div>Out: {L.departureFlightNo} · {L.departureFrom} → {L.departureTo} · {shortDate(L.departureFlightDate)} {L.departureFlightTime}{L.departureIntl ? ' · international' : ''}{L.departurePnr ? ` · PNR ${L.departurePnr}` : ''}</div>}
          </> : 'Not booked yet'} />
          <Row k="Hotel" v={L.accomReq === 'not_required' ? 'Not required' : L.hotelName ? `${L.hotelName} · ${shortDate(L.checkinDate)} → ${shortDate(L.checkoutDate)}` : 'Not set'} />
          <Row k="Car" v={L.carReq === 'not_required' ? 'Not required' : vendor ? <>
            {vendor.name}{L.carType ? ` · ${L.carType}` : ''}{driver ? ` · driver ${driver.name}${driver.contact ? ' (' + driver.contact + ')' : ''}` : ''}
            {L.carPickupDate && <div className="muted-sm">Pickup {shortDate(L.carPickupDate)} {L.carPickupTime}{L.carPickupFrom ? ` from ${L.carPickupFrom}` : ''}</div>}
            {L.carDepartureDate && <div className="muted-sm">Drop {shortDate(L.carDepartureDate)} {L.carDepartureTime}</div>}
          </> : 'Not booked yet'} />
          <Row k="Overall POC" v={L.overallPocId && vName(L.overallPocId)} />
          {warns.map(w => <div key={w.key} className="src-warn">⚠ {w.text}</div>)}
        </section>
      </div>

      <section>
        <h3>Day by day</h3>
        {days.length ? days.map(d => (
          <div key={d} className="gp-day">
            <div className="gp-day-h">{fmtDate(d)}</div>
            {items.filter(i => i.date === d).sort((a, b) => tMin(a.time) - tMin(b.time)).map((i, k) => (
              <div key={k} className={'gp-item ' + i.kind}><span className="mono">{i.time || '—'}</span><span>{i.text}</span></div>
            ))}
          </div>
        )) : <div className="muted-sm">Nothing scheduled yet.</div>}
        {m && !m.date && m.durationReq !== 'not_required' && <div className="muted-sm" style={{ marginTop: 6 }}>Sahebji meeting: needs a time.</div>}
        {plan.missing.length > 0 && <div className="muted-sm" style={{ marginTop: 6 }}>Add a travel time for {plan.missing.join(' and ')} (Logistics → 🕒 Travel times) to complete the travel plan.</div>}
      </section>

      {notes.length > 0 && (
        <section>
          <h3>Notes & follow-ups</h3>
          {notes.slice(0, 10).map(n => (
            <div key={n.id} className="gp-note"><span className="muted-sm">{n.date || ''} · {n.type}</span> {n.text}{n.dueDate && !n.done ? <span className="src-warn"> · follow up {shortDate(n.dueDate)}</span> : ''}</div>
          ))}
        </section>
      )}

      {canLookup && <OnlineLookup c={c} activeEventId={activeEventId} toast={toast} />}
    </div>
  );
}

/* ══ Look up online + same-person check ══ */
function OnlineLookup({ c, activeEventId, toast }) {
  const [st, setSt] = useState(null);   // { busy } | { error } | result
  const [saved, setSaved] = useState(false);
  async function run() {
    setSt({ busy: true }); setSaved(false);
    try {
      // ONLY these three fields leave the app
      const out = await postJson('/api/lookup', { name: [c.honor, c.name].filter(Boolean).join(' ').trim() || displayName(c), organisation: c.org || '', designation: c.desig || '' });
      setSt(out);
    } catch (e) { setSt({ error: e.message || String(e) }); }
  }
  React.useEffect(() => { setSt(null); setSaved(false); }, [c.id]);

  const checks = st && !st.busy && !st.error && st.found ? [
    { k: 'Organisation', ours: c.org, theirs: st.organisation, ok: overlap(c.org, st.organisation) },
    { k: 'Designation', ours: c.desig, theirs: st.currentRole, ok: overlap(c.desig, st.currentRole) },
    { k: 'Field', ours: c.field, theirs: st.expertise, ok: overlap(c.field, st.expertise) },
  ] : [];
  const yes = checks.filter(x => x.ok === true).length, no = checks.filter(x => x.ok === false).length;
  const orgOk = checks[0]?.ok === true;
  let conf = 'low';
  if (orgOk && yes >= 2) conf = 'high'; else if (orgOk || yes >= 2) conf = 'medium';
  if (st?.ambiguous && conf === 'high') conf = 'medium';
  if (no >= 2) conf = 'low';

  async function saveNote() {
    const text = `Online profile (${conf} confidence it's the same person): ${st.summary}${st.sources?.length ? `\nSources: ${st.sources.slice(0, 3).map(s => s.uri).join(' , ')}` : ''}`;
    await saveItem('contact_notes', { contactId: c.id, eventId: activeEventId, text, type: 'Other', dueDate: null, done: true,
      createdAt: { seconds: Math.floor(Date.now() / 1000) }, date: todayISO() });
    setSaved(true); toast('Saved to the guest’s notes.');
  }

  return (
    <section className="gp-lookup">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0 }}>Public information</h3>
        <button className="btn sm" disabled={st?.busy} onClick={run}>{st?.busy ? 'Searching…' : st ? '↻ Search again' : '🌐 Look up online'}</button>
        <span className="muted-sm">Sends only: name, organisation, designation.</span>
      </div>
      {st?.error && <div className="av-err" style={{ marginTop: 8 }}>{st.error}</div>}
      {st && !st.busy && !st.error && !st.found && <div className="muted-sm" style={{ marginTop: 8 }}>Nothing reliable found online for this person.</div>}
      {st && !st.busy && !st.error && st.found && (
        <div className="gp-web">
          <div className={'gp-conf ' + conf}>
            {conf === 'high' ? '✓ Very likely the same person' : conf === 'medium' ? '◐ Possibly the same person — check the sources' : '✗ May be a different person — don’t rely on this'}
            {st.ambiguous ? ' · several people share this name' : ''}
          </div>
          <table className="gp-check"><thead><tr><th></th><th>Our record</th><th>Online</th><th></th></tr></thead><tbody>
            {checks.map(x => <tr key={x.k}><td>{x.k}</td><td>{x.ours || '—'}</td><td>{x.theirs || '—'}</td><td>{x.ok === true ? '✓' : x.ok === false ? '✗' : '?'}</td></tr>)}
          </tbody></table>
          {st.summary && <p style={{ margin: '10px 0 6px' }}>{st.summary}</p>}
          {st.location && <div className="muted-sm">Based in: {st.location}</div>}
          {st.highlights?.length > 0 && <ul className="gp-hl">{st.highlights.map((h, i) => <li key={i}>{h}</li>)}</ul>}
          {st.sources?.length > 0 && <div className="muted-sm">Sources: {st.sources.map((s, i) => <React.Fragment key={s.uri}>{i > 0 && ' · '}<a href={s.uri} target="_blank" rel="noopener noreferrer">{s.title}</a></React.Fragment>)}</div>}
          <div style={{ marginTop: 10 }}>
            <button className="btn xs" disabled={saved} onClick={saveNote}>{saved ? '✓ Saved to notes' : 'Save to notes'}</button>
            <span className="muted-sm" style={{ marginLeft: 8 }}>Nothing is saved unless you click this.</span>
          </div>
        </div>
      )}
    </section>
  );
}
