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
const DETAILS_RE = /^\s*(all\s+)?(details?|info|information|everything|profile)\b|\b(details?|everything|all\s+info|information|profile)\s+(of|about|on|for)\b/i;
const WHO_IS_RE = /^\s*(who\s+is|tell\s+me\s+about|show\s+me)\s+G\d+\s*\??\s*$/i;   // "who is Raj Doshi" — but not "who is the POC for Raj Doshi"

/* scope: { guestIds: Set | null, volunteers: bool, allSessions: bool } — send only what the question needs (faster answers) */
function buildContext(store, activeEventId, coder, scope = {}) {
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

  const guests = coder.contacts.filter(c => !scope.guestIds || scope.guestIds.has(c.id)).map(c => {
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
  const volunteers = scope.volunteers === false ? [] : coder.vols.filter(v => !scope.volIds || scope.volIds.has(v.id)).map(v => {
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
    sessions: sessions.filter(s => scope.allSessions !== false || guests.some(g => (g.sessions || []).includes(sCode.get(s.id)))).map(s => ({ id: sCode.get(s.id), title: coder.scrub(s.title || ''), type: s.type || '', date: s.date || '', start: s.start || '', end: s.end || '', venue: coder.scrub(s.venue || '') })),
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
export function Assistant({ store, rawStore, activeEventId }) {
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
        {sel && <GuestProfile c={sel} store={store} rawStore={rawStore} activeEventId={activeEventId} canLookup={can('ai.lookup')} toast={toast} />}
      </div>}
    </>
  );
}

/* seconds since shown — so a slow answer visibly isn't stuck */
function Secs() {
  const [n, setN] = useState(0);
  React.useEffect(() => { const t = setInterval(() => setN(x => x + 1), 1000); return () => clearInterval(t); }, []);
  return <>{n}s</>;
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
    if (canOpen && (DETAILS_RE.test(text) || WHO_IS_RE.test(found.coded)) && guests.length === 1 && found.matched.length === 1) {
      const gid = found.matched[0].id;
      setTurns(t => [...t, { q: text, local: { opened: found.matched[0].name } }]);
      onOpenGuest(gid);
      return;
    }
    const qCoded = coder.scrub(found.coded);
    const idx = turns.length;
    setTurns(t => [...t, { q: text, qCoded, busy: true, guests }]);
    try {
      // Send only what this question needs: one guest's question doesn't need all 50 guests
      const lower = text.toLowerCase();
      const mGuests = found.matched.filter(p => p.kind === 'guest'), mVols = found.matched.filter(p => p.kind === 'volunteer');
      // "who/which" about a named guest stays about that guest; plural words mean the whole event
      const wide = /\b(any(one|body)?|every(one|body)?|all|guests|people|others?|list|how many|count|total|compare|earliest|latest|most|least)\b/.test(lower)
        || (/\b(who|which|whom)\b/.test(lower) && !mGuests.length);
      const aboutVols = mVols.length > 0 || /\b(volunteer|volunteers|poc|pocs|free|available|availability|busy|slot|slots|department)\b/.test(lower);
      const scope = {
        guestIds: mGuests.length && !wide ? new Set(mGuests.map(p => p.id)) : null,
        volunteers: aboutVols,
        volIds: mVols.length && !wide && !mGuests.length ? new Set(mVols.map(p => p.id)) : null,
        allSessions: !(mGuests.length && !wide) || /\b(session|sessions|panel|panels|programme|program|agenda)\b/.test(lower),
      };
      const context = buildContext(store, activeEventId, coder, scope);
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
            {t.busy && <div className="ai-a muted-sm">Thinking… <Secs /></div>}
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

/* ══ Guest profile ══════════════════════════════════════════════════
   Gathers everything the app holds about one guest, from every module. "Other recorded fields"
   lists anything saved on the guest's records that isn't shown above, so nothing is ever hidden. */

// Personalised Schedule rows exactly as that screen builds them (auto rows + hand-added rows,
// hidden rows left out, per-guest time changes applied, POC Required ticks)
const MANDATORY_KEYWORDS = {
  arrivalAtVenue: ['arrival at venue'], guidedTour: ['guided tour', 'exhibition'], mediaBytes: ['media bytes', 'media byte'],
  sahebji: ['sahebji', 'one-on-one', 'one on one'], podcast: ['podcast'],
};
function personalSchedule(store, c, L, cfg) {
  const cid = c.id;
  const saved = (store.personalisedSchedule || []).filter(r => r.contactId === cid);
  const isLegacyAuto = r => { const b = r.refId || r.id || ''; return b.startsWith('auto_session_') && !b.includes('__'); };
  const canon = r => { const b = r.refId || r.id || ''; return isLegacyAuto(r) ? `${b}__${cid}` : b; };
  const override = id => saved.find(r => r.override && r.refId === id);
  const deleted = new Set(saved.filter(r => r.auto && r.deleted).map(canon));
  const pocOv = Object.fromEntries(saved.filter(r => r.auto && !r.deleted && !r.override).map(r => [canon(r), r.pocRequired || false]));
  // hand-added rows, in the same threaded order as the Personalised Schedule screen
  const manualAll = saved.filter(r => !r.auto && !r.override);
  const byId = Object.fromEntries(manualAll.map(r => [r.id, r]));
  const seen = new Set(), manual = [];
  const chain = r => { if (!r || seen.has(r.id)) return; seen.add(r.id); manual.push(r); manualAll.filter(x => x.insertAfter === r.id && !seen.has(x.id)).forEach(chain); };
  const byTime = (a, b) => ((a.date || '') + (a.time || '')) > ((b.date || '') + (b.time || '')) ? 1 : -1;
  manualAll.filter(r => !r.insertAfter || !byId[r.insertAfter]).sort(byTime).forEach(chain);
  manualAll.filter(r => !seen.has(r.id)).sort(byTime).forEach(chain);

  const autos = [];
  const arrSrc = L.arrivalOverride ? 'manual' : (L.arrivalSource || 'manual');
  if (L.arrivalDate && L.arrivalTime) autos.push({ id: `auto_arrival_${cid}`, date: L.arrivalDate, time: L.arrivalTime, source: 'Logistics',
    event: arrSrc === 'flight' ? `Arrival at ${L.arrivalLocation || 'the Airport'}${L.arrivalFlightNo ? ` (${L.arrivalFlightNo})` : ''}` : arrSrc === 'car' ? `Arrival at ${L.arrivalLocation || 'the venue'} by car` : 'Arrival at the Airport' });
  const plan = travelPlan(L, cfg);
  plan.steps.forEach(st => {
    if (st.key === 'land' || (st.key === 'reach' && arrSrc === 'car')) return;
    autos.push({ id: `auto_travel_${st.key}_${cid}`, date: st.date, time: st.time, event: st.label, source: 'Travel' });
  });
  if (!plan.steps.some(st => st.key === 'depart') && L.departureDate && L.departureTime)
    autos.push({ id: `auto_travel_depart_${cid}`, date: L.departureDate, time: L.departureTime, event: `Departure${L.departureLocation ? ' from ' + L.departureLocation : ''}`, source: 'Travel' });
  const sIds = (store.assignments || []).filter(a => a.contactId === cid).map(a => a.sessionId);
  (store.sessions || []).filter(s => sIds.includes(s.id)).forEach(s => {
    const id = `auto_session_${s.id}__${cid}`, ov = override(id);
    autos.push({ id, date: ov?.date || s.date, time: ov?.time || s.start, event: s.title, source: 'Scheduling', overridden: !!ov });
  });
  const m = (store.founder || []).find(f => f.contactId === cid);
  const manualSahebji = manualAll.some(r => /sahebji|one-on-one|one on one/i.test(r.event || ''));
  if (m && m.date && m.time && !manualSahebji) autos.push({ id: `auto_sahebji_${cid}`, date: m.date, time: m.time, event: 'One-on-One Meeting with Sahebji', source: 'Sahebji' });
  saved.filter(r => r.auto && r.id?.startsWith('poc_auto_') && !r.deleted).forEach(r => autos.push({ ...r, source: 'POC Allocation' }));

  const rows = [
    ...manual.filter(r => !r.deleted && !(r.event || '').startsWith('__session__')).map(r => ({ ...r, source: 'Manual' })),
    ...autos.filter(r => !deleted.has(r.id)).map(r => ({ ...r, pocRequired: pocOv[r.id] ?? r.pocRequired ?? false })),
  ].sort(byTime);

  // Mandatory items: ticked for this guest → must appear somewhere in the schedule
  const cfgItems = ((store.appConfig || []).find(x => x.id === 'mandatoryItems')?.items || [])
    .map(i => typeof i === 'string' ? { key: i.toLowerCase().replace(/\s+/g, '_'), label: i } : i).filter(i => i && i.key);
  const DEF = [{ key: 'guidedTour', label: 'Guided tour' }, { key: 'mediaBytes', label: 'Media Bytes' }, { key: 'sahebji', label: 'Sahebji meeting' }, { key: 'podcast', label: 'Podcast' }];
  const ALL = [{ key: 'arrivalAtVenue', label: 'Arrival at Venue' }, ...DEF, ...cfgItems.filter(ci => !DEF.find(d => d.key === ci.key)).map(i => ({ key: i.key, label: i.label || i.key }))];
  const chosen = (store.personalisedMandatory || []).find(r => r.contactId === cid) || { arrivalAtVenue: true };
  const mandatory = ALL.filter(it => chosen[it.key]).map(it => {
    const kws = MANDATORY_KEYWORDS[it.key] || [(it.label || it.key).toLowerCase()];
    return { label: it.label, done: rows.some(r => kws.some(k => (r.event || '').toLowerCase().includes(k))) };
  });
  return { rows, mandatory };
}

// A volunteer's slots on a day (same rule as POC Allocation: a ticked day with no times = 09:00–22:00)
function volSlots(store, volId, day, eventId) {
  const a = (store.availability || []).find(x => x.volId === volId && x.day === day && x.eventId === eventId);
  if (!a || !a.checked) return [];
  if (!a.fullDay && Array.isArray(a.slots) && a.slots.some(s => s.start && s.end)) return a.slots.filter(s => s.start && s.end);
  if (a.start && a.end) return [{ start: a.start, end: a.end }];
  return [{ start: '09:00', end: '22:00' }];
}

const SHOWN = {
  contact: ['id', 'eventId', '_updated', 'name', 'honor', 'suffix', 'desig', 'org', 'field', 'type', 'status', 'phone', 'email', 'address', 'liaisonName', 'liaisonPhone',
    'eventRole', 'eventNotes', 'remark', 'tags', 'last', 'createdAt', 'updatedAt'],
  logistics: ['id', 'eventId', '_updated', 'contactId', 'arrivalDate', 'arrivalTime', 'arrivalLocation', 'departureDate', 'departureTime', 'departureLocation',
    'arrivalSource', 'departureSource', 'arrivalOverride', 'departureOverride', 'plannedArrivalDate', 'plannedDepartureDate',
    'flightReq', 'carReq', 'accomReq', 'arrivalFrom', 'arrivalTo', 'arrivalFlightNo', 'arrivalFlightDate', 'arrivalFlightTime', 'arrivalPnr',
    'departureFrom', 'departureTo', 'departureFlightNo', 'departureFlightDate', 'departureFlightTime', 'departureIntl', 'departurePnr',
    'hotelName', 'checkinDate', 'checkinTime', 'checkoutDate', 'checkoutTime', 'carVendorId', 'carDriverId', 'carType', 'carPickupFrom',
    'carPickupDate', 'carPickupTime', 'carDepartureDate', 'carDepartureTime', 'overallPocId', 'remarks', 'item'],
};
const LABEL = k => k.replace(/([A-Z])/g, ' $1').replace(/^./, x => x.toUpperCase()).replace(/_/g, ' ');
const show = v => {
  if (v === true) return 'Yes'; if (v === false) return 'No';
  if (Array.isArray(v)) return v.map(x => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(', ');
  if (v && typeof v === 'object') return v.seconds ? tsText(v) : JSON.stringify(v);
  return String(v);
};
const when = ms => new Date(ms).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const tsText = v => v?.seconds ? when(v.seconds * 1000) : (typeof v === 'number' ? when(v) : '');
function OtherFields({ rec, known, title = 'Other recorded fields' }) {
  const extra = Object.entries(rec || {}).filter(([k, v]) => !known.includes(k) && v !== '' && v !== null && v !== undefined && !(Array.isArray(v) && !v.length) && !k.startsWith('_'));
  if (!extra.length) return null;
  return (
    <div className="gp-other">
      <div className="muted-sm" style={{ fontWeight: 600, marginBottom: 2 }}>{title}</div>
      {extra.map(([k, v]) => <div key={k} className="gp-kv"><span>{LABEL(k)}</span><div>{show(v)}</div></div>)}
    </div>
  );
}

export function GuestProfile({ c, store, rawStore, activeEventId, canLookup, toast }) {
  const cfg = getTravelCfg(store, activeEventId);
  const L = pickLogistics(store.logistics || [], c.id);
  const vols = store.volunteers || [];
  const vendors = store.carVendors || [];
  const vol = id => vols.find(v => v.id === id);
  const vName = id => vol(id)?.name || '—';
  const plan = travelPlan(L, cfg);
  const warns = travelWarnings(L, cfg);
  const sessions = (store.assignments || []).filter(a => a.contactId === c.id)
    .map(a => (store.sessions || []).find(s => s.id === a.sessionId)).filter(Boolean)
    .sort((a, b) => `${a.date}${a.start}` > `${b.date}${b.start}` ? 1 : -1);
  const minute = (store.minuteItems || []).filter(mi => mi.speakerId === c.id)
    .map(mi => ({ ...mi, session: (store.sessions || []).find(s => s.id === mi.sessionId) }));
  const m = (store.founder || []).find(f => f.contactId === c.id);
  const pocs = (store.poc || []).filter(p => p.contactId === c.id && p.eventId === activeEventId).sort((a, b) => a.day > b.day ? 1 : -1);
  const notes = (store.contact_notes || []).filter(n => n.contactId === c.id).sort((a, b) => ((b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0)));
  const vendor = vendors.find(v => v.id === L.carVendorId);
  const driver = vendor?.drivers?.find(d => d.id === L.carDriverId);
  const pending = pendingFor(L);
  const { rows, mandatory } = personalSchedule(store, c, L, cfg);
  const kit = (store.felicitation || []).find(k => k.contactId === c.id) || {};
  const KIT = ['Momento', 'Shawl', 'Kumkum', 'Cover', 'Gold Coin', 'Silver Coin', 'Frame'];
  const kitKey = i => i.toLowerCase().replace(/ /g, '_');
  const nights = L.checkinDate && L.checkoutDate ? Math.max(0, Math.round((Date.parse(L.checkoutDate) - Date.parse(L.checkinDate)) / 864e5)) : null;

  // POC: needed (from POC Required ticks) vs assigned, with the same checks POC Allocation makes
  const needs = pocNeeds(store.personalisedSchedule || [], c.id);
  const pocDays = [...new Set([...Object.keys(needs), ...pocs.map(p => p.day)])].sort();
  const pocIssues = day => {
    const need = needs[day], p = pocs.find(x => x.day === day), out = [];
    if (need && !p) out.push('No POC assigned');
    if (!p) return out;
    if (!need) out.push('POC no longer required for this day');
    else if (p.fromTime && (p.fromTime !== need.from || p.toTime !== need.to)) out.push(`Timing changed — now needed ${need.from}–${need.to}`);
    const v = vol(p.volunteerId);
    if (!v) out.push('Assigned volunteer no longer exists');
    else {
      const sl = volSlots(store, v.id, day, activeEventId);
      if (!sl.length) out.push(`${v.name} is not available on this day`);
      else if (p.fromTime && p.toTime && !sl.some(x => tMin(x.start) <= tMin(p.fromTime) && tMin(x.end) >= tMin(p.toTime))) out.push(`Outside ${v.name}'s hours (${sl.map(x => `${x.start}–${x.end}`).join(', ')})`);
    }
    if ((L.arrivalDate && day < L.arrivalDate) || (L.departureDate && day > L.departureDate)) out.push('Outside the guest’s stay');
    return out;
  };

  // Same person in other events (phone, or name)
  const allC = rawStore?.contacts || [], events = rawStore?.events || [];
  const ph = x => String(x || '').replace(/\D/g, '').slice(-10), nm = x => String(x || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const others = allC.filter(o => o.id !== c.id && o.eventId !== activeEventId && (
    (ph(c.phone).length >= 7 && ph(o.phone) === ph(c.phone)) || (nm(c.name).length > 3 && nm(o.name) === nm(c.name))))
    .map(o => ({ o, ev: events.find(e => e.id === o.eventId) })).filter(x => x.ev)
    .sort((a, b) => (b.ev.startDate || '') > (a.ev.startDate || '') ? 1 : -1);

  // Recent changes to this guest's records (activity log keeps the guest's name or the record id)
  const myIds = new Set([c.id, L.id, m?.id, kit.id, ...pocs.map(p => p.id), ...(store.personalisedSchedule || []).filter(r => r.contactId === c.id).map(r => r.id), ...notes.map(n => n.id)].filter(Boolean));
  const activity = (rawStore?.activity_log || store.activity_log || [])
    .filter(a => myIds.has(a.detail) || (c.name && a.detail === c.name) || a.detail === displayName(c))
    .sort((a, b) => (b.ts?.seconds || 0) - (a.ts?.seconds || 0)).slice(0, 15);

  const days = [...new Set(rows.map(r => r.date).filter(Boolean))].sort();
  const Row = ({ k, v }) => (v || v === 0) ? <div className="gp-kv"><span>{k}</span><div>{v}</div></div> : null;
  const arr = sourceLabel(L, 'arrival'), dep = sourceLabel(L, 'departure');
  const req = k => L[k] === 'not_required' ? 'Not required' : 'Required';

  const [printing, setPrinting] = useState(false);
  React.useEffect(() => {
    if (!printing) return;
    const t = setTimeout(() => { window.print(); setPrinting(false); }, 80);
    return () => clearTimeout(t);
  }, [printing]);

  return (
    <div className={'gp' + (printing ? ' print-target' : '')}>
      <div className="gp-head">
        <div style={{ flex: 1, minWidth: 220 }}>
          <div className="gp-name">{displayName(c)}</div>
          <div className="muted-sm">{[c.desig, c.org].filter(Boolean).join(' · ')}</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
            {c.status && <span className={'badge b-' + c.status.toLowerCase()}>{c.status}</span>}
            {c.type && <span className="badge b-type">{c.type}</span>}
            {(c.tags || []).map(t => <span key={t} className="gp-chip">{t}</span>)}
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-end' }}>
          <button className="btn sm no-print" onClick={() => setPrinting(true)}>🖨 Print / PDF</button>
          <span className="print-only muted-sm">Printed {when(Date.now())}</span>
          {pending.length > 0 && <div className="src-warn" style={{ maxWidth: 260 }}>⚠ Still missing: {pending.join(', ')}</div>}
        </div>
      </div>

      <div className="gp-grid">
        <section>
          <h3>Contact</h3>
          <Row k="Name" v={[c.honor, c.name, c.suffix].filter(Boolean).join(' ')} />
          <Row k="Designation" v={c.desig} />
          <Row k="Organisation" v={c.org} />
          <Row k="Field" v={c.field} />
          <Row k="Phone" v={c.phone && <a href={`tel:${c.phone}`}>{c.phone}</a>} />
          <Row k="Email" v={c.email && <a href={`mailto:${c.email}`}>{c.email}</a>} />
          <Row k="Address" v={c.address} />
          <Row k="Liaison" v={[c.liaisonName, c.liaisonPhone].filter(Boolean).join(' · ')} />
          <Row k="Event role" v={c.eventRole} />
          <Row k="Event notes" v={c.eventNotes} />
          <Row k="Remark" v={c.remark} />
          <Row k="Added" v={tsText(c.createdAt)} />
          <Row k="Last updated" v={tsText(c._updated)} />
          <OtherFields rec={c} known={SHOWN.contact} />
        </section>
        <section>
          <h3>Travel & stay</h3>
          <Row k="Arrival" v={L.arrivalDate && <>{shortDate(L.arrivalDate)} {L.arrivalTime} {L.arrivalLocation && `· ${L.arrivalLocation}`} <span className={'src-tag ' + arr.cls}>{arr.t}</span>
            {L.plannedArrivalDate && L.plannedArrivalDate !== L.arrivalDate && <div className="muted-sm">Planned: {shortDate(L.plannedArrivalDate)}</div>}</>} />
          <Row k="Departure" v={L.departureDate && <>{shortDate(L.departureDate)} {L.departureTime} {L.departureLocation && `· ${L.departureLocation}`} <span className={'src-tag ' + dep.cls}>{dep.t}</span>
            {L.plannedDepartureDate && L.plannedDepartureDate !== L.departureDate && <div className="muted-sm">Planned: {shortDate(L.plannedDepartureDate)}</div>}</>} />
          <Row k="Needs" v={`Flight: ${req('flightReq')} · Car: ${req('carReq')} · Hotel: ${req('accomReq')}`} />
          <Row k="Flights" v={L.flightReq === 'not_required' ? 'Not required' : (L.arrivalFlightNo || L.departureFlightNo) ? <>
            {L.arrivalFlightNo && <div>In: {L.arrivalFlightNo} · {L.arrivalFrom || '?'} → {L.arrivalTo || '?'} · lands {shortDate(L.arrivalFlightDate)} {L.arrivalFlightTime}{L.arrivalPnr ? ` · PNR ${L.arrivalPnr}` : ''}</div>}
            {L.departureFlightNo && <div>Out: {L.departureFlightNo} · {L.departureFrom || '?'} → {L.departureTo || '?'} · {shortDate(L.departureFlightDate)} {L.departureFlightTime}{L.departureIntl ? ' · international' : ''}{L.departurePnr ? ` · PNR ${L.departurePnr}` : ''}</div>}
          </> : 'Not booked yet'} />
          <Row k="Hotel" v={L.accomReq === 'not_required' ? 'Not required' : L.hotelName ? <>
            {L.hotelName}
            <div className="muted-sm">Check-in {shortDate(L.checkinDate)} {L.checkinTime || ''} · Check-out {shortDate(L.checkoutDate)} {L.checkoutTime || ''}{nights !== null ? ` · ${nights} night${nights === 1 ? '' : 's'}` : ''}</div>
          </> : 'Not set'} />
          <Row k="Car" v={L.carReq === 'not_required' ? 'Not required' : vendor ? <>
            {vendor.name}{vendor.contact ? ` (${vendor.contact})` : ''}{L.carType ? ` · ${L.carType}` : ''}
            {driver && <div>Driver: {driver.name}{driver.contact ? ` · ${driver.contact}` : ''}</div>}
            {L.carPickupDate && <div className="muted-sm">Pickup {shortDate(L.carPickupDate)} {L.carPickupTime}{L.carPickupFrom ? ` from ${L.carPickupFrom}` : ''}</div>}
            {L.carDepartureDate && <div className="muted-sm">Drop {shortDate(L.carDepartureDate)} {L.carDepartureTime}</div>}
          </> : 'Not booked yet'} />
          <Row k="Overall POC" v={L.overallPocId && <>{vName(L.overallPocId)}{vol(L.overallPocId)?.phone ? ` · ${vol(L.overallPocId).phone}` : ''}</>} />
          <Row k="Remarks" v={L.remarks} />
          {warns.map(w => <div key={w.key} className="src-warn" style={{ maxWidth: 'none' }}>⚠ {w.text}</div>)}
          <OtherFields rec={L} known={SHOWN.logistics} />
        </section>
      </div>

      {plan.steps.length > 0 && (
        <section>
          <h3>Travel plan</h3>
          <div className="travel-plan">{plan.steps.map(st => <div key={st.key} className={'tp-step ' + st.key}><span className="mono">{shortDate(st.date)} {st.time}</span><span>{st.label}</span></div>)}</div>
          {plan.missing.length > 0 && <div className="muted-sm" style={{ marginTop: 6 }}>Add a travel time for {plan.missing.join(' and ')} (Logistics → 🕒 Travel times) to complete it.</div>}
        </section>
      )}

      <section>
        <h3>Programme</h3>
        {sessions.length ? sessions.map(s => (
          <div key={s.id} className="gp-kv"><span>{shortDate(s.date)} {s.start}{s.end ? `–${s.end}` : ''}</span>
            <div><b>{s.title}</b>{s.type ? ` · ${s.type}` : ''}{s.venue ? ` · ${s.venue}` : ''}{s.topic && <div className="muted-sm">Topic: {s.topic}</div>}</div></div>
        )) : <div className="muted-sm">Not assigned to any session.</div>}
        {minute.length > 0 && <>
          <div className="muted-sm" style={{ fontWeight: 600, margin: '8px 0 2px' }}>Speaking slots (minute-to-minute)</div>
          {minute.map(mi => <div key={mi.id} className="gp-kv"><span>{mi.schedule || '—'}{mi.duration ? ` · ${mi.duration}` : ''}</span><div>{mi.detail}{mi.session ? <span className="muted-sm"> — {mi.session.title}, {shortDate(mi.session.date)}</span> : ''}</div></div>)}
        </>}
        <div className="gp-kv"><span>Sahebji meeting</span><div>{!m ? 'No meeting yet'
          : m.durationReq === 'not_required' ? 'Not required'
          : m.date && m.time ? <>{shortDate(m.date)} {m.time} · {m.duration || 30} min · {m.venue || 'VIP Lounge'}{m.frozen ? ' · 🔒 frozen' : ''}{m.notes && <div className="muted-sm">{m.notes}</div>}</>
          : 'Needs a time'}</div></div>
      </section>

      <section>
        <h3>Personalised schedule</h3>
        {mandatory.length > 0 && (
          <div className="gp-mand">{mandatory.map(x => <span key={x.label} className={'gp-chip ' + (x.done ? 'ok' : 'warn')}>{x.done ? '✓' : '⚠'} {x.label}</span>)}</div>
        )}
        {days.length ? days.map(d => (
          <div key={d} className="gp-day">
            <div className="gp-day-h">{fmtDate(d)}</div>
            {rows.filter(r => r.date === d).map((r, k) => (
              <div key={r.id || k} className={'gp-item src-' + r.source.toLowerCase().replace(/\s+/g, '-')}>
                <span className="mono">{r.time || '—'}</span>
                <span style={{ flex: 1 }}>{r.event}{r.overridden ? ' (time changed for this guest)' : ''}</span>
                {r.pocRequired && <span className="gp-chip ok">POC</span>}
                <span className="gp-src">{r.source}</span>
              </div>
            ))}
          </div>
        )) : <div className="muted-sm">Nothing scheduled yet.</div>}
      </section>

      <section>
        <h3>POC</h3>
        {pocDays.length ? pocDays.map(d => {
          const p = pocs.find(x => x.day === d), need = needs[d], issues = pocIssues(d);
          return (
            <div key={d} className="gp-kv"><span>{shortDate(d)}</span><div>
              {need ? <span className="muted-sm">Needed {need.from}–{need.to} · </span> : null}
              {p ? <>{vName(p.volunteerId)}{vol(p.volunteerId)?.phone ? ` · ${vol(p.volunteerId).phone}` : ''}{p.fromTime ? ` · ${p.fromTime}–${p.toTime}` : ''}{p.frozen ? ' · 🔒' : ''}</> : <b>Not assigned</b>}
              {issues.map(t => <div key={t} className="src-warn" style={{ maxWidth: 'none' }}>⚠ {t}</div>)}
            </div></div>
          );
        }) : <div className="muted-sm">No POC needed or assigned.</div>}
      </section>

      <section>
        <h3>Felicitation kit</h3>
        <div className="gp-mand">{KIT.map(i => <span key={i} className={'gp-chip ' + (kit[kitKey(i)] ? 'ok' : '')}>{kit[kitKey(i)] ? '✓' : '○'} {i}</span>)}</div>
      </section>

      <section>
        <h3>Notes & follow-ups</h3>
        {notes.length ? notes.map(n => (
          <div key={n.id} className="gp-note"><span className="muted-sm">{n.date || ''} · {n.type}</span> {n.text}{n.dueDate && !n.done ? <span className="src-warn"> · follow up {shortDate(n.dueDate)}</span> : ''}{n.dueDate && n.done ? <span className="muted-sm"> · done</span> : ''}</div>
        )) : <div className="muted-sm">No notes.</div>}
      </section>

      {others.length > 0 && (
        <section>
          <h3>Other events</h3>
          {others.map(({ o, ev }) => (
            <div key={o.id} className="gp-kv"><span>{ev.name}</span><div>{o.status || '—'}{o.type ? ` · ${o.type}` : ''}{o.eventRole ? ` · ${o.eventRole}` : ''}{ev.startDate ? <span className="muted-sm"> · {shortDate(ev.startDate)}</span> : ''}</div></div>
          ))}
        </section>
      )}

      {activity.length > 0 && (
        <section className="no-print">
          <h3>Recent changes</h3>
          {activity.map(a => (
            <div key={a.id} className="gp-note"><span className="muted-sm">{tsText(a.ts)} · {a.email || 'someone'}</span> {a.action}</div>
          ))}
        </section>
      )}

      {canLookup && <div className="no-print"><OnlineLookup c={c} activeEventId={activeEventId} toast={toast} /></div>}
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
