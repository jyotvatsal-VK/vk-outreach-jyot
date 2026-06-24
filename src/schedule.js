import { FOUNDER_STRING } from './data';

export const esc = (s) => (s == null ? '' : String(s));
export const initials = (n) => (n || '?').split(' ').filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
export const displayName = (c) => [c.honor, c.name, c.suffix].filter(Boolean).join(' ');
export const toMin = (t) => { if (!t) return 0; const [h, m] = t.split(':').map(Number); return h * 60 + (m || 0); };
export const addMin = (t, d) => { let x = toMin(t) + d; x = ((x % 1440) + 1440) % 1440; return String(Math.floor(x / 60)).padStart(2, '0') + ':' + String(x % 60).padStart(2, '0'); };
const ord = (n) => { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const fmtDate = (iso) => { if (!iso) return ''; const [y, m, d] = iso.split('-').map(Number); return `${ord(d)} ${MONTHS[m - 1]} ${y}`; };
export const shortDate = (iso) => { if (!iso) return '—'; const [y, m, d] = iso.split('-').map(Number); return `${ord(d)} ${MONTHS[m - 1].slice(0, 3)}`; };
function daysBetween(a, b) { const out = []; let d = new Date(a + 'T00:00:00'); const end = new Date(b + 'T00:00:00'); let g = 0; while (d <= end && g < 60) { out.push(d.toISOString().slice(0, 10)); d.setDate(d.getDate() + 1); g++; } return out; }

/* Build one VIP's personalised schedule from logistics + sessions + founder + standard hospitality. */
export function buildPersonalSchedule(c, store) {
  const L = (store.logistics || []).find((x) => x.contactId === c.id || x.id === c.id) || {};
  const entries = [];
  const add = (date, time, label, src, sub) => { if (date && time) entries.push({ date, time, label, src, sub }); };
  if (L.inbDate && L.inbTime) { add(L.inbDate, L.inbTime, `Arrival at ${L.inbLoc || 'Venue'}`, 'Logistics'); if (L.hotel) add(L.inbDate, addMin(L.inbTime, 50), 'Journey towards Hotel', 'Logistics'); }
  if (L.outDate && L.outDepart) { add(L.outDate, L.outDepart, L.hotel ? 'Departure towards Airport' : 'Departure from Venue', 'Logistics'); if (L.outFlight) add(L.outDate, L.outFlight, 'Outbound Flight', 'Logistics'); }
  (store.assignments || []).filter((a) => a.contactId === c.id).forEach((a) => { const s = (store.sessions || []).find((x) => x.id === a.sessionId); if (s) add(s.date, s.start, s.title, 'Session', s.topic ? 'Topic: ' + s.topic : ''); });
  const f = (store.founder || []).find((x) => x.contactId === c.id || x.id === c.id);
  if (f && f.time) add(f.date, f.time, FOUNDER_STRING, 'Founder');
  const present = (L.inbDate && L.outDate) ? daysBetween(L.inbDate, L.outDate) : [...new Set(entries.map((e) => e.date))];
  const staying = !!L.hotel;
  present.forEach((day) => {
    const isArr = L.inbDate === day; const hasSession = entries.some((e) => e.date === day && e.src === 'Session');
    if (isArr) {
      if (staying) { add(day, '17:30', 'High Tea & Fellowship at VIP Lounge', 'Hospitality'); add(day, '18:00', 'Guided Tour of Exhibition', 'Hospitality'); if ((store.sessions || []).some((s) => s.date === day && s.type === 'Drone Show')) add(day, '19:00', 'Drone Show', 'Hospitality'); }
      else add(day, '10:00', 'Guided Tour of Exhibition', 'Hospitality');
    }
    if (hasSession && !isArr && staying) {
      add(day, '08:30', 'Breakfast at Hotel', 'Hospitality'); add(day, '09:30', 'Journey towards Venue', 'Logistics');
      add(day, '12:00', 'Media Bytes', 'Hospitality'); add(day, '12:30', 'Lunch and networking at VIP Lounge', 'Hospitality'); add(day, '13:30', 'Journey towards Hotel', 'Logistics');
    }
  });
  const byDay = {}; entries.forEach((e) => { (byDay[e.date] = byDay[e.date] || []).push(e); });
  const days = Object.keys(byDay).sort(); days.forEach((d) => byDay[d].sort((a, b) => toMin(a.time) - toMin(b.time)));
  return { days, byDay, stay: L.hotel };
}
export function buildEventSchedule(store) {
  const byDay = {}; (store.sessions || []).forEach((s) => { (byDay[s.date] = byDay[s.date] || []).push(s); });
  const days = Object.keys(byDay).sort(); days.forEach((d) => byDay[d].sort((a, b) => toMin(a.start) - toMin(b.start)));
  return { days, byDay };
}
export function buildFounderSchedule(store) {
  const ent = [];
  (store.founder || []).forEach((f) => {
    const cid = f.contactId || f.id;
    const c = (store.contacts || []).find((x) => x.id === cid);
    if (f.time && c) ent.push({ date: f.date, time: f.time, label: `One-on-One — ${displayName(c)}` });
  });
  const byDay = {}; ent.forEach((e) => { (byDay[e.date] = byDay[e.date] || []).push(e); });
  const days = Object.keys(byDay).sort(); days.forEach((d) => byDay[d].sort((a, b) => toMin(a.time) - toMin(b.time)));
  return { days, byDay };
}
