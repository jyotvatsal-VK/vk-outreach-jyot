import { useState, useMemo } from 'react';
import { saveItem, removeItem, batchUpsert } from './data';
import { useAuth } from './auth';
import {
  esc, initials, displayName, toMin, fmtDate, shortDate,
  buildPersonalSchedule, buildEventSchedule, buildFounderSchedule,
} from './schedule';
import { ICON, Modal, Field, Empty, SearchBox, useToast } from './ui';
import { parseContactsFile, planImport, downloadTemplate, parseSessionsFile, planSessionsImport, parseVolunteersFile, planVolunteersImport, parseTasksFile, planTasksImport } from './excel';

const STATUSES = ['Pending', 'Contacted', 'Tentative', 'Confirmed', 'Declined'];
const TYPES = ['Panelist', 'VIP', 'Podcast Guest', 'Guest'];
const TASK_STATUS = ['Open', 'In Progress', 'Blocked', 'Done'];
const SESSION_TYPES = ['Panel', 'Meal', 'Ceremony', 'Exhibition', 'Podcast', 'Competition', 'Drone Show', 'Hospitality'];
const SHIFTS = ['Full day', 'Morning', 'Afternoon', 'Evening'];

const S = (store, n) => store[n] || [];
const sbadge = (s) => <span className={'badge b-' + s.toLowerCase().replace(/ /g, '-')}>{s}</span>;

/* ============================ DASHBOARD ============================ */
export function Dashboard({ store, go }) {
  const { profile } = useAuth();
  const contacts = S(store, 'contacts'), tasks = S(store, 'tasks');
  const conf = contacts.filter((c) => c.status === 'Confirmed');
  const pend = contacts.filter((c) => c.status === 'Pending' || c.status === 'Contacted');
  const logi = S(store, 'logistics');
  const hasLogi = (id) => logi.some((x) => x.contactId === id && (x.hotel || x.inbTime));
  const noLog = conf.filter((c) => !hasLogi(c.id));
  const vols = S(store, 'volunteers');
  const depts = S(store, 'departments');

  // HOD personalised view
  const isHOD = profile?.role === 'HOD';
  const myDepts = isHOD ? depts.filter(d=>(d.hodIds||[]).some(id=>{
    const v=vols.find(v=>v.id===id);
    return v&&v.name?.toLowerCase()===profile?.email?.split('@')[0]?.toLowerCase();
  })) : [];
  const myDeptIds = new Set(myDepts.map(d=>d.id));
  const myTasks = isHOD ? tasks.filter(t=>myDeptIds.has(t.deptId)) : tasks;
  const myOpenTasks = myTasks.filter(t=>t.status!=='Done');
  const myBlocked = myTasks.filter(t=>{
    const blockers=(t.blockedBy||[]).map(id=>tasks.find(x=>x.id===id)).filter(Boolean).filter(b=>b.status!=='Done');
    return blockers.length>0;
  });

  if (isHOD && myDepts.length > 0) {
    // HOD sees their department view
    return (
      <>
        <div className="page-head"><div className="ph-txt"><h1>My Department{myDepts.length>1?'s':''}</h1><p>Your personalised view — tasks and team for your department{myDepts.length>1?'s':''}.</p></div></div>
        <div className="cards">
          <Stat label="My open tasks" icon={ICON.dept} val={myOpenTasks.length} hint={`${myTasks.filter(t=>t.status==='Done').length} done`}/>
          <Stat label="Blocked tasks" icon={ICON.dept} val={myBlocked.length} hint="need attention"/>
          <Stat label="Event invitees" icon={ICON.outreach} val={contacts.length} hint={`${conf.length} confirmed`}/>
          <Stat label="Sessions" icon={ICON.cal} val={S(store,'sessions').length} hint="scheduled"/>
        </div>
        {myDepts.map(dept=>{
          const dTasks=tasks.filter(t=>t.deptId===dept.id);
          const dOpen=dTasks.filter(t=>t.status!=='Done');
          const dVols=vols.filter(v=>(dept.hodIds||[]).includes(v.id));
          const pct=dTasks.length?Math.round((dTasks.filter(t=>t.status==='Done').length/dTasks.length)*100):0;
          return (
            <div className="panel" key={dept.id}>
              <div className="panel-head"><h2>{dept.name}</h2><div className="desc">{dept.desc}</div>
                <div className="right"><div style={{width:80,height:6,background:'var(--line)',borderRadius:3}}><div style={{width:pct+'%',height:'100%',background:'var(--teal)',borderRadius:3}}/></div><span className="muted-sm">{pct}%</span></div>
              </div>
              <div className="panel-body"><table><thead><tr><th>Task</th><th>Owner</th><th>Due</th><th>Status</th></tr></thead><tbody>
                {dOpen.map(t=>{
                  const blockers=(t.blockedBy||[]).map(id=>tasks.find(x=>x.id===id)).filter(Boolean).filter(b=>b.status!=='Done');
                  return <tr key={t.id}>
                    <td><div className="nm">{t.title}</div>{blockers.length>0&&<div className="role" style={{color:'var(--rose)'}}>⛔ Blocked by: {blockers.map(b=>b.title).join(', ')}</div>}</td>
                    <td className="muted-sm">{vols.find(v=>v.id===t.assigneeId)?.name||'—'}</td>
                    <td className="muted-sm">{shortDate(t.due)}</td>
                    <td><select className="statsel" value={t.status} onChange={e=>saveItem('tasks',{...t,status:e.target.value})}>{TASK_STATUS.map(s=><option key={s}>{s}</option>)}</select></td>
                  </tr>;
                })}
                {!dOpen.length&&<tr><td colSpan="4"><div style={{padding:'12px 0',color:'var(--muted)',fontSize:13,textAlign:'center'}}>✓ All tasks done</div></td></tr>}
              </tbody></table></div>
            </div>
          );
        })}
      </>
    );
  }

  // Master / default view
  return (
    <>
      <div className="page-head"><div className="ph-txt"><h1>Dashboard</h1><p>One connected view for this event. Every number reads from the same records each department works from.</p></div></div>
      <div className="cards">
        <Stat label="Invitees" icon={ICON.outreach} val={contacts.length} hint={`${conf.length} confirmed · ${pend.length} pending`} />
        <Stat label="In logistics" icon={ICON.truck} val={conf.length} hint={`${noLog.length} need travel details`} />
        <Stat label="Sessions" icon={ICON.cal} val={S(store, 'sessions').length} hint={`${S(store, 'assignments').length} panel assignments`} />
        <Stat label="Open tasks" icon={ICON.dept} val={tasks.filter((t) => t.status !== 'Done').length} hint={`${S(store, 'volunteers').length} volunteers`} />
      </div>
      <div className="flow-note">{ICON.info}<div><b>Core flow:</b> in <b>Outreach</b>, set a pending invitee to <b>Confirmed</b> and a logistics record appears automatically. In <b>Generate</b>, produce a personalised schedule assembled from every department. Use <b>Import from Excel</b> in Outreach to bulk-load your sheet.</div></div>
      <div className="panel"><div className="panel-head"><h2>Needs attention</h2><div className="desc">Auto-flagged</div></div><div className="panel-body"><table><tbody>
        {pend.map((c) => <AttnRow key={c.id} c={c} note={`${c.status} · last contacted ${fmtDate(c.last) || '—'}`} btn="Open Outreach" onClick={() => go('outreach')} />)}
        {noLog.map((c) => <AttnRow key={'l' + c.id} c={c} note="Confirmed but no travel details" btn="Open Logistics" onClick={() => go('logistics')} />)}
        {tasks.filter(t=>{const bl=(t.blockedBy||[]).map(id=>tasks.find(x=>x.id===id)).filter(Boolean).filter(b=>b.status!=='Done');return bl.length>0;}).map((t) => (
          <tr key={t.id}><td><div className="person"><div className="avatar" style={{ background: 'var(--rose-wash)', color: 'var(--rose)' }}>!</div><div><div className="nm">{t.title}</div><div className="role">Blocked task</div></div></div></td><td style={{ textAlign: 'right' }}><button className="btn sm" onClick={() => go('depts')}>Open Tasks</button></td></tr>
        ))}
        {!pend.length && !noLog.length && <tr><td colSpan="2"><div className="empty">{ICON.check}<h3>All clear</h3><p>No pending follow-ups right now.</p></div></td></tr>}
      </tbody></table></div></div>
    </>
  );
}
const Stat = ({ label, icon, val, hint }) => <div className="stat"><div className="lab">{icon}{label}</div><div className="val">{val}</div><div className="hint">{hint}</div></div>;
const AttnRow = ({ c, note, btn, onClick }) => <tr><td><div className="person"><div className="avatar">{initials(c.name)}</div><div><div className="nm">{displayName(c)}</div><div className="role">{note}</div></div></div></td><td style={{ textAlign: 'right' }}><button className="btn sm" onClick={onClick}>{btn}</button></td></tr>;

/* ============================ OUTREACH ============================ */
export function Outreach({ store, activeEventId }) {
  const toast = useToast();
  const contacts = S(store, 'contacts'), logi = S(store, 'logistics');
  const [q, setQ] = useState('');
  const [modal, setModal] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const [selectMode, setSelectMode] = useState(false);
  const [bulkStatus, setBulkStatus] = useState('Confirmed');

  const list = useMemo(() => {
    const t = q.toLowerCase();
    return contacts.filter((c) => !t || displayName(c).toLowerCase().includes(t) || (c.org || '').toLowerCase().includes(t) || (c.field || '').toLowerCase().includes(t));
  }, [contacts, q]);

  async function setStatus(c, val) {
    await saveItem('contacts', { ...c, status: val });
    if (val === 'Confirmed' && c.status !== 'Confirmed') {
      if (!logi.some((x) => x.contactId === c.id)) {
        await saveItem('logistics', { contactId: c.id, eventId: activeEventId });
      }
      toast(`<b>${esc(displayName(c))}</b> confirmed. Logistics record created automatically.`);
    }
  }

  function toggleSelect(id) {
    setSelected(prev => { const n=new Set(prev); n.has(id)?n.delete(id):n.add(id); return n; });
  }
  function toggleAll() {
    if (selected.size===list.length) setSelected(new Set());
    else setSelected(new Set(list.map(c=>c.id)));
  }
  async function applyBulk() {
    const toUpdate = list.filter(c=>selected.has(c.id));
    for (const c of toUpdate) await setStatus(c, bulkStatus);
    toast(`Updated ${toUpdate.length} contacts to <b>${bulkStatus}</b>.`);
    setSelected(new Set()); setSelectMode(false);
  }

  const noteCount = cid => (store.contact_notes||[]).filter(n=>n.contactId===cid).length;

  return (
    <>
      <div className="page-head"><div className="ph-txt"><h1>Delegate Outreach</h1><p>The expert directory for this event. Add contacts, follow up, or import your Excel sheet.</p></div></div>
      <div className="panel">
        <div className="panel-head"><h2>Invitees</h2><div className="desc">{list.length} shown</div>
          <div className="right">
            <SearchBox value={q} onChange={setQ} />
            <button className={'btn sm'+(selectMode?' primary':'')} onClick={()=>{setSelectMode(s=>!s);setSelected(new Set());}}>
              {selectMode?'Cancel select':'Select multiple'}
            </button>
            <button className="btn sm" onClick={() => setModal({ type: 'import' })}>{ICON.upload}Import</button>
            <button className="btn primary sm" onClick={() => setModal({ type: 'add' })}>{ICON.plus}Add</button>
          </div></div>
        <div className="panel-body"><table>
          <thead><tr>
            {selectMode&&<th><input type="checkbox" checked={selected.size===list.length&&list.length>0} onChange={toggleAll} style={{accentColor:'var(--teal)'}}/></th>}
            <th>Name</th><th>Field</th><th>Type</th><th>Liaison</th><th>Status</th><th></th>
          </tr></thead>
          <tbody>
            {list.map((c) => (
              <tr key={c.id} style={selected.has(c.id)?{background:'var(--teal-wash)'}:{}}>
                {selectMode&&<td><input type="checkbox" checked={selected.has(c.id)} onChange={()=>toggleSelect(c.id)} style={{accentColor:'var(--teal)'}}/></td>}
                <td><div className="person"><div className="avatar">{initials(c.name)}</div><div><div className="nm">{displayName(c)}</div><div className="role">{c.desig}{c.org ? ' · ' + c.org : ''}</div></div></div></td>
                <td><span className="muted-sm">{c.field}</span></td>
                <td><span className="badge b-type">{c.type}</span></td>
                <td><span className="muted-sm">{c.liaisonName || '—'}</span></td>
                <td><select className="statsel" value={c.status} onChange={(e) => setStatus(c, e.target.value)}>{STATUSES.map((s) => <option key={s}>{s}</option>)}</select></td>
                <td><div className="rowacts">
                  <button className="btn ghost xs" onClick={() => setModal({ type: 'whatsapp', item: c })} title="WhatsApp">💬</button>
                  <button className="btn ghost xs" onClick={() => setModal({ type: 'history', item: c })} title="Contact history">📅</button>
                  <button className="btn ghost xs" onClick={() => setModal({ type: 'notes', item: c })} title="Follow-up log">
                    📝{noteCount(c.id)>0&&<span style={{fontSize:10,marginLeft:2,color:'var(--teal)',fontWeight:700}}>{noteCount(c.id)}</span>}
                  </button>
                  <button className="btn ghost xs" onClick={() => setModal({ type: 'edit', item: c })}>{ICON.edit}</button>
                  <button className="btn ghost xs" onClick={() => setModal({ type: 'del', item: c })}>{ICON.trash}</button>
                </div></td>
              </tr>
            ))}
            {!list.length && <tr><td colSpan={selectMode?7:6}><Empty title="No matches" sub="Try a different search, add a contact, or import from Excel." /></td></tr>}
          </tbody></table></div>
      </div>
      {/* Bulk action bar */}
      {selectMode && selected.size>0 && (
        <div style={{position:'fixed',bottom:20,left:'50%',transform:'translateX(-50%)',background:'var(--ink)',color:'#fff',padding:'12px 20px',borderRadius:12,display:'flex',alignItems:'center',gap:12,boxShadow:'0 8px 30px rgba(0,0,0,.3)',zIndex:50,flexWrap:'wrap'}}>
          <span style={{fontSize:13.5,fontWeight:600}}>{selected.size} selected</span>
          <span style={{color:'var(--faint)'}}>→ Set status to</span>
          <select style={{background:'#fff',color:'var(--ink)',border:'none',borderRadius:7,padding:'5px 10px',fontWeight:600,fontSize:13}} value={bulkStatus} onChange={e=>setBulkStatus(e.target.value)}>
            {STATUSES.map(s=><option key={s}>{s}</option>)}
          </select>
          <button className="btn primary sm" onClick={applyBulk}>Apply to all</button>
          <button className="btn ghost sm" style={{color:'#fff'}} onClick={()=>{setSelected(new Set());setSelectMode(false);}}>Cancel</button>
        </div>
      )}
      {(modal?.type === 'add' || modal?.type === 'edit') && <ContactModal item={modal.item} activeEventId={activeEventId} store={store} onClose={() => setModal(null)} toast={toast} />}
      {modal?.type === 'import' && <ImportModal store={store} activeEventId={activeEventId} onClose={() => setModal(null)} toast={toast} />}
      {modal?.type === 'notes' && <ContactNotesModal contact={modal.item} store={store} activeEventId={activeEventId} onClose={() => setModal(null)} />}
      {modal?.type === 'whatsapp' && <WhatsAppModal contact={modal.item} store={store} activeEventId={activeEventId} onClose={() => setModal(null)} />}
      {modal?.type === 'history' && <ContactHistoryModal contact={modal.item} rawStore={store.__raw||store} onClose={() => setModal(null)} />}
      {modal?.type === 'del' && <DeleteModal label={displayName(modal.item)} onClose={() => setModal(null)} onConfirm={async () => {
        await removeItem('contacts', modal.item.id);
        const L = S(store,'logistics').find(x=>x.contactId===modal.item.id);
        if(L) await removeItem('logistics', L.id);
        const F = S(store,'founder').find(x=>x.contactId===modal.item.id);
        if(F) await removeItem('founder', F.id);
        S(store, 'assignments').filter((a) => a.contactId === modal.item.id).forEach((a) => removeItem('assignments', a.id));
        S(store, 'poc').filter((p) => p.contactId === modal.item.id).forEach((p) => removeItem('poc', p.id));
        setModal(null); toast('Contact deleted.');
      }} />}
    </>
  );
}

function ContactModal({ item, activeEventId, store, onClose, toast }) {
  const [f, setF] = useState(() => ({ name: '', honor: '', desig: '', org: '', field: '', phone: '', email: '', liaisonName: '', liaisonPhone: '', type: 'Panelist', remark: '', ...item }));
  const set = (k) => (e) => setF((p) => ({ ...p, [k]: e.target.value }));
  const [dupWarning, setDupWarning] = useState(null);

  async function save() {
    if (!f.name.trim()) return;
    // Check for duplicates before saving (skip when editing existing contact)
    if (!item) {
      const existing = store?.contacts || [];
      const dup = findDuplicate(f, existing, null);
      if (dup) { setDupWarning(dup); return; }
    }
    await doSave();
  }
  async function doSave() {
    const data = { ...f, eventId: activeEventId };
    if (!item) { data.status = 'Pending'; data.suffix = 'Ji'; data.last = ''; }
    await saveItem('contacts', data);
    onClose(); toast(item ? 'Contact updated.' : `<b>${esc(f.name)}</b> added as Pending.`);
  }
  return (<>
    <Modal title={item ? 'Edit contact' : 'Add contact'} onClose={onClose} onSave={save} saveLabel={item ? 'Save changes' : 'Add contact'}>
      <Field label="Full name"><input className="input" value={f.name} onChange={set('name')} placeholder="e.g. Sujit Dutta" /></Field>
      <div className="grid2">
        <Field label="Honorific"><input className="input" value={f.honor} onChange={set('honor')} placeholder="Dr. / Prof." /></Field>
        <Field label="Type"><select className="input" value={f.type} onChange={set('type')}>{TYPES.map((t) => <option key={t}>{t}</option>)}</select></Field>
        <Field label="Designation"><input className="input" value={f.desig} onChange={set('desig')} /></Field>
        <Field label="Organisation"><input className="input" value={f.org} onChange={set('org')} /></Field>
        <Field label="Field"><input className="input" value={f.field} onChange={set('field')} placeholder="Legal / Geopolitics" /></Field>
        <Field label="Phone"><input className="input" value={f.phone} onChange={set('phone')} /></Field>
        <Field label="Liaison name"><input className="input" value={f.liaisonName} onChange={set('liaisonName')} /></Field>
        <Field label="Liaison phone"><input className="input" value={f.liaisonPhone} onChange={set('liaisonPhone')} /></Field>
      </div>
      <Field label="Remark"><input className="input" value={f.remark} onChange={set('remark')} /></Field>
    </Modal>
    {dupWarning && <DuplicateWarningModal incoming={f} existing={dupWarning} onSaveAnyway={()=>{setDupWarning(null);doSave();}} onCancel={()=>setDupWarning(null)}/>}
  </>);
}

