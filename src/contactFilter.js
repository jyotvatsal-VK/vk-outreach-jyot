/**
 * Contact-level access control.
 *
 * Each user can have a `contactFilter` object on their Firestore profile:
 * {
 *   fields:   ['Geopolitics', 'Legal'],   // match contact.field
 *   pocNames: ['Jinalben', 'Tejas'],       // match contact.liaisonName (contains)
 *   types:    ['VIP', 'Panelist'],         // match contact.type
 *   statuses: ['Confirmed', 'Pending'],    // match contact.status
 *   tags:     ['Priority', 'Bangalore'],   // match contact.tags (array)
 * }
 *
 * Empty array or missing key = no restriction on that dimension.
 * All active dimensions are AND-ed (contact must pass every active filter).
 */

/** Apply a contactFilter to a list of contacts. Returns filtered list. */
export function applyContactFilter(contacts, filterObj) {
  if (!filterObj) return contacts;
  const { fields, pocNames, types, statuses, tags } = filterObj;

  return contacts.filter(c => {
    if (fields?.length) {
      if (!fields.some(f => (c.field||'').toLowerCase().includes(f.toLowerCase()))) return false;
    }
    if (pocNames?.length) {
      if (!pocNames.some(p => (c.liaisonName||'').toLowerCase().includes(p.toLowerCase()))) return false;
    }
    if (types?.length) {
      if (!types.includes(c.type)) return false;
    }
    if (statuses?.length) {
      if (!statuses.includes(c.status)) return false;
    }
    if (tags?.length) {
      const cTags = c.tags || [];
      if (!tags.some(t => cTags.includes(t))) return false;
    }
    return true;
  });
}

/** Check if a filter object has any active restrictions */
export function hasActiveFilter(filterObj) {
  if (!filterObj) return false;
  return ['fields','pocNames','types','statuses','tags'].some(
    k => filterObj[k]?.length > 0
  );
}

/** Human-readable summary of what the filter does */
export function filterSummary(filterObj) {
  if (!hasActiveFilter(filterObj)) return 'No filter — sees all contacts';
  const parts = [];
  if (filterObj.fields?.length)   parts.push(`Field: ${filterObj.fields.join(', ')}`);
  if (filterObj.pocNames?.length) parts.push(`POC: ${filterObj.pocNames.join(', ')}`);
  if (filterObj.types?.length)    parts.push(`Type: ${filterObj.types.join(', ')}`);
  if (filterObj.statuses?.length) parts.push(`Status: ${filterObj.statuses.join(', ')}`);
  if (filterObj.tags?.length)     parts.push(`Tag: ${filterObj.tags.join(', ')}`);
  return parts.join(' · ');
}
