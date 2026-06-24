import { db } from './firebase';
import { collection, addDoc, serverTimestamp, query, orderBy, limit, onSnapshot } from 'firebase/firestore';
import { useEffect, useState } from 'react';

/* Log an action to Firestore activity_log */
export async function logAction(user, profile, action, detail = '') {
  try {
    if (!db) return;
    await addDoc(collection(db, 'activity_log'), {
      uid: user?.uid || '',
      email: user?.email || '',
      role: profile?.role || '',
      action,  // e.g. 'Added contact', 'Deleted session', 'Approved user'
      detail,  // e.g. contact name, session title
      deviceLabel: profile?.deviceLabel || '',
      ts: serverTimestamp(),
    });
  } catch (e) { /* never block the main action */ }
}

/* Live subscription to recent activity */
export function useActivityLog(n = 100) {
  const [log, setLog] = useState([]);
  useEffect(() => {
    if (!db) return;
    const q = query(collection(db, 'activity_log'), orderBy('ts', 'desc'), limit(n));
    return onSnapshot(q, snap => setLog(snap.docs.map(d => ({ id: d.id, ...d.data() }))), () => {});
  }, [n]);
  return log;
}