function ImportModal({ store, activeEventId, onClose, toast }) {
  const [step, setStep] = useState('choose');
  const [parsed, setParsed] = useState(null);
  const [plan, setPlan] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  async function handleFile(file) {
    if (!file) return; setErr('');
    try {
      const res = await parseContactsFile(file);
      if (!res.items.length) { setErr('No rows with a Name column were found.'); return; }
      const p = planImport(res.items, S(store, 'contacts'));
      setParsed(res); setPlan(p); setStep('preview');
    } catch { setErr('Could not read that file. Make sure it is a .xlsx or .csv.'); }
  }
  async function commit() {
    setBusy(true);
    try {
      await batchUpsert('contacts', plan.plan.map((p) => ({ ...p.item, eventId: activeEventId })));
      onClose(); toast(`Import complete — <b>${plan.newCount}</b> added, <b>${plan.updateCount}</b> updated.`);
    } catch (e) { setErr('Saving failed: ' + (e.message || e)); setBusy(false); }
  }
  return (
    <Modal title="Import contacts from Excel" onClose={onClose} footer={null}>
      {err && <div style={{ background: 'var(--rose-wash)', color: 'var(--rose)', padding: '9px 12px', borderRadius: 8, fontSize: 13, marginBottom: 12 }}>{err}</div>}
      {step === 'choose' && (<>
        <p className="muted-sm" style={{ marginTop: 0 }}>Columns matched by name: Name, Designation, Organisation, Phone, POC, Confirmation, Remarks… Existing records matched by phone (or name+org) are overwritten.</p>
        <label className="dropzone"><span style={{display:"flex",justifyContent:"center"}}>{ICON.upload}</span><div>Click to choose a file</div><input type="file" accept=".xlsx,.xls,.csv" style={{ display: 'none' }} onChange={(e) => handleFile(e.target.files[0])} /></label>
        <div style={{ marginTop: 14, textAlign: 'center' }}><button className="linkbtn" onClick={downloadTemplate}>Download blank template</button></div>
        <div className="modal-foot" style={{ padding: '14px 0 0' }}><button className="btn" onClick={onClose}>Cancel</button></div>
      </>)}
      {step === 'preview' && plan && (<>
        <div style={{ display: 'flex', gap: 18, marginBottom: 6 }}>
          <div><div style={{ fontFamily:'var(--serif)',fontSize:26,color:'var(--teal)' }}>{plan.newCount}</div><div className="muted-sm">new</div></div>
          <div><div style={{ fontFamily:'var(--serif)',fontSize:26,color:'var(--amber)' }}>{plan.updateCount}</div><div className="muted-sm">overwrite</div></div>
        </div>
        <div style={{ maxHeight: '38vh', overflow: 'auto', border: '1px solid var(--line)', borderRadius: 8 }}>
          <table className="import-tbl"><thead><tr><th>Name</th><th>Org</th><th>Phone</th><th>Result</th></tr></thead><tbody>
            {plan.plan.slice(0, 60).map((p, i) => <tr key={i}><td>{p.item.name}</td><td>{p.item.org||'—'}</td><td>{p.item.phone||'—'}</td><td>{p.mode==='new'?<span className="pill-new">New</span>:<span className="pill-upd">Overwrite</span>}</td></tr>)}
          </tbody></table>
        </div>
        <div className="modal-foot" style={{ padding: '14px 0 0' }}>
          <button className="btn" onClick={() => setStep('choose')}>Back</button>
          <button className="btn primary" onClick={commit} disabled={busy}>{busy ? 'Importing…' : `Import ${plan.plan.length} rows`}</button>
        </div>
      </>)}
    </Modal>
  );
}

/* ============================ LOGISTICS ============================ */
export function Logistics({ store, activeEventId }) {
  const toast = useToast();
  const [importOpen, setImportOpen] = useState(false);
  const conf = S(store, 'contacts').filter((c) => c.status === 'Confirmed');
  const logi = S(store, 'logistics');
  const getL = (cid) => logi.find((x) => x.contactId === cid) || { contactId: cid, eventId: activeEventId };
  const setK = (cid, k) => async (e) => {
    const L = getL(cid);
    await saveItem('logistics', { ...L, [k]: e.target.value });
  };
  if (!conf.length) return <><div className="page-head"><div className="ph-txt"><h1>Logistics</h1></div></div><div className="panel"><Empty title="No one to arrange yet" sub="Confirmed invitees appear here automatically." /></div></>;
  const F = (cid, k, label, ph, type) => <Field label={label}><input className="input" type={type||'text'} defaultValue={getL(cid)[k]||''} onBlur={setK(cid,k)} placeholder={ph} /></Field>;
  return (
    <>
      <div className="page-head"><div className="ph-txt"><h1>Logistics</h1><p>Confirmed invitees flow in automatically. Travel and stay attach here.</p></div>
        <button className="btn sm" onClick={()=>setImportOpen(true)}>{ICON.upload}Import from Excel</button>
      </div>
      {importOpen && <LogisticsImportModal store={store} activeEventId={activeEventId} onClose={()=>setImportOpen(false)} toast={toast}/>}
      {conf.map((c) => {
        const L = getL(c.id); const filled = L.hotel || L.inbTime;
        return (
          <div className="panel" key={c.id}>
            <div className="panel-head"><div className="person"><div className="avatar">{initials(c.name)}</div><div><div className="nm">{displayName(c)}</div><div className="role">{c.type} · {c.field}</div></div></div><div className="right">{filled?sbadge('Confirmed'):<span className="badge b-pending">Needs details</span>}</div></div>
            <div className="panel-pad"><div className="grid2">
              {F(c.id,'inbMode','Arrival mode','Flight / Train / Car')}
              {F(c.id,'inbLoc','Arrival location','Mumbai Airport')}
              {F(c.id,'inbDate','Arrival date','','date')}
              {F(c.id,'inbTime','Arrival time','12:20')}
              {F(c.id,'hotel','Hotel','Taj President, IHCL')}
              {F(c.id,'checkin','Check-in time','13:30')}
              {F(c.id,'outDate','Departure date','','date')}
              {F(c.id,'outDepart','Departs for airport','07:00')}
              {F(c.id,'outFlight','Outbound flight time','09:30')}
            </div>{F(c.id,'special','Special requirements','Diet, accessibility, etc.')}</div>
          </div>
        );
      })}
    </>
  );
}

/* ============================ SCHEDULING ============================ */
export function Scheduling({ store, activeEventId }) {
  const toast = useToast();
  const [tab, setTab] = useState('sessions');
  const [modal, setModal] = useState(null);
  return (
    <>
      <div className="page-head"><div className="ph-txt"><h1>Scheduling</h1><p>Event sessions, panel assignments and founder one-on-ones.</p></div></div>
      <div className="subnav">
        <button className={tab==='sessions'?'active':''} onClick={()=>setTab('sessions')}>Event schedule</button>
        <button className={tab==='assign'?'active':''} onClick={()=>setTab('assign')}>Session assignments</button>
        <button className={tab==='founder'?'active':''} onClick={()=>setTab('founder')}>Founder one-on-ones</button>
      </div>
      {tab==='sessions' && <SessionsTab store={store} activeEventId={activeEventId} setModal={setModal} />}
      {tab==='assign' && <AssignTab store={store} activeEventId={activeEventId} />}
      {tab==='founder' && <FounderTab store={store} activeEventId={activeEventId} setModal={setModal} />}
      {(modal?.type==='add-s'||modal?.type==='edit-s') && <SessionModal item={modal.item} activeEventId={activeEventId} onClose={()=>setModal(null)} toast={toast} />}
      {modal?.type==='del-s' && <DeleteModal label={modal.item.title} onClose={()=>setModal(null)} onConfirm={async()=>{ await removeItem('sessions',modal.item.id); S(store,'assignments').filter(a=>a.sessionId===modal.item.id).forEach(a=>removeItem('assignments',a.id)); setModal(null); toast('Session deleted.'); }} />}
      {(modal?.type==='add-f'||modal?.type==='edit-f') && <FounderMeetingModal item={modal.item} store={store} activeEventId={activeEventId} onClose={()=>setModal(null)} toast={toast} />}
      {modal?.type==='del-f' && <DeleteModal label={`meeting with ${displayName((store.contacts||[]).find(c=>c.id===modal.item.contactId)||{name:'this guest'})}`} onClose={()=>setModal(null)} onConfirm={async()=>{ await removeItem('founder',modal.item.id); setModal(null); toast('Meeting deleted.'); }} />}
    </>
  );
}

function SessionsTab({ store, activeEventId, setModal }) {
  const toast = useToast();
  const [importOpen, setImportOpen] = useState(false);
  const rows = [...S(store,'sessions')].sort((a,b)=>a.date<b.date?-1:a.date>b.date?1:toMin(a.start)-toMin(b.start));
  return (<>
    <div className="panel"><div className="panel-head"><h2>Sessions</h2><div className="right">
      <button className="btn sm" onClick={()=>setImportOpen(true)}>{ICON.upload}Import Excel</button>
      <button className="btn primary sm" onClick={()=>setModal({type:'add-s'})}>{ICON.plus}Add session</button>
    </div></div>
      <div className="panel-body"><table><thead><tr><th>Date</th><th>Time</th><th>Session</th><th>Type</th><th></th></tr></thead><tbody>
        {rows.map(s=>(
          <tr key={s.id}><td className="muted-sm">{shortDate(s.date)}</td><td className="mono">{s.start}{s.end?'–'+s.end:''}</td><td><div className="nm">{s.title}</div>{s.topic&&<div className="role">Topic: {s.topic}</div>}</td><td><span className="badge b-type">{s.type}</span></td>
            <td><div className="rowacts"><button className="btn ghost xs" onClick={()=>setModal({type:'edit-s',item:s})}>{ICON.edit}</button><button className="btn ghost xs" onClick={()=>setModal({type:'del-s',item:s})}>{ICON.trash}</button></div></td></tr>
        ))}
        {!rows.length&&<tr><td colSpan="5"><Empty title="No sessions yet" sub="Add sessions or import from Excel." /></td></tr>}
      </tbody></table></div></div>
    {importOpen&&<GenericImportModal title="Import sessions" store={store} activeEventId={activeEventId} onClose={()=>setImportOpen(false)} toast={toast} parseFile={parseSessionsFile} planFn={planSessionsImport} existingItems={S(store,'sessions')} itemLabel="sessions" buildItem={item=>({...item,eventId:activeEventId})}/>}
  </>);
}

function SessionModal({ item, activeEventId, onClose, toast }) {
  const [f, setF] = useState(()=>({title:'',topic:'',date:'',type:'Panel',start:'',end:'',...item}));
  const set=(k)=>(e)=>setF(p=>({...p,[k]:e.target.value}));
  async function save(){ if(!f.title.trim()||!f.date||!f.start){toast('Title, date and start time are required.');return;} await saveItem('sessions',{...f,eventId:activeEventId}); onClose(); toast(item?'Session updated.':'Session added.'); }
  return (
    <Modal title={item?'Edit session':'Add session'} onClose={onClose} onSave={save} saveLabel={item?'Save changes':'Add session'}>
      <Field label="Title"><input className="input" value={f.title} onChange={set('title')} placeholder="e.g. Legal Round Table Deliberation" /></Field>
      <Field label="Topic (optional)"><input className="input" value={f.topic} onChange={set('topic')} /></Field>
      <div className="grid2">
        <Field label="Date"><input className="input" type="date" value={f.date} onChange={set('date')} /></Field>
        <Field label="Type"><select className="input" value={f.type} onChange={set('type')}>{SESSION_TYPES.map(t=><option key={t}>{t}</option>)}</select></Field>
        <Field label="Start time"><input className="input" value={f.start} onChange={set('start')} placeholder="10:00" /></Field>
        <Field label="End time (optional)"><input className="input" value={f.end} onChange={set('end')} placeholder="12:45" /></Field>
      </div>
    </Modal>
  );
}

function AssignTab({ store, activeEventId }) {
  const conf = S(store,'contacts').filter(c=>c.status==='Confirmed');
  const panels = S(store,'sessions').filter(s=>s.type==='Panel').sort((a,b)=>a.date<b.date?-1:1);
  const assigns = S(store,'assignments');
  const [conflict, setConflict] = useState(null);
  if(!conf.length) return <div className="panel"><Empty title="Nothing here yet" sub="Confirm a guest in Outreach to assign sessions." /></div>;

  // Check if adding s2 conflicts with any existing session for this contact
  function findConflict(contactId, s2) {
    const existing = assigns.filter(a=>a.contactId===contactId).map(a=>S(store,'sessions').find(x=>x.id===a.sessionId)).filter(Boolean);
    return existing.find(s1 => {
      if (s1.date !== s2.date) return false;
      const s1Start=toMin(s1.start), s1End=toMin(s1.end||s1.start)+60;
      const s2Start=toMin(s2.start), s2End=toMin(s2.end||s2.start)+60;
      return s1Start < s2End && s2Start < s1End;
    });
  }

  async function toggle(c,s,on){
    if (on) {
      const clash = findConflict(c.id, s);
      if (clash) { setConflict({ contact: c, session: s, clash }); return; }
    }
    const ex=assigns.find(a=>a.contactId===c.id&&a.sessionId===s.id);
    if(on&&!ex) await saveItem('assignments',{contactId:c.id,sessionId:s.id,role:'Panelist',eventId:activeEventId});
    if(!on&&ex) await removeItem('assignments',ex.id);
  }
  return (<>
    <div className="panel"><div className="panel-pad">
      <p className="muted-sm" style={{marginTop:0}}>Tick the sessions each panelist speaks at. Conflicts are detected automatically.</p>
      {conf.map(c=>{
        const mine=new Set(assigns.filter(a=>a.contactId===c.id).map(a=>a.sessionId));
        return <div key={c.id} style={{margin:'14px 0 6px'}}><div className="nm" style={{fontWeight:600,marginBottom:8}}>{displayName(c)}</div>
          {panels.map(s=><label className="chk" key={s.id}><input type="checkbox" checked={mine.has(s.id)} onChange={e=>toggle(c,s,e.target.checked)}/> {shortDate(s.date)} · {s.topic||s.title}</label>)}
          {!panels.length&&<span className="muted-sm">No panel sessions yet — add them in Event schedule.</span>}
        </div>;
      })}
    </div></div>
    {conflict&&<Modal title="⚠ Session conflict" onClose={()=>setConflict(null)} footer={null} size="sm">
      <p style={{fontSize:13.5}}><b>{displayName(conflict.contact)}</b> is already assigned to <b>{conflict.clash.title}</b> on {shortDate(conflict.clash.date)} at {conflict.clash.start}–{conflict.clash.end||'?'}.</p>
      <p style={{fontSize:13.5}}>Adding <b>{conflict.session.title}</b> at {conflict.session.start} on the same day would create a schedule overlap.</p>
      <div className="modal-foot" style={{padding:'12px 0 0'}}>
        <button className="btn" onClick={()=>setConflict(null)}>Cancel</button>
        <button className="btn danger" onClick={async()=>{
          await saveItem('assignments',{contactId:conflict.contact.id,sessionId:conflict.session.id,role:'Panelist',eventId:activeEventId});
          setConflict(null);
        }}>Assign anyway</button>
      </div>
    </Modal>}
  </>);
}

/* Founder one-on-ones with full add/edit/delete */
function FounderTab({ store, activeEventId, setModal }) {
  const conf = S(store,'contacts').filter(c=>c.status==='Confirmed');
  const meetings = S(store,'founder');
  if(!conf.length) return <div className="panel"><Empty title="Nothing here yet" sub="Confirm a guest in Outreach to schedule a one-on-one." /></div>;
  return (
    <div className="panel">
      <div className="panel-head"><h2>Founder one-on-ones</h2><div className="right"><button className="btn primary sm" onClick={()=>setModal({type:'add-f'})}>{ICON.plus}Add meeting</button></div></div>
      <div className="panel-body"><table><thead><tr><th>Guest</th><th>Date</th><th>Time</th><th>Venue</th><th>Notes</th><th></th></tr></thead><tbody>
        {meetings.map(m=>{
          const c=(store.contacts||[]).find(x=>x.id===m.contactId);
          return (
            <tr key={m.id}>
              <td><div className="nm">{c?displayName(c):'—'}</div></td>
              <td className="muted-sm">{shortDate(m.date)}</td>
              <td className="mono">{m.time||'—'}</td>
              <td className="muted-sm">{m.venue||'VIP Lounge'}</td>
              <td className="muted-sm">{m.notes||'—'}</td>
              <td><div className="rowacts">
                <button className="btn ghost xs" onClick={()=>setModal({type:'edit-f',item:m})}>{ICON.edit}</button>
                <button className="btn ghost xs" onClick={()=>setModal({type:'del-f',item:m})}>{ICON.trash}</button>
              </div></td>
            </tr>
          );
        })}
        {!meetings.length&&<tr><td colSpan="6"><Empty title="No meetings scheduled yet" sub='Click "Add meeting" to schedule a one-on-one.' /></td></tr>}
      </tbody></table>
      <p className="muted-sm" style={{padding:'12px 20px 4px'}}>Every meeting renders with the agreed wording in the personalised schedule.</p>
    </div></div>
  );
}

function FounderMeetingModal({ item, store, activeEventId, onClose, toast }) {
  const conf = S(store,'contacts').filter(c=>c.status==='Confirmed');
  const [f, setF] = useState(()=>({contactId:conf[0]?.id||'',date:'',time:'',venue:'VIP Lounge',notes:'',...item}));
  const set=(k)=>(e)=>setF(p=>({...p,[k]:e.target.value}));
  async function save(){
    if(!f.contactId||!f.date||!f.time){toast('Guest, date and time are required.');return;}
    // Conflict detection — check if another meeting exists at same date+time
    const meetings = S(store,'founder');
    const clash = meetings.find(m => m.id!==item?.id && m.date===f.date && m.time===f.time);
    if (clash) {
      const clashContact = conf.find(c=>c.id===clash.contactId);
      const clashName = clashContact ? displayName(clashContact) : 'another guest';
      toast(`⚠ Time conflict — ${clashName} already has a meeting at ${f.time} on this date. Please choose a different time.`);
      return;
    }
    await saveItem('founder',{...f,eventId:activeEventId});
    onClose(); toast(item?'Meeting updated.':'Meeting scheduled.');
  }
  return (
    <Modal title={item?'Edit one-on-one meeting':'Schedule one-on-one meeting'} onClose={onClose} onSave={save} saveLabel={item?'Save changes':'Schedule meeting'}>
      <Field label="Guest"><select className="input" value={f.contactId} onChange={set('contactId')}><option value="">Select guest…</option>{conf.map(c=><option key={c.id} value={c.id}>{displayName(c)}</option>)}</select></Field>
      <div className="grid2">
        <Field label="Date"><input className="input" type="date" value={f.date} onChange={set('date')} /></Field>
        <Field label="Time"><input className="input" value={f.time} onChange={set('time')} placeholder="20:30" /></Field>
        <Field label="Venue"><input className="input" value={f.venue} onChange={set('venue')} placeholder="VIP Lounge" /></Field>
      </div>
      <Field label="Notes"><input className="input" value={f.notes} onChange={set('notes')} placeholder="Any specific agenda or requirements" /></Field>
    </Modal>
  );
}

