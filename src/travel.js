/* ══════════════════════════════════════════════════════════════════
   TRAVEL — keeps Logistics' main Arrival / Departure in step with the
   flight and car bookings, and works out pickup / leave times from the
   Travel times table (Logistics → 🕒 Travel times).

   Main fields on a logistics record (read by Personalised Schedule, POC, exports):
     arrivalDate / arrivalTime / arrivalLocation, departureDate / departureTime / departureLocation
   New fields written here:
     arrivalSource / departureSource   'manual' | 'flight' | 'car'
     arrivalOverride / departureOverride  true = typed by hand, never auto-replaced
     plannedArrivalDate / plannedDepartureDate  the dates entered before booking,
                                                kept to flag a mismatch with the booking
   Priority: flight (Flight = Required + flight date) → car (Flight = Not required,
   Car = Required + car date) → the manually planned dates.
══════════════════════════════════════════════════════════════════ */

export const TRAVEL_CFG_ID = 'travelTimes';
export const DEFAULT_TRAVEL_CFG = {
  venueName: 'Venue',
  routes: [],                 // [{ id, from, to, normal, peak }] minutes, either direction
  landingBuffer: 30,          // landing → car ready (baggage, walk to pickup)
  domesticReport: 120,        // be at the airport this long before a domestic flight
  intlReport: 180,            // … international flight
  peak: '08:00-11:00, 17:00-21:00',
};

export function getTravelCfg(store) {
  const c = (store?.appConfig || []).find(x => x.id === TRAVEL_CFG_ID) || {};
  const num = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) && n >= 0 ? n : d; };
  return {
    ...DEFAULT_TRAVEL_CFG,
    ...c,
    venueName: (c.venueName || '').trim() || DEFAULT_TRAVEL_CFG.venueName,
    routes: Array.isArray(c.routes) ? c.routes.filter(r => r && (r.from || r.to)) : [],
    landingBuffer: num(c.landingBuffer, DEFAULT_TRAVEL_CFG.landingBuffer),
    domesticReport: num(c.domesticReport, DEFAULT_TRAVEL_CFG.domesticReport),
    intlReport: num(c.intlReport, DEFAULT_TRAVEL_CFG.intlReport),
    peak: typeof c.peak === 'string' ? c.peak : DEFAULT_TRAVEL_CFG.peak,
  };
}

/* ── time helpers (handle crossing midnight) ── */
const pad = n => String(n).padStart(2, '0');
export const tMin = t => { if (!t) return 0; const [h, m] = String(t).split(':'); return (parseInt(h, 10) || 0) * 60 + (parseInt(m, 10) || 0); };
export function addDT(date, time, mins) {
  if (!date || !time) return null;
  const [y, mo, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y, mo - 1, d, 0, tMin(time) + mins));
  return { date: `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`, time: `${pad(dt.getUTCHours())}:${pad(dt.getUTCMinutes())}` };
}
export function inPeak(spec, time) {
  if (!time || !spec) return false;
  const t = tMin(time);
  return String(spec).split(',').some(part => {
    const m = part.trim().match(/^(\d{1,2}:\d{2})\s*[-–]\s*(\d{1,2}:\d{2})$/);
    if (!m) return false;
    const a = tMin(m[1]), b = tMin(m[2]);
    return a <= b ? (t >= a && t < b) : (t >= a || t < b);
  });
}
const fmtD = iso => { if (!iso) return ''; const [, m, d] = iso.split('-').map(Number); return `${d} ${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][m - 1]}`; };

/* ── place matching: "Mumbai T2" ≈ "Mumbai Airport T2", "Taj" ≈ "Taj Lands End" ── */
const tokens = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
const STOP = new Set(['the', 'and', 'of', 'at', 'to', 'airport', 'international', 'intl', 'domestic', 'terminal', 'hotel']);
export function samePlace(a, b) {
  const x = tokens(a), y = tokens(b);
  if (!x.length || !y.length) return false;
  if (x.join(' ') === y.join(' ')) return true;
  // Different terminals are different places
  const term = arr => arr.find(t => /^t\d$/.test(t));
  const tx = term(x), ty = term(y);
  if (tx && ty && tx !== ty) return false;
  const kx = x.filter(t => !STOP.has(t)), ky = y.filter(t => !STOP.has(t));
  if (!kx.length || !ky.length) return false;
  const [s, l] = kx.length <= ky.length ? [kx, ky] : [ky, kx];
  const hit = s.filter(t => l.includes(t)).length;
  if (hit === s.length) return true;
  // Airports are written many ways ("Mumbai (BOM) T2" / "Mumbai Airport T2"): with a matching
  // terminal, allow one unmatched word. Other places must match fully ("Jio World Centre" ≠ "Jio World Garden").
  return !!(tx && ty) && hit >= 2 && hit >= s.length - 1;
}

