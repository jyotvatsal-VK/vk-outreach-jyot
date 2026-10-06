import { logAction } from "./activity";
import { applyContactFilter } from './contactFilter';
import { useEffect, useState } from 'react';
import { db } from './firebase';
import {
  collection, doc, onSnapshot, setDoc, deleteDoc, updateDoc,
  writeBatch, serverTimestamp, getDoc, getDocs, query, where, Timestamp,
} from 'firebase/firestore';

export const COLLECTIONS = [
  'events', 'contacts', 'logistics', 'sessions', 'assignments',
  'founder', 'volunteers', 'poc', 'departments', 'tasks', 'felicitation',
  'checklist', 'contact_notes', 'activity_log',
  'personalisedSchedule', 'personalisedMandatory',
  'availability', 'sahebjiSlots', 'appConfig', 'trash',
  'carVendors', 'minuteItems',
];

/* Collections whose rows carry an eventId and belong to one event */
export const EVENT_SCOPED = [
  'contacts', 'logistics', 'sessions', 'assignments', 'founder', 'poc', 'tasks',
  'felicitation', 'checklist', 'contact_notes', 'personalisedSchedule',
  'personalisedMandatory', 'availability', 'sahebjiSlots', 'minuteItems',
];

/* Audit context — set once by AuthProvider so every write is logged,
   even when the caller doesn't pass a user context. */
let auditCtx = null;
export function setAuditContext(user, profile) { auditCtx = user ? { user, profile } : null; }
const NO_LOG = new Set(['trash', 'activity_log']);

export const FOUNDER_STRING =
  "One on One Meeting with His Holiness Spiritual Sovereign Jainacharya Yugbhushan Suri, 79th Successor to Tirthankar Shri Mahavir Swami at VIP Lounge";

/* Active event
   - app_state/activeEvent  = org-wide DEFAULT (only Master / settings.config can change it)
   - users/{uid}.activeEventId = each person's own selection (switching no longer affects others) */
export async function setMyActiveEventId(uid, eventId) {
  if (!db || !uid) return;
  await updateDoc(doc(db, 'users', uid), { activeEventId: eventId || null });
}

export async function getActiveEventId() {
  try {
    const snap = await getDoc(doc(db, 'app_state', 'activeEvent'));
    return snap.exists() ? snap.data().eventId : null;
  } catch { return null; }
}
export async function setActiveEventId(eventId) {
  // Sets the org-wide default. Rules allow this only for Master / settings.config.
  await setDoc(doc(db, 'app_state', 'activeEvent'), { eventId }, { merge: true });
}

/* Live subscription to every collection + the active-event pointer */
export function useLiveData() {
  const [data, setData] = useState(() =>
    Object.fromEntries(COLLECTIONS.map((c) => [c, null]))
  );
  const [activeEventId, setActiveEventIdState] = useState(null);

  useEffect(() => {
    if (!db) { setData(Object.fromEntries(COLLECTIONS.map((c) => [c, []]))); return; }
    // subscribe to app_state/activeEvent
    const unsubActive = onSnapshot(doc(db, 'app_state', 'activeEvent'), (snap) => {
      setActiveEventIdState(snap.exists() ? snap.data().eventId : null);
    }, () => {});

    const unsubs = COLLECTIONS.map((name) =>
      onSnapshot(collection(db, name), (snap) => {
        const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        setData((prev) => ({ ...prev, [name]: rows }));
      }, (err) => {
        // Permission denied (or offline failure) must not leave the app stuck on "Connecting…"
        console.warn('snapshot error', name, err?.code || err);
        setData((prev) => ({ ...prev, [name]: prev[name] || [] }));
      })
    );
    return () => { unsubActive(); unsubs.forEach((u) => u()); };
  }, []);

  return { ...data, defaultEventId: activeEventId };
}