/* ============================ VOLUNTEERS & POC ============================ */
export function People({ store, activeEventId }) {
  const toast = useToast();
  const [modal, setModal] = useState(null);
  const vols=S(store,'volunteers'), poc=S(store,'poc'), contacts=S(store,'contacts');
  const volName=id=>vols.find(v=>v.id===id)?.name||'—';
  const cName=id=>{const c=contacts.find(x=>x.id===id);return c?displayName(c):'—';};
  async function swap(p){const alt=vols.find(v=>v.id!==p.volunteerId);if(alt){await saveItem('poc',{...p,volunteerId:alt.id,status:'Active'});toast(`POC swapped to <b>${esc(alt.name)}</b> for that day.`);}}
  return (
    <>
      <div className="page-head"><div className="ph-txt"><h1>Volunteers & POC</h1><p>One volunteer directory feeding department duty and POC assignment per day.</p></div></div>
      <div className="panel"><div className="panel-head"><h2>POC duty roster</h2><div className="desc">Per VIP, per day</div><div className="right"><button className="btn primary sm" onClick={()=>setModal({type:'add-poc'})}>{ICON.plus}Assign POC</button></div></div>
        <div className="panel-body"><table><thead><tr><th>VIP</th><th>Day</th><th>POC on duty</th><th>Shift</th><th></th></tr></thead><tbody>
          {poc.map(p=>(
            <tr key={p.id}><td><div className="nm">{cName(p.contactId)}</div></td><td className="muted-sm">{shortDate(p.day)}</td>
              <td><select className="statsel" value={p.volunteerId} onChange={e=>saveItem('poc',{...p,volunteerId:e.target.value,status:'Active'})}>{vols.map(v=><option key={v.id} value={v.id}>{v.name}</option>)}</select></td>
              <td className="muted-sm">{p.shift}</td>
              <td><div className="rowacts"><button className="btn ghost xs" onClick={()=>swap(p)}>Reassign</button><button className="btn ghost xs" onClick={()=>setModal({type:'del-poc',item:p})}>{ICON.trash}</button></div></td></tr>
          ))}
          {!poc.length&&<tr><td colSpan="5"><Empty title="No POC assignments" sub="Assign a volunteer to escort a VIP on a given day." /></td></tr>}
        </tbody></table></div></div>
      <div className="panel"><div className="panel-head"><h2>Volunteer directory</h2><div className="right">
        <button className="btn sm" onClick={()=>setModal({type:'import-v'})}>{ICON.upload}Import Excel</button>
        <button className="btn primary sm" onClick={()=>setModal({type:'add-v'})}>{ICON.plus}Add volunteer</button>
      </div></div>
        <div className="panel-body"><table><thead><tr><th>Name</th><th>City</th><th>Skills</th><th></th></tr></thead><tbody>
          {vols.map(v=>(
            <tr key={v.id}><td><div className="person"><div className="avatar">{initials(v.name)}</div><div className="nm">{v.name}</div></div></td><td className="muted-sm">{v.city}</td><td className="muted-sm">{v.skills}</td>
              <td><div className="rowacts"><button className="btn ghost xs" onClick={()=>setModal({type:'edit-v',item:v})}>{ICON.edit}</button><button className="btn ghost xs" onClick={()=>setModal({type:'del-v',item:v})}>{ICON.trash}</button></div></td></tr>
          ))}
        </tbody></table></div></div>
      {(modal?.type==='add-v'||modal?.type==='edit-v')&&<VolModal item={modal.item} onClose={()=>setModal(null)} toast={toast} />}
      {modal?.type==='add-poc'&&<PocModal store={store} activeEventId={activeEventId} onClose={()=>setModal(null)} toast={toast} />}
      {modal?.type==='del-v'&&<DeleteModal label={modal.item.name} onClose={()=>setModal(null)} onConfirm={async()=>{await removeItem('volunteers',modal.item.id);poc.filter(p=>p.volunteerId===modal.item.id).forEach(p=>removeItem('poc',p.id));setModal(null);toast('Volunteer deleted.');}} />}
      {modal?.type==='del-poc'&&<DeleteModal label="this POC assignment" onClose={()=>setModal(null)} onConfirm={async()=>{await removeItem('poc',modal.item.id);setModal(null);toast('POC assignment removed.');}} />}
      {modal?.type==='import-v'&&<GenericImportModal title="Import volunteers" store={store} activeEventId={activeEventId} onClose={()=>setModal(null)} toast={toast} parseFile={parseVolunteersFile} planFn={planVolunteersImport} existingItems={vols} itemLabel="volunteers" buildItem={item=>item}/>}
    </>
  );
}
function VolModal({item,onClose,toast}){
  const[f,setF]=useState(()=>({name:'',phone:'',city:'',skills:'',...item}));
  const set=k=>e=>setF(p=>({...p,[k]:e.target.value}));
  async function save(){if(!f.name.trim())return;await saveItem('volunteers',f);onClose();toast(item?'Volunteer updated.':'Volunteer added.');}
  return(<Modal title={item?'Edit volunteer':'Add volunteer'} onClose={onClose} onSave={save} size="sm" saveLabel={item?'Save changes':'Add volunteer'}>
    <Field label="Name"><input className="input" value={f.name} onChange={set('name')}/></Field>
    <div className="grid2"><Field label="Phone"><input className="input" value={f.phone} onChange={set('phone')}/></Field><Field label="City"><input className="input" value={f.city} onChange={set('city')}/></Field></div>
    <Field label="Skills"><input className="input" value={f.skills} onChange={set('skills')} placeholder="POC, Hospitality…"/></Field>
  </Modal>);
}
function PocModal({store,activeEventId,onClose,toast}){
  const vips=S(store,'contacts').filter(c=>c.status==='Confirmed');
  const vols=S(store,'volunteers');
  const[f,setF]=useState({contactId:vips[0]?.id||'',volunteerId:vols[0]?.id||'',day:'',shift:'Full day',notes:''});
  const set=k=>e=>setF(p=>({...p,[k]:e.target.value}));
  async function save(){if(!f.contactId||!f.volunteerId||!f.day)return;await saveItem('poc',{...f,eventId:activeEventId,status:'Active'});onClose();toast('POC assigned.');}
  return(<Modal title="Assign POC" onClose={onClose} onSave={save} size="sm" saveLabel="Assign">
    <Field label="VIP / Guest"><select className="input" value={f.contactId} onChange={set('contactId')}>{vips.map(c=><option key={c.id} value={c.id}>{displayName(c)}</option>)}</select></Field>
    <Field label="Volunteer"><select className="input" value={f.volunteerId} onChange={set('volunteerId')}>{vols.map(v=><option key={v.id} value={v.id}>{v.name}</option>)}</select></Field>
    <div className="grid2"><Field label="Day"><input className="input" type="date" value={f.day} onChange={set('day')}/></Field><Field label="Shift"><select className="input" value={f.shift} onChange={set('shift')}>{SHIFTS.map(s=><option key={s}>{s}</option>)}</select></Field></div>
    <Field label="Handover notes (diet, preferences, special instructions)"><input className="input" value={f.notes} onChange={set('notes')} placeholder="e.g. Vegetarian (Jain). Call office 30 min before pickup."/></Field>
  </Modal>);
}

/* ============================ DEPARTMENTS & TASKS ============================ */
export function Depts({ store, activeEventId }) {
  const toast=useToast();
  const[modal,setModal]=useState(null);
  const depts=S(store,'departments'),tasks=S(store,'tasks'),vols=S(store,'volunteers');
  const dName=id=>depts.find(d=>d.id===id)?.name||'—';
  const vName=id=>vols.find(v=>v.id===id)?.name||'—';
  return(
    <>
      <div className="page-head"><div className="ph-txt"><h1>Departments & Tasks</h1></div></div>
      <div className="panel"><div className="panel-head"><h2>Departments</h2><div className="right"><button className="btn primary sm" onClick={()=>setModal({type:'add-d'})}>{ICON.plus}Add</button></div></div>
        <div className="panel-body"><table><thead><tr><th>Department</th><th>HOD(s)</th><th>Open tasks</th><th></th></tr></thead><tbody>
          {depts.map(d=>{const hods=(d.hodIds||[]).map(id=>vName(id)).filter(x=>x!=='—').join(', ');const open=tasks.filter(t=>t.deptId===d.id&&t.status!=='Done').length;
            return<tr key={d.id}><td><div className="nm">{d.name}</div><div className="role">{d.desc}</div></td><td className="muted-sm">{hods||'—'}</td><td><span className={'badge '+(open?'b-open':'b-done')}>{open} open</span></td>
              <td><div className="rowacts"><button className="btn ghost xs" onClick={()=>setModal({type:'edit-d',item:d})}>{ICON.edit}</button><button className="btn ghost xs" onClick={()=>setModal({type:'del-d',item:d})}>{ICON.trash}</button></div></td></tr>;
          })}
          {!depts.length&&<tr><td colSpan="4"><Empty title="No departments yet" sub="Add your first department."/></td></tr>}
        </tbody></table></div></div>
      <div className="panel"><div className="panel-head"><h2>Tasks</h2><div className="right">
        <button className="btn sm" onClick={()=>setModal({type:'import-t'})}>{ICON.upload}Import Excel</button>
        <button className="btn primary sm" onClick={()=>setModal({type:'add-t'})}>{ICON.plus}Add task</button>
      </div></div>
        <div className="panel-body"><table><thead><tr><th>Task</th><th>Department</th><th>Owner</th><th>Due</th><th>Status</th><th></th></tr></thead><tbody>
          {tasks.map(t=>{
            const blockers=(t.blockedBy||[]).map(id=>tasks.find(x=>x.id===id)).filter(Boolean).filter(b=>b.status!=='Done');
            const isBlocked=blockers.length>0;
            return(<tr key={t.id}><td>
              <div className="nm">{t.title}</div>
              {isBlocked&&<div className="role" style={{color:'var(--rose)'}}>⛔ Blocked by: {blockers.map(b=>b.title).join(', ')}</div>}
              {!isBlocked&&(t.connected||[]).length>0&&<div className="role">Linked: {(t.connected||[]).map(id=>dName(id)).filter(x=>x!=='—').join(', ')}</div>}
            </td>
              <td className="muted-sm">{dName(t.deptId)}</td><td className="muted-sm">{vName(t.assigneeId)}</td><td className="muted-sm">{shortDate(t.due)}</td>
              <td><select className="statsel" value={t.status} disabled={isBlocked}
                onChange={e=>!isBlocked&&saveItem('tasks',{...t,status:e.target.value})}
                style={isBlocked?{opacity:.5,cursor:'not-allowed'}:{}}>{TASK_STATUS.map(s=><option key={s}>{s}</option>)}</select></td>
              <td><div className="rowacts"><button className="btn ghost xs" onClick={()=>setModal({type:'edit-t',item:t})}>{ICON.edit}</button><button className="btn ghost xs" onClick={()=>setModal({type:'del-t',item:t})}>{ICON.trash}</button></div></td></tr>);
          })}
          {!tasks.length&&<tr><td colSpan="6"><Empty title="No tasks yet" sub="Add the first task."/></td></tr>}
        </tbody></table></div></div>
      {(modal?.type==='add-d'||modal?.type==='edit-d')&&<DeptModal item={modal.item} vols={vols} onClose={()=>setModal(null)} toast={toast}/>}
      {(modal?.type==='add-t'||modal?.type==='edit-t')&&<TaskModal item={modal.item} depts={depts} vols={vols} tasks={tasks} activeEventId={activeEventId} onClose={()=>setModal(null)} toast={toast}/>}
      {modal?.type==='del-d'&&<DeleteModal label={modal.item.name} onClose={()=>setModal(null)} onConfirm={async()=>{await removeItem('departments',modal.item.id);tasks.filter(t=>t.deptId===modal.item.id).forEach(t=>removeItem('tasks',t.id));setModal(null);toast('Department deleted.');}}/>}
      {modal?.type==='del-t'&&<DeleteModal label={modal.item.title} onClose={()=>setModal(null)} onConfirm={async()=>{await removeItem('tasks',modal.item.id);setModal(null);toast('Task deleted.');}}/>}
      {modal?.type==='import-t'&&<GenericImportModal title="Import tasks" store={store} activeEventId={activeEventId} onClose={()=>setModal(null)} toast={toast} parseFile={parseTasksFile} planFn={planTasksImport} existingItems={tasks} itemLabel="tasks" buildItem={item=>({...item,eventId:activeEventId,deptId:item.deptId||depts[0]?.id||''})}/>}
    </>
  );
}
function DeptModal({item,vols,onClose,toast}){
  const[f,setF]=useState(()=>({name:'',desc:'',hodIds:[],...item}));
  const set=k=>e=>setF(p=>({...p,[k]:e.target.value}));
  const toggleHod=id=>setF(p=>({...p,hodIds:p.hodIds.includes(id)?p.hodIds.filter(x=>x!==id):[...p.hodIds,id]}));
  async function save(){if(!f.name.trim())return;await saveItem('departments',f);onClose();toast(item?'Department updated.':'Department added.');}
  return(<Modal title={item?'Edit department':'Add department'} onClose={onClose} onSave={save} saveLabel={item?'Save changes':'Add'}>
    <Field label="Name"><input className="input" value={f.name} onChange={set('name')}/></Field>
    <Field label="Description"><input className="input" value={f.desc} onChange={set('desc')}/></Field>
    <Field label="HOD(s)"><div>{vols.map(v=><label className="chk" key={v.id}><input type="checkbox" checked={f.hodIds.includes(v.id)} onChange={()=>toggleHod(v.id)}/> {v.name}</label>)}</div></Field>
  </Modal>);
}
function TaskModal({item,depts,vols,tasks,activeEventId,onClose,toast}){
  const[f,setF]=useState(()=>({title:'',deptId:depts[0]?.id||'',assigneeId:'',due:'',status:'Open',connected:[],blockedBy:[],notes:'',...item}));
  const set=k=>e=>setF(p=>({...p,[k]:e.target.value}));
  const toggleCon=id=>setF(p=>({...p,connected:p.connected.includes(id)?p.connected.filter(x=>x!==id):[...p.connected,id]}));
  const toggleBlockedBy=id=>setF(p=>({...p,blockedBy:(p.blockedBy||[]).includes(id)?(p.blockedBy||[]).filter(x=>x!==id):[...(p.blockedBy||[]),id]}));
  const otherTasks=(tasks||[]).filter(t=>t.id!==item?.id);
  async function save(){if(!f.title.trim())return;await saveItem('tasks',{...f,eventId:activeEventId});onClose();toast(item?'Task updated.':'Task added.');}
  return(<Modal title={item?'Edit task':'Add task'} onClose={onClose} onSave={save} saveLabel={item?'Save changes':'Add task'}>
    <Field label="Task"><input className="input" value={f.title} onChange={set('title')}/></Field>
    <div className="grid2">
      <Field label="Department"><select className="input" value={f.deptId} onChange={set('deptId')}>{depts.map(d=><option key={d.id} value={d.id}>{d.name}</option>)}</select></Field>
      <Field label="Owner"><select className="input" value={f.assigneeId} onChange={set('assigneeId')}><option value="">—</option>{vols.map(v=><option key={v.id} value={v.id}>{v.name}</option>)}</select></Field>
      <Field label="Due date"><input className="input" type="date" value={f.due} onChange={set('due')}/></Field>
      <Field label="Status"><select className="input" value={f.status} onChange={set('status')}>{TASK_STATUS.map(s=><option key={s}>{s}</option>)}</select></Field>
    </div>
    <Field label="Connected departments"><div>{depts.map(d=><label className="chk" key={d.id}><input type="checkbox" checked={f.connected.includes(d.id)} onChange={()=>toggleCon(d.id)}/> {d.name}</label>)}</div></Field>
    {otherTasks.length>0&&<Field label="Blocked by (cannot start until these are Done)">
      <div>{otherTasks.map(t=><label className="chk" key={t.id}><input type="checkbox" checked={(f.blockedBy||[]).includes(t.id)} onChange={()=>toggleBlockedBy(t.id)}/> {t.title}</label>)}</div>
    </Field>}
    <Field label="Notes"><input className="input" value={f.notes} onChange={set('notes')}/></Field>
  </Modal>);
}

/* ============================ GENERATE ============================ */
export function Reports({ store }) {
  const toast=useToast();
  const[mode,setMode]=useState('personal');
  const confirmed=S(store,'contacts').filter(c=>c.status==='Confirmed');
  return(
    <>
      <div className="page-head"><div className="ph-txt"><h1>Generate schedules</h1><p>Documents built from live data. Change anything upstream and regenerate.</p></div></div>
      <div className="subnav">
        <button className={mode==='personal'?'active':''} onClick={()=>setMode('personal')}>Personalised</button>
        <button className={mode==='event'?'active':''} onClick={()=>setMode('event')}>Event schedule</button>
        <button className={mode==='founder'?'active':''} onClick={()=>setMode('founder')}>Founder's day</button>
      </div>
      {mode==='personal'&&<PersonalReport store={store} confirmed={confirmed} toast={toast}/>}
      {mode==='event'&&<EventScheduleReport store={store}/>}
      {mode==='founder'&&<FounderReport store={store}/>}
    </>
  );
}
const tagClass=src=>({Logistics:'t-log',Session:'t-ses',Founder:'t-fnd',Hospitality:'t-hos'}[src]||'t-hos');
function PersonalReport({store,confirmed,toast}){
  const[cid,setCid]=useState(confirmed[0]?.id||'');
  const[showSrc,setShowSrc]=useState(false);
  const[emailModal,setEmailModal]=useState(false);
  if(!confirmed.length) return <div className="panel"><Empty title="No confirmed guests yet" sub="Confirm an invitee in Outreach to generate their schedule."/></div>;
  const c=confirmed.find(x=>x.id===cid)||confirmed[0];
  const sch=buildPersonalSchedule(c,store);
  return(<>
    <div className={'rep '+(showSrc?'show-src':'')}>
      <div className="repbar">
        <label className="muted-sm" style={{fontWeight:500}}>Guest</label>
        <select className="input" style={{width:'auto',minWidth:220}} value={c.id} onChange={e=>setCid(e.target.value)}>{confirmed.map(x=><option key={x.id} value={x.id}>{displayName(x)}</option>)}</select>
        <button className="btn primary sm" onClick={()=>toast('Schedule generated.')}>{ICON.spark}Generate</button>
        <button className="btn sm" onClick={()=>window.print()}>{ICON.print}Print / Save PDF</button>
        <button className="btn sm" onClick={()=>setEmailModal(true)}>✉ Send by email</button>
        <div className="srctoggle" style={{marginLeft:'auto'}}><span>Show sources</span><button className={'switch '+(showSrc?'on':'')} onClick={()=>setShowSrc(s=>!s)}><i/></button></div>
      </div>
      <div className="legend"><span className="tag t-log">Logistics</span><span className="tag t-ses">Session</span><span className="tag t-fnd">Founder</span><span className="tag t-hos">Hospitality</span></div>
      <div className="doc print-target">
        <div className="doc-kicker">Vasudhaiva Kutumbakam Ki Oar 4.0</div><h2>Personalised Schedule</h2><div className="doc-name">{displayName(c)}</div>
        {sch.days.length?sch.days.map(d=>(
          <div className="day" key={d}><div className="day-h">{fmtDate(d)}</div>
            {sch.byDay[d].map((e,i)=><div className="row" key={i}><div className="tm">{e.time}</div><div className="ac">{e.label}{e.sub&&<small>{e.sub}</small>}</div><div><span className={'tag '+tagClass(e.src)}>{e.src}</span></div></div>)}
          </div>
        )):<div className="empty"><p>No travel, sessions or meetings recorded yet.</p></div>}
        {sch.stay&&<div className="stay"><b>Stay:</b> {sch.stay}</div>}
      </div>
    </div>
    {emailModal&&<ScheduleEmailModal contact={c} scheduleHtml={''} onClose={()=>setEmailModal(false)} toast={toast}/>}
  </>);
}
function EventScheduleReport({store}){
  const ev=buildEventSchedule(store);
  return(<><div className="repbar"><button className="btn sm" onClick={()=>window.print()}>{ICON.print}Print / Save PDF</button></div>
    <div className="doc print-target"><div className="doc-kicker">Vasudhaiva Kutumbakam Ki Oar 4.0</div><h2>Event Schedule</h2>
      {ev.days.map(d=><div className="day" key={d}><div className="day-h">{fmtDate(d)}</div>{ev.byDay[d].map(s=><div className="row" key={s.id}><div className="tm">{s.start}{s.end?'–'+s.end:''}</div><div className="ac">{s.title}{s.topic&&<small>Topic: {s.topic}</small>}</div><div/></div>)}</div>)}
    </div></>);
}
function FounderReport({store}){
  const fs=buildFounderSchedule(store);
  return(<><div className="repbar"><button className="btn sm" onClick={()=>window.print()}>{ICON.print}Print / Save PDF</button></div>
    <div className="doc print-target"><div className="doc-kicker">Vasudhaiva Kutumbakam Ki Oar 4.0</div><h2>Founder's Schedule</h2><div className="doc-name">One-on-one meetings</div>
      {fs.days.length?fs.days.map(d=><div className="day" key={d}><div className="day-h">{fmtDate(d)}</div>{fs.byDay[d].map((e,i)=><div className="row" key={i}><div className="tm">{e.time}</div><div className="ac">{e.label}<small>at VIP Lounge</small></div><div/></div>)}</div>):<div className="empty"><p>No meetings scheduled yet.</p></div>}
    </div></>);
}