/* Minutes between two places, either direction; peak value when `time` falls in a peak window */
export function travelMin(cfg, a, b, time) {
  if (!a || !b) return null;
  if (samePlace(a, b)) return 0;
  const r = cfg.routes.find(x => (samePlace(x.from, a) && samePlace(x.to, b)) || (samePlace(x.from, b) && samePlace(x.to, a)));
  if (!r) return null;
  const n = parseInt(r.normal, 10), p = parseInt(r.peak, 10);
  if (Number.isFinite(p) && inPeak(cfg.peak, time)) return p;
  if (Number.isFinite(n)) return n;
  return Number.isFinite(p) ? p : null;
}

/* All place names known to the app — for the input suggestions */
export function knownPlaces(cfg, logistics = []) {
  const s = new Set([cfg.venueName]);
  cfg.routes.forEach(r => { if (r.from) s.add(r.from.trim()); if (r.to) s.add(r.to.trim()); });
  logistics.forEach(L => [L.hotelName, L.arrivalTo, L.departureFrom, L.carPickupFrom].forEach(v => { if (v && v.trim()) s.add(v.trim()); }));
  return [...s].filter(Boolean).sort((a, b) => a.localeCompare(b));
}

export const flightOn = L => L.flightReq !== 'not_required';
export const carIsTravel = L => !flightOn(L) && L.carReq !== 'not_required';   // guest comes by car
export const staysAtHotel = L => L.accomReq !== 'not_required' && !!(L.hotelName || '').trim();

/* Step-by-step travel plan for one guest. Every step: { key, date, time, label, src }.
   `missing` lists routes that need a travel time before a step can be worked out. */
export function travelPlan(L, cfg) {
  const steps = [], missing = [];
  const base = staysAtHotel(L) ? L.hotelName.trim() : cfg.venueName;
  const out = { steps, missing, base, carPickup: null, carDeparture: null };
  const push = (key, dt, label) => { if (dt && dt.date && dt.time) steps.push({ key, date: dt.date, time: dt.time, label }); };

  // ── Arrival
  if (flightOn(L) && L.arrivalFlightDate && L.arrivalFlightTime) {
    const ap = (L.arrivalTo || '').trim() || 'the airport';
    const no = (L.arrivalFlightNo || '').trim();
    push('land', { date: L.arrivalFlightDate, time: L.arrivalFlightTime }, `Flight ${no ? no + ' ' : ''}lands at ${ap}`);
    const ready = addDT(L.arrivalFlightDate, L.arrivalFlightTime, cfg.landingBuffer);
    push('pickup', ready, `Pickup from ${ap}`);
    out.carPickup = { ...ready, note: `lands ${L.arrivalFlightTime} + ${cfg.landingBuffer} min` };
    const m = travelMin(cfg, ap, base, ready.time);
    if (m === null) missing.push(`${ap} → ${base}`);
    else push('reach', addDT(ready.date, ready.time, m), `Arrive at ${base} (${m} min drive)`);
  } else if (carIsTravel(L) && L.carPickupDate && L.carPickupTime) {
    const from = (L.carPickupFrom || '').trim();
    push('pickup', { date: L.carPickupDate, time: L.carPickupTime }, `Car pickup${from ? ' from ' + from : ''}`);
    if (from) {
      const m = travelMin(cfg, from, base, L.carPickupTime);
      if (m === null) missing.push(`${from} → ${base}`);
      else push('reach', addDT(L.carPickupDate, L.carPickupTime, m), `Arrive at ${base} (${m} min drive)`);
    }
  }

  // ── Departure
  if (flightOn(L) && L.departureFlightDate && L.departureFlightTime) {
    const ap = (L.departureFrom || '').trim() || 'the airport';
    const no = (L.departureFlightNo || '').trim();
    const rep = L.departureIntl ? cfg.intlReport : cfg.domesticReport;
    const report = addDT(L.departureFlightDate, L.departureFlightTime, -rep);
    const m = travelMin(cfg, base, ap, report.time);
    if (m === null) missing.push(`${base} → ${ap}`);
    else {
      const leave = addDT(report.date, report.time, -m);
      push('leave', leave, `Leave ${base} for ${ap} (${m} min drive)`);
      out.carDeparture = { ...leave, note: `flight ${L.departureFlightTime} − ${rep} min reporting − ${m} min drive` };
    }
    push('report', report, `Report at ${ap} (${L.departureIntl ? 'international' : 'domestic'}, ${rep} min before)`);
    push('depart', { date: L.departureFlightDate, time: L.departureFlightTime }, `Flight ${no ? no + ' ' : ''}departs`);
  } else if (carIsTravel(L) && L.carDepartureDate && L.carDepartureTime) {
    push('depart', { date: L.carDepartureDate, time: L.carDepartureTime }, `Departure by car from ${base}`);
  }

  steps.sort((a, b) => a.date !== b.date ? (a.date > b.date ? 1 : -1) : tMin(a.time) - tMin(b.time));
  return out;
}

