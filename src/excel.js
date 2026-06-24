import * as XLSX from 'xlsx';

/* ---- shared header matcher ---- */
const CONTACT_MAP = [
  { keys: ['name of delegate','delegate name','name','full name','delegate','guest name','guest'], field:'name' },
  { keys: ['honorific','title prefix','salutation','prefix'], field:'honor' },
  { keys: ['designation','title','role','position'], field:'desig' },
  { keys: ['organisation','organization','org','company','institution','affiliation'], field:'org' },
  { keys: ['field','expertise','domain','sector','advisory member domain','area'], field:'field' },
  { keys: ['address'], field:'address' },
  { keys: ['contact no','contact number','contact details','contact','phone','mobile','number','cell','whatsapp'], field:'phone' },
  { keys: ['email','e-mail','mail','email id'], field:'email' },
  { keys: ['poc name','poc','liaison','assistant','secretary','point of contact','spoc'], field:'liaisonName' },
  { keys: ['poc phone','poc number','liaison phone','assistant phone'], field:'liaisonPhone' },
  { keys: ['category','type','delegate type','guest type'], field:'type' },
  { keys: ['confirmation','confirmed','status','attending'], field:'status' },
  { keys: ['remark','remarks','notes','note','comment','comments','action category','bangalore meeting','one on one'], field:'remark' },
];
const SESSION_MAP = [
  { keys: ['title','session','session title','name'], field:'title' },
  { keys: ['topic','subject','theme'], field:'topic' },
  { keys: ['date','session date'], field:'date' },
  { keys: ['start','start time','from','time'], field:'start' },
  { keys: ['end','end time','to'], field:'end' },
  { keys: ['type','session type','category'], field:'type' },
  { keys: ['venue','location','place'], field:'venue' },
];
const VOLUNTEER_MAP = [
  { keys: ['name','full name','volunteer name'], field:'name' },
  { keys: ['phone','mobile','contact','number'], field:'phone' },
  { keys: ['city','location','area'], field:'city' },
  { keys: ['skills','skill','expertise','department'], field:'skills' },
  { keys: ['pre event','pre-event','before event','available before'], field:'preEvent' },
  { keys: ['event days','event dates','available days'], field:'eventDays' },
  { keys: ['time','availability','time slot','shift'], field:'timeSlot' },
];
const TASK_MAP = [
  { keys: ['task','title','task title','name','description'], field:'title' },
  { keys: ['department','dept'], field:'deptName' },
  { keys: ['owner','assigned to','assignee','volunteer'], field:'assigneeName' },
  { keys: ['due','due date','deadline'], field:'due' },
  { keys: ['status','state'], field:'status' },
  { keys: ['notes','remarks','comment'], field:'notes' },
];

const norm = s => String(s||'').trim().toLowerCase().replace(/\s+/g,' ');
function fieldFor(header, map) {
  const h = norm(header);
  for (const m of map) if (m.keys.some(k=>h===k)) return m.field;
  for (const m of map) if (m.keys.some(k=>h.includes(k)||k.includes(h))) return m.field;
  return null;
}

/* find header row even if there are blank/logo rows at top */
function findHeaderRow(raw, map) {
  for (let i=0; i<Math.min(raw.length,15); i++) {
    const cells = raw[i].map(c=>norm(String(c)));
    if (cells.filter(c=>fieldFor(c,map)!==null).length >= 2) return i;
  }
  return 0;
}