function DeleteModal({label,onClose,onConfirm}){
  return(<Modal title="Delete?" onClose={onClose} size="sm" footer={null}>
    <p>Delete <b>{label}</b>? This cannot be undone.</p>
    <div className="modal-foot" style={{padding:'14px 0 0'}}>
      <button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn danger" onClick={onConfirm}>Delete</button>
    </div>
  </Modal>);
}

/* ============================ CONTROL ROOM ============================ */
export function ControlRoom({ store }) {
  const contacts = (store.contacts||[]).filter(c=>c.status==='Confirmed');
  const logi = store.logistics||[];
  const poc = store.poc||[];
  const vols = store.volunteers||[];
  const sessions = store.sessions||[];
  const assigns = store.assignments||[];

  const today = new Date().toISOString().slice(0,10);

  const getL = cid => logi.find(x=>x.contactId===cid||x.id===cid)||{};
  const getPOC = (cid, day) => {
    const p = poc.find(x=>x.contactId===cid&&x.day===day);
    return p ? vols.find(v=>v.id===p.volunteerId) : null;
  };
  const getSessions = cid => assigns.filter(a=>a.contactId===cid).map(a=>sessions.find(s=>s.id===a.sessionId)).filter(Boolean);

  const arriving = contacts.filter(c=>{ const L=getL(c.id); return L.inbDate===today; });
  const departing = contacts.filter(c=>{ const L=getL(c.id); return L.outDate===today; });
  const onsite = contacts.filter(c=>{ const L=getL(c.id); return L.inbDate&&L.outDate&&L.inbDate<=today&&L.outDate>=today; });
  const todaySessions = sessions.filter(s=>s.date===today).sort((a,b)=>toMin(a.start)-toMin(b.start));

  return <>
    <div className="page-head"><div className="ph-txt"><h1>Control Room</h1><p>Live event-day view — who is arriving, on-site, and in which session right now.</p></div></div>

    {todaySessions.length>0&&<div className="cr-section">
      <h3>Today's sessions</h3>
      <div className="cr-grid">
        {todaySessions.map(s=>{
          const speakers = assigns.filter(a=>a.sessionId===s.id).map(a=>contacts.find(c=>c.id===a.contactId)).filter(Boolean);
          return <div className="cr-card" key={s.id}>
            <div className="cr-name"><span className="mono" style={{fontSize:12}}>{s.start}{s.end?'–'+s.end:''}</span> {s.title}</div>
            {s.topic&&<div className="cr-detail">Topic: {s.topic}</div>}
            {speakers.length>0&&<div className="cr-detail" style={{marginTop:6}}>Speakers: {speakers.map(c=>c.name).join(', ')}</div>}
          </div>;
        })}
      </div>
    </div>}

    <div className="cr-section">
      <h3>Arriving today {arriving.length>0&&<span className="badge b-pending" style={{marginLeft:8,fontSize:11}}>{arriving.length}</span>}</h3>
      {arriving.length>0?<div className="cr-grid">{arriving.map(c=>{
        const L=getL(c.id); const poc=getPOC(c.id,today);
        return <div className="cr-card" key={c.id}>
          <div className="cr-name"><div className="avatar" style={{width:26,height:26,fontSize:10}}>{initials(c.name)}</div>{displayName(c)}</div>
          <div className="cr-detail">{L.inbMode} · {L.inbTime} · {L.inbLoc||'—'}</div>
          {L.hotel&&<div className="cr-detail">Hotel: {L.hotel} · Check-in {L.checkin||'—'}</div>}
          <div className="cr-poc">{poc?<><div className="avatar av">{initials(poc.name)}</div><span>POC: {poc.name}</span></>:<span style={{color:'var(--rose)'}}>⚠ No POC assigned</span>}</div>
        </div>;
      })}</div>:<div className="muted-sm" style={{padding:'12px 0'}}>No arrivals scheduled for today.</div>}
    </div>

    <div className="cr-section">
      <h3>On-site {onsite.length>0&&<span className="badge b-confirmed" style={{marginLeft:8,fontSize:11}}>{onsite.length}</span>}</h3>
      {onsite.length>0?<div className="cr-grid">{onsite.map(c=>{
        const myS=getSessions(c.id).filter(s=>s.date===today);
        const poc=getPOC(c.id,today);
        return <div className="cr-card" key={c.id}>
          <div className="cr-name"><div className="avatar" style={{width:26,height:26,fontSize:10}}>{initials(c.name)}</div>{displayName(c)}<span className="cr-status">{sbadge('Confirmed')}</span></div>
          <div className="cr-detail">{c.type} · {c.field}</div>
          {myS.length>0&&<div className="cr-detail" style={{marginTop:4}}>Sessions: {myS.map(s=>s.start+' '+s.title).join(' · ')}</div>}
          <div className="cr-poc">{poc?<><div className="avatar av">{initials(poc.name)}</div><span>POC: {poc.name}</span></>:<span style={{color:'var(--rose)'}}>⚠ No POC assigned</span>}</div>
        </div>;
      })}</div>:<div className="muted-sm" style={{padding:'12px 0'}}>No guests on-site today.</div>}
    </div>

    <div className="cr-section">
      <h3>Departing today {departing.length>0&&<span className="badge b-pending" style={{marginLeft:8,fontSize:11}}>{departing.length}</span>}</h3>
      {departing.length>0?<div className="cr-grid">{departing.map(c=>{
        const L=getL(c.id);
        return <div className="cr-card" key={c.id}>
          <div className="cr-name"><div className="avatar" style={{width:26,height:26,fontSize:10}}>{initials(c.name)}</div>{displayName(c)}</div>
          <div className="cr-detail">Departs {L.outDepart||'—'}{L.outFlight?' · Flight '+L.outFlight:''}</div>
        </div>;
      })}</div>:<div className="muted-sm" style={{padding:'12px 0'}}>No departures scheduled for today.</div>}
    </div>

    {!arriving.length&&!onsite.length&&!departing.length&&!todaySessions.length&&
      <div className="panel"><div className="empty">{ICON.cal}<h3>Nothing scheduled for today</h3><p>Add logistics and session dates in Logistics and Scheduling to see the live event view here.</p></div></div>}
  </>;
}

