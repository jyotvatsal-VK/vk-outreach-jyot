/* ── Trash / Soft-Delete Utilities ────────────────────────────────
   30-day soft delete. Records move to 'trash' collection.
   Bundled deletes keep all linked records together.
   `expireAt` (Firestore Timestamp) lets a TTL policy auto-purge expired
   items server-side; `expiresAt` (ms) is kept for the UI and old records.
   ──────────────────────────────────────────────────────────────── */

import { db } from './firebase';
import { doc, writeBatch, Timestamp } from 'firebase/firestore';
import { saveItem, removeItem } from './data';

const DAYS_30 = 30 * 24 * 60 * 60 * 1000;

/* Move a single record (or bundle) to trash */
export async function trashItem(collection, item, linkedItems = [], userEmail = '') {
  const now = Date.now();
  const trashId = `trash_${collection}_${item.id}_${now}`;
  await saveItem('trash', {
    id: trashId,
    originalCollection: collection,
    originalId: item.id,
    data: item,
    linked: linkedItems, // [{ collection, data }]
    deletedAt: now,
    expiresAt: now + DAYS_30,
    expireAt: Timestamp.fromMillis(now + DAYS_30),
    deletedBy: userEmail,
  });
}

/* Permanently delete a trash record */
export async function purgeTrashItem(trashId) {
  await removeItem('trash', trashId);
}

/* Restore a trash record back to its original collection */
export async function restoreTrashItem(trashRecord, overridePOC = false) {
  const { originalCollection, data, linked = [] } = trashRecord;

  // Restore main record
  await saveItem(originalCollection, data);

  // Restore linked records
  for (const l of linked) {
    // Skip POC if overridePOC is false and there's a conflict
    if (l.collection === 'poc' && !overridePOC) continue;
    await saveItem(l.collection, l.data);
  }

  // Remove from trash
  await removeItem('trash', trashRecord.id);
}

/* Restore a whole bundle (e.g. a deleted event and everything in it) */
export async function restoreTrashBundle(bundleRecords) {
  for (let i = 0; i < bundleRecords.length; i += 200) {
    const batch = writeBatch(db);
    bundleRecords.slice(i, i + 200).forEach((t) => {
      const { id, ...rest } = t.data || {};
      batch.set(doc(db, t.originalCollection, t.originalId || id), rest, { merge: true });
      batch.delete(doc(db, 'trash', t.id));
    });
    await batch.commit();
  }
}

/* Permanently delete a whole bundle */
export async function purgeTrashBundle(bundleRecords) {
  for (let i = 0; i < bundleRecords.length; i += 450) {
    const batch = writeBatch(db);
    bundleRecords.slice(i, i + 450).forEach((t) => batch.delete(doc(db, 'trash', t.id)));
    await batch.commit();
  }
}

/* Clean up expired trash items (fallback for when no TTL policy is configured) */
export async function purgeExpiredTrash(trashItems) {
  const now = Date.now();
  const expired = trashItems.filter(t => t.expiresAt && t.expiresAt < now);
  for (let i = 0; i < expired.length; i += 450) {
    const batch = writeBatch(db);
    expired.slice(i, i + 450).forEach((t) => batch.delete(doc(db, 'trash', t.id)));
    await batch.commit();
  }
  return expired.length;
}