/* What the main Arrival / Departure should be, from the bookings. null = no booking yet. */
export function bookedMain(L, cfg) {
  const plan = travelPlan(L, cfg);
  let arr = null, dep = null;
  if (flightOn(L) && L.arrivalFlightDate) {
    arr = { date: L.arrivalFlightDate, time: L.arrivalFlightTime || '', location: (L.arrivalTo || '').trim(), source: 'flight', ref: (L.arrivalFlightNo || '').trim() };
  } else if (carIsTravel(L) && L.carPickupDate) {
    const reach = plan.steps.find(s => s.key === 'reach');
    arr = reach
      ? { date: reach.date, time: reach.time, location: plan.base, source: 'car', ref: '' }
      : { date: L.carPickupDate, time: L.carPickupTime || '', location: L.carPickupFrom ? `By car from ${L.carPickupFrom}` : 'By car', source: 'car', ref: '' };
  }
  if (flightOn(L) && L.departureFlightDate) {
    dep = { date: L.departureFlightDate, time: L.departureFlightTime || '', location: (L.departureFrom || '').trim(), source: 'flight', ref: (L.departureFlightNo || '').trim() };
  } else if (carIsTravel(L) && L.carDepartureDate) {
    dep = { date: L.carDepartureDate, time: L.carDepartureTime || '', location: plan.base, source: 'car', ref: '' };
  }
  return { arr, dep, plan };
}

/* Fields to write so the main Arrival / Departure follow the bookings.
   Respects manual overrides; remembers the planned dates the first time a booking takes over. */
export function syncPatch(L, cfg) {
  const { arr, dep } = bookedMain(L, cfg);
  const p = {};
  const side = (b, k) => {   // k = 'arrival' | 'departure'
    const K = k[0].toUpperCase() + k.slice(1);
    const src = L[`${k}Source`] || 'manual';
    if (L[`${k}Override`]) return;
    if (b) {
      if (src === 'manual' && L[`${k}Date`] && !L[`planned${K}Date`]) p[`planned${K}Date`] = L[`${k}Date`];
      p[`${k}Date`] = b.date; p[`${k}Time`] = b.time; p[`${k}Location`] = b.location; p[`${k}Source`] = b.source;
    } else if (src !== 'manual') {
      // Booking removed (or switched to Not required) → back to the planned date
      p[`${k}Source`] = 'manual';
      if (L[`planned${K}Date`]) p[`${k}Date`] = L[`planned${K}Date`];
    }
  };
  side(arr, 'arrival');
  side(dep, 'departure');
  // Keep only real changes
  Object.keys(p).forEach(key => { if ((L[key] ?? '') === p[key]) delete p[key]; });
  return p;
}
export const needsSync = (L, cfg) => Object.keys(syncPatch(L, cfg)).length > 0;

