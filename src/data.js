import { logAction } from "./activity";
import { useEffect, useState } from 'react';
import { db } from './firebase';
import {
  collection, doc, onSnapshot, setDoc, deleteDoc,
  writeBatch, serverTimestamp, getDoc,
} from 'firebase/firestore';

export const COLLECTIONS = [
  'events', 'contacts', 'logistics', 'sessions', 'assignments',
  'founder', 'volunteers', 'poc', 'departments', 'tasks', 'felicitation',
  'checklist', 'contact_notes', 'activity_log',
];

export const FOUNDER_STRING =
  "One on One Meeting with His Holiness Spiritual Sovereign Jainacharya Yugbhushan Suri, 79th Successor to Tirthankar Shri Mahavir Swami at VIP Lounge";

/* Active-event pointer stored in Firestore so all users share the same selection */
const ACTIVE_DOC = 'app_state/activeEvent';

export async function getActiveEventId() {
  try {
    const snap = await getDoc(doc(db, 'app_state', 'activeEvent'));
    return snap.exists() ? snap.data().eventId : null;
  } catch { return null; }
}
export async function setActiveEventId(eventId) {
  await setDoc(doc(db, 'app_state', 'activeEvent'), { eventId }, { merge: true });
}

/* Live subscription to every collection + the active-event pointer */
export function useLiveData() {
  const [data, setData] = useState(() =>
    Object.fromEntries(COLLECTIONS.map((c) => [c, null]))
  );
  const [activeEventId, setActiveEventIdState] = useState(null);

  useEffect(() => {
    if (!db) { setReady && setReady(true); return; }
    // subscribe to app_state/activeEvent
    const unsubActive = onSnapshot(doc(db, 'app_state', 'activeEvent'), (snap) => {
      setActiveEventIdState(snap.exists() ? snap.data().eventId : null);
    }, () => {});

    const unsubs = COLLECTIONS.map((name) =>
      onSnapshot(collection(db, name), (snap) => {
        const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        setData((prev) => ({ ...prev, [name]: rows }));
      }, (err) => console.error('snapshot error', name, err))
    );
    return () => { unsubActive(); unsubs.forEach((u) => u()); };
  }, []);

  return { ...data, activeEventId };
}

/* Filter store collections to the active event */
export function scopedStore(store, eventId) {
  if (!eventId) return store;
  const scoped = (col) => (store[col] || []).filter((r) => r.eventId === eventId);
  return {
    ...store,
    contacts: scoped('contacts'),
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
  };
}

/* writes */
export async function saveItem(name, item, userCtx) {
  if (!db) return null;
  const id = item.id || crypto.randomUUID();
  const { id: _omit, ...rest } = item;
  await setDoc(doc(db, name, id), { ...rest, _updated: serverTimestamp() }, { merge: true });
  if (userCtx) logAction(userCtx.user, userCtx.profile, (item.id ? "Updated " : "Added ") + name, item.name || item.title || id);
  return id;
}
export async function removeItem(name, id, userCtx) {
  if (!db) return;
  await deleteDoc(doc(db, name, id));
  if (userCtx) logAction(userCtx.user, userCtx.profile, "Deleted " + name, id);
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
    { id: 'c1_l', eventId: eid, contactId: 'c1', inbMode: 'Flight', inbDate: '2026-01-18', inbTime: '12:20', inbLoc: 'Mumbai Airport', hotel: 'Taj President, IHCL', checkin: '13:30', outDate: '2026-01-20', outDepart: '07:00', outFlight: '09:30', special: 'Vegetarian (Jain).' },
    { id: 'c2_l', eventId: eid, contactId: 'c2', inbMode: 'Car', inbDate: '2026-01-18', inbTime: '09:10', inbLoc: 'Venue', hotel: '', checkin: '', outDate: '2026-01-18', outDepart: '12:15', outFlight: '', special: 'Day visitor.' },
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
  await setActiveEventId(eid);
}