async function parseFile(file, map, requiredField) {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, {type:'array'});
  const ws = wb.Sheets[wb.SheetNames[0]];
  const raw = XLSX.utils.sheet_to_json(ws, {header:1, defval:''});
  const headerIdx = findHeaderRow(raw, map);
  const rows = XLSX.utils.sheet_to_json(ws, {defval:'', range:headerIdx});
  if (!rows.length) return {items:[], unmapped:[]};
  const headers = Object.keys(rows[0]);
  const mapping = {}; const unmapped = [];
  headers.forEach(h => {
    if (norm(h).match(/^(sr\.?|s\.no|sr no|serial|#|sl\.?)/)) return;
    const f = fieldFor(h, map);
    if (f) mapping[h]=f; else unmapped.push(h);
  });
  const items = rows.map(r => {
    const o = {};
    for (const [h,f] of Object.entries(mapping)) {
      let val = String(r[h]??'').trim();
      if (!val||val==='0') continue;
      if (!o[f]) o[f]=val;
    }
    return o;
  }).filter(o=>o[requiredField]&&String(o[requiredField]).trim());
  return {items, unmapped};
}

/* ---- Contacts ---- */
const STATUS_CANON = {
  confirmed:'Confirmed',yes:'Confirmed',y:'Confirmed',done:'Confirmed',
  pending:'Pending',no:'Pending',n:'Pending',
  contacted:'Contacted',called:'Contacted',reached:'Contacted',
  tentative:'Tentative',maybe:'Tentative',
  declined:'Declined',rejected:'Declined',cancel:'Declined',
};
function canonStatus(v) {
  const k=norm(v);
  if (STATUS_CANON[k]) return STATUS_CANON[k];
  if (k.includes('confirm')) return 'Confirmed';
  if (k.includes('pend')) return 'Pending';
  if (k.includes('contact')||k.includes('reach')) return 'Contacted';
  if (k.includes('tent')||k.includes('maybe')) return 'Tentative';
  if (k.includes('declin')||k.includes('reject')||k.includes('cancel')) return 'Declined';
  return v?'Contacted':'Pending';
}
export async function parseContactsFile(file) {
  const {items, unmapped} = await parseFile(file, CONTACT_MAP, 'name');
  const processed = items.map(o=>({...o, status:o.status?canonStatus(o.status):undefined})).filter(o=>o.name);
  return {items:processed, unmapped};
}
export function contactKey(c) {
  const phone = String(c.phone||'').replace(/[^\d]/g,'');
  if (phone.length>=7) return 'ph:'+phone.slice(-10);
  return 'nm:'+norm(c.name)+'|'+norm(c.org);
}
export function planImport(parsedItems, existingContacts) {
  const index = new Map();
  existingContacts.forEach(c=>index.set(contactKey(c),c));
  const plan = parsedItems.map(row=>{
    const key=contactKey(row); const match=index.get(key);
    if (match) { const merged={...match,...row,id:match.id}; if(!row.status) merged.status=match.status; return {mode:'update',item:merged,name:row.name}; }
    return {mode:'new',item:{suffix:'Ji',status:'Pending',type:'Panelist',...row},name:row.name};
  });
  return {plan, newCount:plan.filter(p=>p.mode==='new').length, updateCount:plan.filter(p=>p.mode==='update').length};
}

/* ---- Sessions ---- */
export async function parseSessionsFile(file) {
  const {items,unmapped} = await parseFile(file, SESSION_MAP, 'title');
  return {items:items.map(o=>({...o,type:o.type||'Panel'})), unmapped};
}
export function planSessionsImport(parsed, existing) {
  const index = new Map();
  existing.forEach(s=>index.set(norm(s.title)+'|'+s.date, s));
  const plan = parsed.map(row=>{
    const key=norm(row.title)+'|'+(row.date||'');
    const match=index.get(key);
    if (match) return {mode:'update',item:{...match,...row,id:match.id},name:row.title};
    return {mode:'new',item:row,name:row.title};
  });
  return {plan,newCount:plan.filter(p=>p.mode==='new').length,updateCount:plan.filter(p=>p.mode==='update').length};
}

/* ---- Volunteers ---- */
export async function parseVolunteersFile(file) {
  return await parseFile(file, VOLUNTEER_MAP, 'name');
}
export function planVolunteersImport(parsed, existing) {
  const index = new Map();
  existing.forEach(v=>index.set(norm(v.name),v));
  const plan = parsed.map(row=>{
    const match=index.get(norm(row.name));
    if (match) return {mode:'update',item:{...match,...row,id:match.id},name:row.name};
    return {mode:'new',item:row,name:row.name};
  });
  return {plan,newCount:plan.filter(p=>p.mode==='new').length,updateCount:plan.filter(p=>p.mode==='update').length};
}

/* ---- Tasks ---- */
const TASK_STATUS_CANON = {open:'Open',pending:'Open','in progress':'In Progress',blocked:'Blocked',done:'Done',complete:'Done',completed:'Done'};
export async function parseTasksFile(file) {
  const {items,unmapped} = await parseFile(file, TASK_MAP, 'title');
  return {items:items.map(o=>({...o,status:TASK_STATUS_CANON[norm(o.status||'')]||'Open'})),unmapped};
}
export function planTasksImport(parsed, existing) {
  const index = new Map();
  existing.forEach(t=>index.set(norm(t.title),t));
  const plan = parsed.map(row=>{
    const match=index.get(norm(row.title));
    if (match) return {mode:'update',item:{...match,...row,id:match.id},name:row.title};
    return {mode:'new',item:{status:'Open',...row},name:row.title};
  });
  return {plan,newCount:plan.filter(p=>p.mode==='new').length,updateCount:plan.filter(p=>p.mode==='update').length};
}

/* ---- Template downloads ---- */
export function downloadTemplate(type='contacts') {
  const TEMPLATES = {
    contacts:[{'Name of Delegate':'Sujit Dutta',Designation:'Expert',Organisation:'JNU',Contact:'+91 90000 00000',Email:'',POC:'Office',Category:'Panelist',Status:'Pending',Comments:''}],
    sessions:[{Title:'Legal Round Table',Topic:'Constitutional Law',Date:'2026-01-18','Start Time':'10:00','End Time':'12:00',Type:'Panel'}],
    volunteers:[{Name:'Volunteer Name',Phone:'+91 90000 00000',City:'Mumbai',Skills:'POC, Hospitality','Pre Event':'Yes','Event Days':'16,17,18 Jan','Time Slot':'Full Day'}],
    tasks:[{Task:'Task description',Department:'Outreach',Owner:'Volunteer Name','Due Date':'2026-01-10',Status:'Open',Notes:''}],
  };
  const ws = XLSX.utils.json_to_sheet(TEMPLATES[type]||TEMPLATES.contacts);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb,ws,'Sheet1');
  XLSX.writeFile(wb,`VK_${type}_template.xlsx`);
}

/* ---- Logistics import ---- */
const LOGISTICS_MAP = [
  { keys: ['name','delegate name','guest name','full name','name of delegate'], field:'_matchName' },
  { keys: ['phone','mobile','contact','number'], field:'_matchPhone' },
  { keys: ['arrival mode','mode','travel mode','inbound mode','flight/train/car'], field:'inbMode' },
  { keys: ['arrival date','inbound date','date of arrival','arriving on'], field:'inbDate' },
  { keys: ['arrival time','inbound time','time of arrival','arriving at'], field:'inbTime' },
  { keys: ['arrival location','pickup location','airport','station','arriving at'], field:'inbLoc' },
  { keys: ['hotel','accommodation','stay','hotel name'], field:'hotel' },
  { keys: ['check in','checkin','check-in time'], field:'checkin' },
  { keys: ['departure date','outbound date','date of departure','departing on'], field:'outDate' },
  { keys: ['departure time','departs for airport','checkout time','departing at'], field:'outDepart' },
  { keys: ['flight time','outbound flight','return flight'], field:'outFlight' },
  { keys: ['special','dietary','requirements','special requirements','diet'], field:'special' },
];

export async function parseLogisticsFile(file) {
  return await parseFile(file, LOGISTICS_MAP, '_matchName');
}

export function planLogisticsImport(parsedRows, existingContacts, existingLogistics) {
  const normPhone = p => String(p||'').replace(/[^\d]/g,'').slice(-10);
  const normName  = n => String(n||'').toLowerCase().replace(/[^a-z0-9]/g,'');

  const plan = [];
  for (const row of parsedRows) {
    // Try to match a contact by phone first, then by name
    let contact = null;
    if (row._matchPhone) {
      const ph = normPhone(row._matchPhone);
      contact = existingContacts.find(c => normPhone(c.phone) === ph && ph.length >= 7);
    }
    if (!contact && row._matchName) {
      const nm = normName(row._matchName);
      contact = existingContacts.find(c => {
        const cn = normName(c.name);
        return nm && cn && (nm === cn || nm.includes(cn) || cn.includes(nm));
      });
    }

    // Strip the match helper fields
    const { _matchName, _matchPhone, ...fields } = row;

    if (contact) {
      const existing = existingLogistics.find(l => l.contactId === contact.id || l.id === contact.id);
      plan.push({
        mode: existing ? 'update' : 'new',
        contactId: contact.id,
        contactName: contact.name,
        item: existing
          ? { ...existing, ...fields, contactId: contact.id }
          : { contactId: contact.id, ...fields },
      });
    } else {
      plan.push({ mode: 'unmatched', contactName: row._matchName || '(no name)', item: null });
    }
  }
  return {
    plan,
    newCount:       plan.filter(p => p.mode === 'new').length,
    updateCount:    plan.filter(p => p.mode === 'update').length,
    unmatchedCount: plan.filter(p => p.mode === 'unmatched').length,
  };
}