/* Filter store collections to the active event, and optionally apply a contact filter */
export function scopedStore(store, eventId, contactFilter) {
  if (!eventId) return store;
  const scoped = (col) => (store[col] || []).filter((r) => r.eventId === eventId);
  const scopedContacts = scoped('contacts');
  const filteredContacts = contactFilter ? applyContactFilter(scopedContacts, contactFilter) : scopedContacts;
  return {
    ...store,
    contacts: filteredContacts,
    logistics: scoped('logistics'),
    sessions: scoped('sessions'),
    assignments: scoped('assignments'),
    founder: scoped('founder'),
    poc: scoped('poc'),
    tasks: scoped('tasks'),
    felicitation: scoped('felicitation'),
    checklist: scoped('checklist'),
    contact_notes: scoped('contact_notes'),
    activity_log: store.activity_log || [],  // global, not scoped by event
    // volunteers and departments are shared across events
    volunteers: store.volunteers || [],
    departments: store.departments || [],
    // these are event-scoped but keyed differently
    personalisedSchedule: scoped('personalisedSchedule'),
    personalisedMandatory: scoped('personalisedMandatory'),
    availability: (store.availability || []).filter(r => r.eventId === eventId || r.day === 'depts' || r.day === 'pre-event'),
    sahebjiSlots: scoped('sahebjiSlots'),
    appConfig: store.appConfig || [],
    trash: store.trash || [],
    carVendors: store.carVendors || [],          // shared across events
    minuteItems: scoped('minuteItems'),
  };
}

/* writes */
export async function saveItem(name, item, userCtx) {
  if (!db) return null;
  const id = item.id || crypto.randomUUID();
  const { id: _omit, ...rest } = item;
  await setDoc(doc(db, name, id), { ...rest, _updated: serverTimestamp() }, { merge: true });
  const ctx = userCtx || auditCtx;
  if (ctx && !NO_LOG.has(name)) logAction(ctx.user, ctx.profile, (item.id ? "Updated " : "Added ") + name, item.name || item.title || id);
  return id;
}
export async function removeItem(name, id, userCtx) {
  if (!db) return;
  await deleteDoc(doc(db, name, id));
  const ctx = userCtx || auditCtx;
  if (ctx && !NO_LOG.has(name)) logAction(ctx.user, ctx.profile, "Deleted " + name, id);
}
export async function batchUpsert(name, items) {
  for (let i = 0; i < items.length; i += 450) {
    const batch = writeBatch(db);
    items.slice(i, i + 450).forEach((it) => {
      const id = it.id || crypto.randomUUID();
      const { id: _o, ...rest } = it;
      batch.set(doc(db, name, id), { ...rest, _updated: serverTimestamp() }, { merge: true });
    });
    await batch.commit();
  }
  if (auditCtx && items.length) logAction(auditCtx.user, auditCtx.profile, 'Bulk saved ' + name, items.length + ' rows');
}

/* Soft-delete an entire event: every event-scoped record goes to trash under one
   bundleId (restorable together for 30 days), then originals are removed.
   Done in batches so it is fast and never half-finished per chunk. */
export async function softDeleteEvent(ev, deletedBy = '') {
  if (!db || !ev?.id) return 0;
  const now = Date.now();
  const bundleId = `event_${ev.id}_${now}`;
  const expiresAt = now + 30 * 24 * 60 * 60 * 1000;
  const rows = [];
  for (const col of EVENT_SCOPED) {
    const snap = await getDocs(query(collection(db, col), where('eventId', '==', ev.id)));
    snap.docs.forEach((d) => rows.push({ col, id: d.id, data: { id: d.id, ...d.data() } }));
  }
  rows.push({ col: 'events', id: ev.id, data: ev, head: true });

  const trashDoc = (r) => ({
    originalCollection: r.col, originalId: r.id, data: r.data, linked: [],
    bundleId, bundleLabel: ev.name || ev.id, bundleHead: !!r.head,
    bundleCount: r.head ? rows.length - 1 : undefined,
    deletedAt: now, expiresAt, expireAt: Timestamp.fromMillis(expiresAt), deletedBy,
  });
  // 2 ops per record (trash write + delete) → 200 records per batch stays under the 500 limit
  for (let i = 0; i < rows.length; i += 200) {
    const batch = writeBatch(db);
    rows.slice(i, i + 200).forEach((r) => {
      const t = trashDoc(r);
      if (t.bundleCount === undefined) delete t.bundleCount;
      batch.set(doc(db, 'trash', `trash_${r.col}_${r.id}_${now}`), t);
      batch.delete(doc(db, r.col, r.id));
    });
    await batch.commit();
  }
  if (auditCtx) logAction(auditCtx.user, auditCtx.profile, 'Deleted event', `${ev.name} (${rows.length - 1} records to trash)`);
  return rows.length - 1;
}