/* Things worth a second look (shown as ⚠ in Logistics) */
export function travelWarnings(L) {
  const w = [];
  const booked = k => (L[`${k}Source`] || 'manual') !== 'manual' && !L[`${k}Override`];
  if (booked('arrival') && L.plannedArrivalDate && L.arrivalDate && L.plannedArrivalDate !== L.arrivalDate)
    w.push({ key: 'arrival', text: `Planned arrival ${fmtD(L.plannedArrivalDate)}, booking says ${fmtD(L.arrivalDate)}`, accept: { plannedArrivalDate: L.arrivalDate } });
  if (booked('departure') && L.plannedDepartureDate && L.departureDate && L.plannedDepartureDate !== L.departureDate)
    w.push({ key: 'departure', text: `Planned departure ${fmtD(L.plannedDepartureDate)}, booking says ${fmtD(L.departureDate)}`, accept: { plannedDepartureDate: L.departureDate } });
  if (L.accomReq !== 'not_required' && L.hotelName) {
    if (L.checkinDate && L.arrivalDate && L.checkinDate !== L.arrivalDate)
      w.push({ key: 'checkin', text: `Hotel check-in ${fmtD(L.checkinDate)}, but arrives ${fmtD(L.arrivalDate)}` });
    if (L.checkoutDate && L.departureDate && L.checkoutDate !== L.departureDate)
      w.push({ key: 'checkout', text: `Hotel check-out ${fmtD(L.checkoutDate)}, but departs ${fmtD(L.departureDate)}` });
  }
  if (flightOn(L) && L.arrivalFlightDate && L.departureFlightDate && L.departureFlightDate < L.arrivalFlightDate)
    w.push({ key: 'order', text: 'Departure flight is before the arrival flight — check the dates' });
  return w;
}

export const sourceLabel = (L, k) => {
  const src = L[`${k}Source`] || 'manual';
  if (L[`${k}Override`]) return { t: 'Manual override', cls: 'manual' };
  if (src === 'flight') { const no = k === 'arrival' ? L.arrivalFlightNo : L.departureFlightNo; return { t: `✈ From flight${no ? ' ' + no : ''}`, cls: 'flight' }; }
  if (src === 'car') return { t: '🚗 From car', cls: 'car' };
  return { t: 'Planned', cls: 'planned' };
};

/* ── Ticket reading (AI) helpers ─────────────────────────────────── */

/* Group legs into journeys: a connection continues if the next leg leaves the same
   airport within 24 h of landing. Returns [{ legs, from, to, departDate, departTime, arriveDate, arriveTime, flightNo }] */
export function journeysFromLegs(legs = []) {
  const clean = legs.filter(l => l && (l.departDate || l.arriveDate))
    .sort((a, b) => `${a.departDate || a.arriveDate} ${a.departTime || ''}` > `${b.departDate || b.arriveDate} ${b.departTime || ''}` ? 1 : -1);
  const out = [];
  const place = p => [p?.city, p?.code ? `(${p.code})` : '', p?.terminal ? `T${String(p.terminal).replace(/^t/i, '')}` : ''].filter(Boolean).join(' ').trim();
  clean.forEach(l => {
    const cur = out[out.length - 1];
    const prev = cur?.legs[cur.legs.length - 1];
    const gap = prev && prev.arriveDate && l.departDate
      ? (Date.parse(`${l.departDate}T${l.departTime || '00:00'}`) - Date.parse(`${prev.arriveDate}T${prev.arriveTime || '00:00'}`)) / 60000 : null;
    const sameAirport = prev && (prev.to?.code && l.from?.code ? prev.to.code === l.from.code : true);
    if (cur && gap !== null && gap >= 0 && gap <= 24 * 60 && sameAirport) cur.legs.push(l);
    else out.push({ legs: [l] });
  });
  return out.map(j => {
    const a = j.legs[0], z = j.legs[j.legs.length - 1];
    return {
      legs: j.legs,
      from: place(a.from), to: place(z.to),
      departDate: a.departDate || '', departTime: a.departTime || '',
      arriveDate: z.arriveDate || '', arriveTime: z.arriveTime || '',
      flightNo: j.legs.map(l => l.flightNo).filter(Boolean).join(' + '),
    };
  });
}

/* Does any passenger on the ticket look like this guest? (shares a name word, ignoring titles) */
const TITLES = new Set(['mr', 'mrs', 'ms', 'miss', 'dr', 'prof', 'shri', 'smt', 'sri', 'ji', 'mstr', 'master', 'adult', 'child']);
export function passengerMatches(passengers = [], guestName = '') {
  const g = tokens(guestName).filter(t => !TITLES.has(t) && t.length > 1);
  if (!g.length || !passengers.length) return null;   // can't tell
  return passengers.some(p => tokens(p).filter(t => !TITLES.has(t) && t.length > 1).some(t => g.includes(t)));
}
