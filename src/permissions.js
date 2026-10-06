// ============================================================
// JYOT Permission System
// Every action key: 'module.action'
// Master always has all permissions regardless.
// All other users are LOCKED OUT by default —
// only explicitly granted permissions are allowed.
// ============================================================

export const PERMISSION_GROUPS = [
  {
    module: 'outreach',
    label: 'Outreach',
    icon: '👥',
    actions: [
      { key: 'outreach.view',        label: 'View contacts' },
      { key: 'outreach.add',         label: 'Add contact' },
      { key: 'outreach.edit',        label: 'Edit contact details' },
      { key: 'outreach.status',      label: 'Change contact status' },
      { key: 'outreach.delete',      label: 'Delete contact' },
      { key: 'outreach.import',      label: 'Import / bulk actions' },
      { key: 'outreach.whatsapp',    label: 'Send WhatsApp messages' },
    ],
  },
  {
    module: 'logistics',
    label: 'Logistics',
    icon: '✈️',
    actions: [
      { key: 'logistics.view',       label: 'View logistics' },
      { key: 'logistics.edit',       label: 'Edit arrival/departure details' },
      { key: 'logistics.flight',     label: 'Fill Flight form' },
      { key: 'logistics.car',        label: 'Fill Car form' },
      { key: 'logistics.accom',      label: 'Fill Accommodation form' },
      { key: 'logistics.poc',        label: 'Assign Overall POC' },
    ],
  },
  {
    module: 'schedule',
    label: 'Scheduling',
    icon: '📅',
    actions: [
      { key: 'schedule.view',        label: 'View sessions' },
      { key: 'schedule.edit',        label: 'Add / edit / delete sessions' },
      { key: 'schedule.minutemin',   label: 'Edit minute-to-minute' },
      { key: 'schedule.sahebji',     label: 'Edit Sahebji meetings' },
    ],
  },
  {
    module: 'reports',
    label: 'Personalised Schedule',
    icon: '📋',
    actions: [
      { key: 'reports.view',         label: 'View schedules' },
      { key: 'reports.edit',         label: 'Edit schedule rows' },
      { key: 'reports.poc',          label: 'Tick POC Required' },
      { key: 'reports.print',        label: 'Generate / print VK schedule' },
      { key: 'reports.mandatory',    label: 'Set mandatory fields' },
    ],
  },
  {
    module: 'pocallocation',
    label: 'POC Allocation',
    icon: '🔗',
    actions: [
      { key: 'poc.view',             label: 'View POC allocation' },
      { key: 'poc.assign',           label: 'Assign volunteers to panelists' },
      { key: 'poc.freeze',           label: 'Freeze / unfreeze assignments' },
    ],
  },
  {
    module: 'people',
    label: 'Volunteers & POC',
    icon: '🙋',
    actions: [
      { key: 'people.view',          label: 'View volunteers' },
      { key: 'people.add',           label: 'Add volunteer' },
      { key: 'people.edit',          label: 'Edit volunteer details' },
      { key: 'people.delete',        label: 'Delete volunteer' },
    ],
  },
  {
    module: 'availability',
    label: 'Volunteer Availability',
    icon: '📆',
    actions: [
      { key: 'availability.view',    label: 'View availability' },
      { key: 'availability.edit',    label: 'Edit availability' },
    ],
  },
  {
    module: 'depts',
    label: 'Departments & Tasks',
    icon: '🏢',
    actions: [
      { key: 'depts.view',           label: 'View tasks' },
      { key: 'depts.add',            label: 'Add / edit tasks' },
      { key: 'depts.complete',       label: 'Mark tasks complete' },
      { key: 'depts.signoff',        label: 'HOD sign-off' },
      { key: 'depts.delete',         label: 'Delete tasks' },
    ],
  },
  {
    module: 'checklist',
    label: 'Event Checklist',
    icon: '✅',
    actions: [
      { key: 'checklist.view',       label: 'View checklist' },
      { key: 'checklist.edit',       label: 'Add / tick / edit checklist items' },
    ],
  },
  {
    module: 'settings',
    label: 'Settings',
    icon: '⚙️',
    actions: [
      { key: 'settings.users',       label: 'Manage users & permissions' },
      { key: 'settings.config',      label: 'Edit configurations' },
    ],
  },
];

// Check if a user has a specific permission
// Master always returns true. All others locked out by default.
export function hasPermission(profile, key) {
  if (!profile) return false;
  if (profile.role === 'Master') return true;
  const perms = profile.permissions || {};
  return perms[key] === true;
}

// Check multiple permissions — returns true if user has ANY of them
export function hasAnyPermission(profile, keys) {
  return keys.some(k => hasPermission(profile, k));
}