/* seed — now everything gets an eventId */
export async function seedSampleData(eventId) {
  const eid = eventId || 'evt_vk4';
  const event = [{ id: eid, name: 'VK 4.0', type: 'Conclave', startDate: '2026-01-16', endDate: '2026-01-22', venue: 'Mumbai', status: 'Active', parentId: '' }];
  const contacts = [
    { id: 'c1', eventId: eid, name: 'Ajai Kumar Singh', honor: 'Lieutenant General', suffix: 'Ji', desig: 'Former Army Commander, Southern Command', org: 'Indian Army (Retd.)', field: 'Geopolitics', phone: '+91 98xxx xxxxx', email: '', liaisonName: 'Col. Verma (ADC)', liaisonPhone: '', status: 'Confirmed', type: 'VIP', remark: 'Keynote on multilateral institutions.', last: '2025-12-22' },
    { id: 'c2', eventId: eid, name: 'Amit Desai', honor: '', suffix: 'Ji', desig: 'Senior Advocate', org: 'Bombay High Court', field: 'Legal', phone: '+91 98xxx xxxxx', email: '', liaisonName: 'Ms. Shah', liaisonPhone: '', status: 'Confirmed', type: 'Panelist', remark: 'Day visitor.', last: '2025-12-20' },
    { id: 'c3', eventId: eid, name: 'Vijay Chauthaiwale', honor: 'Dr.', suffix: 'Ji', desig: 'In-charge, Foreign Affairs', org: 'BJP', field: 'Geopolitics', phone: '+91 98xxx xxxxx', email: '', liaisonName: '', liaisonPhone: '', status: 'Confirmed', type: 'VIP', remark: 'Logistics pending.', last: '2025-12-24' },
    { id: 'c4', eventId: eid, name: 'Prashant Sharma', honor: '', suffix: 'Ji', desig: 'Economist', org: 'Policy Research Institute', field: 'Economics', phone: '+91 98xxx xxxxx', email: '', liaisonName: 'Mr. Nair', liaisonPhone: '', status: 'Pending', type: 'Panelist', remark: 'Follow up.', last: '2025-12-12' },
  ];
  const logistics = [
    { id: 'c1_l', eventId: eid, contactId: 'c1', arrivalMode: 'Flight', arrivalDate: '2026-01-18', arrivalTime: '12:20', arrivalLocation: 'Mumbai Airport', hotelName: 'Taj President, IHCL', checkinTime: '13:30', departureDate: '2026-01-20', departureTime: '07:00', departureFlightTime: '09:30', remarks: 'Vegetarian (Jain).' },
    { id: 'c2_l', eventId: eid, contactId: 'c2', arrivalMode: 'Car', arrivalDate: '2026-01-18', arrivalTime: '09:10', arrivalLocation: 'Venue', hotelName: '', checkinTime: '', departureDate: '2026-01-18', departureTime: '12:15', remarks: 'Day visitor.' },
  ];
  const sessions = [
    { id: 's10', eventId: eid, date: '2026-01-17', start: '09:00', end: '21:00', title: 'Exhibition', topic: '', type: 'Exhibition' },
    { id: 's12', eventId: eid, date: '2026-01-17', start: '10:00', end: '12:45', title: 'Legal Round Table Deliberation', topic: 'Constitutional Jurisprudence', type: 'Panel' },
    { id: 's22', eventId: eid, date: '2026-01-18', start: '10:45', end: '13:30', title: 'Legal Round Table Deliberation', topic: 'Fundamental Rights', type: 'Panel' },
    { id: 's32', eventId: eid, date: '2026-01-19', start: '09:15', end: '12:00', title: 'Geopolitical Round Table Deliberation', topic: 'Principles of Ancient Rajneeti', type: 'Panel' },
    { id: 's41', eventId: eid, date: '2026-01-20', start: '14:00', end: '16:00', title: 'Geopolitical Round Table Deliberation', topic: 'Multilateral Institutions', type: 'Panel' },
    { id: 's60', eventId: eid, date: '2026-01-22', start: '19:00', end: '', title: 'Closing Ceremony', topic: '', type: 'Ceremony' },
  ];
  const assignments = [
    { id: 'a1', eventId: eid, contactId: 'c1', sessionId: 's32', role: 'Panelist' },
    { id: 'a2', eventId: eid, contactId: 'c2', sessionId: 's22', role: 'Panelist' },
    { id: 'a3', eventId: eid, contactId: 'c3', sessionId: 's41', role: 'Panelist' },
  ];
  const founder = [
    { id: 'f_c1', eventId: eid, contactId: 'c1', date: '2026-01-18', time: '20:30', venue: 'VIP Lounge', notes: '' },
    { id: 'f_c2', eventId: eid, contactId: 'c2', date: '2026-01-18', time: '09:15', venue: 'VIP Lounge', notes: '' },
  ];
  const volunteers = [
    { id: 'v1', name: 'Jinalben Mehta', phone: '98xxx', city: 'Mumbai', skills: 'POC, Accounts' },
    { id: 'v2', name: 'Tejasbhai Shah', phone: '98xxx', city: 'Mumbai', skills: 'POC, Hospitality' },
    { id: 'v3', name: 'Jigar', phone: '98xxx', city: 'Mumbai', skills: 'POC, 1:1 Coordination' },
    { id: 'v4', name: 'Manish Daga', phone: '98xxx', city: 'Mumbai', skills: 'Logistics' },
  ];
  const poc = [
    { id: 'p1', eventId: eid, volunteerId: 'v2', contactId: 'c1', day: '2026-01-18', shift: 'Full day', status: 'Active' },
    { id: 'p2', eventId: eid, volunteerId: 'v1', contactId: 'c1', day: '2026-01-19', shift: 'Full day', status: 'Active' },
  ];
  const departments = [
    { id: 'd1', name: 'Delegate Outreach', desc: 'Invite experts and chase confirmations', hodIds: ['v1'] },
    { id: 'd2', name: 'Logistics', desc: 'Travel and accommodation', hodIds: ['v4'] },
    { id: 'd3', name: 'Scheduling', desc: 'Event, founder and panelist schedules', hodIds: ['v3'] },
  ];
  const tasks = [
    { id: 't1', eventId: eid, deptId: 'd3', title: 'Finalise photo & video plan', status: 'In Progress', assigneeId: 'v3', due: '2026-01-10', connected: ['d1'], notes: '' },
    { id: 't2', eventId: eid, deptId: 'd1', title: 'Follow up with pending economists', status: 'Open', assigneeId: 'v1', due: '2026-01-05', connected: [], notes: '' },
  ];
  const all = { events: event, contacts, logistics, sessions, assignments, founder, volunteers, poc, departments, tasks };
  for (const [name, rows] of Object.entries(all)) await batchUpsert(name, rows);
  if (auditCtx?.user?.uid) await setMyActiveEventId(auditCtx.user.uid, eid);
  try { await setActiveEventId(eid); } catch { /* only Master / settings.config may set the org default */ }
}