/* ============================ FELICITATION KITS ============================ */
export function FelicitationKits({ store, activeEventId }) {
  const toast = useToast();
  const contacts = (store.contacts||[]).filter(c=>c.status==='Confirmed'||c.status==='VIP');
  const kits = store.felicitation || [];
  const getKit = cid => kits.find(k=>k.contactId===cid) || {contactId:cid, eventId:activeEventId};
  const ITEMS = ['Momento','Shawl','Kumkum','Cover','Gold Coin','Silver Coin','Frame'];
  const key = item => item.toLowerCase().replace(/ /g,'_');

  const toggle = async (c, item) => {
    const k = getKit(c.id);
    const updated = {...k, [key(item)]: !k[key(item)]};
    await saveItem('felicitation', updated);
  };

  const totalNeeded = contacts.length;
  const totalReady = kits.filter(k=>ITEMS.every(i=>k[key(i)])).length;

  if (!contacts.length) return (
    <>
      <div className="page-head"><div className="ph-txt"><h1>Felicitation Kits</h1></div></div>
      <div className="panel"><Empty title="No confirmed guests yet" sub="Confirm guests in Outreach to track their felicitation kits."/></div>
    </>
  );

  return (
    <>
      <div className="page-head"><div className="ph-txt"><h1>Felicitation Kits</h1><p>Track which items are ready for each guest. Tick each item when it is packed and ready.</p></div></div>
      <div className="cards">
        <div className="stat"><div className="lab">{ICON.users}Guests</div><div className="val">{totalNeeded}</div><div className="hint">confirmed guests</div></div>
        <div className="stat"><div className="lab">{ICON.check}Fully ready</div><div className="val">{totalReady}</div><div className="hint">all items packed</div></div>
        {ITEMS.map(item=>{
          const readyCount = kits.filter(k=>k[key(item)]).length;
          return <div className="stat" key={item}><div className="lab">{item}</div><div className="val">{readyCount}<span style={{fontSize:14,color:'var(--muted)'}}>/{totalNeeded}</span></div><div className="hint">ready</div></div>;
        })}
      </div>
      <div className="panel">
        <div className="panel-head"><h2>Kit checklist</h2><div className="desc">Tick each item when packed</div></div>
        <div className="panel-body" style={{overflowX:'auto'}}>
          <table style={{minWidth:700}}>
            <thead><tr>
              <th>Guest</th>
              {ITEMS.map(i=><th key={i} style={{textAlign:'center'}}>{i}</th>)}
              <th>Status</th>
            </tr></thead>
            <tbody>
              {contacts.map(c=>{
                const k=getKit(c.id);
                const allDone=ITEMS.every(i=>k[key(i)]);
                return <tr key={c.id}>
                  <td><div className="person"><div className="avatar">{initials(c.name)}</div><div><div className="nm">{displayName(c)}</div><div className="role">{c.type}</div></div></div></td>
                  {ITEMS.map(item=>(
                    <td key={item} style={{textAlign:'center'}}>
                      <input type="checkbox" checked={!!k[key(item)]} onChange={()=>toggle(c,item)} style={{width:16,height:16,accentColor:'var(--teal)',cursor:'pointer'}}/>
                    </td>
                  ))}
                  <td>{allDone?<span className="badge b-confirmed">Ready ✓</span>:<span className="badge b-pending">Pending</span>}</td>
                </tr>;
              })}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

/* ============================ VOLUNTEER AVAILABILITY ============================ */
export function VolunteerAvailability({ store, activeEventId }) {
  const toast = useToast();
  const vols = store.volunteers || [];
  const [modal, setModal] = useState(null);
  const activeEvent = (store.events||[]).find(e=>e.id===activeEventId);

  // Generate date range for the event
  function eventDates() {
    if (!activeEvent?.startDate) return [];
    const dates=[]; let d=new Date(activeEvent.startDate+'T00:00:00');
    // include 3 pre-event days
    const pre=new Date(d); pre.setDate(pre.getDate()-3);
    const end=new Date((activeEvent.endDate||activeEvent.startDate)+'T00:00:00');
    let cur=new Date(pre); let g=0;
    while(cur<=end&&g<30){ dates.push(cur.toISOString().slice(0,10)); cur=new Date(cur); cur.setDate(cur.getDate()+1); g++; }
    return dates;
  }
  const dates = eventDates();
  const SLOTS = ['Full Day','Morning','Afternoon','Evening','Not Available'];
  const slotColor = s => ({
    'Full Day':'var(--teal)','Morning':'var(--blue)','Afternoon':'var(--amber)',
    'Evening':'var(--purple)','Not Available':'var(--rose)'
  }[s]||'var(--muted)');

  const getAvail = (v,date) => {
    const a = v.availability || {};
    return a[date] || '';
  };
  const setAvail = async (v, date, slot) => {
    const avail = {...(v.availability||{}), [date]:slot};
    await saveItem('volunteers', {...v, availability:avail});
  };

  return (
    <>
      <div className="page-head"><div className="ph-txt"><h1>Volunteer Availability</h1><p>Mark which volunteers are available on each day. This feeds the smart POC allotment.</p></div></div>
      {!dates.length && <div className="flow-note">{ICON.info}<div>Set start and end dates on your event (Events tab) to see the availability grid.</div></div>}
      {dates.length>0 && (
        <div className="panel">
          <div className="panel-head"><h2>Availability grid</h2>
            <div className="right">
              <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
                {['Full Day','Morning','Afternoon','Evening','Not Available'].map(s=>(
                  <span key={s} style={{fontSize:11,padding:'2px 8px',borderRadius:20,background:slotColor(s)+'22',color:slotColor(s),fontWeight:600}}>{s}</span>
                ))}
              </div>
            </div>
          </div>
          <div className="panel-body" style={{overflowX:'auto'}}>
            <table style={{minWidth:Math.max(600,dates.length*80+200)}}>
              <thead><tr>
                <th style={{minWidth:160}}>Volunteer</th>
                {dates.map(d=>{
                  const isEvent = activeEvent && d>=activeEvent.startDate && d<=(activeEvent.endDate||activeEvent.startDate);
                  return <th key={d} style={{textAlign:'center',minWidth:70,fontSize:10,background:isEvent?'var(--teal-wash)':''}}>
                    <div>{shortDate(d)}</div>
                    {isEvent&&<div style={{color:'var(--teal)',fontSize:9,fontWeight:700}}>EVENT</div>}
                  </th>;
                })}
              </tr></thead>
              <tbody>
                {vols.map(v=>(
                  <tr key={v.id}>
                    <td><div className="person"><div className="avatar">{initials(v.name)}</div><div><div className="nm">{v.name}</div><div className="role">{v.skills}</div></div></div></td>
                    {dates.map(d=>{
                      const slot=getAvail(v,d);
                      return <td key={d} style={{textAlign:'center',padding:'6px 4px'}}>
                        <select style={{fontSize:11,padding:'2px 4px',borderRadius:6,border:'1px solid var(--line)',background:slot?slotColor(slot)+'22':'#fff',color:slot?slotColor(slot):'var(--muted)',fontWeight:slot?600:400,cursor:'pointer',width:'100%'}}
                          value={slot} onChange={e=>setAvail(v,d,e.target.value)}>
                          <option value="">—</option>
                          {SLOTS.map(s=><option key={s} value={s}>{s}</option>)}
                        </select>
                      </td>;
                    })}
                  </tr>
                ))}
                {!vols.length&&<tr><td colSpan={dates.length+1}><Empty title="No volunteers yet" sub="Add volunteers in the Volunteers & POC module."/></td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}

/* ============================ SMART POC ALLOTMENT ============================ */
export function SmartPOC({ store, activeEventId }) {
  const toast = useToast();
  const contacts = (store.contacts||[]).filter(c=>c.status==='Confirmed');
  const vols = store.volunteers||[];
  const logi = store.logistics||[];
  const poc = store.poc||[];
  const activeEvent = (store.events||[]).find(e=>e.id===activeEventId);

  // get days a VIP is present from logistics
  function vipDays(c) {
    const L=logi.find(x=>x.contactId===c.id||x.id===c.id)||{};
    if(!L.inbDate||!L.outDate) return [];
    const dates=[]; let d=new Date(L.inbDate+'T00:00:00'); const end=new Date(L.outDate+'T00:00:00'); let g=0;
    while(d<=end&&g<20){ dates.push(d.toISOString().slice(0,10)); d=new Date(d); d.setDate(d.getDate()+1); g++; }
    return dates;
  }
  // get volunteers available on a day
  function availVols(day) {
    return vols.filter(v=>{
      const slot=(v.availability||{})[day];
      return slot&&slot!=='Not Available';
    });
  }
  // get existing POC for a VIP on a day
  function existingPOC(cid,day) { return poc.find(p=>p.contactId===cid&&p.day===day); }

  async function assign(cid, vid, day) {
    const ex=existingPOC(cid,day);
    if(ex) await saveItem('poc',{...ex,volunteerId:vid,status:'Active'});
    else await saveItem('poc',{contactId:cid,volunteerId:vid,day,shift:'Full day',eventId:activeEventId,status:'Active'});
    toast('POC assigned.');
  }
  async function autoAssign() {
    let count=0;
    for(const c of contacts) {
      const days=vipDays(c);
      for(const day of days) {
        if(existingPOC(c.id,day)) continue;
        const avail=availVols(day);
        if(!avail.length) continue;
        // pick least-loaded volunteer
        const loads={};
        avail.forEach(v=>{ loads[v.id]=(poc.filter(p=>p.volunteerId===v.id&&p.day===day).length); });
        const best=avail.sort((a,b)=>(loads[a.id]||0)-(loads[b.id]||0))[0];
        await saveItem('poc',{contactId:c.id,volunteerId:best.id,day,shift:'Full day',eventId:activeEventId,status:'Active'});
        count++;
      }
    }
    toast(`Auto-assigned ${count} POC slots.`);
  }

  return (
    <>
      <div className="page-head"><div className="ph-txt"><h1>Smart POC Allotment</h1><p>See which volunteers are free for each VIP's visit days and assign with one click.</p></div>
        <button className="btn primary" onClick={autoAssign}>{ICON.spark}Auto-assign all gaps</button>
      </div>
      {!contacts.length&&<div className="panel"><Empty title="No confirmed guests" sub="Confirm guests in Outreach first."/></div>}
      {contacts.map(c=>{
        const days=vipDays(c);
        if(!days.length) return <div className="panel" key={c.id}>
          <div className="panel-head"><div className="nm">{displayName(c)}</div><div className="desc muted-sm" style={{marginLeft:8}}>No logistics dates set — add arrival and departure in Logistics.</div></div>
        </div>;
        return <div className="panel" key={c.id}>
          <div className="panel-head"><div className="person"><div className="avatar">{initials(c.name)}</div><div><div className="nm">{displayName(c)}</div><div className="role">{c.type} · {c.field}</div></div></div></div>
          <div className="panel-body">
            <table><thead><tr><th>Day</th><th>POC assigned</th><th>Available volunteers</th><th></th></tr></thead><tbody>
              {days.map(day=>{
                const ex=existingPOC(c.id,day); const exVol=ex?vols.find(v=>v.id===ex.volunteerId):null;
                const avail=availVols(day);
                return <tr key={day}>
                  <td className="muted-sm">{shortDate(day)}</td>
                  <td>{exVol?<div className="person"><div className="avatar" style={{width:26,height:26,fontSize:10}}>{initials(exVol.name)}</div><div className="nm">{exVol.name}</div></div>:<span style={{color:'var(--rose)',fontSize:13}}>⚠ Not assigned</span>}</td>
                  <td>
                    {avail.length?<select className="statsel" value={ex?.volunteerId||''} onChange={e=>e.target.value&&assign(c.id,e.target.value,day)}>
                      <option value="">Pick volunteer…</option>
                      {avail.map(v=>{
                        const load=poc.filter(p=>p.volunteerId===v.id&&p.day===day).length;
                        return <option key={v.id} value={v.id}>{v.name} ({(v.availability||{})[day]}) — {load} VIP{load!==1?'s':''}</option>;
                      })}
                    </select>:<span className="muted-sm">No volunteers available</span>}
                  </td>
                  <td>{ex&&<button className="btn ghost xs" onClick={async()=>{await removeItem('poc',ex.id);toast('POC removed.');}}>Remove</button>}</td>
                </tr>;
              })}
            </tbody></table>
          </div>
        </div>;
      })}
    </>
  );
}

/* ============================ GENERIC IMPORT MODAL ============================ */
export function GenericImportModal({ title, store, activeEventId, onClose, toast,
  parseFile, planFn, existingItems, itemLabel, buildItem }) {
  const [step, setStep] = useState('choose');
  const [plan, setPlan] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function handleFile(file) {
    setErr('');
    try {
      const {items} = await parseFile(file);
      if (!items.length) { setErr('No matching rows found. Check your column headers match the expected format, or download the template.'); return; }
      const p = planFn(items, existingItems);
      setPlan(p); setStep('preview');
    } catch(e) { setErr('Could not read file: '+(e.message||e)); }
  }
  async function commit() {
    setBusy(true);
    try {
      const {batchUpsert} = await import('./data');
      const items = plan.plan.map(p=>buildItem(p.item));
      await batchUpsert(itemLabel, items);
      onClose(); toast(`Import complete — ${plan.newCount} added, ${plan.updateCount} updated.`);
    } catch(e) { setErr('Save failed: '+(e.message||e)); setBusy(false); }
  }
  return (
    <Modal title={title} onClose={onClose} footer={null}>
      {err&&<div style={{background:'var(--rose-wash)',color:'var(--rose)',padding:'9px 12px',borderRadius:8,fontSize:13,marginBottom:12}}>{err}</div>}
      {step==='choose'&&<>
        <p className="muted-sm" style={{marginTop:0}}>Upload an .xlsx or .csv. Columns are matched automatically.</p>
        <label className="dropzone">
          <span style={{display:'flex',justifyContent:'center'}}>{ICON.upload}</span>
          <div>Click to choose a file</div>
          <input type="file" accept=".xlsx,.xls,.csv" style={{display:'none'}} onChange={e=>handleFile(e.target.files[0])}/>
        </label>
        <div style={{marginTop:12,textAlign:'center'}}>
          <button className="linkbtn" onClick={()=>downloadTemplate(itemLabel)}>Download blank template</button>
        </div>
        <div className="modal-foot" style={{padding:'12px 0 0'}}><button className="btn" onClick={onClose}>Cancel</button></div>
      </>}
      {step==='preview'&&plan&&<>
        <div style={{display:'flex',gap:18,marginBottom:10}}>
          <div><div style={{fontFamily:'var(--serif)',fontSize:26,color:'var(--teal)'}}>{plan.newCount}</div><div className="muted-sm">new</div></div>
          <div><div style={{fontFamily:'var(--serif)',fontSize:26,color:'var(--amber)'}}>{plan.updateCount}</div><div className="muted-sm">overwrite</div></div>
        </div>
        <div style={{maxHeight:'36vh',overflow:'auto',border:'1px solid var(--line)',borderRadius:8}}>
          <table className="import-tbl"><thead><tr><th>Name / Title</th><th>Result</th></tr></thead><tbody>
            {plan.plan.slice(0,60).map((p,i)=><tr key={i}><td>{p.name}</td><td>{p.mode==='new'?<span className="pill-new">New</span>:<span className="pill-upd">Overwrite</span>}</td></tr>)}
          </tbody></table>
        </div>
        <div className="modal-foot" style={{padding:'12px 0 0'}}>
          <button className="btn" onClick={()=>setStep('choose')}>Back</button>
          <button className="btn primary" onClick={commit} disabled={busy}>{busy?'Importing…':`Import ${plan.plan.length} rows`}</button>
        </div>
      </>}
    </Modal>
  );
}

/* ============================ SCHEDULE EMAIL ============================ */
export function ScheduleEmailModal({ contact, scheduleHtml, onClose, toast }) {
  const [email, setEmail] = useState(contact.email||'');
  const [subject, setSubject] = useState(`Your Personalised Schedule — VK Event`);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  async function send() {
    if (!email.trim()) return;
    setBusy(true);
    try {
      // Use EmailJS — user needs to set up a free account at emailjs.com
      // and update these IDs. For now we show the email content for manual sending.
      const body = scheduleHtml;
      // Fallback: open in mail client
      const mailto = `mailto:${email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent('Please find your personalised schedule attached.\n\nFor the full formatted schedule, please contact the organising team.')}`;
      window.open(mailto);
      setSent(true);
      toast(`Email client opened for ${email}`);
    } catch(e) { toast('Could not open email client.'); }
    finally { setBusy(false); }
  }

  return (
    <Modal title="Send schedule by email" onClose={onClose} size="sm" footer={null}>
      {sent
        ? <div style={{textAlign:'center',padding:'20px 0'}}>
            <div style={{fontSize:32,marginBottom:10}}>✉️</div>
            <div style={{fontFamily:'var(--serif)',fontSize:18,marginBottom:8}}>Email client opened</div>
            <p className="muted-sm">Your default email app has opened with the message pre-filled. Send it from there.</p>
            <div style={{marginTop:16}}><button className="btn primary" onClick={onClose}>Done</button></div>
          </div>
        : <>
          <Field label="Recipient email"><input className="input" type="email" value={email} onChange={e=>setEmail(e.target.value)} placeholder="guest@example.com"/></Field>
          <Field label="Subject"><input className="input" value={subject} onChange={e=>setSubject(e.target.value)}/></Field>
          <div style={{background:'var(--teal-wash)',borderRadius:8,padding:'10px 14px',fontSize:13,color:'#1c4d3e',marginBottom:14}}>
            This will open your default email app with the details pre-filled. The formatted schedule PDF can be attached manually before sending.
          </div>
          <div className="modal-foot" style={{padding:'12px 0 0'}}>
            <button className="btn" onClick={onClose}>Cancel</button>
            <button className="btn primary" onClick={send} disabled={busy||!email}>{busy?'Opening…':'Open in email app'}</button>
          </div>
        </>}
    </Modal>
  );
}

/* ============================ FEATURE 6: EVENT DAY CHECKLIST ============================ */
export function EventDayChecklist({ store, activeEventId }) {
  const toast = useToast();
  const { user, profile } = (typeof useAuth === 'function') ? useAuth() : {user:null,profile:null};
  const contacts = (store.contacts||[]).filter(c=>c.status==='Confirmed');
  const poc = store.poc||[];
  const vols = store.volunteers||[];
  const checklists = store.checklist||[];

  const today = new Date().toISOString().slice(0,10);

  // If current user is a volunteer/POC, filter to only their assigned VIPs today
  const myVolId = vols.find(v=>v.phone===profile?.phone||v.name?.toLowerCase()===profile?.email?.split('@')[0]?.toLowerCase())?.id;
  const myVIPs = myVolId ? poc.filter(p=>p.volunteerId===myVolId&&p.day===today).map(p=>p.contactId) : null;
  const visibleContacts = myVIPs ? contacts.filter(c=>myVIPs.includes(c.id)) : contacts;

  const STEPS = [
    {key:'picked_up', label:'Picked up from airport/station', icon:'🚗'},
    {key:'hotel_checkin', label:'Checked into hotel', icon:'🏨'},
    {key:'arrived_venue', label:'Arrived at venue', icon:'📍'},
    {key:'attended_session', label:'Attended session', icon:'🎤'},
    {key:'received_kit', label:'Received felicitation kit', icon:'🎁'},
    {key:'departed', label:'Departed', icon:'✈️'},
  ];

  const getChecklist = cid => checklists.find(cl=>cl.contactId===cid&&cl.eventId===activeEventId) || {contactId:cid,eventId:activeEventId};

  async function toggle(c, stepKey) {
    const cl = getChecklist(c.id);
    const cur = cl[stepKey];
    const updated = {
      ...cl,
      [stepKey]: !cur,
      [stepKey+'_time']: !cur ? new Date().toISOString() : null,
      [stepKey+'_by']: !cur ? (profile?.email||'') : null,
    };
    await saveItem('checklist', updated);
    if (!cur) toast(`${STEPS.find(s=>s.key===stepKey)?.label} ✓`);
  }

  const progress = cl => STEPS.filter(s=>cl[s.key]).length;

  return (
    <>
      <div className="page-head"><div className="ph-txt"><h1>Event Day Checklist</h1>
        <p>Track each VIP through their day. Tap each step as it's completed — timestamped automatically.</p>
      </div></div>
      {!visibleContacts.length && <div className="panel"><Empty title="No VIPs assigned to you today" sub="POC assignments for today will appear here."/></div>}
      {visibleContacts.map(c=>{
        const cl=getChecklist(c.id); const done=progress(cl);
        const pct=Math.round((done/STEPS.length)*100);
        return (
          <div className="panel" key={c.id}>
            <div className="panel-head">
              <div className="person"><div className="avatar">{initials(c.name)}</div><div><div className="nm">{displayName(c)}</div><div className="role">{c.type} · {c.field}</div></div></div>
              <div className="right">
                <div style={{display:'flex',alignItems:'center',gap:8}}>
                  <div style={{width:100,height:6,background:'var(--line)',borderRadius:3}}>
                    <div style={{width:pct+'%',height:'100%',background:pct===100?'var(--teal-2)':'var(--teal)',borderRadius:3,transition:'width .3s'}}/>
                  </div>
                  <span className="muted-sm">{done}/{STEPS.length}</span>
                  {pct===100&&<span className="badge b-confirmed">Complete ✓</span>}
                </div>
              </div>
            </div>
            <div className="panel-pad">
              <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(260px,1fr))',gap:10}}>
                {STEPS.map(step=>{
                  const done=!!cl[step.key];
                  const time=cl[step.key+'_time'];
                  const by=cl[step.key+'_by'];
                  return (
                    <button key={step.key} onClick={()=>toggle(c,step.key)}
                      style={{display:'flex',alignItems:'center',gap:12,padding:'12px 14px',borderRadius:10,border:`2px solid ${done?'var(--teal)':'var(--line)'}`,background:done?'var(--teal-wash)':'#fff',cursor:'pointer',textAlign:'left',transition:'all .15s'}}>
                      <span style={{fontSize:22}}>{step.icon}</span>
                      <div style={{flex:1}}>
                        <div style={{fontWeight:600,fontSize:13.5,color:done?'var(--teal)':'var(--ink)'}}>{step.label}</div>
                        {done&&time&&<div style={{fontSize:11,color:'var(--muted)',marginTop:2}}>
                          {new Date(time).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}{by?' · '+by.split('@')[0]:''}
                        </div>}
                        {!done&&<div style={{fontSize:11,color:'var(--faint)',marginTop:2}}>Tap to mark done</div>}
                      </div>
                      <span style={{fontSize:18}}>{done?'✅':'⬜'}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        );
      })}
    </>
  );
}

/* ============================ FEATURE 9: FOLLOW-UP LOG PER CONTACT ============================ */
export function ContactNotesModal({ contact, store, activeEventId, onClose }) {
  const toast = useToast();
  const notes = (store.contact_notes||[])
    .filter(n=>n.contactId===contact.id)
    .sort((a,b)=>b.createdAt?.seconds-a.createdAt?.seconds||0);
  const [text, setText] = useState('');
  const [type, setType] = useState('Call');
  const [busy, setBusy] = useState(false);
  const NOTE_TYPES = ['Call','WhatsApp','Email','Meeting','Other'];
  const typeColor = t => ({Call:'var(--teal)',WhatsApp:'#25D366',Email:'var(--blue)',Meeting:'var(--purple)',Other:'var(--muted)'}[t]||'var(--muted)');

  async function addNote() {
    if (!text.trim()) return;
    setBusy(true);
    try {
      await saveItem('contact_notes', {
        contactId: contact.id,
        eventId: activeEventId,
        text: text.trim(),
        type,
        createdAt: {seconds: Math.floor(Date.now()/1000)},
        date: new Date().toISOString().slice(0,10),
      });
      setText(''); toast('Note added.');
    } finally { setBusy(false); }
  }

  return (
    <Modal title={`Follow-up log — ${displayName(contact)}`} onClose={onClose} footer={null}>
      <div style={{display:'flex',gap:8,marginBottom:14}}>
        <select className="statsel" value={type} onChange={e=>setType(e.target.value)} style={{width:'auto'}}>
          {NOTE_TYPES.map(t=><option key={t}>{t}</option>)}
        </select>
        <input className="input" style={{flex:1}} value={text} onChange={e=>setText(e.target.value)}
          placeholder="e.g. Called, said will confirm by Friday…"
          onKeyDown={e=>e.key==='Enter'&&addNote()}/>
        <button className="btn primary sm" onClick={addNote} disabled={busy||!text.trim()}>Add</button>
      </div>
      <div style={{maxHeight:'50vh',overflow:'auto',display:'flex',flexDirection:'column',gap:8}}>
        {notes.map(n=>(
          <div key={n.id} style={{padding:'10px 14px',background:'#F9F8F4',borderRadius:9,border:'1px solid var(--line)'}}>
            <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:4}}>
              <span style={{fontSize:11,fontWeight:700,color:typeColor(n.type),background:typeColor(n.type)+'18',padding:'1px 8px',borderRadius:20}}>{n.type}</span>
              <span style={{fontSize:11.5,color:'var(--muted)'}}>{fmtDate(n.date)}</span>
            </div>
            <div style={{fontSize:13.5,lineHeight:1.5}}>{n.text}</div>
          </div>
        ))}
        {!notes.length&&<div style={{textAlign:'center',color:'var(--muted)',padding:'20px 0',fontSize:13}}>No notes yet. Add the first follow-up above.</div>}
      </div>
      <div className="modal-foot" style={{padding:'12px 0 0'}}>
        <button className="btn" onClick={onClose}>Close</button>
      </div>
    </Modal>
  );
}

/* ============================ FEATURE 11: DUPLICATE DETECTION ============================ */
export function DuplicateWarningModal({ incoming, existing, onSaveAnyway, onCancel }) {
  return (
    <Modal title="Possible duplicate detected" onClose={onCancel} footer={null} size="sm">
      <div style={{background:'var(--amber-wash)',borderRadius:9,padding:'10px 14px',fontSize:13,color:'var(--amber)',marginBottom:14,fontWeight:500}}>
        ⚠ This contact looks similar to one that already exists.
      </div>
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12,marginBottom:16}}>
        <div style={{background:'#F9F8F4',borderRadius:9,padding:'12px 14px',border:'1px solid var(--line)'}}>
          <div style={{fontSize:11,fontWeight:700,color:'var(--muted)',marginBottom:6,textTransform:'uppercase',letterSpacing:'.06em'}}>New contact</div>
          <div style={{fontWeight:600,fontSize:14}}>{incoming.name}</div>
          {incoming.org&&<div style={{fontSize:12.5,color:'var(--muted)',marginTop:2}}>{incoming.org}</div>}
          {incoming.phone&&<div style={{fontSize:12.5,color:'var(--muted)',marginTop:2}}>📞 {incoming.phone}</div>}
        </div>
        <div style={{background:'var(--teal-wash)',borderRadius:9,padding:'12px 14px',border:'1px solid var(--teal-line)'}}>
          <div style={{fontSize:11,fontWeight:700,color:'var(--teal)',marginBottom:6,textTransform:'uppercase',letterSpacing:'.06em'}}>Existing contact</div>
          <div style={{fontWeight:600,fontSize:14}}>{existing.name}</div>
          {existing.org&&<div style={{fontSize:12.5,color:'var(--muted)',marginTop:2}}>{existing.org}</div>}
          {existing.phone&&<div style={{fontSize:12.5,color:'var(--muted)',marginTop:2}}>📞 {existing.phone}</div>}
          <span className={'badge b-'+existing.status.toLowerCase()} style={{marginTop:6,display:'inline-flex'}}>{existing.status}</span>
        </div>
      </div>
      <div className="modal-foot" style={{padding:'12px 0 0',justifyContent:'space-between'}}>
        <button className="btn" onClick={onCancel}>Cancel — go back</button>
        <button className="btn primary" onClick={onSaveAnyway}>Save anyway — they're different people</button>
      </div>
    </Modal>
  );
}

/* Duplicate check logic — returns matching contact or null */
export function findDuplicate(incoming, existingContacts, skipId) {
  const normPhone = p => String(p||'').replace(/[^\d]/g,'').slice(-10);
  const normName = n => String(n||'').toLowerCase().replace(/[^a-z0-9]/g,'');
  const inPhone = normPhone(incoming.phone);
  const inName = normName(incoming.name);
  for (const c of existingContacts) {
    if (c.id === skipId) continue;
    if (inPhone && inPhone.length>=7 && normPhone(c.phone)===inPhone) return c;
    const cName = normName(c.name);
    if (inName && cName && inName.length>3 && (inName===cName || inName.includes(cName) || cName.includes(inName))) return c;
  }
  return null;
}

/* ============================ FEATURE 13: DEPARTMENT MASTER VIEW ============================ */
export function DepartmentMaster({ store }) {
  const toast = useToast();
  const { profile } = useAuth();
  const depts = store.departments||[];
  const vols = store.volunteers||[];
  const tasks = store.tasks||[];

  if (!depts.length) return (
    <>
      <div className="page-head"><div className="ph-txt"><h1>Department Master</h1></div></div>
      <div className="panel"><Empty title="No departments yet" sub="Add departments in the Departments & Tasks module."/></div>
    </>
  );

  return (
    <>
      <div className="page-head"><div className="ph-txt">
        <h1>Department Master</h1>
        <p>Auto-generated from your departments, volunteers and tasks. No extra entry needed.</p>
      </div></div>
      {depts.map(d => {
        const dTasks = tasks.filter(t=>t.deptId===d.id);
        const open = dTasks.filter(t=>t.status!=='Done');
        const done = dTasks.filter(t=>t.status==='Done');
        const blocked = dTasks.filter(t=>{
          const bl=(t.blockedBy||[]).map(id=>tasks.find(x=>x.id===id)).filter(Boolean).filter(b=>b.status!=='Done');
          return bl.length>0;
        });
        const pct = dTasks.length ? Math.round((done.length/dTasks.length)*100) : 0;
        const hods = (d.hodIds||[]).map(id=>vols.find(v=>v.id===id)).filter(Boolean);
        // All volunteers whose skills mention this dept or who are hods
        const members = vols.filter(v=>(d.hodIds||[]).includes(v.id));

        return (
          <div className="panel" key={d.id} style={{marginBottom:20}}>
            <div className="panel-head" style={{background:'var(--teal-wash)'}}>
              <div>
                <div style={{fontFamily:'var(--serif)',fontSize:18,fontWeight:500,color:'var(--teal)'}}>{d.name}</div>
                {d.desc&&<div style={{fontSize:12.5,color:'var(--muted)',marginTop:2}}>{d.desc}</div>}
              </div>
              <div className="right" style={{gap:16}}>
                <div style={{textAlign:'center'}}>
                  <div style={{fontFamily:'var(--serif)',fontSize:22,color:'var(--teal)',lineHeight:1}}>{pct}%</div>
                  <div style={{fontSize:10.5,color:'var(--muted)'}}>complete</div>
                </div>
                <div style={{textAlign:'center'}}>
                  <div style={{fontFamily:'var(--serif)',fontSize:22,color:'var(--amber)',lineHeight:1}}>{open.length}</div>
                  <div style={{fontSize:10.5,color:'var(--muted)'}}>open tasks</div>
                </div>
                {blocked.length>0&&<div style={{textAlign:'center'}}>
                  <div style={{fontFamily:'var(--serif)',fontSize:22,color:'var(--rose)',lineHeight:1}}>{blocked.length}</div>
                  <div style={{fontSize:10.5,color:'var(--muted)'}}>blocked</div>
                </div>}
                {/* HOD sign-off */}
                {d.ready
                  ? <span className="badge b-confirmed" style={{fontSize:13,padding:'4px 12px'}}>✓ Ready</span>
                  : <button className="btn primary sm" onClick={async()=>{
                      await saveItem('departments',{...d,ready:true,readyBy:profile?.email,readyAt:new Date().toISOString()});
                      toast(`${d.name} marked as ready.`);
                    }}>Mark ready</button>}
              </div>
            </div>
            <div style={{padding:'14px 18px',borderBottom:'1px solid var(--line)'}}>
              <div style={{marginBottom:6,fontWeight:600,fontSize:12,color:'var(--muted)',textTransform:'uppercase',letterSpacing:'.06em'}}>Head of Department</div>
              <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
                {hods.length?hods.map(v=>(
                  <div key={v.id} style={{display:'flex',alignItems:'center',gap:7,padding:'6px 12px',background:'#fff',border:'1px solid var(--line)',borderRadius:20}}>
                    <div className="avatar" style={{width:26,height:26,fontSize:10}}>{initials(v.name)}</div>
                    <span style={{fontSize:13,fontWeight:500}}>{v.name}</span>
                    <span style={{fontSize:11,color:'var(--teal)',fontWeight:600,background:'var(--teal-wash)',padding:'1px 6px',borderRadius:10}}>HOD</span>
                  </div>
                )):<span style={{fontSize:13,color:'var(--muted)'}}>No HOD assigned</span>}
              </div>
            </div>
            <div className="panel-body">
              <table>
                <thead><tr><th>Task</th><th>Owner</th><th>Due</th><th>Status</th></tr></thead>
                <tbody>
                  {dTasks.map(t=>{
                    const bl=(t.blockedBy||[]).map(id=>tasks.find(x=>x.id===id)).filter(Boolean).filter(b=>b.status!=='Done');
                    const isBlocked=bl.length>0;
                    return <tr key={t.id}>
                      <td><div className="nm" style={{textDecoration:t.status==='Done'?'line-through':'',color:t.status==='Done'?'var(--muted)':''}}>{t.title}</div>
                        {isBlocked&&<div className="role" style={{color:'var(--rose)'}}>⛔ {bl.map(b=>b.title).join(', ')}</div>}
                      </td>
                      <td className="muted-sm">{vols.find(v=>v.id===t.assigneeId)?.name||'—'}</td>
                      <td className="muted-sm">{shortDate(t.due)}</td>
                      <td><span className={'badge b-'+t.status.toLowerCase().replace(/ /g,'-')}>{t.status}</span></td>
                    </tr>;
                  })}
                  {!dTasks.length&&<tr><td colSpan="4"><div style={{padding:'12px 0',textAlign:'center',color:'var(--muted)',fontSize:13}}>No tasks yet</div></td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}
    </>
  );
}

/* ============================ FEATURE 14: MULTI-EVENT DASHBOARD ============================ */
export function AllEventsDashboard({ rawStore }) {
  const events = rawStore.events||[];
  const today = new Date().toISOString().slice(0,10);

  function daysUntil(dateStr) {
    if (!dateStr) return null;
    const diff = Math.ceil((new Date(dateStr+'T00:00:00')-new Date())/(1000*60*60*24));
    return diff;
  }

  function eventStats(ev) {
    const eid = ev.id;
    const contacts = (rawStore.contacts||[]).filter(c=>c.eventId===eid);
    const tasks = (rawStore.tasks||[]).filter(t=>t.eventId===eid);
    const sessions = (rawStore.sessions||[]).filter(s=>s.eventId===eid);
    return {
      total: contacts.length,
      confirmed: contacts.filter(c=>c.status==='Confirmed').length,
      pending: contacts.filter(c=>c.status==='Pending'||c.status==='Contacted').length,
      openTasks: tasks.filter(t=>t.status!=='Done').length,
      doneTasks: tasks.filter(t=>t.status==='Done').length,
      sessions: sessions.length,
      taskPct: tasks.length ? Math.round((tasks.filter(t=>t.status==='Done').length/tasks.length)*100) : 0,
    };
  }

  if (!events.length) return (
    <>
      <div className="page-head"><div className="ph-txt"><h1>All Events</h1></div></div>
      <div className="panel"><Empty title="No events yet" sub='Create events using "New event" in the topbar.'/></div>
    </>
  );

  return (
    <>
      <div className="page-head"><div className="ph-txt">
        <h1>All Events</h1>
        <p>Side-by-side overview of every event — confirmed counts, tasks, and days until each event.</p>
      </div></div>
      <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(300px,1fr))',gap:16,marginBottom:20}}>
        {events.map(ev=>{
          const st=eventStats(ev);
          const days=daysUntil(ev.startDate);
          const isLive=ev.startDate<=today&&(!ev.endDate||ev.endDate>=today);
          const isPast=ev.endDate&&ev.endDate<today;
          const parent=events.find(e=>e.id===ev.parentId);
          return (
            <div key={ev.id} style={{background:'var(--surface)',border:'2px solid '+(isLive?'var(--teal)':'var(--line)'),borderRadius:'var(--r-lg)',overflow:'hidden',boxShadow:'var(--shadow)'}}>
              <div style={{padding:'14px 16px',background:isLive?'var(--teal-wash)':isPast?'#F5F4F0':'#fff',borderBottom:'1px solid var(--line)'}}>
                <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:4}}>
                  <span style={{fontFamily:'var(--serif)',fontSize:17,fontWeight:500}}>{ev.name}</span>
                  {isLive&&<span className="badge b-confirmed">● Live</span>}
                  {isPast&&<span className="badge b-declined">Ended</span>}
                </div>
                <div style={{fontSize:12.5,color:'var(--muted)'}}>
                  {ev.type}{ev.venue?' · '+ev.venue:''}{parent?' · Linked to '+parent.name:''}
                </div>
                {ev.startDate&&<div style={{fontSize:12.5,color:'var(--muted)',marginTop:3}}>
                  📅 {fmtDate(ev.startDate)}{ev.endDate&&ev.endDate!==ev.startDate?' – '+fmtDate(ev.endDate):''}
                  {days!==null&&!isPast&&<span style={{marginLeft:8,fontWeight:600,color:days<=7?'var(--rose)':days<=14?'var(--amber)':'var(--teal)'}}>
                    {days<0?'Started '+Math.abs(days)+'d ago':days===0?'Today!':days+'d to go'}
                  </span>}
                </div>}
              </div>
              <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:0}}>
                {[
                  {label:'Confirmed',val:st.confirmed,color:'var(--teal)'},
                  {label:'Pending',val:st.pending,color:'var(--amber)'},
                  {label:'Sessions',val:st.sessions,color:'var(--blue)'},
                ].map((s,i)=>(
                  <div key={i} style={{padding:'12px',textAlign:'center',borderRight:i<2?'1px solid var(--line)':'',borderBottom:'1px solid var(--line)'}}>
                    <div style={{fontFamily:'var(--serif)',fontSize:22,color:s.color,lineHeight:1}}>{s.val}</div>
                    <div style={{fontSize:11,color:'var(--muted)',marginTop:3}}>{s.label}</div>
                  </div>
                ))}
              </div>
              <div style={{padding:'12px 16px'}}>
                <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:5}}>
                  <span style={{fontSize:12,color:'var(--muted)'}}>Task completion</span>
                  <span style={{fontSize:12,fontWeight:600,color:'var(--teal)'}}>{st.taskPct}%</span>
                </div>
                <div style={{height:6,background:'var(--line)',borderRadius:3}}>
                  <div style={{width:st.taskPct+'%',height:'100%',background:st.taskPct===100?'var(--teal-2)':'var(--teal)',borderRadius:3,transition:'width .4s'}}/>
                </div>
                <div style={{fontSize:11.5,color:'var(--muted)',marginTop:5}}>{st.openTasks} open · {st.doneTasks} done</div>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

/* ============================ FEATURE: VOLUNTEER PERSONAL VIEW ============================ */
export function VolunteerView({ store, activeEventId, go }) {
  const { profile } = useAuth();
  const vols = store.volunteers||[];
  const poc = store.poc||[];
  const tasks = store.tasks||[];
  const contacts = store.contacts||[];
  const checklists = store.checklist||[];
  const today = new Date().toISOString().slice(0,10);

  // Find this volunteer by matching email prefix to name
  const myVol = vols.find(v=>v.name?.toLowerCase()===profile?.email?.split('@')[0]?.toLowerCase())
    || vols.find(v=>profile?.email?.toLowerCase().includes(v.name?.toLowerCase().split(' ')[0]||'zzz'));

  const myPOCToday = poc.filter(p=>p.volunteerId===myVol?.id&&p.day===today);
  const myAllPOC = poc.filter(p=>p.volunteerId===myVol?.id);
  const myTasks = tasks.filter(t=>t.assigneeId===myVol?.id);

  const getContact = cid => contacts.find(c=>c.id===cid);
  const getChecklist = cid => checklists.find(cl=>cl.contactId===cid&&cl.eventId===activeEventId)||{contactId:cid,eventId:activeEventId};
  const STEPS = [
    {key:'picked_up',label:'Picked up',icon:'🚗'},
    {key:'hotel_checkin',label:'Hotel check-in',icon:'🏨'},
    {key:'arrived_venue',label:'Arrived venue',icon:'📍'},
    {key:'attended_session',label:'Session attended',icon:'🎤'},
    {key:'received_kit',label:'Kit received',icon:'🎁'},
    {key:'departed',label:'Departed',icon:'✈️'},
  ];

  return (
    <>
      <div className="page-head"><div className="ph-txt">
        <h1>My Dashboard</h1>
        <p>Your personalised volunteer view — POC duties, tasks and checklist.</p>
      </div></div>
      {/* Today's POC duties */}
      <div style={{marginBottom:6,fontFamily:'var(--serif)',fontSize:16,fontWeight:500,color:'var(--teal)'}}>Today's VIP duties</div>
      {myPOCToday.length ? myPOCToday.map(p=>{
        const c=getContact(p.contactId); if(!c) return null;
        const cl=getChecklist(c.id);
        const done=STEPS.filter(s=>cl[s.key]).length;
        return (
          <div className="panel" key={p.id} style={{marginBottom:14}}>
            <div className="panel-head">
              <div className="person"><div className="avatar">{initials(c.name)}</div><div><div className="nm">{displayName(c)}</div><div className="role">{c.type} · {p.shift}</div></div></div>
              <div className="right"><span className="muted-sm">{done}/{STEPS.length} steps done</span></div>
            </div>
            <div style={{padding:'12px 16px',display:'flex',flexWrap:'wrap',gap:8}}>
              {STEPS.map(step=>{
                const isDone=!!cl[step.key];
                return <div key={step.key} style={{padding:'8px 12px',borderRadius:9,border:`1.5px solid ${isDone?'var(--teal)':'var(--line)'}`,background:isDone?'var(--teal-wash)':'#fff',fontSize:13,display:'flex',alignItems:'center',gap:6}}>
                  <span>{step.icon}</span><span style={{color:isDone?'var(--teal)':'var(--ink)',fontWeight:isDone?600:400}}>{step.label}</span>
                  <span>{isDone?'✅':'⬜'}</span>
                </div>;
              })}
            </div>
            <div style={{padding:'0 16px 12px'}}><button className="btn primary sm" onClick={()=>go('checklist')}>Open full checklist</button></div>
          </div>
        );
      }) : <div className="panel" style={{marginBottom:14}}><div className="empty"><h3>No VIP duties today</h3><p>Your POC assignments will appear here on the day.</p></div></div>}

      {/* Upcoming POC duties */}
      {myAllPOC.filter(p=>p.day>today).length>0&&<>
        <div style={{marginBottom:6,fontFamily:'var(--serif)',fontSize:16,fontWeight:500,color:'var(--teal)'}}>Upcoming POC duties</div>
        <div className="panel" style={{marginBottom:20}}>
          <div className="panel-body"><table><thead><tr><th>VIP</th><th>Day</th><th>Shift</th></tr></thead><tbody>
            {myAllPOC.filter(p=>p.day>today).sort((a,b)=>a.day>b.day?1:-1).map(p=>{
              const c=getContact(p.contactId);
              return <tr key={p.id}><td><div className="nm">{c?displayName(c):'—'}</div></td><td className="muted-sm">{shortDate(p.day)}</td><td className="muted-sm">{p.shift}</td></tr>;
            })}
          </tbody></table></div>
        </div>
      </>}

      {/* My tasks */}
      <div style={{marginBottom:6,fontFamily:'var(--serif)',fontSize:16,fontWeight:500,color:'var(--teal)'}}>My tasks</div>
      <div className="panel">
        <div className="panel-body"><table><thead><tr><th>Task</th><th>Due</th><th>Status</th></tr></thead><tbody>
          {myTasks.length?myTasks.map(t=>(
            <tr key={t.id}>
              <td><div className="nm">{t.title}</div></td>
              <td className="muted-sm">{shortDate(t.due)}</td>
              <td><select className="statsel" value={t.status} onChange={e=>saveItem('tasks',{...t,status:e.target.value})}>{TASK_STATUS.map(s=><option key={s}>{s}</option>)}</select></td>
            </tr>
          )):<tr><td colSpan="3"><Empty title="No tasks assigned to you" sub="Tasks assigned to you will appear here."/></td></tr>}
        </tbody></table></div>
      </div>
    </>
  );
}

/* ============================ FEATURE 17: IN-APP NOTIFICATIONS ============================ */
export function NotificationBell({ store, profile }) {
  const [open, setOpen] = useState(false);
  const log = (store?.activity_log || []).slice(0, 30);

  // Notifications relevant to the current user
  const myEmail = profile?.email || '';
  const relevant = log.filter(l =>
    l.detail?.toLowerCase().includes(myEmail.toLowerCase()) ||
    l.action?.toLowerCase().includes('approved') ||
    l.action?.toLowerCase().includes('assigned') ||
    l.action?.toLowerCase().includes('swapped') ||
    l.action?.toLowerCase().includes('wipe')
  );

  // Count unseen (last 5 minutes from others)
  const fiveMinAgo = Date.now() / 1000 - 300;
  const unseenCount = relevant.filter(l =>
    l.ts?.seconds > fiveMinAgo && l.email !== myEmail
  ).length;

  const fmt = ts => {
    if (!ts?.seconds) return '';
    const d = new Date(ts.seconds * 1000);
    const diff = Math.floor((Date.now() - d) / 60000);
    if (diff < 1) return 'just now';
    if (diff < 60) return diff + 'm ago';
    if (diff < 1440) return Math.floor(diff / 60) + 'h ago';
    return d.toLocaleDateString();
  };

  const actionIcon = a => {
    if (!a) return '📋';
    if (a.includes('Approved')) return '✅';
    if (a.includes('Rejected')) return '❌';
    if (a.includes('Added')) return '➕';
    if (a.includes('Updated') || a.includes('Changed')) return '✏️';
    if (a.includes('Deleted') || a.includes('Wiped')) return '🗑️';
    if (a.includes('Assigned') || a.includes('swapped')) return '👤';
    return '📋';
  };

  return (
    <div style={{ position: 'relative' }}>
      <button
        className="btn ghost sm"
        onClick={() => setOpen(o => !o)}
        style={{ position: 'relative', fontSize: 16 }}
        title="Notifications"
      >
        🔔
        {unseenCount > 0 && (
          <span style={{
            position: 'absolute', top: -2, right: -2, width: 16, height: 16,
            background: 'var(--rose)', color: '#fff', borderRadius: '50%',
            fontSize: 9, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>{unseenCount}</span>
        )}
      </button>
      {open && (
        <div style={{
          position: 'absolute', right: 0, top: '100%', marginTop: 8,
          width: 340, background: '#fff', borderRadius: 12, border: '1px solid var(--line)',
          boxShadow: '0 12px 40px rgba(0,0,0,.18)', zIndex: 60, overflow: 'hidden',
        }} onMouseLeave={() => setOpen(false)}>
          <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--line)', fontWeight: 600, fontSize: 14 }}>
            Recent activity
          </div>
          <div style={{ maxHeight: 380, overflow: 'auto' }}>
            {log.length ? log.map(l => (
              <div key={l.id} style={{
                padding: '10px 16px', borderBottom: '1px solid var(--line)',
                display: 'flex', gap: 10, alignItems: 'flex-start',
                background: l.email !== myEmail && l.ts?.seconds > fiveMinAgo ? 'var(--teal-wash)' : '#fff',
              }}>
                <span style={{ fontSize: 16, flex: 'none', marginTop: 1 }}>{actionIcon(l.action)}</span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 500 }}>{l.action}</div>
                  {l.detail && <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 1 }}>{l.detail}</div>}
                  <div style={{ fontSize: 11, color: 'var(--faint)', marginTop: 2 }}>
                    {l.email?.split('@')[0]} · {fmt(l.ts)}
                  </div>
                </div>
              </div>
            )) : (
              <div style={{ padding: '24px', textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>
                No activity yet
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ============================ FEATURE 18: DATA EXPORT ============================ */
export function ExportData({ store, rawStore }) {
  const toast = useToast();

  function exportSheet(name, rows, cols) {
    if (!rows.length) { toast('Nothing to export in ' + name); return; }
    import('xlsx').then(XLSX => {
      const data = rows.map(r => {
        const o = {};
        cols.forEach(([key, label]) => { o[label] = r[key] ?? ''; });
        return o;
      });
      const ws = XLSX.utils.json_to_sheet(data);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, name);
      XLSX.writeFile(wb, `VK_${name}_${new Date().toISOString().slice(0,10)}.xlsx`);
      toast(`${name} exported.`);
    });
  }

  const contacts = store.contacts || [];
  const vols = store.volunteers || [];
  const sessions = store.sessions || [];
  const tasks = store.tasks || [];
  const logi = store.logistics || [];
  const poc = store.poc || [];
  const depts = store.departments || [];
  const kits = store.felicitation || [];

  const volName = id => vols.find(v => v.id === id)?.name || '';
  const deptName = id => depts.find(d => d.id === id)?.name || '';
  const contactName = id => { const c = contacts.find(x => x.id === id); return c ? displayName(c) : ''; };

  const EXPORTS = [
    {
      label: 'Contacts (Outreach)',
      icon: '📋',
      count: contacts.length,
      run: () => exportSheet('Contacts', contacts, [
        ['name','Name'], ['honor','Honorific'], ['desig','Designation'], ['org','Organisation'],
        ['field','Field'], ['phone','Phone'], ['email','Email'],
        ['liaisonName','POC / Liaison'], ['liaisonPhone','Liaison Phone'],
        ['type','Type'], ['status','Confirmation Status'], ['remark','Remarks'],
      ]),
    },
    {
      label: 'Logistics',
      icon: '✈️',
      count: logi.length,
      run: () => exportSheet('Logistics', logi.map(L => ({
        ...L, name: contactName(L.contactId || L.id),
      })), [
        ['name','Guest Name'], ['inbMode','Arrival Mode'], ['inbDate','Arrival Date'],
        ['inbTime','Arrival Time'], ['inbLoc','Arrival Location'],
        ['hotel','Hotel'], ['checkin','Check-in Time'],
        ['outDate','Departure Date'], ['outDepart','Departs for Airport'],
        ['outFlight','Outbound Flight'], ['special','Special Requirements'],
      ]),
    },
    {
      label: 'Event Schedule',
      icon: '🗓️',
      count: sessions.length,
      run: () => exportSheet('Sessions', sessions, [
        ['date','Date'], ['start','Start Time'], ['end','End Time'],
        ['title','Session Title'], ['topic','Topic'], ['type','Type'],
      ]),
    },
    {
      label: 'Volunteers',
      icon: '👥',
      count: vols.length,
      run: () => exportSheet('Volunteers', vols, [
        ['name','Name'], ['phone','Phone'], ['city','City'], ['skills','Skills'],
      ]),
    },
    {
      label: 'POC Roster',
      icon: '🤝',
      count: poc.length,
      run: () => exportSheet('POC_Roster', poc.map(p => ({
        ...p,
        vipName: contactName(p.contactId),
        volunteerName: volName(p.volunteerId),
      })), [
        ['vipName','VIP Name'], ['volunteerName','POC Volunteer'],
        ['day','Day'], ['shift','Shift'], ['status','Status'],
      ]),
    },
    {
      label: 'Tasks',
      icon: '✅',
      count: tasks.length,
      run: () => exportSheet('Tasks', tasks.map(t => ({
        ...t,
        deptName: deptName(t.deptId),
        assigneeName: volName(t.assigneeId),
      })), [
        ['title','Task'], ['deptName','Department'], ['assigneeName','Owner'],
        ['due','Due Date'], ['status','Status'], ['notes','Notes'],
      ]),
    },
    {
      label: 'Felicitation Kits',
      icon: '🎁',
      count: kits.length,
      run: () => exportSheet('Felicitation', kits.map(k => ({
        ...k, guestName: contactName(k.contactId),
      })), [
        ['guestName','Guest'], ['momento','Momento ✓'], ['shawl','Shawl ✓'],
        ['kumkum','Kumkum ✓'], ['cover','Cover ✓'],
        ['gold_coin','Gold Coin ✓'], ['silver_coin','Silver Coin ✓'], ['frame','Frame ✓'],
      ]),
    },
    {
      label: 'Full backup (all contacts)',
      icon: '💾',
      count: (rawStore.contacts || []).length,
      run: () => exportSheet('AllContacts_Backup', rawStore.contacts || [], [
        ['name','Name'], ['honor','Honorific'], ['desig','Designation'], ['org','Organisation'],
        ['field','Field'], ['phone','Phone'], ['email','Email'],
        ['liaisonName','POC'], ['type','Type'], ['status','Status'], ['remark','Remarks'],
        ['eventId','Event ID'],
      ]),
    },
  ];

  return (
    <>
      <div className="page-head"><div className="ph-txt">
        <h1>Export Data</h1>
        <p>Download any module as an Excel file — for sharing, reporting or backup. All exports include the data for the currently active event.</p>
      </div></div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(280px,1fr))', gap: 14 }}>
        {EXPORTS.map((ex, i) => (
          <div key={i} style={{
            background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 'var(--r-lg)',
            padding: '18px 20px', boxShadow: 'var(--shadow)', display: 'flex', alignItems: 'center', gap: 14,
          }}>
            <span style={{ fontSize: 28 }}>{ex.icon}</span>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600, fontSize: 14 }}>{ex.label}</div>
              <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 2 }}>{ex.count} records</div>
            </div>
            <button className="btn primary sm" onClick={ex.run} disabled={ex.count === 0}>
              {ICON.doc}Export
            </button>
          </div>
        ))}
      </div>
    </>
  );
}

/* ============================ FEATURE 19: HELP & GUIDE ============================ */
export function HelpGuide({ profile }) {
  const role = profile?.role || 'Volunteer';
  const [tab, setTab] = useState('features');

  const ALL_FEATURES = [
    { roles: ['Master', 'HOD', 'Volunteer'], icon: '🏠', title: 'Dashboard', desc: 'Your personalised home screen. Masters see the full event picture. HODs see their department tasks. Volunteers see their POC duties and assigned tasks.' },
    { roles: ['Master', 'HOD'], icon: '🔴', title: 'Control Room', desc: 'Live event-day view. See who is arriving today, who is on-site, who is departing, and which sessions are running right now.' },
    { roles: ['Master', 'HOD'], icon: '📋', title: 'Outreach', desc: 'The permanent expert directory. Add contacts, track confirmation status (Pending → Contacted → Tentative → Confirmed), log follow-up notes, and import from Excel. Confirming someone automatically creates a Logistics record.' },
    { roles: ['Master', 'HOD'], icon: '✈️', title: 'Logistics', desc: 'Travel and stay details for confirmed guests. Appears automatically when someone is confirmed. Fill in arrival mode, time, hotel check-in, and departure details.' },
    { roles: ['Master', 'HOD'], icon: '🗓️', title: 'Scheduling', desc: 'Three tabs: Event schedule (add/edit sessions), Session assignments (tick which panelist speaks at which session), and Founder one-on-ones (schedule individual meetings).' },
    { roles: ['Master', 'HOD', 'Volunteer'], icon: '👥', title: 'Volunteers & POC', desc: 'The volunteer directory and the per-day POC duty roster. Assign a volunteer to escort a VIP on a specific day. Swapping a sick POC only affects that day — other days are untouched.' },
    { roles: ['Master', 'HOD'], icon: '📊', title: 'Volunteer Availability', desc: 'A colour-coded grid showing which volunteers are free on each event day (Full Day / Morning / Afternoon / Evening). Set dates on the event first to see the grid.' },
    { roles: ['Master', 'HOD'], icon: '🤝', title: 'Smart POC', desc: 'Shows each VIP\'s visit days and which volunteers are available. One click assigns. The Auto-assign button picks the least-loaded available volunteer for every unfilled slot.' },
    { roles: ['Master', 'HOD', 'Volunteer'], icon: '☑️', title: 'Event Checklist', desc: 'Mobile-friendly per-VIP checklist: Picked up → Hotel → Venue → Session → Kit → Departed. Each step is timestamped when tapped. POCs see their assigned VIPs.' },
    { roles: ['Master', 'HOD'], icon: '🎁', title: 'Felicitation Kits', desc: 'Track which kit items (Momento, Shawl, Kumkum, Cover, Gold Coin, Silver Coin, Frame) are packed for each confirmed guest. Summary cards show totals.' },
    { roles: ['Master', 'HOD'], icon: '📁', title: 'Departments & Tasks', desc: 'Create departments with HODs and tasks. Tasks can be marked as "Blocked by" another task — blocked tasks cannot move to In Progress until their blocker is Done.' },
    { roles: ['Master', 'HOD'], icon: '📄', title: 'Department Master', desc: 'Auto-generated full view of each department — HOD, volunteers, all tasks with status and completion percentage. Nothing extra to enter.' },
    { roles: ['Master', 'HOD'], icon: '📑', title: 'Generate Schedules', desc: 'One-click generation of: Personalised schedule per VIP (assembled from logistics, sessions, founder meeting), Event schedule, and Founder\'s day. Toggle "Show sources" to see which module each line came from.' },
    { roles: ['Master'], icon: '🌐', title: 'All Events', desc: 'Side-by-side dashboard for all events — confirmed counts, task completion, days until event. No need to switch the active event to check status.' },
    { roles: ['Master'], icon: '📤', title: 'Export Data', desc: 'Download any module as an Excel file — contacts, logistics, sessions, volunteers, POC roster, tasks, felicitation kits, or a full backup.' },
    { roles: ['Master'], icon: '⚙️', title: 'Settings', desc: 'User management (approve/reject new signups, assign roles), activity log (every action logged with user, time and device), and data management (clear individual collections or wipe everything — with password + confirmation phrase required).' },
  ];

  const myFeatures = ALL_FEATURES.filter(f => f.roles.includes(role));

  const QUICKSTART = [
    { step: 1, title: 'Create your event', desc: 'Click "New event" in the topbar. Set the name, type, start and end dates, and venue.' },
    { step: 2, title: 'Add or import contacts', desc: 'Go to Outreach. Add contacts manually or click "Import from Excel" to upload your sheet.' },
    { step: 3, title: 'Confirm guests', desc: 'Change status to "Confirmed" — a Logistics record is created automatically.' },
    { step: 4, title: 'Fill in logistics', desc: 'Go to Logistics. Fill in travel mode, arrival time, hotel, and departure for each confirmed guest.' },
    { step: 5, title: 'Add sessions', desc: 'Go to Scheduling → Event schedule. Add each session with date, time and type.' },
    { step: 6, title: 'Assign panelists', desc: 'Scheduling → Session assignments. Tick which confirmed guest speaks at which panel.' },
    { step: 7, title: 'Schedule founder meetings', desc: 'Scheduling → Founder one-on-ones. Set date and time for each VIP\'s meeting.' },
    { step: 8, title: 'Set volunteer availability', desc: 'Go to Vol. Availability. Mark which volunteers are free on each day.' },
    { step: 9, title: 'Assign POCs', desc: 'Go to Smart POC. Use Auto-assign or pick manually for each VIP\'s day.' },
    { step: 10, title: 'Generate schedules', desc: 'Go to Generate. Select a guest and click Generate — their full personalised schedule is ready to print or email.' },
  ];

  return (
    <>
      <div className="page-head"><div className="ph-txt">
        <h1>Help & Guide</h1>
        <p>Everything you need to know about VK Outreach Program (JYOT).</p>
      </div></div>
      <div className="subnav">
        <button className={tab === 'features' ? 'active' : ''} onClick={() => setTab('features')}>Features ({myFeatures.length})</button>
        <button className={tab === 'quickstart' ? 'active' : ''} onClick={() => setTab('quickstart')}>Quick start</button>
        <button className={tab === 'tips' ? 'active' : ''} onClick={() => setTab('tips')}>Tips & shortcuts</button>
      </div>

      {tab === 'features' && (
        <>
          <div className="flow-note">{ICON.info}<div>Showing features available to your role: <b>{role}</b>. {role === 'Volunteer' ? 'You have read-only access to most modules.' : role === 'HOD' ? 'You can add and edit data but cannot manage users or wipe data.' : 'You have full access to all features.'}</div></div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(300px,1fr))', gap: 14 }}>
            {myFeatures.map((f, i) => (
              <div key={i} style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 'var(--r-lg)', padding: '16px 18px', boxShadow: 'var(--shadow)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                  <span style={{ fontSize: 22 }}>{f.icon}</span>
                  <span style={{ fontFamily: 'var(--serif)', fontSize: 15, fontWeight: 500 }}>{f.title}</span>
                </div>
                <p style={{ fontSize: 13.5, color: 'var(--muted)', lineHeight: 1.55, margin: 0 }}>{f.desc}</p>
              </div>
            ))}
          </div>
        </>
      )}

      {tab === 'quickstart' && (
        <div className="panel">
          <div className="panel-head"><h2>Quick start — new event setup</h2><div className="desc">Follow these steps in order</div></div>
          <div className="panel-pad">
            {QUICKSTART.map(s => (
              <div key={s.step} style={{ display: 'flex', gap: 14, marginBottom: 18, alignItems: 'flex-start' }}>
                <div style={{ width: 32, height: 32, borderRadius: '50%', background: 'var(--teal)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 13, flex: 'none' }}>{s.step}</div>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>{s.title}</div>
                  <div style={{ fontSize: 13.5, color: 'var(--muted)', marginTop: 3, lineHeight: 1.5 }}>{s.desc}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {tab === 'tips' && (
        <div className="panel">
          <div className="panel-head"><h2>Tips & shortcuts</h2></div>
          <div className="panel-pad">
            {[
              { tip: '🔍 Search everything', desc: 'Press Ctrl+K (or Cmd+K on Mac) to open global search. Find any contact, volunteer, session or task instantly.' },
              { tip: '📱 Mobile use', desc: 'The app works on phones. Tap the ☰ menu to open the sidebar. The Event Checklist is designed for one-hand use in the field.' },
              { tip: '📊 Bulk confirm', desc: 'In Outreach, click "Select multiple" to tick several contacts and confirm them all at once — great after a single outreach call.' },
              { tip: '📝 Follow-up log', desc: 'In Outreach, the 📝 button on each contact opens a running log. Add notes per call or WhatsApp with one tap.' },
              { tip: '🔄 POC swap', desc: 'In Volunteers & POC, the POC roster is per-day. Swapping a sick volunteer only affects that one day — other days are untouched.' },
              { tip: '⛔ Task blocking', desc: 'When editing a task, use "Blocked by" to link it to another task. Blocked tasks cannot be marked In Progress until their blocker is Done.' },
              { tip: '📤 Export anytime', desc: 'Use Export Data to download any module as Excel — useful for sharing with people who don\'t use the app or for management reports.' },
              { tip: '⚡ Offline', desc: 'The app works offline. Changes are saved locally and sync automatically when you\'re back online. Look for the amber "Offline" indicator in the topbar.' },
              { tip: '🗑️ Wipe safely', desc: 'The data wipe in Settings never deletes user accounts — only event data. You will always be able to log back in.' },
              { tip: '👤 Adding team members', desc: 'Share the app URL. New users sign up and land on "Waiting for approval". Go to Settings → Users to approve them and assign a role.' },
            ].map((t, i) => (
              <div key={i} style={{ marginBottom: 16, paddingBottom: 16, borderBottom: i < 9 ? '1px solid var(--line)' : 'none' }}>
                <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 4 }}>{t.tip}</div>
                <div style={{ fontSize: 13.5, color: 'var(--muted)', lineHeight: 1.5 }}>{t.desc}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

/* ============================ GLOBAL SEARCH ============================ */
export function GlobalSearch({ store, onNavigate, onClose }) {
  const [q, setQ] = useState('');
  const results = useMemo(() => {
    if (!q.trim() || q.length < 2) return [];
    const t = q.toLowerCase();
    const out = [];
    (store.contacts||[]).forEach(c=>{ if((c.name||'').toLowerCase().includes(t)||(c.org||'').toLowerCase().includes(t)||(c.phone||'').includes(t)) out.push({type:'Contact',label:displayName(c),sub:c.org||c.field,view:'outreach'}); });
    (store.volunteers||[]).forEach(v=>{ if((v.name||'').toLowerCase().includes(t)||(v.skills||'').toLowerCase().includes(t)) out.push({type:'Volunteer',label:v.name,sub:v.skills,view:'people'}); });
    (store.sessions||[]).forEach(s=>{ if((s.title||'').toLowerCase().includes(t)||(s.topic||'').toLowerCase().includes(t)) out.push({type:'Session',label:s.title,sub:s.topic||s.date,view:'schedule'}); });
    (store.tasks||[]).forEach(t2=>{ if((t2.title||'').toLowerCase().includes(t)) out.push({type:'Task',label:t2.title,sub:t2.status,view:'depts'}); });
    (store.departments||[]).forEach(d=>{ if((d.name||'').toLowerCase().includes(t)) out.push({type:'Department',label:d.name,sub:d.desc,view:'depts'}); });
    return out.slice(0, 20);
  }, [q, store]);

  useEffect(() => {
    const h = e => { if (e.key==='Escape') onClose(); };
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  const typeColor = { Contact:'var(--teal)', Volunteer:'var(--blue)', Session:'var(--purple)', Task:'var(--amber)', Department:'var(--muted)' };

  return (
    <div className="scrim" onMouseDown={onClose} style={{alignItems:'flex-start',paddingTop:60}}>
      <div style={{background:'#fff',borderRadius:16,width:'100%',maxWidth:560,boxShadow:'0 24px 60px rgba(0,0,0,.25)',overflow:'hidden'}} onMouseDown={e=>e.stopPropagation()}>
        <div style={{display:'flex',alignItems:'center',gap:12,padding:'14px 18px',borderBottom:'1px solid var(--line)'}}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--muted)" strokeWidth="2"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>
          <input autoFocus style={{flex:1,border:'none',outline:'none',fontSize:16,fontFamily:'var(--sans)',color:'var(--ink)'}} placeholder="Search contacts, volunteers, sessions, tasks…" value={q} onChange={e=>setQ(e.target.value)}/>
          <button style={{border:'none',background:'none',color:'var(--muted)',cursor:'pointer',fontSize:13}} onClick={onClose}>Esc</button>
        </div>
        {results.length > 0 && (
          <div style={{maxHeight:400,overflow:'auto'}}>
            {results.map((r,i) => (
              <button key={i} onClick={()=>{onNavigate(r.view);onClose();}} style={{width:'100%',display:'flex',alignItems:'center',gap:12,padding:'11px 18px',border:'none',background:'none',cursor:'pointer',textAlign:'left',borderBottom:'1px solid var(--line)'}}>
                <span style={{fontSize:10.5,fontWeight:700,color:typeColor[r.type],background:typeColor[r.type]+'18',padding:'2px 8px',borderRadius:20,minWidth:70,textAlign:'center',textTransform:'uppercase',letterSpacing:'.04em'}}>{r.type}</span>
                <div style={{flex:1}}>
                  <div style={{fontSize:13.5,fontWeight:500}}>{r.label}</div>
                  {r.sub && <div style={{fontSize:12,color:'var(--muted)'}}>{r.sub}</div>}
                </div>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--faint)" strokeWidth="2"><path d="m9 18 6-6-6-6"/></svg>
              </button>
            ))}
          </div>
        )}
        {q.length >= 2 && !results.length && <div style={{padding:'24px',textAlign:'center',color:'var(--muted)',fontSize:13}}>No results for "<b>{q}</b>"</div>}
        {q.length < 2 && <div style={{padding:'16px 18px',color:'var(--muted)',fontSize:13}}>Type at least 2 characters to search across all modules.</div>}
      </div>
    </div>
  );
}

/* ============================ FEATURE 8: WHATSAPP TEMPLATES ============================ */
export function WhatsAppModal({ contact, store, activeEventId, onClose }) {
  const [tpl, setTpl] = useState('invite');
  const logi = (store.logistics||[]).find(l=>l.contactId===contact.id||l.id===contact.id)||{};
  const assigns = (store.assignments||[]).filter(a=>a.contactId===contact.id);
  const sessions = assigns.map(a=>(store.sessions||[]).find(s=>s.id===a.sessionId)).filter(Boolean);
  const founder = (store.founder||[]).find(f=>f.contactId===contact.id||f.id===contact.id);
  const event = (store.events||[]).find(e=>e.id===activeEventId)||{name:'VK 4.0',startDate:'2026-01-16',venue:'Mumbai'};

  const dn = displayName(contact);
  const sessionLine = sessions.length
    ? sessions.map(s=>`• ${s.title}${s.topic?' — '+s.topic:''} (${shortDate(s.date)}, ${s.start})`).join('\n')
    : '';
  const founderLine = founder?.time
    ? `\n\nYour one-on-one meeting with His Holiness is scheduled on ${shortDate(founder.date)} at ${founder.time} at the VIP Lounge.`
    : '';

  const TEMPLATES = {
    invite: {
      label: 'Invitation',
      msg: `Jai Jinendra ${dn} Ji,\n\nWith humble regards, we cordially invite you to *Vasudhaiva Kutumbakam Ki Oar ${event.name}* — a gathering of eminent experts in law, geopolitics and economics.\n\n📅 ${shortDate(event.startDate)}\n📍 ${event.venue||'Mumbai'}\n\nYour expertise and perspective would be invaluable to our deliberations. We would be honoured by your gracious presence.\n\nKindly confirm your participation at your earliest convenience.\n\nWith warm regards,\nVK Outreach Team`,
    },
    confirm: {
      label: 'Confirmation',
      msg: `Jai Jinendra ${dn} Ji,\n\nThank you for confirming your participation in *Vasudhaiva Kutumbakam Ki Oar ${event.name}*.\n\nWe are truly honoured to have you with us.\n\n${sessionLine ? `*Your sessions:*\n${sessionLine}\n` : ''}${founderLine}\nOur team will reach out with further details regarding travel and accommodation shortly.\n\nWith warm regards,\nVK Outreach Team`,
    },
    schedule: {
      label: 'Schedule',
      msg: `Jai Jinendra ${dn} Ji,\n\nPlease find below your personalised schedule for *Vasudhaiva Kutumbakam Ki Oar ${event.name}*:\n\n${logi.inbDate ? `🚗 *Arrival:* ${shortDate(logi.inbDate)} at ${logi.inbTime||''} — ${logi.inbLoc||'Mumbai'}` : ''}\n${logi.hotel ? `🏨 *Stay:* ${logi.hotel}` : ''}\n\n${sessionLine ? `*Sessions:*\n${sessionLine}` : ''}\n${founderLine}\n${logi.outDate ? `\n✈️ *Departure:* ${shortDate(logi.outDate)} at ${logi.outDepart||''}` : ''}\n\nA dedicated Point of Contact will be assigned to you. Please feel free to reach out for any assistance.\n\nWith warm regards,\nVK Outreach Team`,
    },
    followup: {
      label: 'Follow-up',
      msg: `Jai Jinendra ${dn} Ji,\n\nThis is a gentle follow-up regarding your participation in *Vasudhaiva Kutumbakam Ki Oar ${event.name}*.\n\nWe would be grateful to receive your confirmation at your earliest convenience so we can make the necessary arrangements.\n\nWith warm regards,\nVK Outreach Team`,
    },
  };

  const msg = TEMPLATES[tpl].msg.trim();
  const phone = String(contact.phone||'').replace(/[^\d+]/g,'');
  const waUrl = `https://wa.me/${phone.startsWith('+')?phone.slice(1):phone}?text=${encodeURIComponent(msg)}`;

  return (
    <Modal title={`WhatsApp — ${displayName(contact)}`} onClose={onClose} footer={null}>
      <div style={{display:'flex',gap:8,marginBottom:14,flexWrap:'wrap'}}>
        {Object.entries(TEMPLATES).map(([k,v])=>(
          <button key={k} className={'btn sm'+(tpl===k?' primary':'')} onClick={()=>setTpl(k)}>{v.label}</button>
        ))}
      </div>
      <div style={{background:'#ECF8ED',borderRadius:10,padding:'14px 16px',fontFamily:'system-ui',fontSize:13.5,lineHeight:1.6,whiteSpace:'pre-wrap',maxHeight:320,overflow:'auto',border:'1px solid #D4EDDA'}}>
        {msg}
      </div>
      <div style={{marginTop:14,display:'flex',gap:10,justifyContent:'flex-end',flexWrap:'wrap'}}>
        <button className="btn sm" onClick={()=>{navigator.clipboard.writeText(msg);}}>📋 Copy message</button>
        {phone
          ? <a href={waUrl} target="_blank" rel="noopener noreferrer" className="btn primary sm" style={{textDecoration:'none'}}>
              <span style={{fontSize:16}}>💬</span> Open in WhatsApp
            </a>
          : <span style={{fontSize:13,color:'var(--rose)'}}>No phone number — add one in Outreach first.</span>}
      </div>
      <div className="modal-foot" style={{padding:'12px 0 0'}}>
        <button className="btn" onClick={onClose}>Close</button>
      </div>
    </Modal>
  );
}

/* ============================ FEATURE 9: BULK LOGISTICS IMPORT ============================ */
export function LogisticsImportModal({ store, activeEventId, onClose, toast }) {
  const [step, setStep] = useState('choose');
  const [plan, setPlan] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function handleFile(file) {
    setErr('');
    try {
      const { parseLogisticsFile, planLogisticsImport } = await import('./excel');
      const { items } = await parseLogisticsFile(file);
      if (!items.length) { setErr('No matching rows found. Make sure your sheet has a Name or Phone column.'); return; }
      const p = planLogisticsImport(items, store.contacts||[], store.logistics||[]);
      setPlan(p); setStep('preview');
    } catch(e) { setErr('Could not read file: ' + (e.message||e)); }
  }

  async function commit() {
    setBusy(true);
    try {
      const { saveItem } = await import('./data');
      for (const row of plan.plan.filter(p=>p.mode!=='unmatched')) {
        await saveItem('logistics', { ...row.item, eventId: activeEventId });
      }
      onClose();
      toast(`Logistics imported — ${plan.newCount} new, ${plan.updateCount} updated, ${plan.unmatchedCount} unmatched.`);
    } catch(e) { setErr('Save failed: '+(e.message||e)); setBusy(false); }
  }

  const modeColor = m => m==='new'?'var(--teal)':m==='update'?'var(--amber)':'var(--rose)';
  const modeLabel = m => m==='new'?'New':m==='update'?'Update':'No match';

  return (
    <Modal title="Import logistics from Excel" onClose={onClose} footer={null}>
      {err&&<div style={{background:'var(--rose-wash)',color:'var(--rose)',padding:'9px 12px',borderRadius:8,fontSize:13,marginBottom:12}}>{err}</div>}
      {step==='choose'&&<>
        <p className="muted-sm" style={{marginTop:0}}>Upload your travel sheet. Each row is matched to an existing contact by phone number or name. Columns recognised: Name, Phone, Arrival Mode, Arrival Date, Arrival Time, Arrival Location, Hotel, Check-in, Departure Date, Departs for Airport, Flight Time, Special Requirements.</p>
        <label className="dropzone">
          <span style={{display:'flex',justifyContent:'center'}}>{ICON.upload}</span>
          <div>Click to choose a file (.xlsx or .csv)</div>
          <input type="file" accept=".xlsx,.xls,.csv" style={{display:'none'}} onChange={e=>handleFile(e.target.files[0])}/>
        </label>
        <div className="modal-foot" style={{padding:'12px 0 0'}}><button className="btn" onClick={onClose}>Cancel</button></div>
      </>}
      {step==='preview'&&plan&&<>
        <div style={{display:'flex',gap:16,marginBottom:12}}>
          <div><div style={{fontFamily:'var(--serif)',fontSize:24,color:'var(--teal)'}}>{plan.newCount}</div><div className="muted-sm">new records</div></div>
          <div><div style={{fontFamily:'var(--serif)',fontSize:24,color:'var(--amber)'}}>{plan.updateCount}</div><div className="muted-sm">will update</div></div>
          <div><div style={{fontFamily:'var(--serif)',fontSize:24,color:'var(--rose)'}}>{plan.unmatchedCount}</div><div className="muted-sm">no contact match</div></div>
        </div>
        {plan.unmatchedCount>0&&<div style={{background:'var(--amber-wash)',padding:'8px 12px',borderRadius:8,fontSize:12.5,color:'var(--amber)',marginBottom:10}}>
          ⚠ Unmatched rows will be skipped. Make sure these contacts exist in Outreach first, or add them manually.
        </div>}
        <div style={{maxHeight:'36vh',overflow:'auto',border:'1px solid var(--line)',borderRadius:8}}>
          <table className="import-tbl"><thead><tr><th>Name in sheet</th><th>Matched contact</th><th>Result</th></tr></thead><tbody>
            {plan.plan.map((p,i)=>(
              <tr key={i}>
                <td>{p.contactName||'—'}</td>
                <td className="muted-sm">{p.mode!=='unmatched'?p.contactName:'—'}</td>
                <td><span style={{fontSize:11,fontWeight:700,color:modeColor(p.mode)}}>{modeLabel(p.mode)}</span></td>
              </tr>
            ))}
          </tbody></table>
        </div>
        <div className="modal-foot" style={{padding:'12px 0 0'}}>
          <button className="btn" onClick={()=>setStep('choose')}>Back</button>
          <button className="btn primary" onClick={commit} disabled={busy||plan.newCount+plan.updateCount===0}>
            {busy?'Importing…':`Import ${plan.newCount+plan.updateCount} rows`}
          </button>
        </div>
      </>}
    </Modal>
  );
}

/* ============================ FEATURE 13: SENIOR EVENT REPORT ============================ */
export function EventReport({ store, rawStore, activeEventId }) {
  const contacts = store.contacts||[];
  const tasks = store.tasks||[];
  const logi = store.logistics||[];
  const poc = store.poc||[];
  const depts = store.departments||[];
  const vols = store.volunteers||[];
  const sessions = store.sessions||[];
  const event = (rawStore?.events||[]).find(e=>e.id===activeEventId)||{};

  const conf = contacts.filter(c=>c.status==='Confirmed');
  const logiDone = conf.filter(c=>logi.some(l=>(l.contactId===c.id||l.id===c.id)&&(l.hotel||l.inbTime)));
  const today = new Date().toISOString().slice(0,10);
  const eventDays = [];
  if (event.startDate && event.endDate) {
    let d=new Date(event.startDate+'T00:00:00'); const end=new Date(event.endDate+'T00:00:00'); let g=0;
    while(d<=end&&g<20){eventDays.push(d.toISOString().slice(0,10));d=new Date(d);d.setDate(d.getDate()+1);g++;}
  }
  const pocCoverage = conf.length&&eventDays.length
    ? Math.round((conf.filter(c=>eventDays.some(day=>poc.some(p=>p.contactId===c.id&&p.day===day))).length/conf.length)*100)
    : 0;
  const daysToEvent = event.startDate ? Math.ceil((new Date(event.startDate+'T00:00:00')-new Date())/(1000*60*60*24)) : null;

  const deptStats = depts.map(d=>{
    const dt=tasks.filter(t=>t.deptId===d.id);
    const done=dt.filter(t=>t.status==='Done').length;
    const hods=(d.hodIds||[]).map(id=>vols.find(v=>v.id===id)?.name).filter(Boolean).join(', ');
    return {name:d.name,total:dt.length,done,pct:dt.length?Math.round((done/dt.length)*100):0,hods,ready:d.ready};
  });

  return (
    <>
      <div className="page-head"><div className="ph-txt">
        <h1>Event Report</h1>
        <p>Senior review summary — one page overview of readiness for {event.name||'this event'}.</p>
      </div>
      <button className="btn sm" onClick={()=>window.print()}>{ICON.print}Print / PDF</button>
      </div>

      <div className="print-target" id="event-report">
        {/* Header */}
        <div style={{background:'var(--teal)',color:'#fff',borderRadius:'var(--r-lg)',padding:'20px 24px',marginBottom:20}}>
          <div style={{fontFamily:'var(--serif)',fontSize:24,fontWeight:500}}>{event.name||'VK Event'}</div>
          <div style={{fontSize:13.5,opacity:.85,marginTop:4}}>{event.venue}{event.startDate?' · '+fmtDate(event.startDate):''}{event.endDate&&event.endDate!==event.startDate?' – '+fmtDate(event.endDate):''}</div>
          {daysToEvent!==null&&<div style={{fontSize:22,fontFamily:'var(--serif)',marginTop:8,fontWeight:500}}>
            {daysToEvent>0?daysToEvent+' days to go':daysToEvent===0?'Event is today!':'Event has passed'}
          </div>}
        </div>

        {/* Key numbers */}
        <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(140px,1fr))',gap:12,marginBottom:20}}>
          {[
            {label:'Total invited',val:contacts.length,color:'var(--ink)'},
            {label:'Confirmed',val:conf.length,color:'var(--teal)',hint:`${Math.round(conf.length/(contacts.length||1)*100)}% of invited`},
            {label:'Pending',val:contacts.filter(c=>c.status==='Pending'||c.status==='Contacted').length,color:'var(--amber)'},
            {label:'Logistics done',val:logiDone.length+'/'+conf.length,color:logiDone.length===conf.length?'var(--teal)':'var(--amber)'},
            {label:'POC coverage',val:pocCoverage+'%',color:pocCoverage===100?'var(--teal)':pocCoverage>70?'var(--amber)':'var(--rose)'},
            {label:'Sessions',val:sessions.length,color:'var(--blue)'},
          ].map((s,i)=>(
            <div key={i} style={{background:'var(--surface)',border:'1px solid var(--line)',borderRadius:'var(--r)',padding:'14px 16px',boxShadow:'var(--shadow)'}}>
              <div style={{fontSize:11,color:'var(--muted)',fontWeight:500,marginBottom:4}}>{s.label}</div>
              <div style={{fontFamily:'var(--serif)',fontSize:26,color:s.color,lineHeight:1}}>{s.val}</div>
              {s.hint&&<div style={{fontSize:11,color:'var(--faint)',marginTop:3}}>{s.hint}</div>}
            </div>
          ))}
        </div>

        {/* Department readiness */}
        <div className="panel">
          <div className="panel-head"><h2>Department readiness</h2></div>
          <div className="panel-body"><table><thead><tr><th>Department</th><th>HOD</th><th>Tasks</th><th>Done</th><th>Progress</th><th>Sign-off</th></tr></thead><tbody>
            {deptStats.map((d,i)=>(
              <tr key={i}>
                <td><div className="nm">{d.name}</div></td>
                <td className="muted-sm">{d.hods||'—'}</td>
                <td className="mono">{d.total}</td>
                <td className="mono">{d.done}</td>
                <td>
                  <div style={{width:80,height:6,background:'var(--line)',borderRadius:3,display:'inline-block',verticalAlign:'middle'}}>
                    <div style={{width:d.pct+'%',height:'100%',background:d.pct===100?'var(--teal-2)':'var(--teal)',borderRadius:3}}/>
                  </div>
                  <span className="muted-sm" style={{marginLeft:6}}>{d.pct}%</span>
                </td>
                <td>{d.ready?<span className="badge b-confirmed">Ready ✓</span>:<span className="badge b-pending">Pending</span>}</td>
              </tr>
            ))}
            {!deptStats.length&&<tr><td colSpan="6"><div style={{padding:'12px',textAlign:'center',color:'var(--muted)',fontSize:13}}>No departments set up yet.</div></td></tr>}
          </tbody></table></div>
        </div>
      </div>
    </>
  );
}

/* ============================ FEATURE 15: CONTACT HISTORY ============================ */
export function ContactHistoryModal({ contact, rawStore, onClose }) {
  const allContacts = rawStore?.contacts || [];
  const allEvents = rawStore?.events || [];
  const normPhone = p => String(p||'').replace(/[^\d]/g,'').slice(-10);
  const normName  = n => String(n||'').toLowerCase().replace(/[^a-z0-9]/g,'');

  // Find all records of this person across all events
  const matches = allContacts.filter(c => {
    if (c.id === contact.id) return true;
    const ph = normPhone(contact.phone);
    if (ph.length >= 7 && normPhone(c.phone) === ph) return true;
    const nm = normName(contact.name);
    const cn = normName(c.name);
    return nm && cn && nm.length > 3 && (nm === cn || nm.includes(cn) || cn.includes(nm));
  });

  const history = matches.map(c => {
    const ev = allEvents.find(e => e.id === c.eventId);
    return { contact: c, event: ev };
  }).filter(h => h.event).sort((a,b) => (b.event.startDate||'') > (a.event.startDate||'') ? 1 : -1);

  return (
    <Modal title={`History — ${displayName(contact)}`} onClose={onClose} footer={null}>
      {history.length === 0
        ? <div style={{padding:'20px',textAlign:'center',color:'var(--muted)',fontSize:13}}>No cross-event history found for this contact.</div>
        : <div style={{display:'flex',flexDirection:'column',gap:10}}>
            {history.map((h,i)=>(
              <div key={i} style={{padding:'12px 14px',background:h.contact.id===contact.id?'var(--teal-wash)':'#F9F8F4',borderRadius:9,border:'1px solid var(--line)'}}>
                <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:4}}>
                  <span style={{fontFamily:'var(--serif)',fontSize:15,fontWeight:500}}>{h.event.name}</span>
                  {h.contact.id===contact.id&&<span className="badge b-confirmed" style={{fontSize:10}}>Current event</span>}
                  <span className="badge b-type" style={{marginLeft:'auto'}}>{h.event.type}</span>
                </div>
                <div style={{fontSize:12.5,color:'var(--muted)'}}>{h.event.startDate?fmtDate(h.event.startDate):''}{h.event.venue?' · '+h.event.venue:''}</div>
                <div style={{display:'flex',gap:8,marginTop:8,flexWrap:'wrap'}}>
                  <span className={'badge b-'+h.contact.status.toLowerCase()}>{h.contact.status}</span>
                  <span className="badge b-type">{h.contact.type}</span>
                  {h.contact.remark&&<span style={{fontSize:12,color:'var(--muted)'}}>{h.contact.remark}</span>}
                </div>
              </div>
            ))}
          </div>}
      <div className="modal-foot" style={{padding:'12px 0 0'}}><button className="btn" onClick={onClose}>Close</button></div>
    </Modal>
  );
}
