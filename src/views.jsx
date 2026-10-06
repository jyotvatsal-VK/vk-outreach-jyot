import React, { useState, useMemo, useEffect } from 'react';
import { saveItem, removeItem, batchUpsert } from './data';
import { trashItem, restoreTrashItem, purgeExpiredTrash, purgeTrashItem } from './trash_utils';
import { hasPermission } from './permissions';
import { useAuth, updateMyProfile } from './auth';
import { hasActiveFilter, filterSummary } from './contactFilter';
import {
  esc, initials, displayName, toMin, fmtDate, shortDate,
  buildPersonalSchedule, buildEventSchedule, buildFounderSchedule,
  localISO, todayISO, tomorrowISO,
} from './schedule';
import { ICON, Modal, Field, Empty, SearchBox, useToast } from './ui';
import { auth } from './firebase';
import {
  TRAVEL_CFG_ID, getTravelCfg, travelPlan, bookedMain, syncPatch, needsSync, travelWarnings, sourceLabel,
  knownPlaces, carIsTravel, samePlace, journeysFromLegs, passengerMatches,
} from './travel';

/* ── DeleteModal — reusable confirm-delete dialog ── */
function DeleteModal({ label, onClose, onConfirm }) {
  return (
    <div className="scrim" onMouseDown={onClose}>
      <div className="modal" onMouseDown={e=>e.stopPropagation()} style={{maxWidth:360}}>
        <div className="modal-head">
          <h2>Delete?</h2>
          <button className="x" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <p style={{fontSize:13}}>
            Are you sure you want to delete <strong>{label}</strong>?
            This will be moved to trash and can be restored within 30 days from Settings.
          </p>
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn danger" onClick={onConfirm}>Delete</button>
        </div>
      </div>
    </div>
  );
}

/* ── Error boundary — catches render crashes, shows message instead of blank ── */
class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(e) { return { error: e }; }
  componentDidCatch(e, info) { console.error('JYOT render error:', e, info); }
  render() {
    if (this.state.error) return (
      <div style={{padding:32,textAlign:'center'}}>
        <div style={{fontSize:32,marginBottom:12}}>⚠️</div>
        <div style={{fontWeight:600,fontSize:16,marginBottom:8}}>Something went wrong</div>
        <div style={{color:'var(--muted)',fontSize:13,marginBottom:16}}>{String(this.state.error)}</div>
        <button className="btn primary sm" onClick={()=>this.setState({error:null})}>Try again</button>
      </div>
    );
    return this.props.children;
  }
}
import { parseContactsFile, planImport, downloadTemplate, parseSessionsFile, planSessionsImport, parseVolunteersFile, planVolunteersImport, parseTasksFile, planTasksImport, matchDept, matchVolunteer } from './excel';

const STATUSES = ['Pending', 'Contacted', 'Tentative', 'Confirmed', 'Declined'];
const TYPES = ['Panelist', 'VIP', 'Podcast Guest', 'Guest'];
const TASK_STATUS = ['Open', 'In Progress', 'Blocked', 'Done'];
const SESSION_TYPES = ['Panel', 'Meal', 'Ceremony', 'Exhibition', 'Podcast', 'Competition', 'Drone Show', 'Hospitality'];
const SHIFTS = ['Full day', 'Morning', 'Afternoon', 'Evening'];

const S = (store, n) => store[n] || [];
const sbadge = (s) => <span className={'badge b-' + (s||'').toLowerCase().replace(/ /g, '-')}>{s}</span>;

/* ══ Sorting & Filtering utilities ════════════════════════════════ */
function useSortFilter(items, defaultSort) {
  const [sortKey, setSortKey] = useState(defaultSort?.key || '');
  const [sortDir, setSortDir] = useState(defaultSort?.dir || 'asc');
  const [filters, setFilters] = useState({});

  function toggleSort(key) {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir('asc'); }
  }

  function setFilter(key, val) {
    setFilters(prev => ({ ...prev, [key]: val }));
  }

  function clearFilters() { setFilters({}); }

  const sorted = useMemo(() => {
    let result = [...(items || [])];
    // Apply filters
    Object.entries(filters).forEach(([key, val]) => {
      if (!val || val === 'all') return;
      result = result.filter(item => {
        const v = String(item[key] || '').toLowerCase();
        return v.includes(val.toLowerCase());
      });
    });
    // Apply sort
    if (sortKey) {
      result.sort((a, b) => {
        const av = String(a[sortKey] || '').toLowerCase();
        const bv = String(b[sortKey] || '').toLowerCase();
        return sortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
      });
    }
    return result;
  }, [items, sortKey, sortDir, filters]);

  return { sorted, sortKey, sortDir, toggleSort, filters, setFilter, clearFilters };
}

function SortHeader({ label, sortKey, currentKey, dir, onSort, style }) {
  const active = currentKey === sortKey;
  return (
    <th onClick={() => onSort(sortKey)}
      style={{ cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap', ...style }}
      title={`Sort by ${label}`}>
      {label}
      <span style={{ marginLeft: 4, fontSize: 10, color: active ? 'var(--teal)' : 'var(--faint)' }}>
        {active ? (dir === 'asc' ? '▲' : '▼') : '⇅'}
      </span>
    </th>
  );
}

function FilterBar({ filters, setFilter, clearFilters, fields }) {
  const hasActive = fields.some(f => filters[f.key] && filters[f.key] !== 'all');
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', padding: '8px 0', marginBottom: 4 }}>
      {fields.map(f => f.options ? (
        <select key={f.key} className="statsel"
          style={{ fontSize: 12, color: filters[f.key] && filters[f.key] !== 'all' ? 'var(--teal)' : 'var(--muted)' }}
          value={filters[f.key] || 'all'}
          onChange={e => setFilter(f.key, e.target.value)}>
          <option value="all">{f.label}: All</option>
          {f.options.map(o => <option key={o} value={o}>{o}</option>)}
        </select>
      ) : (
        <input key={f.key} className="input"
          style={{ fontSize: 12, padding: '4px 10px', width: 140 }}
          value={filters[f.key] || ''}
          onChange={e => setFilter(f.key, e.target.value)}
          placeholder={`Filter ${f.label}…`} />
      ))}
      {hasActive && (
        <button className="btn ghost xs" onClick={clearFilters}
          style={{ fontSize: 11.5, color: 'var(--rose)' }}>✕ Clear filters</button>
      )}
    </div>
  );
}

/* ── Permission helper — reads from current user profile ─────────── */
function usePerm() {
  const { profile } = useAuth();
  return {
    can: (key) => hasPermission(profile, key),
    isMaster: profile?.role === 'Master',
  };
}

/* ── Lock icon shown when action is not permitted ────────────────── */
function NoAccess({ label }) {
  return (
    <span title={`You don't have permission: ${label}`}
      style={{ fontSize: 12, color: 'var(--faint)', cursor: 'not-allowed', padding: '4px 8px' }}>
      🔒
    </span>
  );
}


/* ── Quick export helper — downloads current filtered list as Excel ── */
async function quickExport(filename, rows, cols) {
  const XLSX = await import('xlsx');
  const data = rows.map(r => {
    const o = {};
    cols.forEach(([key, label]) => { o[label] = r[key] ?? ''; });
    return o;
  });
  const ws = XLSX.utils.json_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Export');
  XLSX.writeFile(wb, filename + '_' + todayISO() + '.xlsx');
}


/* ============================ DASHBOARD ============================ */
export function Dashboard({ store, go }) {
  const { profile } = useAuth();
  const contacts = S(store, 'contacts'), tasks = S(store, 'tasks');
  const conf = contacts.filter((c) => c.status === 'Confirmed');
  const pend = contacts.filter((c) => c.status === 'Pending' || c.status === 'Contacted');
  const logi = S(store, 'logistics');
  const hasLogi = (id) => logi.some((x) => x.contactId === id && (x.hotelName || x.arrivalDate || x.arrivalTime || x.hotel || x.inbTime));
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

  // Master / default view — built from widgets each user can customise
  const sessions   = S(store,'sessions');
  const assignments= S(store,'assignments');
  const openTasks  = tasks.filter(t=>t.status!=='Done');
  const blockedTasks = tasks.filter(t=>{
    const bl=(t.blockedBy||[]).map(id=>tasks.find(x=>x.id===id)).filter(Boolean).filter(b=>b.status!=='Done');
    return bl.length>0;
  });

  const statCards = [
    { label:'Invitees',       val:contacts.length, sub:`${conf.length} confirmed · ${pend.length} pending`,  color:'#0F6E56', emoji:'👥', onClick:()=>go('outreach') },
    { label:'Logistics',      val:conf.length,     sub:`${noLog.length} need travel details`,                color:'#1976D2', emoji:'🚌', onClick:()=>go('logistics') },
    { label:'Sessions',       val:sessions.length, sub:`${assignments.length} panel assignments`,            color:'#7B1FA2', emoji:'📅', onClick:()=>go('schedule') },
    { label:'Open tasks',     val:openTasks.length,sub:`${vols.length} volunteers · ${blockedTasks.length} blocked`, color:'#E65100', emoji:'✅', onClick:()=>go('depts') },
  ];

  const ctx = { store, go, statCards, pend, noLog, blockedTasks, conf };
  return <CustomDashboard ctx={ctx} />;
}

/* ══ Dashboard widgets ═════════════════════════════════════════════
   Each widget: id, title, perm (view permission needed), default visibility/size.
   Layout per user is saved on users/{uid}.dashboard; Master can save a default
   for everyone in appConfig/dashboardDefault. */
const DASH_WIDGETS = [
  { id:'stats',     title:'Key numbers',             perm:null,            on:true,  size:'full' },
  { id:'arrivals',  title:'Arrival countdown',       perm:'logistics.view', on:true,  size:'full' },
  { id:'followups', title:'Follow-ups due',          perm:'outreach.view', on:true,  size:'full' },
  { id:'deptDone',  title:'Department completed',    perm:'depts.view',    on:true,  size:'full' },
  { id:'attention', title:'Needs attention',         perm:null,            on:true,  size:'full' },
  { id:'today',     title:'Today at the event',      perm:'logistics.view', on:false, size:'full' },
  { id:'sahebji',   title:"Today's Sahebji meetings", perm:'schedule.view', on:false, size:'half' },
  { id:'pocGaps',   title:'POC gaps',                perm:'poc.view',      on:false, size:'half' },
  { id:'dueTasks',  title:'Tasks due soon',          perm:'depts.view',    on:false, size:'half' },
  { id:'flow',      title:'How the app connects',    perm:null,            on:true,  size:'full' },
];
const builtinLayout = () => ({ order: DASH_WIDGETS.map(w => w.id), hidden: DASH_WIDGETS.filter(w => !w.on).map(w => w.id), size: Object.fromEntries(DASH_WIDGETS.map(w => [w.id, w.size])) });
function normaliseLayout(l) {
  const base = builtinLayout();
  if (!l || !Array.isArray(l.order)) return base;
  const known = new Set(DASH_WIDGETS.map(w => w.id));
  const order = l.order.filter(id => known.has(id));
  DASH_WIDGETS.forEach(w => { if (!order.includes(w.id)) order.push(w.id); });   // new widgets appear at the end
  const newIds = DASH_WIDGETS.map(w => w.id).filter(id => !l.order.includes(id));
  const hidden = [...(l.hidden || []).filter(id => known.has(id)), ...newIds.filter(id => base.hidden.includes(id))];
  return { order, hidden, size: { ...base.size, ...(l.size || {}) } };
}

function CustomDashboard({ ctx }) {
  const { store, go } = ctx;
  const { user, profile } = useAuth();
  const toast = useToast();
  const isMaster = profile?.role === 'Master';
  const orgDefault = (store.appConfig || []).find(c => c.id === 'dashboardDefault');
  const saved = normaliseLayout(profile?.dashboard || (orgDefault && { order: orgDefault.order, hidden: orgDefault.hidden, size: orgDefault.size }));
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(saved);
  const allowed = w => !w.perm || hasPermission(profile, w.perm);
  const widgets = DASH_WIDGETS.filter(allowed);
  const byId = Object.fromEntries(widgets.map(w => [w.id, w]));
  const layout = editing ? draft : saved;

  function startEdit() { setDraft(saved); setEditing(true); }
  function move(id, dir) {
    setDraft(d => { const o = [...d.order]; const i = o.indexOf(id), j = i + dir; if (j < 0 || j >= o.length) return d; [o[i], o[j]] = [o[j], o[i]]; return { ...d, order: o }; });
  }
  const toggleHidden = id => setDraft(d => ({ ...d, hidden: d.hidden.includes(id) ? d.hidden.filter(x => x !== id) : [...d.hidden, id] }));
  const setSize = (id, sz) => setDraft(d => ({ ...d, size: { ...d.size, [id]: sz } }));
  async function save() {
    try { await updateMyProfile(user.uid, { dashboard: draft }); setEditing(false); toast('Dashboard saved.'); }
    catch (e) { toast('Could not save: ' + (e.code || e.message)); }
  }
  async function resetToDefault() {
    const def = normaliseLayout(orgDefault && { order: orgDefault.order, hidden: orgDefault.hidden, size: orgDefault.size });
    try { await updateMyProfile(user.uid, { dashboard: null }); setDraft(def); setEditing(false); toast('Dashboard reset to the default.'); }
    catch (e) { toast('Could not reset: ' + (e.code || e.message)); }
  }
  async function saveAsOrgDefault() {
    try { await saveItem('appConfig', { id: 'dashboardDefault', ...draft }); toast('Saved as the default layout for everyone.'); }
    catch (e) { toast('Could not save default: ' + (e.code || e.message)); }
  }

  const visible = layout.order.filter(id => byId[id] && !layout.hidden.includes(id));

  return (
    <>
      <div className="page-head">
        <div className="ph-txt">
          <h1>Dashboard</h1>
          <p>One connected view for this event. Choose what you see with Customise.</p>
        </div>
        {!editing && <button className="btn sm" onClick={startEdit}>{ICON.edit}Customise</button>}
      </div>

      {editing && (
        <div className="panel dash-edit">
          <div className="panel-head"><h2>Customise your dashboard</h2><div className="desc">Only you see these changes.</div></div>
          <div className="dash-edit-list">
            {draft.order.filter(id => byId[id]).map((id, i, arr) => (
              <div key={id} className={'dash-edit-row' + (draft.hidden.includes(id) ? ' off' : '')}>
                <label className="dash-edit-show">
                  <input type="checkbox" checked={!draft.hidden.includes(id)} onChange={() => toggleHidden(id)} />
                  <span>{byId[id].title}</span>
                </label>
                <div className="seg" role="group" aria-label="Width">
                  <button type="button" className={draft.size[id] !== 'half' ? 'on' : ''} onClick={() => setSize(id, 'full')}>Full</button>
                  <button type="button" className={draft.size[id] === 'half' ? 'on' : ''} onClick={() => setSize(id, 'half')}>Half</button>
                </div>
                <div className="dash-edit-move">
                  <button type="button" className="btn ghost xs" disabled={i === 0} onClick={() => move(id, -1)} aria-label="Move up">▲</button>
                  <button type="button" className="btn ghost xs" disabled={i === arr.length - 1} onClick={() => move(id, 1)} aria-label="Move down">▼</button>
                </div>
              </div>
            ))}
          </div>
          <div className="dash-edit-foot">
            <button className="btn ghost sm" onClick={resetToDefault}>Reset to default</button>
            {isMaster && <button className="btn sm" onClick={saveAsOrgDefault}>Save as default for everyone</button>}
            <div style={{ flex: 1 }} />
            <button className="btn sm" onClick={() => setEditing(false)}>Cancel</button>
            <button className="btn primary sm" onClick={save}>Save</button>
          </div>
        </div>
      )}

      <div className="dash-grid">
        {visible.map(id => {
          const body = renderDashWidget(id, ctx);
          if (!body) return null;
          return <div key={id} className={'dash-w' + (layout.size[id] === 'half' ? ' half' : '')}>{body}</div>;
        })}
      </div>
      {!visible.length && <div className="panel"><Empty title="Nothing to show" sub="Use Customise to turn widgets on." /></div>}
    </>
  );
}

function renderDashWidget(id, ctx) {
  const { store, go, statCards, pend, noLog, blockedTasks } = ctx;
  switch (id) {
    case 'stats': return (
      <div className="stat-grid-4" style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:12}}>
        {statCards.map(c=>(
          <div key={c.label} onClick={c.onClick} className="dash-stat">
            <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:10}}>
              <span style={{fontSize:11,fontWeight:600,color:'var(--muted)',textTransform:'uppercase',letterSpacing:'0.05em'}}>{c.label}</span>
              <span style={{fontSize:18,lineHeight:1}}>{c.emoji}</span>
            </div>
            <div style={{fontSize:36,fontWeight:700,color:c.color,fontFamily:'var(--serif)',lineHeight:1,marginBottom:6}}>{c.val}</div>
            <div style={{fontSize:11.5,color:'var(--muted)'}}>{c.sub}</div>
          </div>
        ))}
      </div>);
    case 'arrivals': return <ArrivalCountdown store={store} />;
    case 'followups': return <FollowUpDueToday store={store} go={go} />;
    case 'deptDone': return <DeptCompletionBanner store={store} />;
    case 'flow': return (
      <div className="flow-note" style={{marginBottom:0}}>{ICON.info}<div><b>Core flow:</b> in <b>Outreach</b>, set a pending invitee to <b>Confirmed</b> and a logistics record appears automatically. Build each guest's day in <b>Personalised Schedule</b> — session and arrival rows stay linked to <b>Scheduling</b> and <b>Logistics</b>. Use <b>Import from Excel</b> in Outreach to bulk-load your sheet.</div></div>);
    case 'attention': return (
      <div className="panel" style={{marginBottom:0}}>
        <div className="panel-head"><h2>Needs attention</h2><div className="desc">Auto-flagged</div></div>
        <div className="panel-body">
          <table><tbody>
            {pend.map(c=><AttnRow key={c.id} c={c} note={`${c.status} · last contacted ${fmtDate(c.last)||'—'}`} btn="Open Outreach" onClick={()=>go('outreach')}/>)}
            {noLog.map(c=><AttnRow key={'l'+c.id} c={c} note="Confirmed but no travel details" btn="Open Logistics" onClick={()=>go('logistics')}/>)}
            {blockedTasks.map(t=>(
              <tr key={t.id}>
                <td><div className="person"><div className="avatar" style={{background:'var(--rose-wash)',color:'var(--rose)'}}>!</div>
                  <div><div className="nm">{t.title}</div><div className="role">Blocked task</div></div></div></td>
                <td style={{textAlign:'right'}}><button className="btn sm" onClick={()=>go('depts')}>Open Tasks</button></td>
              </tr>
            ))}
            {!pend.length&&!noLog.length&&!blockedTasks.length&&(
              <tr><td colSpan="2"><div className="empty">{ICON.check}<h3>All clear</h3><p>No pending follow-ups right now.</p></div></td></tr>
            )}
          </tbody></table>
        </div>
      </div>);
    case 'today': return <TodayWidget store={store} go={go} />;
    case 'sahebji': return <SahebjiTodayWidget store={store} go={go} />;
    case 'pocGaps': return <PocGapsWidget store={store} go={go} />;
    case 'dueTasks': return <DueTasksWidget store={store} go={go} />;
    default: return null;
  }
}

function WidgetPanel({ title, action, onAction, children }) {
  return (
    <div className="panel" style={{marginBottom:0,height:'100%'}}>
      <div className="panel-head"><h2>{title}</h2>{action && <div className="right"><button className="btn ghost sm" onClick={onAction}>{action}</button></div>}</div>
      <div className="panel-pad" style={{paddingTop:12}}>{children}</div>
    </div>
  );
}

function TodayWidget({ store, go }) {
  const today = todayISO();
  const conf = (store.contacts||[]).filter(c=>c.status==='Confirmed');
  const L = cid => (store.logistics||[]).find(l=>l.contactId===cid||l.id===cid)||{};
  const arr = conf.filter(c=>L(c.id).arrivalDate===today).sort((a,b)=>(L(a.id).arrivalTime||'')>(L(b.id).arrivalTime||'')?1:-1);
  const dep = conf.filter(c=>L(c.id).departureDate===today);
  const onsite = conf.filter(c=>{const l=L(c.id);return l.arrivalDate&&l.departureDate&&l.arrivalDate<=today&&l.departureDate>=today;});
  const sess = (store.sessions||[]).filter(s=>s.date===today).sort((a,b)=>toMin(a.start)-toMin(b.start));
  return (
    <WidgetPanel title="Today at the event" action="Logistics" onAction={()=>go('logistics')}>
      <div className="dash-today">
        <div><div className="dash-k">{arr.length}</div><div className="muted-sm">arriving</div></div>
        <div><div className="dash-k">{onsite.length}</div><div className="muted-sm">on site</div></div>
        <div><div className="dash-k">{dep.length}</div><div className="muted-sm">departing</div></div>
        <div><div className="dash-k">{sess.length}</div><div className="muted-sm">sessions</div></div>
      </div>
      {arr.length>0 && <div className="dash-list">{arr.slice(0,8).map(c=><div key={c.id}><span className="mono">{L(c.id).arrivalTime||'—'}</span> {displayName(c)}{L(c.id).arrivalLocation?<span className="muted-sm"> · {L(c.id).arrivalLocation}</span>:null}</div>)}</div>}
      {sess.length>0 && <div className="dash-list">{sess.map(s=><div key={s.id}><span className="mono">{s.start}</span> {s.title}</div>)}</div>}
      {!arr.length && !sess.length && <div className="muted-sm">Nothing scheduled for today.</div>}
    </WidgetPanel>
  );
}

function SahebjiTodayWidget({ store, go }) {
  const today = todayISO();
  const ms = (store.founder||[]).filter(m=>m.date===today&&m.time).sort((a,b)=>toMin(a.time)-toMin(b.time));
  const name = id => { const c=(store.contacts||[]).find(x=>x.id===id); return c?displayName(c):'—'; };
  return (
    <WidgetPanel title="Today's Sahebji meetings" action="Open" onAction={()=>go('schedule')}>
      {ms.length ? <div className="dash-list">{ms.map(m=><div key={m.id}><span className="mono">{m.time}</span> {name(m.contactId)} <span className="muted-sm">· {m.duration||30} min</span></div>)}</div>
                 : <div className="muted-sm">No meetings today.</div>}
    </WidgetPanel>
  );
}

function PocGapsWidget({ store, go }) {
  const ps = (store.personalisedSchedule||[]).filter(r=>r.pocRequired&&r.date&&!r.deleted);
  const need = [...new Set(ps.map(r=>r.contactId+'_'+r.date))];
  const poc = store.poc||[];
  const gaps = need.filter(k=>{ const [cid,day]=[k.slice(0,k.lastIndexOf('_')),k.slice(k.lastIndexOf('_')+1)]; return !poc.some(p=>p.contactId===cid&&p.day===day); });
  return (
    <WidgetPanel title="POC gaps" action="POC Allocation" onAction={()=>go('pocallocation')}>
      <div className="dash-k" style={{color:gaps.length?'var(--rose)':'var(--teal)'}}>{gaps.length}</div>
      <div className="muted-sm">{gaps.length ? `guest-day${gaps.length>1?'s':''} still need a POC (of ${need.length})` : `All ${need.length} POC needs are covered`}</div>
    </WidgetPanel>
  );
}

function DueTasksWidget({ store, go }) {
  const today = todayISO();
  const soon = new Date(); soon.setDate(soon.getDate()+3); const soonISO = localISO(soon);
  const list = (store.tasks||[]).filter(t=>t.status!=='Done'&&t.due&&t.due<=soonISO).sort((a,b)=>a.due>b.due?1:-1);
  return (
    <WidgetPanel title="Tasks due soon" action="Tasks" onAction={()=>go('depts')}>
      {list.length ? <div className="dash-list">{list.slice(0,8).map(t=><div key={t.id}><span className="mono" style={{color:t.due<today?'var(--rose)':undefined}}>{shortDate(t.due)}</span> {t.title}</div>)}</div>
                   : <div className="muted-sm">Nothing due in the next 3 days.</div>}
    </WidgetPanel>
  );
}

const Stat = ({ label, icon, val, hint }) => <div className="stat"><div className="lab">{icon}{label}</div><div className="val">{val}</div><div className="hint">{hint}</div></div>;
const AttnRow = ({ c, note, btn, onClick }) => <tr><td><div className="person"><div className="avatar">{initials(c.name)}</div><div><div className="nm">{displayName(c)}</div><div className="role">{note}</div></div></div></td><td style={{ textAlign: 'right' }}><button className="btn sm" onClick={onClick}>{btn}</button></td></tr>;

/* ============================ OUTREACH ============================ */
export function Outreach({ store, activeEventId }) {
  const { profile } = useAuth();
  const toast = useToast();
  const contacts = S(store, 'contacts'), logi = S(store, 'logistics');
  const [q, setQ] = useState('');
  const [modal, setModal] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const [selectMode, setSelectMode] = useState(false);
  const [bulkStatus, setBulkStatus] = useState('Confirmed');
  const [showFilters, setShowFilters] = useState(false);
  const { can, isMaster } = usePerm();
  const { sorted: sortedContacts, sortKey: cSortKey, sortDir: cSortDir,
    toggleSort: cToggleSort, filters: cFilters, setFilter: cSetFilter, clearFilters: cClearFilters
  } = useSortFilter(contacts, { key: 'name', dir: 'asc' });

  const list = useMemo(() => {
    const t = q.toLowerCase();
    return sortedContacts.filter((c) => !t || displayName(c).toLowerCase().includes(t) || (c.org || '').toLowerCase().includes(t) || (c.field || '').toLowerCase().includes(t));
  }, [sortedContacts, q]);

  const [downgradeModal, setDowngradeModal] = useState(null);

  async function setStatus(c, val) {
    // Warn before downgrading a Confirmed VIP
    if (c.status === 'Confirmed' && val !== 'Confirmed') {
      const hasLogi = logi.some(x => x.contactId === c.id && (x.hotelName || x.arrivalDate || x.arrivalTime || x.hotel || x.inbTime));
      setDowngradeModal({ contact: c, newStatus: val, hasLogi });
      return;
    }
    await doSetStatus(c, val);
  }

  async function doSetStatus(c, val) {
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
      {hasActiveFilter(profile?.contactFilter) && (
        <div style={{background:'var(--amber-wash)',border:'1px solid #E8D5A3',borderRadius:10,padding:'10px 16px',fontSize:13,color:'var(--amber)',marginBottom:14,display:'flex',alignItems:'center',gap:8}}>
          🔒 <span><b>Filtered view</b> — showing contacts matching: {filterSummary(profile?.contactFilter)}. You can still add any contact — new contacts are visible to everyone with the right access.</span>
        </div>
      )}
      <div className="panel">
        <div className="panel-head"><h2>Invitees</h2><div className="desc">{list.length} shown</div>
          <div className="right">
            <SearchBox value={q} onChange={setQ} />
            <button className={'btn sm'+(showFilters?' primary':'')} onClick={()=>setShowFilters(f=>!f)} title="Filter">⚙ Filter</button>
            {can('outreach.import') && <button className={'btn sm'+(selectMode?' primary':'')} onClick={()=>{setSelectMode(s=>!s);setSelected(new Set());}}>
              {selectMode?'Cancel select':'Select multiple'}
            </button>}
            {selectMode&&selected.size>0&&<button className="btn sm" onClick={()=>setModal({type:'broadcast'})}>📢 Broadcast</button>}
            {can('outreach.import') && <button className="btn sm" onClick={() => setModal({ type: 'import' })}>{ICON.upload}Import</button>}
            <button className="btn sm" title="Export current filtered list" onClick={()=>quickExport('Outreach_Contacts', list, [
              ['name','Name'],['honor','Honorific'],['desig','Designation'],['org','Organisation'],
              ['field','Field'],['phone','Phone'],['email','Email'],['type','Type'],
              ['status','Status'],['eventRole','Event Role'],['eventNotes','Event Notes'],
              ['liaisonName','Liaison'],['remark','Remarks'],
            ])}>⬇ Export ({list.length})</button>
            {can('outreach.add') && <button className="btn primary sm" onClick={() => setModal({ type: 'add' })}>{ICON.plus}Add</button>}
          </div></div>
        {showFilters && <div style={{padding:'0 16px'}}><FilterBar
          filters={cFilters} setFilter={cSetFilter} clearFilters={cClearFilters}
          fields={[
            { key:'field', label:'Field', options:['Geopolitics','Legal','Economics','Business','Media','Politics','Social'] },
            { key:'status', label:'Status', options:['Pending','Contacted','Tentative','Confirmed','Declined'] },
            { key:'type', label:'Type', options:['Panelist','VIP','Podcast Guest','Guest'] },
          ]}
        /></div>}
        <div className="panel-body"><table>
          <thead><tr>
            {selectMode&&<th><input type="checkbox" checked={selected.size===list.length&&list.length>0} onChange={toggleAll} style={{accentColor:'var(--teal)'}}/></th>}
            <SortHeader label="Name" sortKey="name" currentKey={cSortKey} dir={cSortDir} onSort={cToggleSort}/>
            <SortHeader label="Field" sortKey="field" currentKey={cSortKey} dir={cSortDir} onSort={cToggleSort}/>
            <SortHeader label="Type" sortKey="type" currentKey={cSortKey} dir={cSortDir} onSort={cToggleSort}/>
            <th>Event info</th>
            <th title="Editable — specific to this event">Event role ✎</th>
            <th title="Editable — specific to this event">Event notes ✎</th>
            <th>Liaison</th>
            <SortHeader label="Status" sortKey="status" currentKey={cSortKey} dir={cSortDir} onSort={cToggleSort}/>
            <th></th>
          </tr></thead>
          <tbody>
            {list.map((c) => (
              <tr key={c.id} style={selected.has(c.id)?{background:'var(--teal-wash)'}:{}}>
                {selectMode&&<td><input type="checkbox" checked={selected.has(c.id)} onChange={()=>toggleSelect(c.id)} style={{accentColor:'var(--teal)'}}/></td>}
                <td><div className="person"><div className="avatar">{initials(c.name)}</div><div><div className="nm">{displayName(c)}</div><div className="role">{c.desig}{c.org ? ' · ' + c.org : ''}</div></div></div></td>
                <td><span className="muted-sm">{c.field}</span></td>
                <td><span className="badge b-type">{c.type}</span></td>
                <td>{(() => {
                  const L = logi.find(x=>x.contactId===c.id)||{};
                  const sCount = (store.assignments||[]).filter(a=>a.contactId===c.id).length;
                  const ld = L.arrivalDate&&(L.flightReq==='not_required'||L.arrivalFlightNo)&&(L.carReq==='not_required'||L.carVendorId)&&(L.accomReq==='not_required'||L.hotelName);
                  return (<div style={{fontSize:11.5}}><div style={{color:sCount?'var(--teal)':'var(--faint)',marginBottom:2}}>{sCount?`${sCount} session${sCount>1?'s':''}`:'No sessions'}</div><div style={{color:ld?'var(--teal)':L.arrivalDate?'var(--amber)':'var(--faint)'}}>{ld?'✓ Logistics':L.arrivalDate?'⚠ Partial':'—'}</div></div>);
                })()}</td>
                <td><span className="muted-sm">{c.liaisonName || '—'}</span></td>
                <td>{can('outreach.status')
                  ? <select className="statsel" value={c.status} onChange={(e) => setStatus(c, e.target.value)}>{STATUSES.map((s) => <option key={s}>{s}</option>)}</select>
                  : <span className="badge b-type">{c.status}</span>}</td>
                <td><div className="rowacts">
                  {can('outreach.whatsapp') && <button className="btn ghost xs" onClick={() => setModal({ type: 'whatsapp', id: c.id })} title="WhatsApp">💬</button>}
                  <button className="btn ghost xs" onClick={() => setModal({ type: 'sessions', id: c.id })} title="Assign sessions">🗓️
                    {(store.assignments||[]).filter(a=>a.contactId===c.id).length > 0 &&
                      <span style={{fontSize:9,background:'var(--teal)',color:'#fff',borderRadius:8,padding:'1px 4px',marginLeft:2}}>
                        {(store.assignments||[]).filter(a=>a.contactId===c.id).length}
                      </span>}
                  </button>
                  <button className="btn ghost xs" onClick={() => setModal({ type: 'history', id: c.id })} title="Contact history">📅</button>
                  <button className="btn ghost xs" onClick={() => setModal({ type: 'notes', id: c.id })} title="Follow-up log">
                    📝{noteCount(c.id)>0&&<span style={{fontSize:10,marginLeft:2,color:'var(--teal)',fontWeight:700}}>{noteCount(c.id)}</span>}
                  </button>
                  {can('outreach.edit') && <button className="btn ghost xs" onClick={() => setModal({ type: 'edit', id: c.id })}>{ICON.edit}</button>}
                  {can('outreach.delete') && <button className="btn ghost xs" onClick={() => setModal({ type: 'del', id: c.id })}>{ICON.trash}</button>}
                </div></td>
              </tr>
            ))}
            {!list.length && <tr><td colSpan={selectMode?10:9}><Empty title="No matches" sub="Try a different search, add a contact, or import from Excel." /></td></tr>}
          </tbody></table></div>
      </div>
      {/* Bulk action bar */}
      {selectMode && selected.size>0 && (
        <div className="bulk-bar" style={{position:'fixed',bottom:20,left:'50%',transform:'translateX(-50%)',background:'var(--ink)',color:'#fff',padding:'12px 20px',borderRadius:12,display:'flex',alignItems:'center',gap:12,boxShadow:'0 8px 30px rgba(0,0,0,.3)',zIndex:50,flexWrap:'wrap'}}>
          <span style={{fontSize:13.5,fontWeight:600}}>{selected.size} selected</span>
          <span style={{color:'var(--faint)'}}>→ Set status to</span>
          <select style={{background:'#fff',color:'var(--ink)',border:'none',borderRadius:7,padding:'5px 10px',fontWeight:600,fontSize:13}} value={bulkStatus} onChange={e=>setBulkStatus(e.target.value)}>
            {STATUSES.map(s=><option key={s}>{s}</option>)}
          </select>
          <button className="btn primary sm" onClick={applyBulk}>Apply to all</button>
          <button className="btn ghost sm" style={{color:'#fff'}} onClick={()=>{setSelected(new Set());setSelectMode(false);}}>Cancel</button>
        </div>
      )}
      {(modal?.type === 'add' || modal?.type === 'edit') && <ContactModal item={modal.type==='edit'?(store.contacts||[]).find(c=>c.id===modal.id)||null:null} activeEventId={activeEventId} store={store} onClose={() => setModal(null)} toast={toast} />}
      {modal?.type === 'import' && <ImportModal store={store} activeEventId={activeEventId} onClose={() => setModal(null)} toast={toast} />}
      {modal?.type === 'notes' && <ContactNotesModal contact={(store.contacts||[]).find(c=>c.id===modal.id)||{}} store={store} activeEventId={activeEventId} onClose={() => setModal(null)} />}
      {modal?.type === 'whatsapp' && <WhatsAppModal contact={(store.contacts||[]).find(c=>c.id===modal.id)||{}} store={store} activeEventId={activeEventId} onClose={() => setModal(null)} />}
      {modal?.type === 'broadcast' && <WhatsAppBroadcast contacts={list.filter(c=>selected.has(c.id))} onClose={()=>setModal(null)} />}
      {modal?.type === 'history' && <ContactHistoryModal contact={(store.contacts||[]).find(c=>c.id===modal.id)||{}} rawStore={store.__raw||store} onClose={() => setModal(null)} />}
      {modal?.type === 'sessions' && <ContactSessionsModal contact={(store.contacts||[]).find(c=>c.id===modal.id)||{}} store={store} activeEventId={activeEventId} onClose={() => setModal(null)} toast={toast} />}
      {downgradeModal && (
        <Modal title="⚠ Downgrade confirmed guest?" onClose={()=>setDowngradeModal(null)} size="sm" footer={null}>
          <p style={{fontSize:13.5}}><b>{displayName(downgradeModal.contact)}</b> is currently <b>Confirmed</b>. Changing to <b>{downgradeModal.newStatus}</b> will mark them as not attending.</p>
          {downgradeModal.hasLogi && <div style={{background:'var(--amber-wash)',borderRadius:8,padding:'10px 14px',fontSize:13,color:'var(--amber)',margin:'10px 0'}}>
            ⚠ This contact has travel and hotel details in Logistics. Those records will remain but will no longer appear in the active guest list.
          </div>}
          <div className="modal-foot" style={{padding:'12px 0 0'}}>
            <button className="btn" onClick={()=>setDowngradeModal(null)}>Cancel — keep as Confirmed</button>
            <button className="btn danger" onClick={async()=>{ await doSetStatus(downgradeModal.contact, downgradeModal.newStatus); setDowngradeModal(null); toast(`${displayName(downgradeModal.contact)} changed to ${downgradeModal.newStatus}.`); }}>Yes, change status</button>
          </div>
        </Modal>
      )}
      {modal?.type === 'del' && (()=>{
        const _c = (store.contacts||[]).find(c=>c.id===modal.id)||{};
        return _c.id ? <DeleteModal label={displayName(_c)} onClose={() => setModal(null)} onConfirm={async () => {
          const _id = modal.id;
          const _L = S(store,'logistics').find(x=>x.contactId===_id);
          const _F = S(store,'founder').find(x=>x.contactId===_id);
          const _assigns = S(store,'assignments').filter(a=>a.contactId===_id);
          const _pocs = S(store,'poc').filter(p=>p.contactId===_id);
          const _ps = (store.personalisedSchedule||[]).filter(r=>r.contactId===_id);
          const _feli = (store.felicitation||[]).filter(f=>f.contactId===_id);
          const linked = [
            ...(_L ? [{collection:'logistics', data:_L}] : []),
            ...(_F ? [{collection:'founder', data:_F}] : []),
            ..._assigns.map(a=>({collection:'assignments',data:a})),
            ..._pocs.map(p=>({collection:'poc',data:p})),
            ..._ps.map(r=>({collection:'personalisedSchedule',data:r})),
            ..._feli.map(f=>({collection:'felicitation',data:f})),
          ];
          setModal(null);
          await trashItem('contacts', _c, linked, profile?.email||'');
          // Remove from live collections
          if(_L) await removeItem('logistics', _L.id);
          if(_F) await removeItem('founder', _F.id);
          _assigns.forEach(a=>removeItem('assignments',a.id));
          _pocs.forEach(p=>removeItem('poc',p.id));
          _ps.forEach(r=>removeItem('personalisedSchedule',r.id));
          _feli.forEach(f=>removeItem('felicitation',f.id));
          await removeItem('contacts', _id);
          toast('Contact moved to trash. Restore within 30 days from Settings.');
        }} /> : null;
      })()}
    </>
  );
}

function ContactModal({ item, activeEventId, store, onClose, toast }) {
  const { profile } = useAuth();
  const [f, setF] = useState(() => ({ name: '', honor: '', desig: '', org: '', field: '', phone: '', email: '', liaisonName: '', liaisonPhone: '', type: 'Panelist', remark: '', tags: [], ...item }));
  const set = (k) => (e) => setF((p) => ({ ...p, [k]: e.target.value }));
  const [dupWarning, setDupWarning] = useState(null);

  const [errors, setErrors] = useState({});
  async function save() {
    const errs = {};
    if (!f.name.trim()) errs.name = 'Name is required';
    if (!f.type) errs.type = 'Type is required';
    if (Object.keys(errs).length) { setErrors(errs); return; }
    setErrors({});
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
      <Field label="Full name"><input className="input" style={errors.name?{borderColor:'var(--rose)'}:{}} value={f.name} onChange={e=>{set('name')(e);setErrors(p=>({...p,name:undefined}));}} placeholder="e.g. Sujit Dutta" />{errors.name&&<span style={{color:'var(--rose)',fontSize:12}}>{errors.name}</span>}</Field>
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
      <Field label="Tags (for filtering access, comma-separated)">
        <input className="input" value={Array.isArray(f.tags)?f.tags.join(', '):(f.tags||'')}
          onChange={e=>setF(p=>({...p,tags:e.target.value.split(',').map(t=>t.trim()).filter(Boolean)}))}
          placeholder="e.g. Priority, Bangalore batch, VK3 Speaker"/>
        <span style={{fontSize:11,color:'var(--muted)',marginTop:3,display:'block'}}>Master can filter user access by these tags in Settings → Users</span>
      </Field>
    </Modal>
    {dupWarning && <DuplicateWarningModal incoming={f} existing={dupWarning} onSaveAnyway={()=>{setDupWarning(null);doSave();}} onCancel={()=>setDupWarning(null)}/>}
  </>);
}

function ContactSessionsModal({ contact, store, activeEventId, onClose, toast }) {
  const sessions = (store.sessions || []).sort((a,b)=>a.date>b.date?1:-1);
  const assignments = store.assignments || [];

  return (
    <Modal title={`🗓️ Sessions — ${displayName(contact)}`} onClose={onClose} footer={null} size="md">
      <div style={{fontSize:13,color:'var(--muted)',marginBottom:12}}>
        Tick sessions this panelist will attend. Synced with Scheduling → Session Assignments.
      </div>
      {!sessions.length && <div style={{color:'var(--faint)',fontSize:13,padding:16,textAlign:'center'}}>
        No sessions yet. Add sessions in Scheduling first.
      </div>}
      {sessions.map(s => {
        const assigned = assignments.some(a=>a.contactId===contact.id&&a.sessionId===s.id);
        return (
          <label key={s.id} style={{display:'flex',alignItems:'center',gap:10,padding:'8px 12px',
            borderRadius:8,marginBottom:6,cursor:'pointer',
            border:`1px solid ${assigned?'var(--teal)':'var(--line)'}`,
            background:assigned?'var(--teal-wash)':'#fff'}}>
            <input type="checkbox" checked={assigned} style={{accentColor:'var(--teal)',width:15,height:15,flexShrink:0}}
              onChange={async e=>{
                if (e.target.checked) {
                  await saveItem('assignments',{contactId:contact.id,sessionId:s.id,role:'Panelist',eventId:activeEventId});
                  toast('Session assigned.');
                } else {
                  const a = assignments.find(x=>x.contactId===contact.id&&x.sessionId===s.id);
                  if (a) { await removeItem('assignments',a.id); toast('Session removed.'); }
                }
              }}/>
            <div style={{flex:1}}>
              <div style={{fontWeight:500,fontSize:13}}>{s.title}</div>
              <div style={{fontSize:11.5,color:'var(--muted)'}}>
                {s.date}{s.start&&` · ${s.start}`}{s.end&&` – ${s.end}`}{s.venue&&` · ${s.venue}`}
              </div>
            </div>
            {assigned && <span className="badge b-confirmed">Assigned</span>}
          </label>
        );
      })}
      <div className="modal-foot" style={{padding:'12px 0 0'}}>
        <button className="btn" onClick={onClose}>Done</button>
      </div>
    </Modal>
  );
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
/* ── Car Vendor Master (lives in Settings → Configurations) ──────── */
/* ── Logistics requirement toggle (standalone — cannot be nested) ── */
function LogisticsReqToggle({ cid, field, getL, toggleReq, setSubModal }) {
  const L = getL(cid);
  const val = L[field] || 'required';
  return (
    <div style={{ display:'flex', gap:4, alignItems:'center' }}>
      <select className="statsel"
        style={{ fontSize:11.5, color: val==='not_required'?'var(--muted)':'var(--teal)', background: val==='not_required'?'#F5F4F0':'var(--teal-wash)' }}
        value={val}
        onChange={e => toggleReq(cid, field, e.target.value)}>
        <option value="required">Required</option>
        <option value="not_required">Not Required</option>
      </select>
      {val==='required' && (
        <button className="btn ghost xs" title="Open details"
          onClick={() => {
            const typeMap = { flightReq:'flight', carReq:'car', accomReq:'accommodation' };
            setSubModal({ type: typeMap[field] || field.replace('Req','').toLowerCase(), contactId:cid, item:getL(cid) });
          }}>
          ✏️
        </button>
      )}
    </div>
  );
}


export function CarVendorMaster({ store }) {
  const { profile } = useAuth();
  const toast = useToast();
  const vendors = store.carVendors || [];
  const [modal, setModal] = useState(null);
  return (
    <>
      <div style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <div>
            <div style={{ fontWeight: 600, fontSize: 14 }}>Car Vendor Master</div>
            <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 2 }}>
              Vendors and drivers used for guest transport. Referenced in Logistics.
            </div>
          </div>
          <button className="btn primary sm" onClick={() => setModal({ type: 'add' })}>
            {ICON.plus} Add vendor
          </button>
        </div>
        {vendors.length > 0 ? (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: 'var(--teal-wash)' }}>
                {['Vendor name', 'Contact', 'Drivers', ''].map(h => (
                  <th key={h} style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 600, fontSize: 12, borderBottom: '1px solid var(--line)' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {vendors.map(v => (
                <tr key={v.id} style={{ borderBottom: '1px solid var(--line)' }}>
                  <td style={{ padding: '8px 12px', fontWeight: 500 }}>{v.name}</td>
                  <td style={{ padding: '8px 12px', color: 'var(--muted)' }}>{v.contact || '—'}</td>
                  <td style={{ padding: '8px 12px', color: 'var(--muted)' }}>
                    {(v.drivers || []).map(d => d.name).join(', ') || '—'}
                  </td>
                  <td style={{ padding: '8px 12px', textAlign: 'right' }}>
                    <div className="rowacts">
                      <button className="btn ghost xs" onClick={() => setModal({ type: 'edit', id: v.id })}>{ICON.edit}</button>
                      <button className="btn ghost xs" onClick={() => setModal({ type: 'del', id: v.id })}>{ICON.trash}</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div style={{ padding: '16px', color: 'var(--muted)', fontSize: 13, textAlign: 'center', background: 'var(--paper)', borderRadius: 8 }}>
            No vendors yet. Add vendors here to use them in Logistics.
          </div>
        )}
      </div>
      {(modal?.type === 'add' || modal?.type === 'edit') && (
        <VendorModal item={(store.carVendors||[]).find(v=>v.id===modal.id)||undefined} onClose={() => setModal(null)} toast={toast} />
      )}
      {modal?.type === 'del' && (() => {
        const _vendor = (store.carVendors||[]).find(v=>v.id===modal.id);
        return _vendor ? <DeleteModal label={_vendor.name} onClose={()=>setModal(null)}
          onConfirm={async()=>{const _v=(store.carVendors||[]).find(x=>x.id===modal.id);if(_v){await trashItem('carVendors',_v,[],profile?.email||'');}setModal(null);await removeItem('carVendors',modal.id);toast('Vendor moved to trash.');}}/> : null;
      })()}
    </>
  );
}

function VendorModal({ item, onClose, toast }) {
  const [name, setName] = useState(item?.name || '');
  const [contact, setContact] = useState(item?.contact || '');
  const [drivers, setDrivers] = useState(item?.drivers || []);
  const [driverName, setDriverName] = useState('');
  const [driverContact, setDriverContact] = useState('');
  const [errs, setErrs] = useState({});

  function addDriver() {
    if (!driverName.trim()) return;
    setDrivers(d => [...d, { id: Date.now().toString(), name: driverName.trim(), contact: driverContact.trim() }]);
    setDriverName(''); setDriverContact('');
  }

  async function save() {
    if (!name.trim()) { setErrs({ name: 'Vendor name is required' }); return; }
    await saveItem('carVendors', { ...item, name: name.trim(), contact: contact.trim(), drivers });
    onClose(); toast(item ? 'Vendor updated.' : 'Vendor added.');
  }

  return (
    <Modal title={item ? 'Edit vendor' : 'Add car vendor'} onClose={onClose} onSave={save}
      saveLabel={item ? 'Save changes' : 'Add vendor'}>
      <Field label="Vendor name">
        <input className="input" style={errs.name ? { borderColor: 'var(--rose)' } : {}}
          value={name} onChange={e => { setName(e.target.value); setErrs({}); }} />
        {errs.name && <span style={{ color: 'var(--rose)', fontSize: 11.5 }}>{errs.name}</span>}
      </Field>
      <Field label="Vendor contact">
        <input className="input" value={contact} onChange={e => setContact(e.target.value)} />
      </Field>
      <Field label="Drivers">
        <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
          <input className="input" style={{ flex: 1 }} value={driverName}
            onChange={e => setDriverName(e.target.value)} placeholder="Driver name"
            onKeyDown={e => e.key === 'Enter' && addDriver()} />
          <input className="input" style={{ width: 140 }} value={driverContact}
            onChange={e => setDriverContact(e.target.value)} placeholder="Contact" />
          <button className="btn sm" onClick={addDriver}>Add</button>
        </div>
        {drivers.map(d => (
          <div key={d.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 10px',
            background: 'var(--teal-wash)', borderRadius: 8, marginBottom: 4, fontSize: 13 }}>
            <span style={{ flex: 1 }}>{d.name}{d.contact ? ` — ${d.contact}` : ''}</span>
            <button onClick={() => setDrivers(dr => dr.filter(x => x.id !== d.id))}
              style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--rose)', fontSize: 14 }}>×</button>
          </div>
        ))}
      </Field>
    </Modal>
  );
}

/* ── TimePicker — HH:MM dropdowns (no native time input) ─────────── */
export function TimePicker({ value, onChange, style }) {
  const parts = (value || '').split(':');
  const hh = parts[0] || '';
  const mm = parts[1] || '';

  const hours = Array.from({length:24}, (_,i) => String(i).padStart(2,'0'));
  const mins  = ['00','05','10','15','20','25','30','35','40','45','50','55'];

  function update(newHH, newMM) {
    if (newHH && newMM) onChange(newHH + ':' + newMM);
    else if (newHH) onChange(newHH + ':' + (mm||'00'));
    else if (newMM) onChange((hh||'00') + ':' + newMM);
  }

  return (
    <div style={{display:'flex', gap:4, alignItems:'center', ...style}}>
      <select className="input" value={hh}
        style={{width:70, padding:'6px 4px', textAlign:'center'}}
        onChange={e => update(e.target.value, mm)}>
        <option value="">HH</option>
        {hours.map(h => <option key={h} value={h}>{h}</option>)}
      </select>
      <span style={{fontWeight:700, color:'var(--muted)'}}>:</span>
      <select className="input" value={mm}
        style={{width:70, padding:'6px 4px', textAlign:'center'}}
        onChange={e => update(hh, e.target.value)}>
        <option value="">MM</option>
        {mins.map(m => <option key={m} value={m}>{m}</option>)}
      </select>
    </div>
  );
}


/* ── Logistics — main table view ─────────────────────────────────── */
export function Logistics({ store, activeEventId }) {
  const toast = useToast();
  const { can } = usePerm();
  const contacts = (store.contacts || []).filter(c => c.status === 'Confirmed');
  const logi = store.logistics || [];
  const vendors = store.carVendors || [];
  const vols = store.volunteers || [];
  const [expandedId, setExpandedId] = useState(null);
  const [subModal, setSubModal] = useState(null);
  const [importOpen, setImportOpen] = useState(false);
  const [logiShowFilter, setLogiShowFilter] = useState(false);
  const [ttOpen, setTtOpen] = useState(false);
  const [syncBusy, setSyncBusy] = useState(false);
  const cfg = getTravelCfg(store);
  const places = knownPlaces(cfg, logi);

  // getL must be defined before logiWithNames uses it
  // If multiple docs exist for same contact, pick the most complete one
  const getL = cid => {
    const matches = logi.filter(x => x.contactId === cid);
    if (!matches.length) return { contactId: cid, eventId: activeEventId };
    if (matches.length === 1) return matches[0];
    // Pick the one with the most filled fields
    return matches.reduce((best, cur) => {
      const score = r => Object.values(r).filter(v => v && v !== activeEventId).length;
      return score(cur) > score(best) ? cur : best;
    });
  };

  // Build enriched logistics rows (with contact name for sorting)
  const logiWithNames = contacts.map(c => ({
    ...getL(c.id), _name: displayName(c), _contactId: c.id,
  }));
  const { sorted: logiSorted, sortKey: logiSortKey, sortDir: logiSortDir,
    toggleSort: logiToggleSort, filters: logiFilters, setFilter: logiSetFilter, clearFilters: logiClearFilters
  } = useSortFilter(logiWithNames, { key: '_name', dir: 'asc' });
  const sortedContacts = logiSorted.map(l => contacts.find(c => c.id === l._contactId)).filter(Boolean);

  if (!contacts.length) return (
    <>
      <div className="page-head"><div className="ph-txt"><h1>Logistics</h1><p>Confirmed guests appear here automatically.</p></div></div>
      <div className="panel"><Empty title="No confirmed guests yet" sub="Confirm invitees in Outreach to see them here." /></div>
    </>
  );

  // Toggle a top-level requirement field
  async function toggleReq(cid, field, val) {
    const L = getL(cid);
    const next = { ...L, [field]: val, eventId: activeEventId };
    await saveItem('logistics', { ...next, ...syncPatch(next, cfg) });   // main Arrival/Departure follow the bookings
    if (val === 'required') {
      const typeMap = { flightReq:'flight', carReq:'car', accomReq:'accommodation' };
      setSubModal({ type: typeMap[field] || field.replace('Req','').toLowerCase(), contactId: cid, item: L });
    }
  }

  async function setField(cid, key, val) {
    const L = getL(cid);
    await saveItem('logistics', { ...L, [key]: val, eventId: activeEventId });
  }

  // ReqToggle is defined as a standalone function below

  // Pending flag logic
  // A guest is "not required" when all 3 are explicitly marked not_required
  const isNotRequired = cid => {
    const L = getL(cid);
    return L.flightReq === 'not_required' && L.carReq === 'not_required' && L.accomReq === 'not_required';
  };

  // A guest is pending when at least one required item is incomplete
  const isPending = cid => {
    if (isNotRequired(cid)) return false; // all explicitly set — not pending
    const L = getL(cid);
    const flightPending = L.flightReq !== 'not_required' && (!L.arrivalFlightNo && !L.departureFlightNo);
    const carPending    = L.carReq    !== 'not_required' && !L.carVendorId;
    const accomPending  = L.accomReq  !== 'not_required' && !L.hotelName;
    const basicPending  = !L.arrivalDate;
    return flightPending || carPending || accomPending || basicPending;
  };

  return (
    <>
      <div className="page-head">
        <div className="ph-txt"><h1>Logistics</h1><p>Travel and stay for confirmed guests. Click any row to expand details.</p></div>
        <button className={'btn sm'+(logiShowFilter?' primary':'')} onClick={()=>setLogiShowFilter(f=>!f)}>⚙ Filter</button>
        <button className="btn sm" onClick={()=>quickExport('Logistics', sortedContacts.map(c=>{
          const L=getL(c.id);
          return {...L, guestName:displayName(c), arrivalDate:L.arrivalDate, departureDate:L.departureDate,
            hotel:L.hotelName, flightStatus:L.flightReq, carStatus:L.carReq, accomStatus:L.accomReq};
        }), [['guestName','Guest'],['arrivalDate','Arrival Date'],['arrivalTime','Arrival Time'],
          ['arrivalLocation','Arrival Location'],['departureDate','Departure Date'],['departureTime','Departure Time'],
          ['hotelName','Hotel'],['checkinDate','Check-in'],['checkoutDate','Check-out'],
          ['flightReq','Flight'],['carReq','Car'],['accomReq','Accommodation']])}>⬇ Export</button>
        <button className="btn sm" onClick={() => setImportOpen(true)}>{ICON.upload} Import</button>
        <button className="btn sm" onClick={() => setTtOpen(true)} title="Travel times between airport, hotels and venue">🕒 Travel times</button>
      </div>

      {/* Records whose main Arrival / Departure don't yet match their flight / car booking */}
      {(() => {
        const stale = contacts.map(c => getL(c.id)).filter(L => L.id && needsSync(L, cfg));
        if (!stale.length || !can('logistics.edit')) return null;
        return (
          <div className="mtg-note" style={{ display:'flex', alignItems:'center', gap:10, flexWrap:'wrap' }}>
            <span style={{ flex:1 }}>↻ <b>{stale.length} guest{stale.length>1?'s':''}</b> have flight / car details that aren't in their main Arrival / Departure yet.</span>
            <button className="btn sm" disabled={syncBusy} onClick={async () => {
              setSyncBusy(true);
              for (const L of stale) await saveItem('logistics', { ...L, ...syncPatch(L, cfg) });
              setSyncBusy(false); toast(`Updated ${stale.length} guest${stale.length>1?'s':''} from their bookings.`);
            }}>{syncBusy ? 'Updating…' : 'Update from bookings'}</button>
          </div>
        );
      })()}

      {/* Pending flag banner */}
      {(() => {
        const pend    = contacts.filter(c => isPending(c.id));
        const notReqd = contacts.filter(c => isNotRequired(c.id));
        return (<>
          {pend.length > 0 && (
            <div style={{ background:'var(--amber-wash)', border:'1px solid #E8D5A3', borderRadius:10,
              padding:'10px 16px', marginBottom:8, fontSize:13, color:'var(--amber)', display:'flex', gap:8, alignItems:'center' }}>
              ⚠ <b>{pend.length} guest{pend.length>1?'s':''}</b> have incomplete logistics — travel details need to be filled.
            </div>
          )}
          {notReqd.length > 0 && (
            <div style={{ background:'#F0F8F4', border:'1px solid var(--teal)', borderRadius:10,
              padding:'10px 16px', marginBottom:8, fontSize:13, color:'var(--teal)', display:'flex', gap:8, alignItems:'center' }}>
              ✓ <b>{notReqd.length} guest{notReqd.length>1?'s':''}</b> marked as no arrangements required (local/self-arranged).
            </div>
          )}
        </>);
      })()}

      <div className="panel">
        <div className="panel-body" style={{ overflowX: 'auto' }}>
          <table style={{ minWidth: 900 }}>
            <thead>
              <tr>
                {['#', 'Name', 'Contact', 'Overall POC', 'Arrival', 'Departure', 'Flight', 'Car', 'Accommodation', 'Remarks', ''].map(h => (
                  <th key={h} style={{ fontSize: 11.5, fontWeight: 600, whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sortedContacts.map((c, idx) => {
                const L = getL(c.id);
                const pending = isPending(c.id);
                const poc = vols.find(v => v.id === L.overallPocId);
                const isExpanded = expandedId === c.id;
                return (
                  <React.Fragment key={c.id}>
                    <tr
                      style={{ background: pending ? '#FFFBF2' : isNotRequired(c.id) ? '#F5FFF8' : 'white', cursor: 'pointer' }}
                      onClick={() => setExpandedId(isExpanded ? null : c.id)}>
                      <td style={{ color: 'var(--muted)', fontSize: 12 }}>{idx + 1}</td>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          {pending && <span title="Incomplete" style={{ color: 'var(--amber)', fontSize: 14 }}>⚠</span>}
                          <div>
                            <div className="nm">{displayName(c)}</div>
                            <div className="role">{c.type}</div>
                          </div>
                        </div>
                      </td>
                      <td className="muted-sm">{c.phone || '—'}</td>
                      <td>
                        <select className="statsel" value={L.overallPocId || ''}
                          onClick={e => e.stopPropagation()}
                          onChange={e => { e.stopPropagation(); setField(c.id, 'overallPocId', e.target.value); }}>
                          <option value="">— Assign POC —</option>
                          {vols.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
                        </select>
                      </td>
                      <td>
                        <div style={{ fontSize: 12 }}>
                          <div>{L.arrivalDate ? `${L.arrivalDate}` : <span style={{ color: 'var(--faint)' }}>No date</span>}</div>
                          {L.arrivalTime && <div style={{ color: 'var(--muted)' }}>{L.arrivalTime}</div>}
                          {L.arrivalLocation && <div style={{ color: 'var(--muted)' }}>{L.arrivalLocation}</div>}
                          {L.arrivalDate && <span className={'src-tag ' + sourceLabel(L, 'arrival').cls}>{sourceLabel(L, 'arrival').t}</span>}
                          {travelWarnings(L).filter(w => w.key !== 'departure' && w.key !== 'checkout').map(w => <div key={w.key} className="src-warn">⚠ {w.text}</div>)}
                        </div>
                      </td>
                      <td>
                        <div style={{ fontSize: 12 }}>
                          <div>{L.departureDate ? `${L.departureDate}` : <span style={{ color: 'var(--faint)' }}>No date</span>}</div>
                          {L.departureTime && <div style={{ color: 'var(--muted)' }}>{L.departureTime}</div>}
                          {L.departureLocation && <div style={{ color: 'var(--muted)' }}>{L.departureLocation}</div>}
                          {L.departureDate && <span className={'src-tag ' + sourceLabel(L, 'departure').cls}>{sourceLabel(L, 'departure').t}</span>}
                          {travelWarnings(L).filter(w => w.key === 'departure' || w.key === 'checkout').map(w => <div key={w.key} className="src-warn">⚠ {w.text}</div>)}
                        </div>
                      </td>
                      <td onClick={e => e.stopPropagation()}>{can('logistics.flight') ? <LogisticsReqToggle cid={c.id} field="flightReq" getL={getL} toggleReq={toggleReq} setSubModal={setSubModal}/> : <span className="muted-sm">{getL(c.id).flightReq||'required'}</span>}</td>
                      <td onClick={e => e.stopPropagation()}>{can('logistics.car') ? <LogisticsReqToggle cid={c.id} field="carReq" getL={getL} toggleReq={toggleReq} setSubModal={setSubModal}/> : <span className="muted-sm">{getL(c.id).carReq||'required'}</span>}</td>
                      <td onClick={e => e.stopPropagation()}>{can('logistics.accom') ? <LogisticsReqToggle cid={c.id} field="accomReq" getL={getL} toggleReq={toggleReq} setSubModal={setSubModal}/> : <span className="muted-sm">{getL(c.id).accomReq||'required'}</span>}</td>

                      <td style={{ color: 'var(--teal)', fontSize: 13 }}>{isExpanded ? '▲' : '▼'}</td>
                    </tr>
                    {isExpanded && (
                      <tr key={c.id + '_exp'}>
                        <td colSpan={11} style={{ background: 'var(--paper)', padding: '16px 20px', borderBottom: '2px solid var(--teal)' }}>
                          <LogisticsExpandedRow c={c} L={L} store={store} setField={setField} vendors={vendors} vols={vols} toast={toast} cfg={cfg} />
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Sub-modals for Flight / Car / Accommodation */}
      {subModal?.type === 'flight' && (
        <FlightModal contactId={subModal.contactId} item={getL(subModal.contactId)} cfg={cfg} places={places}
          guestName={(() => { const c = contacts.find(x => x.id === subModal.contactId); return c ? displayName(c) : ''; })()}
          onClose={() => setSubModal(null)} toast={toast} activeEventId={activeEventId} />
      )}
      {subModal?.type === 'car' && (
        <CarModal contactId={subModal.contactId} item={getL(subModal.contactId)} cfg={cfg} places={places}
          vendors={vendors} onClose={() => setSubModal(null)} toast={toast} activeEventId={activeEventId} />
      )}
      {subModal?.type === 'accommodation' && (
        <AccommodationModal contactId={subModal.contactId} item={getL(subModal.contactId)} cfg={cfg} places={places}
          onClose={() => setSubModal(null)} toast={toast} activeEventId={activeEventId} />
      )}
      {importOpen && <LogisticsImportModal store={store} activeEventId={activeEventId}
        onClose={() => setImportOpen(false)} toast={toast} />}
      {ttOpen && <TravelTimesModal cfg={cfg} places={places} canEdit={can('settings.config')} onClose={() => setTtOpen(false)} toast={toast} />}
    </>
  );
}

/* ── Expanded inline row — memoized to prevent remount on Firestore updates ── */
const LogisticsExpandedRow = React.memo(function LogisticsExpandedRow({ c, L, store, setField, vendors, vols, toast, cfg }) {
  const { can } = usePerm();
  const pick = X => ({
    arrivalDate: X.arrivalDate||'', arrivalTime: X.arrivalTime||'', arrivalLocation: X.arrivalLocation||'',
    departureDate: X.departureDate||'', departureTime: X.departureTime||'', departureLocation: X.departureLocation||'',
    remarks: X.remarks||'',
  });
  const [local, setLocal] = useState(() => pick(L));
  // Sync from Firestore ONLY when the row is first opened (not on every re-render)
  const initialised = React.useRef(false);
  React.useEffect(() => {
    if (!initialised.current) { setLocal(pick(L)); initialised.current = true; }
  }, [c.id]);
  const set = k => val => setLocal(p => ({...p, [k]: val}));
  const setE = k => e => setLocal(p => ({...p, [k]: e.target.value}));

  /* Arrival / Departure follow the flight or car booking unless overridden by hand */
  const [ov, setOv] = useState({ arrival: !!L.arrivalOverride, departure: !!L.departureOverride });
  const bm = bookedMain(L, cfg);
  const bookedFor = k => k === 'arrival' ? bm.arr : bm.dep;
  const follows = k => !ov[k] && !!bookedFor(k);
  const shown = (k, fld) => follows(k) ? (bookedFor(k)[fld.toLowerCase()] || '') : local[k + fld];
  const fresh = () => (store?.logistics || []).find(x => x.contactId === c.id) || { contactId: c.id };
  const canEdit = can('logistics.edit');

  function startOverride(k) {
    const b = bookedFor(k);
    setLocal(p => ({ ...p, [k+'Date']: b?.date || p[k+'Date'], [k+'Time']: b?.time || p[k+'Time'], [k+'Location']: b?.location || p[k+'Location'] }));
    setOv(p => ({ ...p, [k]: true }));
  }
  async function useBooking(k) {
    const next = { ...fresh(), [k+'Override']: false };
    await saveItem('logistics', { ...next, ...syncPatch(next, cfg) });
    setOv(p => ({ ...p, [k]: false }));
    toast(`${k === 'arrival' ? 'Arrival' : 'Departure'} now follows the booking.`);
  }
  async function save() {
    const next = { ...fresh(), remarks: local.remarks };
    ['arrival', 'departure'].forEach(k => {
      if (follows(k)) return;                       // filled from the booking — nothing typed
      const K = k[0].toUpperCase() + k.slice(1);
      Object.assign(next, { [k+'Date']: local[k+'Date'], [k+'Time']: local[k+'Time'], [k+'Location']: local[k+'Location'] });
      if (ov[k]) next[k+'Override'] = true;
      else { next[k+'Source'] = 'manual'; next['planned'+K+'Date'] = local[k+'Date']; next[k+'Override'] = false; }
    });
    await saveItem('logistics', { ...next, ...syncPatch(next, cfg) });
    toast('Logistics details saved.');
  }
  async function acceptWarning(w) {
    await saveItem('logistics', { ...fresh(), ...w.accept });
    toast('Planned dates updated to the booking.');
  }

  // Missing field detection
  const missing = [];
  if (!shown('arrival','Date'))     missing.push('Arrival date');
  if (!shown('arrival','Time'))     missing.push('Arrival time');
  if (!shown('arrival','Location')) missing.push('Arrival location');
  if (!shown('departure','Date'))   missing.push('Departure date');

  const plan = travelPlan(L, cfg);
  const warns = travelWarnings(L);
  const sideHead = (k, title) => {
    const b = bookedFor(k);
    const lbl = follows(k) ? { t: b.source === 'flight' ? `✈ From flight${b.ref ? ' ' + b.ref : ''}` : '🚗 From car', cls: b.source } : ov[k] ? { t: 'Manual override', cls: 'manual' } : { t: 'Planned (typed by you)', cls: 'planned' };
    return (
      <div style={{ display:'flex', alignItems:'center', gap:8, flexWrap:'wrap', marginBottom: 10, marginTop: k === 'departure' ? 12 : 0 }}>
        <span style={{ fontWeight: 600, fontSize: 13, color: 'var(--teal)' }}>{title}</span>
        <span className={'src-tag ' + lbl.cls}>{lbl.t}</span>
        {canEdit && follows(k) && <button className="linkbtn" style={{ fontSize: 12 }} onClick={() => startOverride(k)}>✎ Change by hand</button>}
        {canEdit && ov[k] && b && <button className="linkbtn" style={{ fontSize: 12 }} onClick={() => useBooking(k)}>↺ Use {b.source} details</button>}
      </div>
    );
  };

  return (
    <div>
      {missing.length > 0 && (
        <div style={{background:'var(--amber-wash)',border:'1px solid #E8D5A3',borderRadius:8,
          padding:'8px 14px',marginBottom:10,fontSize:12.5,color:'var(--amber)'}}>
          ⚠ Missing: {missing.join(' · ')}
        </div>
      )}
      {warns.length > 0 && (
        <div style={{background:'var(--rose-wash)',border:'1px solid #E9C9D2',borderRadius:8,padding:'8px 14px',marginBottom:10,fontSize:12.5,color:'var(--rose)'}}>
          {warns.map(w => (
            <div key={w.key} style={{display:'flex',alignItems:'center',gap:8,flexWrap:'wrap',padding:'2px 0'}}>
              <span style={{flex:1}}>⚠ {w.text}</span>
              {w.accept && canEdit && <button className="btn xs" onClick={() => acceptWarning(w)}>Accept booking dates</button>}
            </div>
          ))}
        </div>
      )}
      <div style={{marginBottom:14}}>
        <label style={{fontSize:12,fontWeight:600,display:'block',marginBottom:4,color:'var(--teal)'}}>Remarks</label>
        <textarea className="input" rows={2} value={local.remarks} onChange={setE('remarks')}
          placeholder="Special requirements, dietary needs, accessibility…"
          style={{resize:'vertical',fontFamily:'var(--sans)',width:'100%'}}/>
      </div>
    <div className="split-2" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
      {/* Left: Arrival / Departure — follow the booking, or typed by hand */}
      <div>
        {sideHead('arrival', 'Arrival details')}
        <fieldset disabled={follows('arrival')} className="logi-fs">
        <div className="grid2" style={{ gap: 8 }}>
          <Field label="Arrival date"><input className="input" type="date" value={shown('arrival','Date')} onChange={setE('arrivalDate')} style={!shown('arrival','Date')?{borderColor:'var(--amber)'}:{}}/></Field>
          <Field label="Arrival time"><TimePicker value={shown('arrival','Time')} onChange={set('arrivalTime')}/></Field>
          <Field label="Arrival location" style={{ gridColumn: '1/-1' }}><input className="input" value={shown('arrival','Location')} onChange={setE('arrivalLocation')} placeholder="Airport / station / venue" style={!shown('arrival','Location')?{borderColor:'var(--amber)'}:{}}/></Field>
        </div>
        </fieldset>
        {sideHead('departure', 'Departure details')}
        <fieldset disabled={follows('departure')} className="logi-fs">
        <div className="grid2" style={{ gap: 8 }}>
          <Field label="Departure date"><input className="input" type="date" value={shown('departure','Date')} onChange={setE('departureDate')} style={!shown('departure','Date')?{borderColor:'var(--amber)'}:{}}/></Field>
          <Field label="Departure from"><input className="input" value={shown('departure','Location')} onChange={setE('departureLocation')} placeholder="Airport / station" /></Field>
          <Field label="Departure time" style={{ gridColumn: '1/-1' }}><TimePicker value={shown('departure','Time')} onChange={set('departureTime')}/></Field>
        </div>
        </fieldset>
        {(!bm.arr || !bm.dep) && <p className="muted-sm" style={{ margin: '8px 0 0' }}>Enter the planned dates now. Once the flight or car is added, these fill in from the booking automatically.</p>}
      </div>
      {/* Right: sub-form summaries + travel plan */}
      <div>
        <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--teal)', marginBottom: 10 }}>Arrangements summary</div>
        {/* Summary of sub-form data */}
        {L.flightReq !== 'not_required' && (L.arrivalFlightNo || L.departureFlightNo) && (
          <div style={{ marginTop: 10, padding: '8px 12px', background: 'var(--teal-wash)', borderRadius: 8, fontSize: 12 }}>
            ✈️ {L.arrivalFlightNo ? <>Arrives {L.arrivalFlightNo} · {L.arrivalFlightDate} {L.arrivalFlightTime}</> : 'Arrival flight not added'}
            {L.departureFlightNo && <><br/>✈️ Departs {L.departureFlightNo} · {L.departureFlightDate} {L.departureFlightTime}{L.departureIntl ? ' · international' : ''}</>}
          </div>
        )}
        {L.carReq !== 'not_required' && L.carVendorId && (
          <div style={{ marginTop: 6, padding: '8px 12px', background: 'var(--teal-wash)', borderRadius: 8, fontSize: 12 }}>
            🚗 Car booked — {(vendors.find(v => v.id === L.carVendorId) || {}).name}{carIsTravel(L) && L.carPickupFrom ? ` · from ${L.carPickupFrom}` : ''}
          </div>
        )}
        {L.accomReq !== 'not_required' && L.hotelName && (
          <div style={{ marginTop: 6, padding: '8px 12px', background: 'var(--teal-wash)', borderRadius: 8, fontSize: 12 }}>
            🏨 {L.hotelName} — {L.checkinDate} to {L.checkoutDate}
          </div>
        )}
        <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--teal)', margin: '14px 0 6px' }}>Travel plan</div>
        {plan.steps.length ? (
          <div className="travel-plan">
            {plan.steps.map(st => (
              <div key={st.key} className={'tp-step ' + st.key}><span className="mono">{shortDate(st.date)} {st.time}</span><span>{st.label}</span></div>
            ))}
          </div>
        ) : <div className="muted-sm">Appears once the flight or car details are added.</div>}
        {plan.missing.length > 0 && (
          <div className="muted-sm" style={{ marginTop: 6, color: 'var(--amber)' }}>
            Add a travel time for {plan.missing.join(' and ')} (🕒 Travel times at the top) to work out the {plan.missing.length > 1 ? 'pickup and leave times' : 'remaining time'}.
          </div>
        )}
      </div>
    </div>
    <div style={{ marginTop: 14, display: 'flex', justifyContent: 'flex-end' }}>
      <button className="btn primary sm" onClick={save}>💾 Save details</button>
    </div>
    {!missing.length && !can('logistics.edit') && (
      <div style={{textAlign:'center',fontSize:12,color:'var(--muted)',marginTop:8}}>🔒 You have view-only access to logistics details.</div>
    )}
  </div>
  );
});

/* ── Flight modal ──────────────────────────────────────────────────
   "Upload ticket" sends the PDF / photo to /api/parse-ticket (Vercel function → Gemini),
   shows what it found, and fills the form only when you click "Fill the form". You still Save. */
const PLACES_LIST_ID = 'vk-travel-places';
function PlacesDatalist({ places }) {
  return <datalist id={PLACES_LIST_ID}>{(places || []).map(p => <option key={p} value={p} />)}</datalist>;
}
// Read a ticket file as base64. Large photos are scaled down so the upload stays under Vercel's limit.
async function ticketToPayload(file) {
  let blob = file, mimeType = file.type || (/\.pdf$/i.test(file.name) ? 'application/pdf' : '');
  if (!/^(application\/pdf|image\/)/.test(mimeType)) throw new Error('Please upload a PDF or a photo / screenshot of the ticket.');
  if (mimeType.startsWith('image/') && file.size > 1.5e6 && typeof createImageBitmap === 'function' && !/hei[cf]/.test(mimeType)) {
    try {
      const bmp = await createImageBitmap(file);
      const k = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
      const cv = document.createElement('canvas');
      cv.width = Math.round(bmp.width * k); cv.height = Math.round(bmp.height * k);
      cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height);
      blob = await new Promise(res => cv.toBlob(res, 'image/jpeg', 0.85));
      mimeType = 'image/jpeg';
    } catch { /* send the original */ }
  }
  if (blob.size > 3.2e6) throw new Error('This file is too large (max about 3 MB). Try a screenshot of the ticket instead.');
  const dataUrl = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(new Error('Could not read the file.')); r.readAsDataURL(blob); });
  return { data: String(dataUrl).split(',')[1] || '', mimeType };
}

function FlightModal({ contactId, item, onClose, toast, activeEventId, cfg, places = [], guestName = '' }) {
  const [f, setF] = useState(() => ({
    arrivalFrom: '', arrivalTo: '', arrivalFlightNo: '', arrivalFlightDate: '', arrivalFlightTime: '',
    departureFrom: '', departureTo: '', departureFlightNo: '', departureFlightDate: '', departureFlightTime: '', departureIntl: false,
    ...item,
  }));
  const set = k => e => setF(p => ({ ...p, [k]: e.target.value }));
  const [scan, setScan] = useState(null);   // { busy } | { error } | { journeys, use, passengers, pnr, airline, intl, nameOk }
  const canon = name => places.find(pl => samePlace(pl, name)) || name;   // use the Travel-times spelling when it's the same place

  async function readTicket(file) {
    if (!file) return;
    setScan({ busy: true });
    try {
      const payload = await ticketToPayload(file);
      const token = await auth?.currentUser?.getIdToken?.();
      const res = await fetch('/api/parse-ticket', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ ...payload, guestName }),
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out.error || (res.status === 404 ? 'Ticket reading isn’t set up on the server yet.' : `Server error (${res.status})`));
      const journeys = journeysFromLegs(out.legs || []);
      if (!journeys.length) throw new Error('No flights found on this ticket. Check it is a flight ticket, or fill the form by hand.');
      // First journey = arrival, last = departure; a one-way ticket fills whichever side is still empty
      const use = journeys.map((j, i) => journeys.length >= 2
        ? (i === 0 ? 'arrival' : i === journeys.length - 1 ? 'departure' : 'skip')
        : (f.arrivalFlightNo && !f.departureFlightNo ? 'departure' : 'arrival'));
      setScan({ journeys, use, passengers: out.passengers || [], pnr: out.pnr || '', airline: out.airline || '', intl: !!out.isInternational,
        nameOk: passengerMatches(out.passengers || [], guestName) });
    } catch (e) { setScan({ error: e.message || String(e) }); }
  }
  function fillFromScan() {
    const p = {};
    scan.journeys.forEach((j, i) => {
      if (scan.use[i] === 'arrival') Object.assign(p, { arrivalFrom: j.from, arrivalTo: canon(j.to), arrivalFlightNo: j.flightNo,
        arrivalFlightDate: j.arriveDate, arrivalFlightTime: j.arriveTime, arrivalPnr: scan.pnr });
      if (scan.use[i] === 'departure') Object.assign(p, { departureFrom: canon(j.from), departureTo: j.to, departureFlightNo: j.flightNo,
        departureFlightDate: j.departDate, departureFlightTime: j.departTime, departureIntl: scan.intl, departurePnr: scan.pnr });
    });
    setF(prev => ({ ...prev, ...p }));
    setScan(null);
    toast('Ticket details filled in — check them, then click Save.');
  }
  async function save() {
    const existing = item?.id ? { id: item.id } : {};
    const next = { ...f, ...existing, contactId, eventId: activeEventId };
    await saveItem('logistics', { ...next, ...syncPatch(next, cfg) });   // main Arrival / Departure follow the flight
    onClose(); toast('Flight details saved. Arrival / Departure updated from the flight.');
  }
  return (
    <Modal title="✈️ Flight details" onClose={onClose} onSave={scan?.busy ? null : save} saveLabel="Save flight details">
      <PlacesDatalist places={places} />
      <div className="ticket-scan">
        <label className={'btn sm' + (scan?.busy ? ' disabled' : '')} style={{ cursor: scan?.busy ? 'wait' : 'pointer' }}>
          📎 {scan?.busy ? 'Reading ticket…' : 'Upload ticket'}
          <input type="file" accept="application/pdf,image/*" style={{ display: 'none' }} disabled={!!scan?.busy}
            onChange={e => { readTicket(e.target.files?.[0]); e.target.value = ''; }} />
        </label>
        <span className="muted-sm">PDF, photo or screenshot. AI reads it and fills the form for you to check.</span>
      </div>
      {scan?.error && <div className="av-err" style={{ marginBottom: 10 }}>{scan.error}</div>}
      {scan?.journeys && (
        <div className="ticket-preview">
          <div className="muted-sm" style={{ marginBottom: 6 }}>
            Found{scan.airline ? ` · ${scan.airline}` : ''}{scan.pnr ? ` · PNR ${scan.pnr}` : ''}{scan.passengers.length ? ` · ${scan.passengers.join(', ')}` : ''}
          </div>
          {scan.nameOk === false && <div className="av-err" style={{ marginBottom: 8 }}>⚠ The passenger name doesn't look like {guestName}. Check this is the right ticket.</div>}
          {scan.journeys.map((j, i) => (
            <div key={i} className="tp-journey">
              <div style={{ flex: 1, minWidth: 200 }}>
                <b>{j.flightNo || 'Flight'}</b> · {j.from} → {j.to}
                <div className="muted-sm">Departs {j.departDate} {j.departTime} · Lands {j.arriveDate} {j.arriveTime}{j.legs.length > 1 ? ` · ${j.legs.length} flights (connection)` : ''}</div>
              </div>
              <select className="statsel" value={scan.use[i]} onChange={e => setScan(sc => ({ ...sc, use: sc.use.map((u, k) => k === i ? e.target.value : u) }))}>
                <option value="arrival">Use as arrival</option>
                <option value="departure">Use as departure</option>
                <option value="skip">Ignore</option>
              </select>
            </div>
          ))}
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button className="btn primary sm" onClick={fillFromScan} disabled={scan.use.every(u => u === 'skip')}>Fill the form</button>
            <button className="btn ghost sm" onClick={() => setScan(null)}>Discard</button>
          </div>
        </div>
      )}
      <div style={{ fontWeight: 600, fontSize: 12, color: 'var(--teal)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '.05em' }}>Arrival flight</div>
      <div className="grid2">
        <Field label="From"><input className="input" value={f.arrivalFrom} onChange={set('arrivalFrom')} placeholder="City or airport" /></Field>
        <Field label="To (airport / terminal)"><input className="input" list={PLACES_LIST_ID} value={f.arrivalTo} onChange={set('arrivalTo')} placeholder="e.g. Mumbai T2" /></Field>
        <Field label="Flight number"><input className="input" value={f.arrivalFlightNo} onChange={set('arrivalFlightNo')} placeholder="e.g. AI 631" /></Field>
        <Field label="Arrival date"><input className="input" type="date" value={f.arrivalFlightDate} onChange={set('arrivalFlightDate')} /></Field>
        <Field label="Arrival time"><TimePicker value={f.arrivalFlightTime} onChange={v => setF(p => ({...p, arrivalFlightTime:v}))}/></Field>
      </div>
      <div style={{ fontWeight: 600, fontSize: 12, color: 'var(--teal)', margin: '14px 0 8px', textTransform: 'uppercase', letterSpacing: '.05em' }}>Departure flight</div>
      <div className="grid2">
        <Field label="From (airport / terminal)"><input className="input" list={PLACES_LIST_ID} value={f.departureFrom} onChange={set('departureFrom')} placeholder="e.g. Mumbai T2" /></Field>
        <Field label="To"><input className="input" value={f.departureTo} onChange={set('departureTo')} placeholder="City or airport" /></Field>
        <Field label="Flight number"><input className="input" value={f.departureFlightNo} onChange={set('departureFlightNo')} placeholder="e.g. AI 632" /></Field>
        <Field label="Departure date"><input className="input" type="date" value={f.departureFlightDate} onChange={set('departureFlightDate')} /></Field>
        <Field label="Flight Departure Time"><TimePicker value={f.departureFlightTime} onChange={v => setF(p => ({...p, departureFlightTime:v}))}/></Field>
        <Field label="Flight type">
          <label className="chk" style={{ margin: '6px 0 0' }}><input type="checkbox" checked={!!f.departureIntl} onChange={e => setF(p => ({ ...p, departureIntl: e.target.checked }))} />
            International (reach airport {cfg.intlReport} min before, else {cfg.domesticReport})</label>
        </Field>
      </div>
    </Modal>
  );
}

/* ── Car modal ───────────────────────────────────────────────────── */
function CarModal({ contactId, item, vendors, onClose, toast, activeEventId, cfg, places = [] }) {
  const [f, setF] = useState(() => ({
    carVendorId: '', carDriverId: '', carType: 'SUV',
    carPickupDate: '', carPickupTime: '', carDepartureDate: '', carDepartureTime: '',
    ...item,
  }));
  const set = k => e => setF(p => ({ ...p, [k]: e.target.value }));
  const selectedVendor = vendors.find(v => v.id === f.carVendorId);
  const drivers = selectedVendor?.drivers || [];
  const selectedDriver = drivers.find(d => d.id === f.carDriverId);
  const [errs, setErrs] = useState({});

  async function save() {
    if (!f.carVendorId) { setErrs({ vendor: 'Select a vendor' }); return; }
    const existing = item?.id ? { id: item.id } : {};
    const next = { ...f, ...existing, contactId, eventId: activeEventId };
    await saveItem('logistics', { ...next, ...syncPatch(next, cfg) });
    onClose(); toast('Car details saved.');
  }
  const byCar = carIsTravel(f);               // Flight = Not required → the guest travels by car
  const plan = travelPlan(f, cfg);
  const Suggest = ({ s, onUse }) => s ? (
    <div className="car-suggest">
      <span>Suggested: <b>{shortDate(s.date)} {s.time}</b> <span className="muted-sm">({s.note})</span></span>
      <button type="button" className="btn xs" onClick={onUse}>Use</button>
    </div>
  ) : null;

  return (
    <Modal title="🚗 Car details" onClose={onClose} onSave={save} saveLabel="Save car details">
      <div className="grid2">
        <Field label="Car vendor">
          <select className="input" style={errs.vendor ? { borderColor: 'var(--rose)' } : {}}
            value={f.carVendorId} onChange={e => { set('carVendorId')(e); setF(p => ({ ...p, carDriverId: '' })); setErrs({}); }}>
            <option value="">— Select vendor —</option>
            {vendors.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
          {errs.vendor && <span style={{ color: 'var(--rose)', fontSize: 11.5 }}>{errs.vendor}</span>}
        </Field>
        <Field label="Vendor contact">
          <input className="input" value={selectedVendor?.contact || ''} readOnly style={{ background: 'var(--paper)', color: 'var(--muted)' }} />
        </Field>
        <Field label="Driver">
          <select className="input" value={f.carDriverId} onChange={set('carDriverId')} disabled={!f.carVendorId}>
            <option value="">— Select driver —</option>
            {drivers.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </Field>
        <Field label="Driver contact">
          <input className="input" value={selectedDriver?.contact || ''} readOnly style={{ background: 'var(--paper)', color: 'var(--muted)' }} />
        </Field>
        <Field label="Car type">
          <select className="input" value={f.carType} onChange={set('carType')}>
            {['SUV', 'Sedan', 'Basic'].map(t => <option key={t}>{t}</option>)}
          </select>
        </Field>
      </div>
      <PlacesDatalist places={places} />
      <div style={{ fontWeight: 600, fontSize: 12, color: 'var(--teal)', margin: '14px 0 8px', textTransform: 'uppercase', letterSpacing: '.05em' }}>
        {byCar ? 'Pickup — guest travels to the event by car' : 'Pickup at airport'}
      </div>
      {!byCar && <Suggest s={plan.carPickup} onUse={() => setF(p => ({ ...p, carPickupDate: plan.carPickup.date, carPickupTime: plan.carPickup.time }))} />}
      <div className="grid2">
        {byCar && <Field label="Pickup from (city / address)" style={{ gridColumn: '1/-1' }}>
          <input className="input" list={PLACES_LIST_ID} value={f.carPickupFrom || ''} onChange={set('carPickupFrom')} placeholder="e.g. Pune — used with Travel times to work out arrival" />
        </Field>}
        <Field label="Pickup date"><input className="input" type="date" value={f.carPickupDate} onChange={set('carPickupDate')} /></Field>
        <Field label="Pickup time"><TimePicker value={f.carPickupTime} onChange={v => setF(p => ({...p, carPickupTime:v}))}/></Field>
      </div>
      <div style={{ fontWeight: 600, fontSize: 12, color: 'var(--teal)', margin: '14px 0 8px', textTransform: 'uppercase', letterSpacing: '.05em' }}>
        {byCar ? 'Departure by car' : 'Drop to airport — pickup time'}
      </div>
      {!byCar && <Suggest s={plan.carDeparture} onUse={() => setF(p => ({ ...p, carDepartureDate: plan.carDeparture.date, carDepartureTime: plan.carDeparture.time }))} />}
      <div className="grid2">
        <Field label="Departure date"><input className="input" type="date" value={f.carDepartureDate} onChange={set('carDepartureDate')} /></Field>
        <Field label="Departure time"><TimePicker value={f.carDepartureTime} onChange={v => setF(p => ({...p, carDepartureTime:v}))}/></Field>
      </div>
    </Modal>
  );
}

/* ── Accommodation modal ─────────────────────────────────────────── */
function AccommodationModal({ contactId, item, onClose, toast, activeEventId, cfg, places = [] }) {
  const [f, setF] = useState(() => ({
    hotelName: '', checkinDate: '', checkinTime: '', checkoutDate: '', checkoutTime: '',
    ...item,
  }));
  const set = k => e => setF(p => ({ ...p, [k]: e.target.value }));

  const totalNights = f.checkinDate && f.checkoutDate
    ? Math.max(0, Math.ceil((new Date(f.checkoutDate) - new Date(f.checkinDate)) / (1000 * 60 * 60 * 24)))
    : null;

  async function save() {
    // Always save into existing logistics record if one exists
    const existing = item?.id ? { id: item.id } : {};
    const next = { ...f, ...existing, contactId, eventId: activeEventId };
    await saveItem('logistics', { ...next, ...syncPatch(next, cfg) });   // hotel changes the car arrival point
    onClose(); toast('Accommodation details saved.');
  }

  return (
    <Modal title="🏨 Accommodation details" onClose={onClose} onSave={save} saveLabel="Save accommodation">
      <Field label="Hotel name">
        <PlacesDatalist places={places} />
        <input className="input" list={PLACES_LIST_ID} value={f.hotelName} onChange={set('hotelName')} placeholder="Hotel name" />
      </Field>
      <div className="grid2">
        <Field label="Check-in date"><input className="input" type="date" value={f.checkinDate} onChange={set('checkinDate')} /></Field>
        <Field label="Check-in time"><TimePicker value={f.checkinTime} onChange={v => setF(p => ({...p, checkinTime:v}))}/></Field>
        <Field label="Check-out date"><input className="input" type="date" value={f.checkoutDate} onChange={set('checkoutDate')} /></Field>
        <Field label="Check-out time"><TimePicker value={f.checkoutTime} onChange={v => setF(p => ({...p, checkoutTime:v}))}/></Field>
      </div>
      {totalNights !== null && (
        <div style={{ padding: '10px 14px', background: 'var(--teal-wash)', borderRadius: 8, fontSize: 13, color: 'var(--teal)', fontWeight: 500 }}>
          Total nights: {totalNights}
        </div>
      )}
    </Modal>
  );
}


/* ── Travel times: minutes between places (both directions), buffers and peak hours ── */
function TravelTimesModal({ cfg, places, canEdit, onClose, toast }) {
  const rid = () => Math.random().toString(36).slice(2, 9);
  const [f, setF] = useState(() => ({
    venueName: cfg.venueName, landingBuffer: String(cfg.landingBuffer), domesticReport: String(cfg.domesticReport),
    intlReport: String(cfg.intlReport), peak: cfg.peak,
    routes: cfg.routes.length ? cfg.routes.map(r => ({ id: r.id || rid(), from: r.from || '', to: r.to || '', normal: r.normal ?? '', peak: r.peak ?? '' }))
                              : [{ id: rid(), from: '', to: cfg.venueName, normal: '', peak: '' }],
  }));
  const [err, setErr] = useState('');
  const setV = k => e => setF(p => ({ ...p, [k]: e.target.value }));
  const setR = (i, k, v) => setF(p => ({ ...p, routes: p.routes.map((r, j) => j === i ? { ...r, [k]: v } : r) }));
  async function save() {
    setErr('');
    const routes = f.routes.filter(r => r.from.trim() || r.to.trim());
    for (const r of routes) {
      if (!r.from.trim() || !r.to.trim()) { setErr('Every route needs both From and To.'); return; }
      if (r.normal === '' || isNaN(parseInt(r.normal, 10))) { setErr(`Add the normal minutes for ${r.from} → ${r.to}.`); return; }
    }
    const bad = f.peak.split(',').map(x => x.trim()).filter(Boolean).find(x => !/^\d{1,2}:\d{2}\s*[-–]\s*\d{1,2}:\d{2}$/.test(x));
    if (bad) { setErr(`Peak hours: "${bad}" isn't like 08:00-11:00.`); return; }
    await saveItem('appConfig', {
      id: TRAVEL_CFG_ID, venueName: f.venueName.trim() || 'Venue', peak: f.peak.trim(),
      landingBuffer: parseInt(f.landingBuffer, 10) || 0, domesticReport: parseInt(f.domesticReport, 10) || 0, intlReport: parseInt(f.intlReport, 10) || 0,
      routes: routes.map(r => ({ id: r.id, from: r.from.trim(), to: r.to.trim(), normal: parseInt(r.normal, 10), peak: r.peak === '' ? '' : parseInt(r.peak, 10) })),
    });
    toast('Travel times saved. Use "Update from bookings" if car arrival times need refreshing.');
    onClose();
  }
  return (
    <Modal title="🕒 Travel times" onClose={onClose} onSave={canEdit ? save : null} saveLabel="Save travel times">
      <PlacesDatalist places={places} />
      {!canEdit && <div className="mtg-note">View only — editing needs the "Edit configurations" permission.</div>}
      {err && <div className="av-err">{err}</div>}
      <fieldset disabled={!canEdit} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
        <p className="muted-sm" style={{ marginTop: 0 }}>
          Used to work out airport pickup times, arrival at the hotel and when to leave for the airport.
          A route works both ways. Place names should match what you type in Flight / Hotel / Car (suggestions appear as you type).
        </p>
        <div className="grid2">
          <Field label="Venue name"><input className="input" list={PLACES_LIST_ID} value={f.venueName} onChange={setV('venueName')} placeholder="e.g. NESCO" /></Field>
          <Field label="Peak hours (comma-separated)"><input className="input" value={f.peak} onChange={setV('peak')} placeholder="08:00-11:00, 17:00-21:00" /></Field>
          <Field label="Landing → car ready (min)"><input className="input" type="number" min={0} value={f.landingBuffer} onChange={setV('landingBuffer')} /></Field>
          <Field label="Reach airport before domestic flight (min)"><input className="input" type="number" min={0} value={f.domesticReport} onChange={setV('domesticReport')} /></Field>
          <Field label="Reach airport before international flight (min)"><input className="input" type="number" min={0} value={f.intlReport} onChange={setV('intlReport')} /></Field>
        </div>
        <div className="av-step" style={{ marginTop: 10 }}>Routes</div>
        <div className="tt-routes">
          <div className="tt-row tt-head"><span>From</span><span>To</span><span>Normal (min)</span><span>Peak (min)</span><span /></div>
          {f.routes.map((r, i) => (
            <div key={r.id} className="tt-row">
              <input className="input" list={PLACES_LIST_ID} value={r.from} onChange={e => setR(i, 'from', e.target.value)} placeholder="Mumbai T2" aria-label="From" />
              <input className="input" list={PLACES_LIST_ID} value={r.to} onChange={e => setR(i, 'to', e.target.value)} placeholder="Hotel / Venue" aria-label="To" />
              <input className="input" type="number" min={0} value={r.normal} onChange={e => setR(i, 'normal', e.target.value)} placeholder="45" aria-label="Normal minutes" />
              <input className="input" type="number" min={0} value={r.peak} onChange={e => setR(i, 'peak', e.target.value)} placeholder="optional" aria-label="Peak minutes" />
              <button type="button" className="btn ghost xs" aria-label="Remove route" onClick={() => setF(p => ({ ...p, routes: p.routes.filter((_, j) => j !== i) }))}>✕</button>
            </div>
          ))}
        </div>
        <button type="button" className="linkbtn" style={{ marginTop: 8 }} onClick={() => setF(p => ({ ...p, routes: [...p.routes, { id: rid(), from: '', to: '', normal: '', peak: '' }] }))}>+ Add route</button>
      </fieldset>
    </Modal>
  );
}

const SESSION_TYPES_NEW = ['Panel', 'Meal', 'Ceremony', 'Exhibition', 'Drone Show',
  'Media Bytes', 'Podcast', 'Hospitality', 'Miscellaneous'];

/* ══ Overall Schedule ══════════════════════════════════════════════ */
/* ── Overall schedule day table (standalone to avoid IIFE in JSX) ── */
function OverallDayTable({ daySessions, store, setModal }) {
  const { can } = usePerm();
  const colCfg = (store.appConfig||[]).find(c=>c.id==='columnConfig')||{};
  const activeCols = colCfg.overallSchedule || ['start','title','venue','type'];
  const COL_LABELS = { date:'Date', start:'Time', end:'End', title:'Session', venue:'Venue', type:'Type', topic:'Topic' };
  const showCol = k => activeCols.includes(k);
  return (
    <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
      <thead>
        <tr style={{ background:'var(--teal-wash)' }}>
          {activeCols.filter(k=>COL_LABELS[k]).map(k=>(
            <th key={k} style={{ padding:'7px 12px', textAlign:'left', fontSize:11.5, fontWeight:600, borderBottom:'1px solid var(--line)' }}>
              {COL_LABELS[k]}
            </th>
          ))}
          <th style={{ padding:'7px 12px' }}></th>
        </tr>
      </thead>
      <tbody>
        {daySessions.map(s => (
          <tr key={s.id} style={{ borderBottom:'1px solid var(--line)' }}>
            {showCol('date') && <td style={{ padding:'8px 12px', whiteSpace:'nowrap', color:'var(--muted)', fontSize:12 }}>{s.date||'—'}</td>}
            {showCol('start') && <td style={{ padding:'8px 12px', whiteSpace:'nowrap', color:'var(--muted)', fontSize:12 }}>{s.start||'—'}{s.end?` – ${s.end}`:''}</td>}
            {showCol('title') && <td style={{ padding:'8px 12px' }}><div className="nm">{s.title}</div>{s.topic&&<div className="role">{s.topic}</div>}</td>}
            {showCol('venue') && <td style={{ padding:'8px 12px', color:'var(--muted)', fontSize:12 }}>{s.venue||'—'}</td>}
            {showCol('type') && <td style={{ padding:'8px 12px' }}><span className="badge b-type">{s.type}</span></td>}
            {showCol('topic') && !showCol('title') && <td style={{ padding:'8px 12px', color:'var(--muted)', fontSize:12 }}>{s.topic||'—'}</td>}
            <td style={{ padding:'8px 12px', textAlign:'right' }}>
              <div className="rowacts">
                {can('schedule.minutemin') && <button className="btn ghost xs" onClick={()=>setModal({type:'minsched',id:s.id})} title="Minute-to-minute">📋</button>}
                {can('schedule.edit') && <button className="btn ghost xs" onClick={()=>setModal({type:'edit',id:s.id})}>{ICON.edit}</button>}
                {can('schedule.edit') && <button className="btn ghost xs" onClick={()=>setModal({type:'del',id:s.id})}>{ICON.trash}</button>}
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}


export function OverallSchedule({ store, activeEventId }) {
  const { profile } = useAuth();
  const toast = useToast();
  const { can } = usePerm();
  const sessions = (store.sessions || []).sort((a, b) =>
    a.date > b.date ? 1 : a.date < b.date ? -1 : (a.start || '') > (b.start || '') ? 1 : -1);
  const [modal, setModal] = useState(null);
  const [q, setQ] = useState('');
  const [viewMode, setViewMode] = useState('list'); // 'list' | 'overlay'

  const filtered = sessions.filter(s =>
    !q || (s.title || '').toLowerCase().includes(q.toLowerCase()) ||
    (s.venue || '').toLowerCase().includes(q.toLowerCase()));

  // Group by date
  const byDate = {};
  filtered.forEach(s => {
    const d = s.date || 'No date';
    if (!byDate[d]) byDate[d] = [];
    byDate[d].push(s);
  });

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14, flexWrap: 'wrap', gap: 8 }}>
        <SearchBox value={q} onChange={setQ} />
        <div style={{ display: 'flex', gap: 8 }}>
          <div style={{display:'flex',border:'1px solid var(--line)',borderRadius:8,overflow:'hidden'}}>
            <button onClick={()=>setViewMode('list')}
              style={{padding:'5px 12px',border:'none',background:viewMode==='list'?'var(--teal)':'#fff',
                color:viewMode==='list'?'#fff':'var(--muted)',cursor:'pointer',fontSize:12,fontWeight:500}}>
              ☰ List
            </button>
            <button onClick={()=>setViewMode('overlay')}
              style={{padding:'5px 12px',border:'none',background:viewMode==='overlay'?'var(--teal)':'#fff',
                color:viewMode==='overlay'?'#fff':'var(--muted)',cursor:'pointer',fontSize:12,fontWeight:500}}>
              ⊞ Grid
            </button>
          </div>
          {can('schedule.edit') && <button className="btn sm" onClick={() => setModal({ type: 'import' })}>{ICON.upload} Import</button>}
          {can('schedule.edit') && <button className="btn primary sm" onClick={() => setModal({ type: 'add' })}>{ICON.plus} Add session</button>}
        </div>
      </div>

      {Object.keys(byDate).length === 0 && (
        <Empty title="No sessions yet" sub="Add sessions manually or import from Excel." />
      )}

      {/* ── Overlay / Grid view ──────────────────────────────── */}
      {viewMode === 'overlay' && Object.keys(byDate).length > 0 && (
        <OverlaySchedule byDate={byDate} onEdit={s=>can('schedule.edit')&&setModal({type:'edit',id:s.id})}
          onDelete={s=>can('schedule.edit')&&setModal({type:'del',id:s.id})} onMinSched={s=>can('schedule.minutemin')&&setModal({type:'minsched',id:s.id})}/>
      )}

      {/* ── List view ────────────────────────────────────────── */}
      {viewMode === 'list' && Object.entries(byDate).map(([date, daySessions]) => (
        <div key={date} style={{ marginBottom: 20 }}>
          <div style={{ fontFamily: 'var(--serif)', fontSize: 15, fontWeight: 500, color: 'var(--teal)',
            marginBottom: 8, paddingBottom: 4, borderBottom: '1px solid var(--line)' }}>
            {date !== 'No date' ? fmtDate(date) : 'No date set'}
          </div>
          <OverallDayTable daySessions={daySessions} store={store} setModal={setModal}/>
        </div>
      ))}

      {(modal?.type === 'add' || modal?.type === 'edit') && (
        <OverallSessionModal item={sessions.find(s=>s.id===modal.id)||undefined} activeEventId={activeEventId}
          onClose={() => setModal(null)} toast={toast} />
      )}
      {modal?.type === 'del' && (() => {
        const _sess = sessions.find(s=>s.id===modal.id);
        return _sess ? <DeleteModal label={_sess.title} onClose={()=>setModal(null)}
          onConfirm={async()=>{const _s=sessions.find(x=>x.id===modal.id);const _sa=(store.assignments||[]).filter(a=>a.sessionId===modal.id);if(_s){await trashItem('sessions',_s,_sa.map(a=>({collection:'assignments',data:a})),profile?.email||'');}_sa.forEach(a=>removeItem('assignments',a.id));setModal(null);await removeItem('sessions',modal.id);toast('Session moved to trash.');}}/> : null;
      })()}
      {modal?.type === 'minsched' && (
        <MinuteToMinuteModal session={sessions.find(s=>s.id===modal.id)||undefined} store={store} activeEventId={activeEventId}
          onClose={() => setModal(null)} toast={toast} />
      )}
      {modal?.type === 'import' && (
        <ImportModal store={store} activeEventId={activeEventId} onClose={() => setModal(null)} toast={toast} />
      )}
    </>
  );
}

/* ── Overlay / Grid Schedule View ───────────────────────────────── */
function OverlaySchedule({ byDate, onEdit, onDelete, onMinSched }) {
  const TYPE_COLORS = {
    'Panel': '#0F6E56', 'Meal': '#A8690C', 'Ceremony': '#7C5CBF',
    'Exhibition': '#1C5D8C', 'Drone Show': '#9A3550', 'Media Bytes': '#1D9E75',
    'Podcast': '#5B7C1F', 'Hospitality': '#C17A2A', 'Miscellaneous': '#6E776F',
  };
  const { can } = usePerm();

  function assignLanes(sessions) {
    const sorted = [...sessions].sort((a,b)=>(a.start||'')>(b.start||'')?1:-1);
    const lanes = [];
    sorted.forEach(s => {
      const sStart = toMin(s.start||'00:00');
      const sEnd   = toMin(s.end||s.start||'00:00') + (s.end ? 0 : 60);
      let placed = false;
      for (let i = 0; i < lanes.length; i++) {
        const last = lanes[i][lanes[i].length-1];
        const lEnd = toMin(last.end||last.start||'00:00') + (last.end ? 0 : 60);
        if (sStart >= lEnd) { lanes[i].push(s); placed = true; break; }
      }
      if (!placed) lanes.push([s]);
    });
    return lanes;
  }

  return (
    <div style={{ overflowX: 'auto' }}>
      {Object.entries(byDate).map(([date, sessions]) => {
        const sorted = [...sessions].sort((a,b)=>(a.start||'')>(b.start||'')?1:-1);
        const starts = sorted.map(s=>s.start).filter(Boolean);
        if (!starts.length) return null;

        const dayStart = toMin(starts[0]);
        const dayEnd   = Math.max(...sorted.map(s=>toMin(s.end||s.start||'00:00')+(s.end?0:60)));
        const totalMin = Math.max(dayEnd - dayStart, 60);
        const PX = 3; // px per minute
        const lanes = assignLanes(sorted);

        return (
          <div key={date} style={{ marginBottom:24 }}>
            <div style={{ fontFamily:'var(--serif)', fontSize:15, fontWeight:500,
              color:'var(--teal)', marginBottom:8, paddingBottom:4, borderBottom:'1px solid var(--line)' }}>
              {date !== 'No date' ? fmtDate(date) : 'No date set'}
              {lanes.length > 1 && <span style={{fontSize:11,color:'var(--muted)',marginLeft:8}}>({lanes.length} parallel tracks)</span>}
            </div>

            <div style={{ overflowX:'auto' }}>
              {/* Time ruler */}
              <div style={{ position:'relative', height:18, minWidth: totalMin*PX+16, marginBottom:2 }}>
                {Array.from({length: Math.ceil(totalMin/60)+1}, (_,i) => {
                  const min = dayStart + i*60;
                  if (min > dayEnd) return null;
                  const hh = String(Math.floor(min/60)).padStart(2,'0');
                  const mm = String(min%60).padStart(2,'0');
                  return (
                    <div key={i} style={{position:'absolute', left:8+i*60*PX, fontSize:10, color:'var(--faint)'}}>
                      {hh}:{mm}
                    </div>
                  );
                })}
              </div>

              {/* Lanes */}
              {lanes.map((lane, laneIdx) => (
                <div key={laneIdx} style={{ position:'relative', height:88, marginBottom:3,
                  minWidth: totalMin*PX+16, background:'#FAFAF7', borderRadius:6 }}>
                  {lane.map(s => {
                    const sStart = toMin(s.start||'00:00');
                    const sEnd   = toMin(s.end||s.start||'00:00') + (s.end ? 0 : 60);
                    const left   = 8 + (sStart - dayStart)*PX;
                    const width  = Math.max((sEnd - sStart)*PX - 2, 60);
                    const color  = TYPE_COLORS[s.type] || '#6E776F';
                    return (
                      <div key={s.id} style={{
                        position:'absolute', top:2, left, width, height:84,
                        background:color+'18', border:`2px solid ${color}`,
                        borderRadius:6, padding:'4px 6px', overflow:'hidden',
                      }} title={`${s.start}${s.end?` – ${s.end}`:''} · ${s.title}${s.venue?` · ${s.venue}`:''}`}>
                        <div style={{fontSize:10,fontWeight:700,color,lineHeight:1.2}}>
                          {s.start}{s.end?`–${s.end}`:''}
                        </div>
                        <div style={{fontSize:11,fontWeight:600,color:'var(--ink)',lineHeight:1.2,marginTop:1,wordBreak:'break-word'}}>
                          {s.title}
                        </div>
                        {s.venue && <div style={{fontSize:10,color:'var(--muted)'}}>{s.venue}</div>}
                        <div style={{display:'flex',gap:2,marginTop:3}}>
                          {can('schedule.minutemin') && <button className="btn ghost xs" style={{fontSize:9,padding:'1px 3px'}}
                            onClick={e=>{e.stopPropagation();onMinSched(s);}}>📋</button>}
                          {can('schedule.edit') && <button className="btn ghost xs" style={{fontSize:9,padding:'1px 3px'}}
                            onClick={e=>{e.stopPropagation();onEdit(s);}}>{ICON.edit}</button>}
                          {can('schedule.edit') && <button className="btn ghost xs" style={{fontSize:9,padding:'1px 3px'}}
                            onClick={e=>{e.stopPropagation();onDelete(s);}}>{ICON.trash}</button>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ))}

              {/* Legend */}
              <div style={{display:'flex',flexWrap:'wrap',gap:8,marginTop:4}}>
                {[...new Set(sorted.map(s=>s.type))].map(type=>(
                  <div key={type} style={{display:'flex',alignItems:'center',gap:4,fontSize:11,color:'var(--muted)'}}>
                    <div style={{width:10,height:10,borderRadius:2,background:TYPE_COLORS[type]||'#6E776F'}}/>
                    {type}
                  </div>
                ))}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}



function OverallSessionModal({ item, activeEventId, onClose, toast }) {
  const [f, setF] = useState(() => ({
    title: '', topic: '', date: '', start: '', end: '', venue: '', type: 'Panel', ...item
  }));
  const set = k => e => setF(p => ({ ...p, [k]: e.target.value }));
  const [errs, setErrs] = useState({});

  async function save() {
    const e = {};
    if (!f.title.trim()) e.title = 'Session title is required';
    if (!f.date) e.date = 'Date is required';
    if (!f.start) e.start = 'Start time is required';
    if (f.end && f.start && f.end <= f.start) e.end = 'End time must be after start time';
    if (Object.keys(e).length) { setErrs(e); return; }
    await saveItem('sessions', { ...f, eventId: activeEventId });
    onClose(); toast(item ? 'Session updated.' : 'Session added.');
  }

  return (
    <Modal title={item ? 'Edit session' : 'Add session'} onClose={onClose} onSave={save} saveLabel={item ? 'Save changes' : 'Add session'}>
      <Field label="Session title">
        <input className="input" style={errs.title ? { borderColor: 'var(--rose)' } : {}}
          value={f.title} onChange={e => { set('title')(e); setErrs(p => ({ ...p, title: undefined })); }}
          placeholder="e.g. Legal Round Table Deliberation" />
        {errs.title && <span style={{ color: 'var(--rose)', fontSize: 11.5 }}>{errs.title}</span>}
      </Field>
      <Field label="Topic / description">
        <input className="input" value={f.topic} onChange={set('topic')} />
      </Field>
      <div className="grid2">
        <Field label="Date">
          <input className="input" type="date" style={errs.date ? { borderColor: 'var(--rose)' } : {}}
            value={f.date} onChange={e => { set('date')(e); setErrs(p => ({ ...p, date: undefined })); }} />
          {errs.date && <span style={{ color: 'var(--rose)', fontSize: 11.5 }}>{errs.date}</span>}
        </Field>
        <Field label="Type">
          <select className="input" value={f.type} onChange={set('type')}>
            {SESSION_TYPES_NEW.map(t => <option key={t}>{t}</option>)}
          </select>
        </Field>
        <Field label="Start time">
          <TimePicker value={f.start} onChange={v => { setF(p=>({...p,start:v})); setErrs(p=>({...p,start:undefined})); }}/>
          {errs.start && <span style={{ color: 'var(--rose)', fontSize: 11.5 }}>{errs.start}</span>}
        </Field>
        <Field label="End time">
          <TimePicker value={f.end} onChange={v => { setF(p=>({...p,end:v})); setErrs(p=>({...p,end:undefined})); }}/>
          {errs.end && <span style={{ color: 'var(--rose)', fontSize: 11.5 }}>{errs.end}</span>}
        </Field>
        <Field label="Venue">
          <input className="input" value={f.venue} onChange={set('venue')} placeholder="e.g. Main Hall, Auditorium" />
        </Field>
      </div>
    </Modal>
  );
}

/* ══ Minute-to-Minute modal ════════════════════════════════════════ */
function MinuteToMinuteModal({ session, store, activeEventId, onClose, toast }) {
  const minItems = (store.minuteItems || []).filter(m => m.sessionId === session.id);
  const contacts = (store.contacts || []).filter(c => c.status === 'Confirmed');
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [f, setF] = useState({ detail: '', schedule: '', duration: '', speakerId: '' });
  const set = k => e => setF(p => ({ ...p, [k]: e.target.value }));

  async function addItem() {
    if (!f.detail.trim()) return;
    if (editingId) {
      // update existing
      const existing = minItems.find(m => m.id === editingId);
      await saveItem('minuteItems', { ...existing, ...f });
      setEditingId(null);
    } else {
      await saveItem('minuteItems', { ...f, sessionId: session.id, eventId: activeEventId });
    }
    setF({ detail: '', schedule: '', duration: '', speakerId: '' });
    setAdding(false); toast(editingId ? 'Row updated.' : 'Row added.');
  }

  function startEdit(m) {
    setF({ detail: m.detail||'', schedule: m.schedule||'', duration: m.duration||'', speakerId: m.speakerId||'' });
    setEditingId(m.id);
    setAdding(true);
  }

  return (
    <Modal title={`📋 Minute-to-minute — ${session.title}`} onClose={onClose} footer={null} size="lg">
      <div style={{ marginBottom: 10, fontSize: 13, color: 'var(--muted)' }}>
        {session.date ? fmtDate(session.date) : ''} {session.start} {session.end ? `– ${session.end}` : ''} · {session.venue || ''}
      </div>
      {(() => {
        const colCfg = (store.appConfig||[]).find(c=>c.id==='columnConfig')||{};
        const mCols = colCfg.minuteToMinute||['detail','schedule','duration','speakerId'];
        const COL_LBL = {detail:'Session details',schedule:'Schedule',duration:'Duration',speakerId:'Speaker'};
        return (
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginBottom: 12 }}>
        <thead>
          <tr style={{ background: 'var(--teal-wash)' }}>
            {mCols.filter(k=>COL_LBL[k]).map(k=>(
              <th key={k} style={{ padding:'7px 12px', textAlign:'left', fontSize:11.5, fontWeight:600, borderBottom:'1px solid var(--line)' }}>{COL_LBL[k]}</th>
            ))}
            <th style={{padding:'7px 12px'}}></th>
          </tr>
        </thead>
        <tbody>
          {minItems.map(m => {
            const speaker = contacts.find(c => c.id === m.speakerId);
            return (
              <tr key={m.id} style={{ borderBottom: '1px solid var(--line)' }}>
                {mCols.includes('detail') && <td style={{ padding: '7px 12px' }}>{m.detail}</td>}
                {mCols.includes('schedule') && <td style={{ padding: '7px 12px', color: 'var(--muted)' }}>{m.schedule || '—'}</td>}
                {mCols.includes('duration') && <td style={{ padding: '7px 12px', color: 'var(--muted)' }}>{m.duration ? `${m.duration} min` : '—'}</td>}
                {mCols.includes('speakerId') && <td style={{ padding: '7px 12px', color: 'var(--muted)' }}>{speaker ? displayName(speaker) : '—'}</td>}
                <td style={{ padding: '7px 12px' }}>
                  <button className="btn ghost xs" onClick={async () => { await removeItem('minuteItems', m.id); toast('Row deleted.'); }}>{ICON.trash}</button>
                </td>
              </tr>
            );
          })}
          {!minItems.length && !adding && (
            <tr><td colSpan={mCols.length+1}><div style={{ padding: '16px', textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>No items yet. Add the first row below.</div></td></tr>
          )}
          {adding && (
            <tr style={{ background: 'var(--teal-wash)' }}>
              <td style={{ padding: '6px 8px' }}><input className="input" value={f.detail} onChange={set('detail')} placeholder="Session details" autoFocus /></td>
              <td style={{ padding: '6px 8px' }}><TimePicker value={f.schedule} onChange={v => setF(p => ({...p, schedule:v}))}/></td>
              <td style={{ padding: '6px 8px' }}><input className="input" type="number" value={f.duration} onChange={set('duration')} placeholder="mins" style={{ width: 70 }} /></td>
              <td style={{ padding: '6px 8px' }}>
                <select className="input" value={f.speakerId} onChange={set('speakerId')}>
                  <option value="">— Speaker —</option>
                  {contacts.map(c => <option key={c.id} value={c.id}>{displayName(c)}</option>)}
                </select>
              </td>
              <td style={{ padding: '6px 8px', display: 'flex', gap: 4 }}>
                <button className="btn primary sm" onClick={addItem}>{editingId?'Update':'Save'}</button>
                <button className="btn sm" onClick={() => {setAdding(false);setEditingId(null);setF({detail:'',schedule:'',duration:'',speakerId:''});}}>Cancel</button>
              </td>
            </tr>
          )}
        </tbody>
      </table>
        );
      })()}
      {!adding && <button className="btn sm" onClick={()=>{setEditingId(null);setF({detail:'',schedule:'',duration:'',speakerId:''});setAdding(true);}}>{ICON.plus} Add row</button>}
      <div className="modal-foot" style={{ padding: '12px 0 0' }}>
        <button className="btn" onClick={onClose}>Close</button>
      </div>
    </Modal>
  );
}

/* ══ Sahebji One-on-One — redesigned ══════════════════════════════ */
/* ── Sahebji auto-slot assignment ─────────────────────────────── */
/* ══ Sahebji helpers ══════════════════════════════════════════════
   Meetings live in `founder`. Each meeting now stores slotId; older meetings
   without one are matched to a slot by date + start time. */
const hhmm = m => `${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`;
const mtgStart = m => toMin(m.time||'00:00');
const mtgEnd   = m => mtgStart(m) + (parseInt(m.duration)||30);
const isScheduled = m => !!(m && m.date && m.time);
function slotOfMeeting(m, slots) {
  if (!isScheduled(m)) return null;
  if (m.slotId) { const s = slots.find(x => x.id === m.slotId); if (s && s.date === m.date) return s; }
  return slots.find(s => s.date === m.date && mtgStart(m) >= toMin(s.startTime) && mtgStart(m) < toMin(s.endTime)) || null;
}
function slotContaining(date, time, duration, slots) {
  const st = toMin(time), en = st + (parseInt(duration)||30);
  return slots.find(s => s.date === date && st >= toMin(s.startTime) && en <= toMin(s.endTime)) || null;
}
const meetingsInSlot = (slot, meetings, slots) => meetings.filter(m => isScheduled(m) && slotOfMeeting(m, slots)?.id === slot.id);
const sortSlots = list => [...list].sort((a,b) => a.date !== b.date ? (a.date > b.date ? 1 : -1) : ((a.startTime||'') > (b.startTime||'') ? 1 : -1));

async function autoAssignSlots(contacts, slots, existingMeetings, activeEventId, toast) {
  if (!slots.length || !contacts.length) return;
  const scheduled = existingMeetings.filter(isScheduled);
  const used = {};
  scheduled.forEach(m => { (used[m.date] = used[m.date] || []).push({ start: mtgStart(m), end: mtgEnd(m) }); });

  // Who needs a meeting: confirmed guests with no meeting, plus unscheduled meetings that still need one
  const todo = [];
  contacts.forEach(c => {
    const mine = existingMeetings.filter(m => m.contactId === c.id);
    if (!mine.length) todo.push({ contact: c, meeting: null });
    else mine.filter(m => !isScheduled(m) && !m.frozen && m.durationReq !== 'not_required').forEach(m => todo.push({ contact: c, meeting: m }));
  });
  if (!todo.length) { toast('Everyone already has a meeting scheduled.'); return; }

  let assigned = 0;
  for (const { contact, meeting } of todo) {
    const dur = parseInt(meeting?.duration) || 30;
    let placed = false;
    for (const slot of sortSlots(slots)) {
      const sEnd = toMin(slot.endTime);
      const u = used[slot.date] || [];
      for (let cur = toMin(slot.startTime); cur + dur <= sEnd; cur += 5) {
        if (u.some(x => cur < x.end && cur + dur > x.start)) continue;
        await saveItem('founder', {
          ...(meeting || { contactId: contact.id, durationReq: 'required', venue: 'VIP Lounge', notes: 'Auto-assigned' }),
          date: slot.date, time: hhmm(cur), duration: String(dur), slotId: slot.id, eventId: activeEventId,
        });
        (used[slot.date] = u).push({ start: cur, end: cur + dur });
        placed = true; assigned++; break;
      }
      if (placed) break;
    }
  }
  const left = todo.length - assigned;
  toast(assigned ? `Scheduled ${assigned} meeting${assigned>1?'s':''}.${left ? ` ${left} didn't fit — add more slot time.` : ''}`
                 : 'No free time left in the slots. Add more slot time or shorten meetings.');
}

export function SahebjiSchedule({ store, activeEventId }) {
  const { profile } = useAuth();
  const toast = useToast();
  const { can } = usePerm();
  const canEdit = can('schedule.sahebji');
  const [tab, setTab] = useState('slots');
  const [view, setView] = useState(() => { try { return localStorage.getItem('vk_meet_view') || 'cards'; } catch { return 'cards'; } });
  const [printDate, setPrintDate] = useState(null);
  const slots = sortSlots((store.sahebjiSlots || []).filter(s => s && s.id && s.date));
  const meetings = (store.founder || []).filter(m => m && m.id)
    .sort((a,b) => (a.date||'~') !== (b.date||'~') ? ((a.date||'~') > (b.date||'~') ? 1 : -1) : ((a.time||'') > (b.time||'') ? 1 : -1));
  const allContacts = store.contacts || [];
  const contacts = allContacts.filter(c => c.status === 'Confirmed');
  const [modal, setModal] = useState(null);

  const setViewSaved = v => { setView(v); try { localStorage.setItem('vk_meet_view', v); } catch {} };

  /* Cards view: dates are collapsed; the ones you open are remembered on this device.
     Today opens by itself unless you closed it ('!date' marker). */
  const [openDates, setOpenDates] = useState(() => {
    let saved = [];
    try { const v = JSON.parse(localStorage.getItem('vk_meet_open') || '[]'); if (Array.isArray(v)) saved = v; } catch {}
    const set = new Set(saved);
    const t = todayISO();
    if (!set.has('!' + t)) set.add(t);
    return set;
  });
  const toggleDate = d => setOpenDates(prev => {
    const n = new Set(prev);
    if (n.has(d)) { n.delete(d); if (d === todayISO()) n.add('!' + d); }
    else { n.add(d); n.delete('!' + d); }
    try { localStorage.setItem('vk_meet_open', JSON.stringify([...n])); } catch {}
    return n;
  });

  /* Table view: filters + print */
  const [tq, setTq] = useState('');
  const [tDate, setTDate] = useState('');
  const [tStatus, setTStatus] = useState('');
  const [tFrozen, setTFrozen] = useState('');
  const [tIssues, setTIssues] = useState(false);
  const [printTable, setPrintTable] = useState(false);
  useEffect(() => {
    if (!printTable) return;
    const t = setTimeout(() => { window.print(); setPrintTable(false); }, 80);
    return () => clearTimeout(t);
  }, [printTable]);

  /* Freeze: a frozen meeting can't be edited, deleted, moved by auto-assign or by slot changes */
  async function toggleFreeze(m) {
    await saveItem('founder', { id: m.id, frozen: !m.frozen });
    toast(m.frozen ? `${nameOf(m)} unfrozen.` : `🔒 ${nameOf(m)} frozen.`);
  }
  async function freezeDay(date, on) {
    const list = meetings.filter(m => isScheduled(m) && m.date === date && !!m.frozen !== on);
    for (const m of list) await saveItem('founder', { id: m.id, frozen: on });
    toast(on ? `🔒 Froze ${list.length} meeting${list.length === 1 ? '' : 's'} on ${fmtDate(date)}.` : `Unfroze ${list.length} meeting${list.length === 1 ? '' : 's'} on ${fmtDate(date)}.`);
  }
  useEffect(() => {
    if (!printDate) return;
    const t = setTimeout(() => { window.print(); setPrintDate(null); }, 80);
    return () => clearTimeout(t);
  }, [printDate]);

  const nameOf = m => { const c = allContacts.find(x => x.id === m.contactId); return c ? displayName(c) : 'Unknown guest'; };
  const flagsOf = m => {
    const f = [];
    const c = allContacts.find(x => x.id === m.contactId);
    if (!c) f.push({ t: 'Guest deleted', bad: true });
    else if (c.status !== 'Confirmed') f.push({ t: `Guest is ${c.status}`, bad: true });
    if (isScheduled(m)) {
      if (!slotContaining(m.date, m.time, m.duration, slots)) f.push({ t: 'Outside Sahebji slot' });
      const clash = meetings.find(o => o.id !== m.id && isScheduled(o) && o.date === m.date && mtgStart(o) < mtgEnd(m) && mtgStart(m) < mtgEnd(o));
      if (clash) f.push({ t: `Overlaps ${nameOf(clash)}`, bad: true });
    }
    return f;
  };

  const scheduledMeetings = meetings.filter(isScheduled);
  const unscheduled = meetings.filter(m => !isScheduled(m) && m.durationReq !== 'not_required');
  const noMeeting = contacts.filter(c => !meetings.some(m => m.contactId === c.id));
  const dates = [...new Set([...slots.map(s => s.date), ...scheduledMeetings.map(m => m.date)])].sort();

  const MeetingCard = ({ m }) => {
    const flags = flagsOf(m);
    const c = allContacts.find(x => x.id === m.contactId);
    const cls = 'mtg-card' + (flags.some(f => f.bad) ? ' bad' : (flags.length || !isScheduled(m)) ? ' warn' : '') + (m.frozen ? ' frozen' : '');
    return (
      <div className={cls} role="button" tabIndex={0}
        onClick={() => canEdit && setModal({ type: 'edit-meeting', id: m.id })}
        onKeyDown={e => { if (e.key === 'Enter' && canEdit) setModal({ type: 'edit-meeting', id: m.id }); }}>
        <div className="mtg-time">{isScheduled(m) ? <>{m.time}<span>{hhmm(mtgEnd(m))}</span></> : <span>—</span>}</div>
        <div className="mtg-body">
          <div className="nm">{m.frozen && <span title="Frozen" style={{ marginRight: 4 }}>🔒</span>}{nameOf(m)}</div>
          {c && (c.desig || c.org) && <div className="role">{[c.desig, c.org].filter(Boolean).join(' · ')}</div>}
          <div className="mtg-meta">{m.durationReq === 'not_required' ? 'No meeting needed' : `${m.duration || 30} min`} · {m.venue || 'VIP Lounge'}</div>
          {flags.map((f, i) => <span key={i} className={'mtg-flag' + (f.bad ? ' bad' : '')}>⚠ {f.t}</span>)}
        </div>
        {canEdit && (
          <div className="mtg-acts no-print">
            <button className={'btn xs ' + (m.frozen ? 'primary' : 'ghost')} title={m.frozen ? 'Unfreeze meeting' : 'Freeze meeting'} aria-label={m.frozen ? 'Unfreeze meeting' : 'Freeze meeting'}
              onClick={e => { e.stopPropagation(); toggleFreeze(m); }}>{m.frozen ? '🔒' : '🔓'}</button>
            {!m.frozen && <button className="btn ghost xs" title="Delete meeting" aria-label="Delete meeting"
              onClick={e => { e.stopPropagation(); setModal({ type: 'del-meeting', id: m.id }); }}>{ICON.trash}</button>}
          </div>
        )}
      </div>
    );
  };

  const renderSlotBlock = (slot) => {
    const inSlot = meetingsInSlot(slot, scheduledMeetings, slots).sort((a,b) => mtgStart(a) - mtgStart(b));
    const sStart = toMin(slot.startTime), sEnd = toMin(slot.endTime);
    const items = []; let cur = sStart;
    inSlot.forEach(m => {
      if (mtgStart(m) - cur >= 10) items.push({ free: true, from: cur, to: mtgStart(m) });
      items.push({ m }); cur = Math.max(cur, mtgEnd(m));
    });
    if (sEnd - cur >= 10) items.push({ free: true, from: cur, to: sEnd });
    const freeMin = items.filter(i => i.free).reduce((a, i) => a + (i.to - i.from), 0);
    return (
      <div className="mtg-slot" key={slot.id}>
        <div className="mtg-slot-head">
          <b>Slot {slot.startTime}–{slot.endTime}</b>
          <span>{inSlot.length} meeting{inSlot.length === 1 ? '' : 's'}</span>
          <span>{freeMin} min free</span>
        </div>
        <div className="mtg-list">
          {items.map((it, i) => it.free
            ? <div className="mtg-free" key={'f' + i}>
                <span>Free {hhmm(it.from)}–{hhmm(it.to)} · {it.to - it.from} min</span>
                {canEdit && <button className="btn xs" onClick={() => setModal({ type: 'add-meeting', prefill: { date: slot.date, time: hhmm(it.from) } })}>{ICON.plus}Add</button>}
              </div>
            : <MeetingCard key={it.m.id} m={it.m} />)}
          {!items.length && <div className="muted-sm">Slot is fully booked.</div>}
        </div>
      </div>
    );
  };

  return (
    <>
      <div className="subnav">
        <button className={tab === 'slots' ? 'active' : ''} onClick={() => setTab('slots')}>Sahebji available slots</button>
        <button className={tab === 'meetings' ? 'active' : ''} onClick={() => setTab('meetings')}>One-on-one meetings</button>
      </div>

      {tab === 'slots' && (
        <>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
            {canEdit && <button className="btn primary sm" onClick={() => setModal({ type: 'add-slot' })}>{ICON.plus} Add slot</button>}
          </div>
          <div className="panel">
            <div className="panel-body">
              <table>
                <thead><tr><th>Date</th><th>Start time</th><th>End time</th><th>Duration</th><th>Meetings</th><th></th></tr></thead>
                <tbody>
                  {slots.map(s => {
                    const dur = s.startTime && s.endTime ? Math.round(toMin(s.endTime) - toMin(s.startTime)) + ' min' : '—';
                    const n = meetingsInSlot(s, scheduledMeetings, slots).length;
                    return (
                      <tr key={s.id}>
                        <td className="muted-sm">{fmtDate(s.date)}</td>
                        <td className="muted-sm">{s.startTime}</td>
                        <td className="muted-sm">{s.endTime}</td>
                        <td><span className="badge b-type">{dur}</span></td>
                        <td className="muted-sm">{n}</td>
                        <td><div className="rowacts">
                          {canEdit && <button className="btn ghost xs" aria-label="Edit slot" onClick={() => setModal({ type: 'edit-slot', id: s.id })}>{ICON.edit}</button>}
                          {canEdit && <button className="btn ghost xs" aria-label="Delete slot" onClick={() => setModal({ type: 'del-slot', id: s.id })}>{ICON.trash}</button>}
                        </div></td>
                      </tr>
                    );
                  })}
                  {!slots.length && <tr><td colSpan={6}><Empty title="No slots yet" sub="Add Sahebji's available time windows above." /></td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {tab === 'meetings' && (
        <>
          <div className="mtg-toolbar">
            <div className="seg" role="group" aria-label="View">
              <button className={view === 'cards' ? 'on' : ''} onClick={() => setViewSaved('cards')}>Cards</button>
              <button className={view === 'table' ? 'on' : ''} onClick={() => setViewSaved('table')}>Table</button>
            </div>
            <div style={{ flex: 1 }} />
            {canEdit && <button className="btn sm" onClick={() => autoAssignSlots(contacts, slots, meetings, activeEventId, toast)}
              disabled={!slots.length || !contacts.length}>⚡ Auto-assign</button>}
            {canEdit && <button className="btn primary sm" onClick={() => setModal({ type: 'add-meeting' })}>{ICON.plus} Add meeting</button>}
          </div>

          {slots.length === 0 && (
            <div className="mtg-note">⚠ Add Sahebji's available slots first, then schedule meetings here.</div>
          )}

          {(unscheduled.length > 0 || noMeeting.length > 0) && (
            <div className="mtg-day">
              <div className="mtg-day-head"><h3>Needs a time</h3><span className="muted-sm">{unscheduled.length + noMeeting.length}</span></div>
              <div className="mtg-list">
                {unscheduled.map(m => <MeetingCard key={m.id} m={m} />)}
                {noMeeting.map(c => (
                  <div className="mtg-card warn" key={c.id} role="button" tabIndex={0}
                    onClick={() => canEdit && setModal({ type: 'add-meeting', prefill: { contactId: c.id } })}>
                    <div className="mtg-time"><span>—</span></div>
                    <div className="mtg-body"><div className="nm">{displayName(c)}</div><div className="mtg-meta">Confirmed · no meeting yet</div></div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {view === 'cards' && dates.map(date => {
            const daySlots = slots.filter(s => s.date === date);
            const outside = scheduledMeetings.filter(m => m.date === date && !slotOfMeeting(m, slots));
            const dayMeetings = scheduledMeetings.filter(m => m.date === date);
            const count = dayMeetings.length;
            const frozenN = dayMeetings.filter(m => m.frozen).length;
            const issueN = dayMeetings.filter(m => flagsOf(m).length).length;
            const freeMin = daySlots.reduce((sum, sl) => {
              const used = meetingsInSlot(sl, scheduledMeetings, slots).reduce((a, m) => a + (parseInt(m.duration) || 30), 0);
              return sum + Math.max(0, toMin(sl.endTime) - toMin(sl.startTime) - used);
            }, 0);
            const open = openDates.has(date) || printDate === date;
            const allFrozen = count > 0 && frozenN === count;
            return (
              <section key={date} className={'mtg-day' + (open ? ' open' : ' closed') + (printDate === date ? ' print-target' : '')}>
                <div className="mtg-day-head mtg-day-toggle" role="button" tabIndex={0} aria-expanded={open}
                  onClick={() => toggleDate(date)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleDate(date); } }}>
                  <span className="mtg-caret no-print">{open ? '▾' : '▸'}</span>
                  <h3>{fmtDate(date)}</h3>
                  <span className="muted-sm">{count} meeting{count === 1 ? '' : 's'}{daySlots.length ? ` · ${freeMin} min free` : ''}</span>
                  {issueN > 0 && <span className="mtg-flag bad no-print">⚠ {issueN}</span>}
                  {frozenN > 0 && <span className="mtg-flag no-print" title="Frozen meetings">🔒 {frozenN}</span>}
                  <span style={{ marginLeft: 'auto' }} />
                  {canEdit && count > 0 && (
                    <button className="btn ghost xs no-print" onClick={e => { e.stopPropagation(); freezeDay(date, !allFrozen); }}>
                      {allFrozen ? '🔓 Unfreeze day' : '🔒 Freeze day'}
                    </button>
                  )}
                  <button className="btn ghost xs no-print" onClick={e => { e.stopPropagation(); setPrintDate(date); }}>{ICON.print}Print day</button>
                </div>
                {open && <>
                  {daySlots.map(renderSlotBlock)}
                  {outside.length > 0 && (
                    <div className="mtg-slot mtg-slot-out">
                      <div className="mtg-slot-head"><b>Outside Sahebji's slots</b><span>{outside.length}</span></div>
                      <div className="mtg-list">{outside.map(m => <MeetingCard key={m.id} m={m} />)}</div>
                    </div>
                  )}
                </>}
              </section>
            );
          })}
          {view === 'cards' && !dates.length && !unscheduled.length && !noMeeting.length &&
            <div className="panel"><Empty title="No meetings yet" sub="Add slots, then schedule or auto-assign meetings." /></div>}

          {view === 'table' && (() => {
            const statusOf = m => m.durationReq === 'not_required' ? 'notreq' : isScheduled(m) ? 'scheduled' : 'unscheduled';
            const STATUS_LABEL = { scheduled: 'Scheduled', unscheduled: 'Needs a time', notreq: 'Not required' };
            const tDates = [...new Set(meetings.filter(m => m.date).map(m => m.date))].sort();
            const q = tq.trim().toLowerCase();
            const rows = meetings.filter(m =>
              (!q || nameOf(m).toLowerCase().includes(q) || (m.venue || '').toLowerCase().includes(q)) &&
              (!tDate || m.date === tDate) &&
              (!tStatus || statusOf(m) === tStatus) &&
              (!tFrozen || (tFrozen === 'frozen' ? !!m.frozen : !m.frozen)) &&
              (!tIssues || flagsOf(m).length > 0));
            const anyF = q || tDate || tStatus || tFrozen || tIssues;
            const printTitle = ['Sahebji one-on-one meetings', tDate ? fmtDate(tDate) : 'All dates',
              tStatus ? STATUS_LABEL[tStatus] : '', tFrozen === 'frozen' ? 'Frozen' : tFrozen === 'open' ? 'Not frozen' : '',
              tIssues ? 'With issues' : '', q ? `"${tq.trim()}"` : ''].filter(Boolean).join(' · ');
            return (
              <div className={'panel' + (printTable ? ' print-target' : '')}>
                <div className="mtg-filters no-print">
                  <input className="input" placeholder="Search name or venue…" value={tq} onChange={e => setTq(e.target.value)} />
                  <select className="statsel" value={tDate} onChange={e => setTDate(e.target.value)} aria-label="Date">
                    <option value="">All dates</option>{tDates.map(d => <option key={d} value={d}>{fmtDate(d)}</option>)}
                  </select>
                  <select className="statsel" value={tStatus} onChange={e => setTStatus(e.target.value)} aria-label="Status">
                    <option value="">Any status</option><option value="scheduled">Scheduled</option><option value="unscheduled">Needs a time</option><option value="notreq">Not required</option>
                  </select>
                  <select className="statsel" value={tFrozen} onChange={e => setTFrozen(e.target.value)} aria-label="Frozen">
                    <option value="">Frozen + not frozen</option><option value="frozen">🔒 Frozen only</option><option value="open">Not frozen only</option>
                  </select>
                  <label className="chk" style={{ margin: 0 }}><input type="checkbox" checked={tIssues} onChange={e => setTIssues(e.target.checked)} />Issues only</label>
                  {anyF && <button className="btn ghost xs" onClick={() => { setTq(''); setTDate(''); setTStatus(''); setTFrozen(''); setTIssues(false); }}>Clear</button>}
                  <span style={{ flex: 1 }} />
                  <span className="muted-sm">{rows.length} of {meetings.length}</span>
                  <button className="btn sm" disabled={!rows.length} onClick={() => setPrintTable(true)}>{ICON.print}Print</button>
                </div>
                <div className="print-only mtg-print-title">{printTitle}<span>{rows.length} meeting{rows.length === 1 ? '' : 's'}</span></div>
                <div className="panel-body">
                  <table>
                    <thead><tr><th>Name</th><th>Duration</th><th>Date</th><th>Start</th><th>End</th><th>Venue</th><th title="Frozen">🔒</th><th className="no-print"></th></tr></thead>
                    <tbody>
                      {rows.map(m => {
                        const flags = flagsOf(m);
                        return (
                          <tr key={m.id} style={flags.length ? { background: '#FFF8F0' } : {}}>
                            <td><div className="nm">{nameOf(m)}</div>{flags.map((f,i) => <div key={i} className={'mtg-flag' + (f.bad ? ' bad' : '')}>⚠ {f.t}</div>)}</td>
                            <td>{m.durationReq === 'not_required' ? <span className="badge b-declined">Not required</span> : <span className="muted-sm">{m.duration || 30} min</span>}</td>
                            <td className="muted-sm">{m.date ? fmtDate(m.date) : 'Not scheduled'}</td>
                            <td className="muted-sm">{m.time || '—'}</td>
                            <td className="muted-sm">{isScheduled(m) ? hhmm(mtgEnd(m)) : '—'}</td>
                            <td className="muted-sm">{m.venue || 'VIP Lounge'}</td>
                            <td>{m.frozen ? '🔒' : ''}</td>
                            <td className="no-print"><div className="rowacts" style={{ opacity: 1 }}>
                              {canEdit && <button className={'btn xs ' + (m.frozen ? 'primary' : 'ghost')} title={m.frozen ? 'Unfreeze' : 'Freeze'} onClick={() => toggleFreeze(m)}>{m.frozen ? '🔒' : '🔓'}</button>}
                              {canEdit && !m.frozen && <button className="btn ghost xs" aria-label="Edit meeting" onClick={() => setModal({ type: 'edit-meeting', id: m.id })}>{ICON.edit}</button>}
                              {canEdit && !m.frozen && <button className="btn ghost xs" aria-label="Delete meeting" onClick={() => setModal({ type: 'del-meeting', id: m.id })}>{ICON.trash}</button>}
                            </div></td>
                          </tr>
                        );
                      })}
                      {!rows.length && <tr><td colSpan={8}>{meetings.length
                        ? <Empty title="No meetings match" sub="Change or clear the filters." />
                        : <Empty title="No meetings yet" sub="Schedule or auto-assign meetings above." />}</td></tr>}
                    </tbody>
                  </table>
                </div>
              </div>
            );
          })()}
        </>
      )}

      {(modal?.type === 'add-slot' || modal?.type === 'edit-slot') && (
        <SahebjiSlotModal item={slots.find(s => s.id === modal.id) || undefined} activeEventId={activeEventId}
          meetings={scheduledMeetings} slots={slots} nameOf={nameOf}
          onClose={() => setModal(null)} toast={toast} />
      )}
      {modal?.type === 'del-slot' && (() => {
        const slot = slots.find(s => s.id === modal.id);
        if (!slot) return null;
        const inSlot = meetingsInSlot(slot, scheduledMeetings, slots);
        const affected = inSlot.filter(m => !m.frozen);
        const kept = inSlot.filter(m => m.frozen);   // frozen meetings stay exactly where they are
        return <SlotDeleteModal slot={slot} affected={affected} kept={kept} nameOf={nameOf} onClose={() => setModal(null)}
          onConfirm={async (mode) => {
            setModal(null);
            const linked = affected.map(m => ({ collection: 'founder', data: m }));
            await trashItem('sahebjiSlots', slot, linked, profile?.email || '');
            await removeItem('sahebjiSlots', slot.id);
            for (const m of affected) {
              if (mode === 'delete') await removeItem('founder', m.id);
              else await saveItem('founder', { ...m, date: '', time: '', slotId: null });
            }
            toast(!affected.length ? 'Slot moved to trash.'
              : mode === 'delete' ? `Slot and ${affected.length} meeting${affected.length>1?'s':''} moved to trash.`
              : `Slot moved to trash. ${affected.length} meeting${affected.length>1?'s are':' is'} now under "Needs a time".`);
          }} />;
      })()}
      {(modal?.type === 'add-meeting' || modal?.type === 'edit-meeting') && (
        <SahebjiMeetingModal item={meetings.find(m => m.id === modal.id) || undefined} prefill={modal.prefill}
          store={store} activeEventId={activeEventId} onClose={() => setModal(null)} toast={toast} />
      )}
      {modal?.type === 'del-meeting' && (() => {
        const mtg = meetings.find(m => m.id === modal.id);
        if (mtg?.frozen) { setTimeout(() => { setModal(null); toast('Frozen — unfreeze first.'); }, 0); return null; }
        return mtg ? <DeleteModal label={nameOf(mtg)} onClose={() => setModal(null)}
          onConfirm={async () => { setModal(null); await trashItem('founder', mtg, [], profile?.email || ''); await removeItem('founder', mtg.id); toast('Meeting moved to trash.'); }} /> : null;
      })()}
    </>
  );
}

/* Deleting a slot: the meetings inside it are handled explicitly, never left orphaned */
function SlotDeleteModal({ slot, affected, kept = [], nameOf, onClose, onConfirm }) {
  const [busy, setBusy] = useState(false);
  const go = async mode => { setBusy(true); await onConfirm(mode); };
  return (
    <Modal title="Delete slot?" onClose={onClose} footer={null} size="sm">
      <p style={{ fontSize: 13.5, marginTop: 0 }}>
        <b>{fmtDate(slot.date)}, {slot.startTime}–{slot.endTime}</b> will move to trash (restorable for 30 days, together with anything below).
      </p>
      {kept.length > 0 && (
        <div className="mtg-note" style={{ marginBottom: 10 }}>
          🔒 {kept.length} frozen meeting{kept.length > 1 ? 's' : ''} will be kept as {kept.length > 1 ? 'they are' : 'it is'}: {kept.map(m => `${nameOf(m)} (${m.time})`).join(', ')}.
        </div>
      )}
      {affected.length > 0 ? (
        <>
          <p style={{ fontSize: 13.5 }}>{affected.length} meeting{affected.length > 1 ? 's are' : ' is'} booked in this slot:</p>
          <ul className="slot-affected">
            {affected.sort((a,b) => mtgStart(a) - mtgStart(b)).map(m => <li key={m.id}><span className="mono">{m.time}</span> {nameOf(m)}</li>)}
          </ul>
          <div className="slot-del-actions">
            <button className="btn danger" disabled={busy} onClick={() => go('delete')}>Delete slot and meetings</button>
            <button className="btn" disabled={busy} onClick={() => go('unschedule')}>Delete slot, keep guests to reschedule</button>
            <button className="btn ghost" disabled={busy} onClick={onClose}>Cancel</button>
          </div>
        </>
      ) : (
        <div className="slot-del-actions">
          <button className="btn danger" disabled={busy} onClick={() => go('delete')}>Delete slot</button>
          <button className="btn ghost" disabled={busy} onClick={onClose}>Cancel</button>
        </div>
      )}
    </Modal>
  );
}

function SahebjiSlotModal({ item, activeEventId, meetings = [], slots = [], nameOf, onClose, toast }) {
  const [f, setF] = useState(() => ({ date: '', startTime: '', endTime: '', ...item }));
  const [errs, setErrs] = useState({});
  const [confirmOutside, setConfirmOutside] = useState(false);
  const set = k => e => setF(p => ({ ...p, [k]: e.target.value }));

  // When editing, meetings in this slot that would no longer fit the new times
  const wouldFallOut = item ? meetingsInSlot(item, meetings, slots).filter(m =>
    m.date !== f.date || (f.startTime && mtgStart(m) < toMin(f.startTime)) || (f.endTime && mtgEnd(m) > toMin(f.endTime))) : [];

  async function save() {
    const e = {};
    if (!f.date) e.date = 'Date is required';
    if (!f.startTime) e.startTime = 'Start time is required';
    if (!f.endTime) e.endTime = 'End time is required';
    if (f.startTime && f.endTime && f.endTime <= f.startTime) e.endTime = 'End must be after start';
    if (Object.keys(e).length) { setErrs(e); return; }
    if (wouldFallOut.length && !confirmOutside) { setConfirmOutside(true); return; }
    await saveItem('sahebjiSlots', { ...f, eventId: activeEventId });
    onClose();
    toast(item ? (wouldFallOut.length ? `Slot updated. ${wouldFallOut.length} meeting${wouldFallOut.length>1?'s are':' is'} now outside it — check One-on-one meetings.` : 'Slot updated.') : 'Slot added.');
  }
  return (
    <Modal title={item ? 'Edit slot' : 'Add Sahebji available slot'} onClose={onClose} onSave={save}
      saveLabel={confirmOutside ? 'Save anyway' : item ? 'Save' : 'Add slot'} size="sm">
      <div className="grid2">
        <Field label="Date"><input className="input" type="date" style={errs.date ? { borderColor: 'var(--rose)' } : {}}
          value={f.date} onChange={e => { set('date')(e); setErrs(p => ({ ...p, date: undefined })); setConfirmOutside(false); }} />
          {errs.date && <span style={{ color: 'var(--rose)', fontSize: 11.5 }}>{errs.date}</span>}
        </Field>
        <div />
        <Field label="Start time"><TimePicker value={f.startTime} onChange={v => { setF(p => ({ ...p, startTime: v })); setErrs(p => ({ ...p, startTime: undefined })); setConfirmOutside(false); }} />
          {errs.startTime && <span style={{ color: 'var(--rose)', fontSize: 11.5 }}>{errs.startTime}</span>}
        </Field>
        <Field label="End time"><TimePicker value={f.endTime} onChange={v => { setF(p => ({ ...p, endTime: v })); setErrs(p => ({ ...p, endTime: undefined })); setConfirmOutside(false); }} />
          {errs.endTime && <span style={{ color: 'var(--rose)', fontSize: 11.5 }}>{errs.endTime}</span>}
        </Field>
      </div>
      {wouldFallOut.length > 0 && (
        <div className="mtg-note" style={{ marginTop: 4 }}>
          ⚠ {wouldFallOut.length} meeting{wouldFallOut.length > 1 ? 's' : ''} won't fit these times:
          {' '}{wouldFallOut.map(m => `${nameOf ? nameOf(m) : ''} (${m.time})`).join(', ')}.
          {confirmOutside ? ' Tap "Save anyway" to keep them as they are — they will be flagged.' : ''}
        </div>
      )}
    </Modal>
  );
}

function SahebjiMeetingModal({ item, prefill, store, activeEventId, onClose, toast }) {
  const contacts = (store.contacts || []).filter(c => c.status === 'Confirmed');
  const slots = store.sahebjiSlots || [];
  const [f, setF] = useState(() => ({
    contactId: contacts[0]?.id || '',
    durationReq: 'required',
    duration: '30',
    date: '',
    time: '',
    venue: 'VIP Lounge',
    notes: '',
    ...prefill,
    ...item
  }));
  const set = k => e => setF(p => ({ ...p, [k]: e.target.value }));

  // Auto-calculate end time
  const endTime = f.time && f.duration && f.durationReq === 'required'
    ? (() => { const m = toMin(f.time) + parseInt(f.duration); return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; })()
    : '—';

  const frozen = !!item?.frozen;
  async function save() {
    if (frozen) return;
    if (!f.contactId || !f.date || !f.time) { return; }

    // Slot boundary check — meeting must fall within a defined slot on that date
    const slotsOnDate = slots.filter(s => s.date === f.date);
    if (slotsOnDate.length > 0) {
      const meetStart = toMin(f.time);
      const meetEnd   = meetStart + parseInt(f.duration || 30);
      const withinSlot = slotsOnDate.some(s => {
        const slotStart = toMin(s.startTime);
        const slotEnd   = toMin(s.endTime);
        return meetStart >= slotStart && meetEnd <= slotEnd;
      });
      if (!withinSlot) {
        const slotTimes = slotsOnDate.map(s => `${s.startTime}–${s.endTime}`).join(', ');
        alert(`Meeting time must fall within a Sahebji available slot on this date.\nAvailable: ${slotTimes}`);
        return;
      }
    }
    // Conflict check
    const others = (store.founder || []).filter(m => m.id !== item?.id && m.date === f.date);
    const clash = others.find(m => {
      const mEnd = toMin(m.time) + parseInt(m.duration || 30);
      const fEnd = toMin(f.time) + parseInt(f.duration || 30);
      return toMin(m.time) < fEnd && toMin(f.time) < mEnd;
    });
    if (clash) {
      const clashC = contacts.find(c => c.id === clash.contactId);
      alert(`Time conflict with ${clashC ? displayName(clashC) : 'another meeting'} at ${clash.time}. Please choose a different time.`);
      return;
    }
    const slot = slotContaining(f.date, f.time, f.duration, slots);
    const savedId = await saveItem('founder', { ...f, slotId: slot?.id || null, eventId: activeEventId });
    // Two-way sync: update duration in personalisedMandatory so Personalised Schedule reflects it
    if (f.durationReq === 'required' && f.duration) {
      await saveItem('personalisedMandatory', {
        id: `${f.contactId}_mandatory`,
        contactId: f.contactId,
        eventId: activeEventId,
        sahebjiDuration: f.duration,
        sahebji: true, // mark as required in mandatory fields
      });
    }
    onClose(); toast(item ? 'Meeting updated.' : 'Meeting scheduled.');
  }

  return (
    <Modal title={frozen ? 'Sahebji meeting (frozen)' : item ? 'Edit Sahebji meeting' : 'Schedule Sahebji one-on-one'} onClose={onClose} onSave={frozen ? null : save} saveLabel={item ? 'Save' : 'Schedule'}>
      {frozen && <div className="mtg-note" style={{ marginBottom: 10 }}>🔒 This meeting is frozen. Unfreeze it (🔒 button on the card or row) to make changes.</div>}
      <fieldset disabled={frozen} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
      <Field label="Guest">
        <select className="input" value={f.contactId} onChange={set('contactId')}>
          {contacts.map(c => <option key={c.id} value={c.id}>{displayName(c)}</option>)}
        </select>
      </Field>
      <div className="grid2">
        <Field label="Duration for meeting">
          <select className="input" value={f.durationReq} onChange={set('durationReq')}>
            <option value="required">Required</option>
            <option value="not_required">Not Required</option>
          </select>
        </Field>
        {f.durationReq === 'required' && (
          <Field label="Duration (minutes)">
            <input className="input" type="number" value={f.duration} onChange={set('duration')} min={5} step={5} />
          </Field>
        )}
        <Field label="Date">
          <input className="input" type="date" value={f.date} onChange={set('date')} />
          {f.date && slots.filter(s=>s.date===f.date).length>0 && (
            <div style={{fontSize:11,color:'var(--teal)',marginTop:3}}>
              Available slot{slots.filter(s=>s.date===f.date).length>1?'s':''}: {slots.filter(s=>s.date===f.date).map(s=>`${s.startTime}–${s.endTime}`).join(', ')}
            </div>
          )}
          {f.date && slots.filter(s=>s.date===f.date).length===0 && (
            <div style={{fontSize:11,color:'var(--amber)',marginTop:3}}>⚠ No Sahebji slot defined for this date</div>
          )}
        </Field>
        <Field label="Start time"><TimePicker value={f.time} onChange={v => setF(p => ({...p, time:v}))}/></Field>
        <Field label="End time (auto-calculated)">
          <input className="input" value={endTime} readOnly style={{ background: 'var(--paper)', color: 'var(--muted)' }} />
        </Field>
        <Field label="Venue"><input className="input" value={f.venue} onChange={set('venue')} /></Field>
      </div>
      <Field label="Notes"><input className="input" value={f.notes} onChange={set('notes')} /></Field>
      </fieldset>
    </Modal>
  );
}

/* ══ Main Scheduling shell ════════════════════════════════════════= */
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

/* Sahebji one-on-ones with full add/edit/delete */

export function Scheduling({ store, activeEventId }) {
  const [tab, setTab] = useState('overall');
  return (
    <>
      <div className="page-head"><div className="ph-txt">
        <h1>Scheduling</h1>
        <p>Overall schedule, session assignments, Sahebji one-on-ones and personalised schedules.</p>
      </div></div>
      <div className="subnav">
        <button className={tab === 'overall' ? 'active' : ''} onClick={() => setTab('overall')}>Overall schedule</button>

        <button className={tab === 'sahebji' ? 'active' : ''} onClick={() => setTab('sahebji')}>Sahebji one-on-ones</button>
      </div>
      {tab === 'overall' && <OverallSchedule store={store} activeEventId={activeEventId} />}

      {tab === 'sahebji' && <SahebjiSchedule store={store} activeEventId={activeEventId} />}
    </>
  );
}



/* ══════════════════════════════════════════════════════════════════
   VOLUNTEER DIRECTORY
   Master list — not event specific. Name, Contact, City, Area.
══════════════════════════════════════════════════════════════════ */
/* ── Task import: Department / Owner names are matched to real records.
   Anything that doesn't match is shown and must be resolved before saving —
   nothing silently lands in the first department any more. ── */
function TaskImportModal({ depts, vols, tasks, activeEventId, onClose, toast }) {
  const [step, setStep] = useState('choose');
  const [rows, setRows] = useState([]);
  const [deptMap, setDeptMap] = useState({});   // unmatched dept name → deptId
  const [ownerMap, setOwnerMap] = useState({}); // unmatched owner name → volId | ''
  const [defaultDept, setDefaultDept] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [lib, setLib] = useState(null);

  async function handleFile(file) {
    setErr('');
    try {
      const x = await import('./excel');
      const { items } = await x.parseTasksFile(file);
      if (!items.length) { setErr('No tasks found. Make sure the sheet has a Task / Title column, or download the template.'); return; }
      const plan = x.planTasksImport(items, tasks);
      setLib(x); setRows(plan.plan); setDeptMap({}); setOwnerMap({}); setStep('preview');
    } catch (e) { setErr('Could not read file: ' + (e.message || e)); }
  }

  const resolve = p => {
    const it = p.item;
    const d = lib.matchDept(it.deptName, depts);
    const deptId = d ? d.id : it.deptName ? (deptMap[it.deptName] || '') : (it.deptId || defaultDept);
    const v = lib.matchVolunteer(it.assigneeName, vols);
    const assigneeId = v ? v.id : it.assigneeName ? (ownerMap[it.assigneeName] ?? '') : (it.assigneeId || '');
    return { deptId, assigneeId, deptMatched: !!d, ownerMatched: !!v };
  };
  const unmatchedDepts  = lib ? [...new Set(rows.map(p => p.item.deptName).filter(n => n && !lib.matchDept(n, depts)))] : [];
  const unmatchedOwners = lib ? [...new Set(rows.map(p => p.item.assigneeName).filter(n => n && !lib.matchVolunteer(n, vols)))] : [];
  const needsDefault = lib ? rows.some(p => !p.item.deptName && !p.item.deptId) : false;
  const resolved = lib ? rows.map(p => ({ p, r: resolve(p) })) : [];
  const missingDept = resolved.filter(x => !x.r.deptId).length;

  async function commit() {
    if (missingDept) { setErr(`${missingDept} task${missingDept > 1 ? 's have' : ' has'} no department yet — choose one above.`); return; }
    setBusy(true);
    try {
      const items = resolved.map(({ p, r }) => ({ ...p.item, deptId: r.deptId, assigneeId: r.assigneeId, deptName: '', assigneeName: '', eventId: activeEventId }));
      await batchUpsert('tasks', items);
      onClose();
      toast(`Imported ${items.length} task${items.length > 1 ? 's' : ''}.`);
    } catch (e) { setErr('Save failed: ' + (e.message || e)); setBusy(false); }
  }

  return (
    <Modal title="Import tasks" onClose={onClose} footer={null}>
      {err && <div className="av-err">{err}</div>}
      {step === 'choose' && <>
        <p className="muted-sm" style={{ marginTop: 0 }}>Columns: Task, Department, Owner, Due Date, Status, Notes. Department and Owner are matched by name to your departments and volunteers.</p>
        <label className="dropzone">
          <span style={{ display: 'flex', justifyContent: 'center' }}>{ICON.upload}</span>
          <div>Click to choose a file (.xlsx or .csv)</div>
          <input type="file" accept=".xlsx,.xls,.csv" style={{ display: 'none' }} onChange={e => handleFile(e.target.files[0])} />
        </label>
        <div style={{ marginTop: 12, textAlign: 'center' }}><button className="linkbtn" onClick={() => downloadTemplate('tasks')}>Download blank template</button></div>
        <div className="modal-foot" style={{ padding: '12px 0 0' }}><button className="btn" onClick={onClose}>Cancel</button></div>
      </>}
      {step === 'preview' && lib && <>
        {(unmatchedDepts.length > 0 || needsDefault) && (
          <div className="ti-fix">
            <div className="av-step" style={{ marginTop: 0 }}>Departments not found — choose where these go</div>
            {unmatchedDepts.map(n => (
              <div className="ti-row" key={n}>
                <span>"{n}"</span>
                <select className="input" value={deptMap[n] || ''} onChange={e => setDeptMap(m => ({ ...m, [n]: e.target.value }))}>
                  <option value="">Choose department…</option>{depts.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                </select>
              </div>
            ))}
            {needsDefault && (
              <div className="ti-row"><span>Rows with no department</span>
                <select className="input" value={defaultDept} onChange={e => setDefaultDept(e.target.value)}>
                  <option value="">Choose department…</option>{depts.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                </select>
              </div>
            )}
            <p className="muted-sm" style={{ margin: '4px 0 0' }}>To use a new department, cancel, add it under Departments, then import again.</p>
          </div>
        )}
        {unmatchedOwners.length > 0 && (
          <div className="ti-fix">
            <div className="av-step" style={{ marginTop: 0 }}>Owners not found in Volunteers</div>
            {unmatchedOwners.map(n => (
              <div className="ti-row" key={n}>
                <span>"{n}"</span>
                <select className="input" value={ownerMap[n] ?? ''} onChange={e => setOwnerMap(m => ({ ...m, [n]: e.target.value }))}>
                  <option value="">No owner</option>{vols.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
                </select>
              </div>
            ))}
          </div>
        )}
        <div style={{ maxHeight: '34vh', overflow: 'auto', border: '1px solid var(--line)', borderRadius: 8 }}>
          <table className="import-tbl"><thead><tr><th>Task</th><th>Department</th><th>Owner</th><th></th></tr></thead><tbody>
            {resolved.map(({ p, r }, i) => (
              <tr key={i}>
                <td>{p.name}</td>
                <td style={!r.deptId ? { color: 'var(--rose)' } : undefined}>{r.deptId ? depts.find(d => d.id === r.deptId)?.name : `⚠ ${p.item.deptName || 'none'}`}</td>
                <td className="muted-sm">{r.assigneeId ? vols.find(v => v.id === r.assigneeId)?.name : '—'}</td>
                <td>{p.mode === 'new' ? <span className="pill-new">New</span> : <span className="pill-upd">Update</span>}</td>
              </tr>
            ))}
          </tbody></table>
        </div>
        <div className="modal-foot" style={{ padding: '12px 0 0' }}>
          <button className="btn" onClick={() => setStep('choose')}>Back</button>
          <button className="btn primary" onClick={commit} disabled={busy || missingDept > 0}>
            {busy ? 'Importing…' : missingDept ? `${missingDept} need a department` : `Import ${rows.length} task${rows.length > 1 ? 's' : ''}`}
          </button>
        </div>
      </>}
    </Modal>
  );
}

/* ── One-time repair for tasks imported before the fix: they kept the sheet's
   Department / Owner text but were filed under the first department. ── */
function TaskRepairModal({ fixes, depts, vols, onClose, toast }) {
  const [busy, setBusy] = useState(false);
  const dn = id => depts.find(d => d.id === id)?.name || '—';
  const vn = id => vols.find(v => v.id === id)?.name || '—';
  const fixable = fixes.filter(f => f.newDept || f.newOwner);
  const stuck = fixes.filter(f => f.deptUnknown || f.ownerUnknown);
  async function apply() {
    setBusy(true);
    try {
      await batchUpsert('tasks', fixable.map(f => ({ ...f.task, ...(f.newDept ? { deptId: f.newDept } : {}), ...(f.newOwner ? { assigneeId: f.newOwner } : {}) })));
      toast(`Fixed ${fixable.length} task${fixable.length > 1 ? 's' : ''}.`);
      onClose();
    } catch (e) { toast('Could not fix: ' + (e.code || e.message)); setBusy(false); }
  }
  return (
    <Modal title="Fix imported tasks" onClose={onClose} footer={null}>
      <p className="muted-sm" style={{ marginTop: 0 }}>These tasks came from an Excel import that didn't link the Department / Owner columns. Here's what will change:</p>
      {fixable.length > 0 && (
        <div style={{ maxHeight: '40vh', overflow: 'auto', border: '1px solid var(--line)', borderRadius: 8 }}>
          <table className="import-tbl"><thead><tr><th>Task</th><th>Department</th><th>Owner</th></tr></thead><tbody>
            {fixable.map(f => (
              <tr key={f.task.id}>
                <td>{f.task.title}</td>
                <td>{f.newDept ? <><s className="muted-sm">{dn(f.task.deptId)}</s> → <b>{dn(f.newDept)}</b></> : <span className="muted-sm">{dn(f.task.deptId)}</span>}</td>
                <td>{f.newOwner ? <b>{vn(f.newOwner)}</b> : <span className="muted-sm">{vn(f.task.assigneeId)}</span>}</td>
              </tr>
            ))}
          </tbody></table>
        </div>
      )}
      {stuck.length > 0 && (
        <div className="mtg-note" style={{ marginTop: 10 }}>
          ⚠ Couldn't match {stuck.reduce((n, f) => n + (f.deptUnknown ? 1 : 0) + (f.ownerUnknown ? 1 : 0), 0) === 1 ? 'this name' : 'these names'}:{' '}
          {stuck.map(f => [f.deptUnknown && `department "${f.task.deptName}"`, f.ownerUnknown && `owner "${f.task.assigneeName}"`].filter(Boolean).join(', ') + ` (${f.task.title})`).join('; ')}.
          {' '}Fix these by editing the task.
        </div>
      )}
      <div className="modal-foot" style={{ padding: '12px 0 0' }}>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={busy || !fixable.length} onClick={apply}>{busy ? 'Fixing…' : `Fix ${fixable.length} task${fixable.length === 1 ? '' : 's'}`}</button>
      </div>
    </Modal>
  );
}

export function Depts({ store, activeEventId }) {
  const { profile } = useAuth();
  const toast=useToast();
  const { can } = usePerm();
  const[modal,setModal]=useState(null);
  const depts=S(store,'departments'),tasks=S(store,'tasks'),vols=S(store,'volunteers');
  const avail=store.availability||[];
  const dName=id=>depts.find(d=>d.id===id)?.name||'—';
  const vName=id=>vols.find(v=>v.id===id)?.name||'—';

  // Tasks imported before the fix: their sheet text doesn't match their linked department/owner
  const taskFixes = tasks.map(t => {
    const d = t.deptName ? matchDept(t.deptName, depts) : null;
    const v = t.assigneeName ? matchVolunteer(t.assigneeName, vols) : null;
    return { task:t,
      newDept: d && d.id !== t.deptId ? d.id : null,
      newOwner: v && !t.assigneeId ? v.id : null,
      deptUnknown: !!t.deptName && !d, ownerUnknown: !!t.assigneeName && !v && !t.assigneeId };
  }).filter(f => f.newDept || f.newOwner || f.deptUnknown || f.ownerUnknown);

  // Get volunteers assigned to a department for this event (from Volunteer Availability)
  const getDeptVols = deptId => {
    return vols.filter(v => {
      const rec = avail.find(a=>a.volId===v.id&&a.day==='depts'&&a.eventId===activeEventId);
      return (rec?.deptIds||[]).includes(deptId);
    });
  };

  return(
    <>
      <div className="page-head"><div className="ph-txt"><h1>Departments & Tasks</h1></div></div>
      {taskFixes.length > 0 && can('depts.add') && (
        <div className="mtg-note" style={{display:'flex',alignItems:'center',gap:10,flexWrap:'wrap'}}>
          <span>⚠ {taskFixes.length} imported task{taskFixes.length>1?'s are':' is'} not linked to the department or owner named in the sheet.</span>
          <button className="btn sm" style={{marginLeft:'auto'}} onClick={()=>setModal({type:'fix-t'})}>Review & fix</button>
        </div>
      )}
      <div className="panel"><div className="panel-head"><h2>Departments</h2><div className="right"><button className="btn primary sm" onClick={()=>setModal({type:'add-d'})}>{ICON.plus}Add</button></div></div>
        <div className="panel-body"><table><thead><tr><th>Department</th><th>HOD(s)</th><th>Volunteers</th><th>Open tasks</th><th></th></tr></thead><tbody>
          {depts.map(d=>{
            const hods=(d.hodIds||[]).map(id=>vName(id)).filter(x=>x!=='—').join(', ');
            const open=tasks.filter(t=>t.deptId===d.id&&t.status!=='Done').length;
            const deptVols=getDeptVols(d.id);
            return<tr key={d.id}>
              <td><div className="nm">{d.name}</div><div className="role">{d.desc}</div></td>
              <td className="muted-sm">{hods||'—'}</td>
              <td>
                {deptVols.length===0
                  ? <span style={{color:'var(--faint)',fontSize:12}}>None assigned</span>
                  : <div style={{display:'flex',flexWrap:'wrap',gap:4}}>
                      {deptVols.map(v=>(
                        <span key={v.id} style={{
                          fontSize:11.5,padding:'2px 8px',borderRadius:12,
                          background:'var(--teal-wash)',color:'var(--teal)',
                          border:'1px solid var(--teal)',whiteSpace:'nowrap'
                        }} title={v.phone||''}>
                          {v.name}
                        </span>
                      ))}
                    </div>
                }
                <div style={{marginTop:3}}>
                  <button className="btn ghost xs" style={{fontSize:10.5,padding:'1px 6px',color:'var(--muted)'}}
                    onClick={()=>window.__jyotGo&&window.__jyotGo('availability')}
                    title="Manage in Volunteer Availability">
                    ↗ Manage
                  </button>
                </div>
              </td>
              <td><span className={'badge '+(open?'b-open':'b-done')}>{open} open</span></td>
              <td><div className="rowacts"><button className="btn ghost xs" onClick={()=>setModal({type:'edit-d',id:d.id})}>{ICON.edit}</button><button className="btn ghost xs" onClick={()=>setModal({type:'del-d',id:d.id})}>{ICON.trash}</button></div></td>
            </tr>;
          })}
          {!depts.length&&<tr><td colSpan="5"><Empty title="No departments yet" sub="Add your first department."/></td></tr>}
        </tbody></table></div></div>
      <div className="panel"><div className="panel-head"><h2>Tasks</h2><div className="right">
        <button className="btn sm" onClick={()=>setModal({type:'import-t'})}>{ICON.upload}Import Excel</button>
        {can('depts.add') && <button className="btn primary sm" onClick={()=>setModal({type:'add-t'})}>{ICON.plus}Add task</button>}
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
              <td><div className="rowacts">{can('depts.add')&&<button className="btn ghost xs" onClick={()=>setModal({type:'edit-t',id:t.id})}>{ICON.edit}</button>}{can('depts.delete')&&<button className="btn ghost xs" onClick={()=>setModal({type:'del-t',id:t.id})}>{ICON.trash}</button>}</div></td></tr>);
          })}
          {!tasks.length&&<tr><td colSpan="6"><Empty title="No tasks yet" sub="Add the first task."/></td></tr>}
        </tbody></table></div></div>
      {(modal?.type==='add-d'||modal?.type==='edit-d')&&<DeptModal item={modal.type==='edit-d'?depts.find(d=>d.id===modal.id)||undefined:undefined} vols={vols} onClose={()=>setModal(null)} toast={toast}/>}
      {(modal?.type==='add-t'||modal?.type==='edit-t')&&<TaskModal item={modal.type==='edit-t'?tasks.find(t=>t.id===modal.id)||undefined:undefined} depts={depts} vols={vols} tasks={tasks} activeEventId={activeEventId} onClose={()=>setModal(null)} toast={toast}/>}
      {modal?.type==='del-d'&&(()=>{const _dept=depts.find(d=>d.id===modal.id);return _dept?<DeleteModal label={_dept.name} onClose={()=>setModal(null)} onConfirm={async()=>{const _did=modal.id;const _dtasks=tasks.filter(t=>t.deptId===_did);const linked=[..._dtasks.map(t=>({collection:'tasks',data:t}))];setModal(null);await trashItem('departments',_dept,linked,profile?.email||'');_dtasks.forEach(t=>removeItem('tasks',t.id));await removeItem('departments',_did);toast('Department moved to trash.');}}/>:null;})()}
      {modal?.type==='del-t'&&(()=>{const _task=tasks.find(t=>t.id===modal.id);return _task?<DeleteModal label={_task.title} onClose={()=>setModal(null)} onConfirm={async()=>{setModal(null);await trashItem('tasks',_task,[],profile?.email||'');await removeItem('tasks',modal.id);toast('Task moved to trash.');}}/>:null;})()}
      {modal?.type==='import-t'&&<TaskImportModal depts={depts} vols={vols} tasks={tasks} activeEventId={activeEventId} onClose={()=>setModal(null)} toast={toast}/>}
      {modal?.type==='fix-t'&&<TaskRepairModal fixes={taskFixes} depts={depts} vols={vols} onClose={()=>setModal(null)} toast={toast}/>}
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
  const [taskErrors, setTaskErrors] = useState({});
  async function save(){
    const errs={};
    if(!f.title.trim()) errs.title='Task title is required';
    if(!f.deptId) errs.dept='Department is required';
    if(Object.keys(errs).length){setTaskErrors(errs);return;}
    await saveItem('tasks',{...f,deptName:'',assigneeName:'',eventId:activeEventId});onClose();toast(item?'Task updated.':'Task added.');
  }
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
/* ── PersonalisedSchedule Info Card (standalone component) ───────── */
function PSInfoCard({ c, store }) {
  const logistics = store.logistics || [];
  const founder   = store.founder   || [];
  const L = logistics.find(l => l.contactId === c.id) || {};
  const sahebji = founder.find(f => f.contactId === c.id);
  const vendor = (store.carVendors || []).find(v => v.id === L.carVendorId);
  const driver = (vendor?.drivers || []).find(d => d.id === L.carDriverId);
  return (
    <div className="ps-info" style={{ minWidth:240, maxWidth:280, background:'#fff', border:'1px solid var(--line)',
      borderRadius:10, padding:'14px 16px', fontSize:12.5, alignSelf:'flex-start', flexShrink:0 }}>
      <div style={{ fontWeight:700, fontSize:13, color:'var(--teal)', marginBottom:10 }}>{displayName(c)}</div>
      <div style={{ fontWeight:600, color:'var(--muted)', marginBottom:4, fontSize:11, textTransform:'uppercase', letterSpacing:'.05em' }}>✈️ Flight</div>
      {L.arrivalFlightNo
        ? <div style={{marginBottom:3}}>Arrival: <b>{L.arrivalFlightNo}</b> · {L.arrivalFlightDate} {L.arrivalFlightTime}</div>
        : <div style={{color:'var(--faint)',fontSize:12,marginBottom:3}}>No arrival flight</div>}
      {L.departureFlightNo && <div style={{marginBottom:8}}>Departure: <b>{L.departureFlightNo}</b> · {L.departureFlightDate} {L.departureFlightTime}</div>}
      {L.carVendorId && <>
        <div style={{ fontWeight:600, color:'var(--muted)', marginBottom:4, fontSize:11, textTransform:'uppercase', letterSpacing:'.05em' }}>🚗 Car</div>
        {vendor && <div style={{marginBottom:3}}>Vendor: <b>{vendor.name}</b></div>}
        {driver && <div style={{marginBottom:3}}>Driver: <b>{driver.name}</b></div>}
        {L.carPickupDate && <div style={{marginBottom:3}}>Pickup: {L.carPickupDate} {L.carPickupTime}</div>}
        {L.carDepartureDate && <div style={{marginBottom:8}}>Departs: {L.carDepartureDate} {L.carDepartureTime}</div>}
      </>}
      {L.hotelName && <>
        <div style={{ fontWeight:600, color:'var(--muted)', marginBottom:4, fontSize:11, textTransform:'uppercase', letterSpacing:'.05em' }}>🏨 Hotel</div>
        <div style={{marginBottom:3}}><b>{L.hotelName}</b></div>
        {L.checkinDate && <div style={{marginBottom:3}}>Check-in: {L.checkinDate} {L.checkinTime}</div>}
        {L.checkoutDate && <div style={{marginBottom:8}}>Check-out: {L.checkoutDate} {L.checkoutTime}</div>}
      </>}
      {sahebji && <>
        <div style={{ fontWeight:600, color:'var(--muted)', marginBottom:4, fontSize:11, textTransform:'uppercase', letterSpacing:'.05em' }}>🙏 Sahebji</div>
        <div style={{marginBottom:3}}>{sahebji.date} at {sahebji.time}</div>
        {sahebji.duration && <div>Duration: {sahebji.duration} min</div>}
      </>}
    </div>
  );
}

/* ── Personalised Schedule ────────────────────────────────────────── */
/* ── Word download for Personalised Schedule ─────────────────────── */
function downloadScheduleWord(contact, store, activeEventId) {
  const logistics    = store.logistics    || [];
  const sessions     = store.sessions     || [];
  const assignments  = store.assignments  || [];
  const founder      = store.founder      || [];
  const personalised = store.personalisedSchedule || [];

  // Load template settings
  const tmpl = (store.appConfig||[]).find(c=>c.id==='scheduleTemplate') || {};
  const hasTemplate    = !!(tmpl.headerTitle || tmpl.headerBg || tmpl.headerLogo);
  const headerBg       = tmpl.headerBg       || '#0F6E56';
  const headerTextColor= tmpl.headerTextColor|| '#ffffff';
  const headerTitle    = tmpl.headerTitle    || 'VK Outreach Program — JYOT';
  const headerSub      = tmpl.headerSub      || '';
  const headerLogo     = tmpl.headerLogo     || '';
  const logoPosition   = tmpl.logoPosition   || 'left';
  const logoSize       = tmpl.logoSize       || 'medium';
  const tableHeaderBg  = tmpl.tableHeaderBg  || headerBg;
  const altRowColor    = tmpl.altRowColor    || '#F0FAF6';
  const fontFamily     = tmpl.fontFamily     || 'Calibri';
  const timeColWidth   = {narrow:'70pt',normal:'90pt',wide:'120pt'}[tmpl.timeColWidth||'normal'];
  const footerLine1    = tmpl.footerLine1    || '';
  const footerLine2    = tmpl.footerLine2    || '';
  const footerLogo     = tmpl.footerLogo     || '';
  const footerBorder   = tmpl.footerBorderColor || headerBg;
  const showPageNumber = tmpl.showPageNumber !== false;
  const showHotel      = tmpl.showHotel      !== false;
  const showPOC        = tmpl.showPOC        !== false;
  const showAutoTag    = tmpl.showAutoTag    !== false;
  const logoSizePx     = {small:'40px',medium:'60px',large:'90px'}[logoSize]||'60px';

  const L       = logistics.find(l => l.contactId === contact.id) || {};
  const sahebji = founder.find(f => f.contactId === contact.id);

  const rows = [];
  personalised.filter(r => r.contactId===contact.id && r.date && r.time && r.event && !r.deleted
    && (showPOC || !r.id?.startsWith('poc_auto_'))
    && !r.id?.startsWith('poc_auto_') === !showPOC ? true : true )
    .forEach(r => {
      if (!showPOC && r.id?.startsWith('poc_auto_')) return;
      rows.push({ date:r.date, time:r.time, event:r.event });
    });
  if (L.arrivalDate && L.arrivalTime)
    rows.push({ date:L.arrivalDate, time:L.arrivalTime, event:'Journey towards Hotel' });
  if (L.departureDate && L.departureTime)
    rows.push({ date:L.departureDate, time:L.departureTime, event:'Departure towards Airport' });
  if (sahebji?.date && sahebji?.time)
    rows.push({ date:sahebji.date, time:sahebji.time, event:'One on One Meeting with His Holiness' });
  const assignedIds = assignments.filter(a=>a.contactId===contact.id).map(a=>a.sessionId);
  sessions.filter(s=>assignedIds.includes(s.id)).forEach(s=>{
    if (!rows.some(r=>r.date===s.date&&r.time===s.start))
      rows.push({ date:s.date, time:s.start, event:s.title });
  });
  rows.sort((a,b)=>((a.date+a.time)>(b.date+b.time)?1:-1));

  const byDate = {};
  rows.forEach(r=>{ if(!byDate[r.date]) byDate[r.date]=[]; byDate[r.date].push(r); });

  // Build logo HTML for header
  const logoHtml = headerLogo ? `<img src="${headerLogo}" style="height:${logoSizePx};object-fit:contain;display:block;" alt="logo"/>` : '';
  const logoAlign = logoPosition==='center'?'center':logoPosition==='right'?'right':'left';

  const headerHtml = `
    <div style="background:${headerBg};color:${headerTextColor};padding:14pt 18pt;margin:-40pt -40pt 20pt -40pt;">
      ${logoPosition==='center'
        ? `<div style="text-align:center">${logoHtml}<div style="font-size:18pt;font-weight:700;color:${headerTextColor}">${headerTitle}</div>${headerSub?`<div style="font-size:11pt;opacity:.85;color:${headerTextColor}">${headerSub}</div>`:''}</div>`
        : `<div style="display:flex;align-items:center;gap:12pt;justify-content:${logoPosition==='right'?'space-between':'flex-start'}">
            ${logoPosition==='left'?logoHtml:''}
            <div style="flex:1"><div style="font-size:18pt;font-weight:700;color:${headerTextColor}">${headerTitle}</div>${headerSub?`<div style="font-size:11pt;opacity:.85;color:${headerTextColor}">${headerSub}</div>`:''}</div>
            ${logoPosition==='right'?logoHtml:''}
           </div>`
      }
    </div>`;

  const dayBlocks = Object.entries(byDate).map(([date,dayRows])=>`
    <p style="font-size:13pt;font-weight:bold;color:${headerBg};margin:16pt 0 4pt;font-family:${fontFamily},sans-serif">${fmtDate(date)}</p>
    <table style="width:100%;border-collapse:collapse;margin-bottom:12pt;font-family:${fontFamily},sans-serif">
      <tr style="background:${tableHeaderBg}">
        <th style="padding:6px 10px;color:${headerTextColor};font-size:11pt;text-align:left;width:${timeColWidth}">Time</th>
        <th style="padding:6px 10px;color:${headerTextColor};font-size:11pt;text-align:left">Programme</th>
      </tr>
      ${dayRows.map((r,i)=>`
        <tr style="background:${i%2===0?'#ffffff':altRowColor}">
          <td style="padding:6px 10px;border:1px solid #ddd;font-size:11pt;font-family:${fontFamily},sans-serif">${r.time||'—'}</td>
          <td style="padding:6px 10px;border:1px solid #ddd;font-size:11pt;font-family:${fontFamily},sans-serif">${r.event||''}${showAutoTag&&r.auto?'  ↺':''}</td>
        </tr>`).join('')}
    </table>`).join('');

  const hotelBlock = showHotel ? `
    <p style="font-size:11pt;color:#555;margin:0 0 16pt;font-family:${fontFamily},sans-serif">
      Hotel: ${L.hotelName||'—'} &nbsp;·&nbsp; Arrival: ${L.arrivalDate||'—'} ${L.arrivalTime||''} &nbsp;·&nbsp; Departure: ${L.departureDate||'—'} ${L.departureTime||''}
    </p>` : '';

  const footerBlock = (footerLine1||footerLine2||footerLogo) ? `
    <div style="border-top:2px solid ${footerBorder};margin-top:24pt;padding-top:8pt;display:flex;align-items:center;justify-content:space-between">
      <div style="font-size:9pt;color:#888;font-family:${fontFamily},sans-serif">
        ${footerLine1?`<div>${footerLine1}</div>`:''}
        ${footerLine2?`<div>${footerLine2}</div>`:''}
        ${showPageNumber?`<div style="color:#aaa;margin-top:2pt">Page 1</div>`:''}
      </div>
      ${footerLogo?`<img src="${footerLogo}" style="height:28pt;object-fit:contain" alt="logo"/>` : ''}
    </div>` : '';

  const html = hasTemplate
    ? `<html xmlns:o="urn:schemas-microsoft-com:office:office"
        xmlns:w="urn:schemas-microsoft-com:office:word"
        xmlns="http://www.w3.org/TR/REC-html40">
        <head><meta charset="utf-8">
        <style>body{font-family:${fontFamily},sans-serif;margin:40pt;color:#1a1a1a}</style>
        </head><body>
        ${headerHtml}
        <h2 style="font-size:16pt;color:${headerBg};margin:0 0 4pt;font-family:${fontFamily},sans-serif">${displayName(contact)}</h2>
        <p style="font-size:12pt;color:#555;margin:0 0 6pt;font-family:${fontFamily},sans-serif">${[contact.type,contact.desig,contact.org].filter(Boolean).join(' · ')}</p>
        ${hotelBlock}
        ${dayBlocks}
        ${footerBlock}
        </body></html>`
    : `<html xmlns:o="urn:schemas-microsoft-com:office:office"
        xmlns:w="urn:schemas-microsoft-com:office:word"
        xmlns="http://www.w3.org/TR/REC-html40">
        <head><meta charset="utf-8">
        <style>body{font-family:Calibri,sans-serif;margin:40pt;color:#1a1a1a}
        h1{color:#0F6E56;font-size:18pt;margin:0 0 4pt}h2{font-size:14pt;font-weight:normal;margin:0 0 12pt;color:#444}</style>
        </head><body>
        <p style="font-size:10pt;color:#888;margin:0">VK Outreach Program — JYOT</p>
        <h1>Personalised Schedule</h1>
        <h2>${displayName(contact)} · ${contact.type||''} · ${contact.org||''}</h2>
        ${hotelBlock}
        ${dayBlocks}
        </body></html>`;

  const blob = new Blob([html],{type:'application/msword'});
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href=url; a.download=`Schedule_${displayName(contact).replace(/\s+/g,'_')}.doc`;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(url);
}

export function Reports({ store, activeEventId }) {
  const toast = useToast();
  const { can } = usePerm();

  const contacts       = (store.contacts || []).filter(c => c.status === 'Confirmed');
  const sessions       = store.sessions || [];
  const assignments    = store.assignments || [];
  const founder        = store.founder || [];
  const logistics      = store.logistics || [];
  const savedRows      = store.personalisedSchedule || [];
  const savedMandatory = store.personalisedMandatory || [];

  const configEventOptions = (store.appConfig||[]).find(c=>c.id==='eventOptions')?.items;
  const EVENT_OPTIONS = configEventOptions || [
    'Arrival at the Airport','Departure Flight','Journey towards Hotel',
    'Journey towards Venue','Arrival at Venue','One-on-One Meeting with Sahebji',
    'Media Bytes','Guided tour of Exhibition','Breakfast','Podcast',
    'Lunch','Journey towards Airport','High Tea','Checkout from Hotel',
  ];

  const configMandatory = (store.appConfig||[]).find(c=>c.id==='mandatoryItems')?.items || [];
  // configMandatory items may be strings or objects — normalise to objects
  const configMandatoryNorm = configMandatory.map(i =>
    typeof i === 'string' ? { key: i.toLowerCase().replace(/\s+/g,'_'), label: i } : i
  ).filter(i => i && i.key);
  const DEFAULT_MANDATORY = [
    { key:'guidedTour', label:'Guided tour' },
    { key:'mediaBytes', label:'Media Bytes' },
    { key:'sahebji',    label:'Sahebji meeting' },
    { key:'podcast',    label:'Podcast' },
  ];
  const ALL_MANDATORY = [
    { key:'arrivalAtVenue', label:'Arrival at Venue', locked:true },
    ...DEFAULT_MANDATORY,
    ...configMandatoryNorm.filter(ci=>!DEFAULT_MANDATORY.find(d=>d.key===ci.key)).map(i=>({key:i.key,label:i.label||i.key,locked:false})),
  ];

  const MANDATORY_KEYWORDS = {
    arrivalAtVenue: ['arrival at venue'],
    guidedTour:     ['guided tour','exhibition'],
    mediaBytes:     ['media bytes','media byte'],
    sahebji:        ['sahebji','one-on-one','one on one'],
    podcast:        ['podcast'],
  };

  // Local editing state per contact — { [cid]: { rows: [...], deleted: Set } }
  const [localEdits, setLocalEdits] = useState({});
  const [expandedId, setExpandedId] = useState(null);
  const [printContact, setPrintContact] = useState(null);
  const [summaryId, setSummaryId] = useState(null);
  const [saving, setSaving] = useState({});
  const [delChoice, setDelChoice] = useState(null);

  const getL       = cid => logistics.find(l=>l.contactId===cid)||{};
  const getSahebji = cid => founder.find(f=>f.contactId===cid);
  const getMandatory = cid => savedMandatory.find(r=>r.contactId===cid)||{ arrivalAtVenue:true };
  const getContactSessions = cid => {
    const ids = assignments.filter(a=>a.contactId===cid).map(a=>a.sessionId);
    return sessions.filter(s=>ids.includes(s.id)).sort((a,b)=>a.date>b.date?1:-1);
  };

  // Get saved manual rows from Firestore (threaded order)
  const getSavedRows = cid => {
    const rows = savedRows.filter(r=>r.contactId===cid && !r.auto);
    const byId = Object.fromEntries(rows.map(r=>[r.id,r]));
    const visited = new Set();
    const ordered = [];
    function chain(row) {
      if (!row || visited.has(row.id)) return;
      visited.add(row.id);
      ordered.push(row);
      rows.filter(r=>r.insertAfter===row.id && !visited.has(r.id)).forEach(chain);
    }
    rows.filter(r=>!r.insertAfter||!byId[r.insertAfter])
        .sort((a,b)=>((a.date||'')+(a.time||''))>((b.date||'')+(b.time||''))?1:-1)
        .forEach(chain);
    rows.filter(r=>!visited.has(r.id))
        .sort((a,b)=>((a.date||'')+(a.time||''))>((b.date||'')+(b.time||''))?1:-1)
        .forEach(chain);
    return ordered;
  };

  /* Auto rows come from other modules and stay linked to them.
     Session row ids are per guest (auto_session_<sid>__<cid>); older saved rows used the
     session id alone, which made guests overwrite each other — canonAutoId maps them. */
  const emptyEdit = () => ({ rows:[], deletedAutoIds:new Set(), pocOverrides:{}, autoEdits:{}, unassign:new Set() });
  const isLegacyAuto = r => { const b = r.refId || r.id || ''; return b.startsWith('auto_session_') && !b.includes('__'); };
  const canonAutoId = r => { const b = r.refId || r.id || ''; return isLegacyAuto(r) ? `${b}__${r.contactId}` : b; };
  const getOverride = (cid, autoId) => savedRows.find(r=>r.contactId===cid && r.override && r.refId===autoId);
  const hasManualSahebji = cid => savedRows.some(r=>r.contactId===cid && !r.auto && /sahebji|one-on-one|one on one/i.test(r.event||''));
  const EDITABLE_SOURCES = ['Scheduling','Logistics','Sahebji'];

  const travelCfg = getTravelCfg(store);
  const getAutoRows = (cid, deletedIds) => {
    const L = getL(cid);
    const autos = [];
    const arrSrc = L.arrivalOverride ? 'manual' : (L.arrivalSource || 'manual');
    if (L.arrivalDate && L.arrivalTime) {
      const event = arrSrc === 'flight' ? `Arrival at ${L.arrivalLocation || 'the Airport'}${L.arrivalFlightNo ? ` (${L.arrivalFlightNo})` : ''}`
        : arrSrc === 'car' ? `Arrival at ${L.arrivalLocation || 'the venue'} by car`
        : 'Arrival at the Airport';
      autos.push({ id:`auto_arrival_${cid}`, contactId:cid, date:L.arrivalDate, time:L.arrivalTime, srcDate:L.arrivalDate, srcTime:L.arrivalTime,
        event, pocRequired:false, auto:true, source:'Logistics' });
    }
    /* Travel steps worked out from the flight / car + Travel times (edit them in Logistics) */
    const plan = travelPlan(L, travelCfg);
    plan.steps.forEach(st => {
      if (st.key === 'land') return;                          // the arrival row above covers it
      if (st.key === 'reach' && arrSrc === 'car') return;       // car arrival row already is "arrive at hotel"
      autos.push({ id:`auto_travel_${st.key}_${cid}`, contactId:cid, date:st.date, time:st.time, srcDate:st.date, srcTime:st.time,
        event:st.label, pocRequired:false, auto:true, source:'Travel' });
    });
    if (!plan.steps.some(st => st.key === 'depart') && L.departureDate && L.departureTime) {
      autos.push({ id:`auto_travel_depart_${cid}`, contactId:cid, date:L.departureDate, time:L.departureTime, srcDate:L.departureDate, srcTime:L.departureTime,
        event:`Departure${L.departureLocation ? ' from ' + L.departureLocation : ''}`, pocRequired:false, auto:true, source:'Travel' });
    }
    getContactSessions(cid).forEach(s => {
      const id = `auto_session_${s.id}__${cid}`;
      const ov = getOverride(cid, id);
      autos.push({ id, contactId:cid, date:ov?.date||s.date, time:ov?.time||s.start, srcDate:s.date, srcTime:s.start, overridden:!!ov,
        event:s.title, pocRequired:false, auto:true, source:'Scheduling', sessionId:s.id });
    });
    const m = getSahebji(cid);
    if (m && m.date && m.time && !hasManualSahebji(cid)) {
      autos.push({ id:`auto_sahebji_${cid}`, contactId:cid, date:m.date, time:m.time, srcDate:m.date, srcTime:m.time,
        event:'One-on-One Meeting with Sahebji', pocRequired:false, auto:true, source:'Sahebji', founderId:m.id });
    }
    // POC assignments auto-rows
    savedRows.filter(r=>r.contactId===cid && r.auto && r.id?.startsWith('poc_auto_') && !r.deleted)
      .forEach(r => autos.push({...r, source:'POC Allocation'}));
    return autos.filter(r=>!deletedIds.has(r.id));
  };

  // Initialize local edits when a contact is expanded
  function initEdits(cid) {
    if (localEdits[cid]) return; // already initialised
    const savedManual = getSavedRows(cid);
    // Load deleted auto rows from Firestore (saved with auto:true but marked deleted)
    const deletedAutoIds = new Set(
      savedRows.filter(r=>r.contactId===cid && r.auto && r.deleted).map(canonAutoId)
    );
    // Load POC overrides for auto rows
    const pocOverrides = Object.fromEntries(
      savedRows.filter(r=>r.contactId===cid && r.auto && !r.deleted && !r.override).map(r=>[canonAutoId(r), r.pocRequired||false])
    );
    setLocalEdits(prev=>({...prev, [cid]:{
      rows: savedManual,
      deletedAutoIds,
      pocOverrides,
      autoEdits: {},
      unassign: new Set(),
    }}));
  }

  function getEdit(cid) {
    return localEdits[cid] || emptyEdit();
  }

  function getAllRows(cid) {
    const edit = getEdit(cid);
    const manualRows = edit.rows;
    const autoRows = getAutoRows(cid, edit.deletedAutoIds).map(r=>{
      const base = { ...r, pocRequired: edit.pocOverrides[r.id] ?? r.pocRequired };
      const ae = edit.autoEdits?.[r.id];
      if (!ae) return base;
      if (ae.reset) return { ...base, date:r.srcDate, time:r.srcTime, overridden:false, pendingReset:true };
      return { ...base, date:ae.date ?? r.date, time:ae.time ?? r.time, changed:true, scope:ae.scope };
    });
    return [...manualRows, ...autoRows]
      .sort((a,b)=>((a.date||'')+(a.time||''))>((b.date||'')+(b.time||''))?1:-1);
  }

  function updateRowLocal(cid, rowId, field, val) {
    setLocalEdits(prev=>{
      const edit = prev[cid]||emptyEdit();
      const rows = edit.rows.map(r=>r.id===rowId?{...r,[field]:val}:r);
      return {...prev,[cid]:{...edit,rows}};
    });
  }

  function updateAutoPocLocal(cid, autoId, val) {
    setLocalEdits(prev=>{
      const edit = prev[cid]||emptyEdit();
      return {...prev,[cid]:{...edit,pocOverrides:{...edit.pocOverrides,[autoId]:val}}};
    });
  }

  function updateAutoLocal(cid, row, field, val) {
    setLocalEdits(prev=>{
      const edit = prev[cid]||emptyEdit();
      const cur = edit.autoEdits?.[row.id] || {};
      const scope = cur.scope || (row.source==='Scheduling' ? 'all' : 'source');
      return {...prev,[cid]:{...edit,autoEdits:{...(edit.autoEdits||{}),[row.id]:{...cur,reset:false,scope,[field]:val}}}};
    });
  }
  function setAutoScope(cid, rowId, scope) {
    setLocalEdits(prev=>{
      const edit = prev[cid]||emptyEdit();
      const cur = edit.autoEdits?.[rowId] || {};
      return {...prev,[cid]:{...edit,autoEdits:{...(edit.autoEdits||{}),[rowId]:{...cur,scope}}}};
    });
  }
  function resetAutoLocal(cid, row) {
    setLocalEdits(prev=>{
      const edit = prev[cid]||emptyEdit();
      return {...prev,[cid]:{...edit,autoEdits:{...(edit.autoEdits||{}),[row.id]:{reset:true}}}};
    });
  }
  function unassignLocal(cid, row) {
    setLocalEdits(prev=>{
      const edit = prev[cid]||emptyEdit();
      return {...prev,[cid]:{...edit,
        unassign:new Set([...(edit.unassign||[]), row.sessionId]),
        deletedAutoIds:new Set([...edit.deletedAutoIds, row.id])}};
    });
  }

  function addRowLocal(cid, afterRow) {
    const newRow = {
      id:`${cid}_${Date.now()}`, contactId:cid, date:afterRow?.date||'', time:'',
      event:'', pocRequired:false, auto:false, insertAfter:afterRow?.id||null,
      eventId:activeEventId,
    };
    setLocalEdits(prev=>{
      const edit = prev[cid]||emptyEdit();
      // Insert after the afterRow
      const rows = [...edit.rows];
      const idx = afterRow ? rows.findIndex(r=>r.id===afterRow.id) : -1;
      if (idx >= 0) rows.splice(idx+1, 0, newRow);
      else rows.push(newRow);
      return {...prev,[cid]:{...edit,rows}};
    });
  }

  function deleteRowLocal(cid, row, force) {
    if (row.source==='Scheduling' && !force) { setDelChoice({ cid, row }); return; }
    setLocalEdits(prev=>{
      const edit = prev[cid]||emptyEdit();
      if (row.auto) {
        const deletedAutoIds = new Set([...edit.deletedAutoIds, row.id]);
        return {...prev,[cid]:{...edit,deletedAutoIds}};
      } else {
        const rows = edit.rows.filter(r=>r.id!==row.id);
        return {...prev,[cid]:{...edit,rows}};
      }
    });
  }

  // Save everything for a contact to Firestore
  async function saveContact(cid) {
    setSaving(prev=>({...prev,[cid]:true}));
    try {
      const edit = getEdit(cid);
      const SESSION_PREFIX = '__session__:';
      const sessionAdds = edit.rows.filter(r=>(r.event||'').startsWith(SESSION_PREFIX));
      const manualRows  = edit.rows.filter(r=>!(r.event||'').startsWith(SESSION_PREFIX));
      const unassign = edit.unassign || new Set();
      const report = [];

      // 1. Rows that pick an existing session → assign the guest in Scheduling
      for (const r of sessionAdds) {
        const sid = r.event.slice(SESSION_PREFIX.length);
        const s = sessions.find(x=>x.id===sid);
        if (!s || assignments.some(a=>a.contactId===cid && a.sessionId===sid)) continue;
        await saveItem('assignments',{contactId:cid,sessionId:sid,role:'Panelist',eventId:activeEventId});
        report.push(`added to "${s.title}"`);
      }
      // 2. Session rows removed with "Remove from session"
      for (const sid of unassign) {
        for (const a of assignments.filter(a=>a.contactId===cid && a.sessionId===sid)) await removeItem('assignments', a.id);
        const s = sessions.find(x=>x.id===sid);
        report.push(`removed from "${s?.title||'session'}"`);
      }
      // 3. Edited linked rows → write back to the module they come from
      const linked = getAutoRows(cid, new Set());
      for (const [autoId, ae] of Object.entries(edit.autoEdits||{})) {
        const row = linked.find(r=>r.id===autoId);
        if (!row) continue;
        if (ae.reset) {
          const ov = getOverride(cid, autoId);
          if (ov) { await removeItem('personalisedSchedule', ov.id); report.push(`"${row.event}" back to the main schedule`); }
          continue;
        }
        const newDate = ae.date ?? row.date, newTime = ae.time ?? row.time;
        if (newDate === row.date && newTime === row.time) continue;
        if (row.source === 'Scheduling') {
          const s = sessions.find(x=>x.id===row.sessionId);
          if (!s) continue;
          if (ae.scope === 'me') {
            await saveItem('personalisedSchedule',{ id:`ovr_${autoId}`, contactId:cid, eventId:activeEventId,
              auto:true, override:true, refId:autoId, date:newDate, time:newTime });
            report.push(`"${s.title}" changed for this guest only`);
          } else {
            const n = assignments.filter(a=>a.sessionId===s.id).length;
            if (!window.confirm(`"${s.title}" will move to ${newDate} at ${newTime} in Scheduling — this changes it for all ${n} guest${n===1?'':'s'} in the session. Continue?`)) continue;
            const end = s.end ? hhmm(toMin(s.end) + (toMin(newTime) - toMin(s.start))) : '';
            await saveItem('sessions',{ ...s, date:newDate, start:newTime, end });
            for (const copy of savedRows.filter(r=>r.auto && !r.deleted && !r.override && r.sessionId===s.id))
              await saveItem('personalisedSchedule',{ ...copy, date:newDate, time:newTime });
            const ov = getOverride(cid, autoId);
            if (ov) await removeItem('personalisedSchedule', ov.id);
            report.push(`"${s.title}" moved in Scheduling`);
          }
        } else if (row.source === 'Logistics') {
          const L = logistics.find(l=>l.contactId===cid) || { contactId:cid, eventId:activeEventId };
          // Changing a booked arrival here = a manual override; a planned one updates the plan
          const booked = L.arrivalSource && L.arrivalSource !== 'manual';
          await saveItem('logistics',{ ...L, arrivalDate:newDate, arrivalTime:newTime,
            ...(booked ? { arrivalOverride:true } : { arrivalSource:'manual', plannedArrivalDate:newDate }) });
          const copy = savedRows.find(r=>r.id===autoId);
          if (copy) await saveItem('personalisedSchedule',{ ...copy, date:newDate, time:newTime });
          report.push('arrival updated in Logistics');
        } else if (row.source === 'Sahebji') {
          const m = founder.find(f=>f.id===row.founderId);
          if (!m) continue;
          if (m.frozen) { report.push('Sahebji meeting is frozen — not moved (unfreeze it in Scheduling first)'); continue; }
          const slot = slotContaining(newDate, newTime, m.duration, store.sahebjiSlots||[]);
          if (!slot && !window.confirm(`${newDate} ${newTime} is outside Sahebji's available slots. Save anyway?`)) continue;
          await saveItem('founder',{ ...m, date:newDate, time:newTime, slotId:slot?.id||null });
          const copy = savedRows.find(r=>r.id===autoId);
          if (copy) await saveItem('personalisedSchedule',{ ...copy, date:newDate, time:newTime });
          report.push('Sahebji meeting updated');
        }
      }

      // Save / update manual rows
      for (const row of manualRows) {
        await saveItem('personalisedSchedule',{...row,contactId:cid,eventId:activeEventId,auto:false});
      }

      // Delete manual rows that were removed
      const existingManual = savedRows.filter(r=>r.contactId===cid && !r.auto);
      const keepIds = new Set(manualRows.map(r=>r.id));
      for (const r of existingManual) {
        if (!keepIds.has(r.id)) await removeItem('personalisedSchedule',r.id);
      }

      // Save deleted auto row markers (not for sessions the guest was removed from — the row is gone anyway)
      const unassignedRowIds = new Set(linked.filter(r=>r.sessionId && unassign.has(r.sessionId)).map(r=>r.id));
      for (const autoId of edit.deletedAutoIds) {
        if (unassignedRowIds.has(autoId)) continue;
        await saveItem('personalisedSchedule',{id:autoId+'_del',contactId:cid,
          eventId:activeEventId,auto:true,deleted:true,refId:autoId});
      }

      // Remove markers that are no longer wanted, and old-format markers (re-saved above in the new format)
      const existingAutoMarkers = savedRows.filter(r=>r.contactId===cid && r.auto && r.deleted);
      for (const m of existingAutoMarkers) {
        if (isLegacyAuto(m) || !edit.deletedAutoIds.has(canonAutoId(m)) || unassignedRowIds.has(canonAutoId(m)))
          await removeItem('personalisedSchedule',m.id);
      }

      // Save POC overrides for auto rows (one copy per guest)
      const freshAuto = getAutoRows(cid, new Set());
      for (const [autoId, poc] of Object.entries(edit.pocOverrides)) {
        const existing = savedRows.find(r=>r.id===autoId);
        const row = freshAuto.find(r=>r.id===autoId);
        if (existing) await saveItem('personalisedSchedule',{...existing,pocRequired:poc});
        else if (row) {
          const { srcDate, srcTime, overridden, ...clean } = row;
          await saveItem('personalisedSchedule',{...clean,pocRequired:poc,eventId:activeEventId});
        }
      }
      // Remove this guest's old-format shared copies now that per-guest copies exist
      for (const r of savedRows.filter(r=>r.contactId===cid && r.auto && !r.deleted && !r.override && isLegacyAuto(r)))
        await removeItem('personalisedSchedule', r.id);

      setLocalEdits(prev=>({...prev,[cid]:{...(prev[cid]||emptyEdit()), rows:manualRows, autoEdits:{}, unassign:new Set()}}));
      toast(report.length ? `Schedule saved — ${report.join(', ')}.` : 'Schedule saved.');
    } catch(e) {
      toast('Error saving: '+e.message);
    }
    setSaving(prev=>({...prev,[cid]:false}));
  }

  async function setMandatory(cid, field, val) {
    const existing = savedMandatory.find(r=>r.contactId===cid)||{};
    await saveItem('personalisedMandatory',{
      id:existing.id||`${cid}_mandatory`,
      contactId:cid, eventId:activeEventId,
      ...getMandatory(cid), [field]:val,
    });
  }

  const getMandatoryPending = cid => {
    const mandatory = getMandatory(cid);
    const allRows = getAllRows(cid);
    const pending = [];
    ALL_MANDATORY.forEach(item=>{
      if (!mandatory[item.key]) return;
      const keywords = MANDATORY_KEYWORDS[item.key]||[(item.label||item.key||'').toLowerCase()];
      const exists = allRows.some(r=>keywords.some(kw=>(r.event||'').toLowerCase().includes(kw)));
      if (!exists) pending.push(item.label);
    });
    return pending;
  };

  if (!contacts.length) return (
    <>
      <div className="page-head"><div className="ph-txt"><h1>Personalised Schedule</h1></div></div>
      <div className="panel"><Empty title="No confirmed guests yet" sub="Confirm guests in Outreach first." /></div>
    </>
  );

  return (
    <>
      <div className="page-head"><div className="ph-txt">
        <h1>Panelists Personalised Schedule</h1>
        <p>Build each panelist's day-by-day schedule. Click Save after making changes.</p>
      </div>

      </div>

      <div className="panel" style={{marginBottom:20}}>
        <div className="panel-body" style={{overflowX:'auto'}}>
          <table style={{minWidth:1000,fontSize:13}}>
            <thead>
              <tr style={{background:'var(--teal-wash)'}}>
                {[
                  {h:'',tip:''},
                  {h:'Name',tip:''},
                  {h:'Arrival Date',tip:'From Logistics',auto:true},
                  {h:'Arrival Time',tip:'From Logistics',auto:true},
                  {h:'Departure Date',tip:'From Logistics',auto:true},
                  {h:'Departure Time',tip:'From Logistics',auto:true},
                  {h:'Sessions',tip:'From Scheduling',auto:true},
                  {h:'Remarks',tip:'From Logistics remarks'},
                  {h:'Mandatory Fields',tip:''},
                  {h:'⚠',tip:'Pending mandatory items'},
                  {h:'',tip:'Print / Word'},
                ].map(({h,tip,auto})=>(
                  <th key={h} style={{padding:'8px 10px',textAlign:'left',fontSize:11.5,fontWeight:600,
                    borderBottom:'1px solid var(--line)',whiteSpace:'nowrap',
                    background:auto?'#EAF7F1':undefined,cursor:tip?'help':'default'}} title={tip||undefined}>
                    {h}{auto&&<span style={{fontSize:9,marginLeft:3,color:'var(--teal)'}}>⟳</span>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {contacts.map(c=>{
                const L          = getL(c.id);
                const sessions_c = getContactSessions(c.id);
                const mandatory  = getMandatory(c.id);
                const pending    = getMandatoryPending(c.id);
                const isExpanded = expandedId===c.id;
                const edit       = getEdit(c.id);
                const isDirty    = !!localEdits[c.id];

                return (
                  <React.Fragment key={c.id}>
                    <tr style={{borderBottom:'1px solid var(--line)',background:isExpanded?'var(--teal-wash)':'white'}}>
                      <td style={{padding:'8px 8px',textAlign:'center',cursor:'pointer',fontSize:16,color:'var(--teal)'}}
                        onClick={()=>{ if (!isExpanded) initEdits(c.id); setExpandedId(isExpanded?null:c.id); }}>
                        {isExpanded?'▲':'▼'}
                      </td>
                      <td style={{padding:'8px 10px'}}>
                        <div style={{display:'flex',alignItems:'flex-start',gap:8}}>
                          <div style={{flex:1}}>
                            <div className="nm">{displayName(c)}</div>
                            <div className="role">{c.type} · {c.field}</div>
                          </div>
                          <button className="btn ghost xs" title="View full summary"
                            onClick={e=>{e.stopPropagation(); setSummaryId(summaryId===c.id?null:c.id);}}
                            style={{fontSize:12,flexShrink:0,marginTop:2}}>📋</button>
                        </div>
                      </td>
                      <td style={{padding:'8px 10px',color:'var(--muted)',fontSize:12,background:'#EAF7F1'}}>{L.arrivalDate||'—'}</td>
                      <td style={{padding:'8px 10px',color:'var(--muted)',fontSize:12,background:'#EAF7F1'}}>{L.arrivalTime||'—'}</td>
                      <td style={{padding:'8px 10px',color:'var(--muted)',fontSize:12,background:'#EAF7F1'}}>{L.departureDate||'—'}</td>
                      <td style={{padding:'8px 10px',color:'var(--muted)',fontSize:12,background:'#EAF7F1'}}>{L.departureTime||'—'}</td>
                      <td style={{padding:'8px 10px',background:'#EAF7F1'}}>
                        {sessions_c.length>0
                          ? <div style={{fontSize:12}}>{sessions_c.map(s=>(
                              <div key={s.id} style={{marginBottom:2}}>
                                <span style={{color:'var(--teal)',fontWeight:500}}>{s.date}</span> · {s.title}
                              </div>
                            ))}</div>
                          : <span style={{color:'var(--faint)',fontSize:12}}>None</span>}
                      </td>
                      <td style={{padding:'8px 10px'}}>
                        {can('reports.edit')
                          ? <input className="input" style={{fontSize:12,padding:'3px 8px',minWidth:120}}
                              defaultValue={L.remarks||''}
                              onBlur={e=>saveItem('logistics',{...L,contactId:c.id,remarks:e.target.value,eventId:activeEventId})}
                              placeholder="Remarks…"/>
                          : <span style={{fontSize:12,color:'var(--muted)'}}>{L.remarks||'—'}</span>}
                      </td>
                      <td style={{padding:'8px 10px'}}>
                        <div style={{display:'flex',flexDirection:'column',gap:3,fontSize:12}}>
                          {ALL_MANDATORY.map(item=>(
                            <label key={item.key} style={{display:'flex',alignItems:'center',gap:5,cursor:item.locked?'default':'pointer'}}>
                              <input type="checkbox"
                                checked={!!mandatory[item.key]}
                                disabled={item.locked||!can('reports.mandatory')}
                                onChange={item.locked?undefined:e=>setMandatory(c.id,item.key,e.target.checked)}
                                style={{accentColor:'var(--teal)'}}/>
                              <span style={{color:item.locked?'var(--muted)':'var(--ink)',fontSize:11.5}}>{item.label}{item.locked?' 🔒':''}</span>
                            </label>
                          ))}
                        </div>
                      </td>
                      <td style={{padding:'8px 10px',textAlign:'center'}}>
                        {pending.length>0 && (
                          <div title={`Pending: ${pending.join(', ')}`}
                            style={{background:'var(--amber-wash)',border:'1px solid #E8D5A3',borderRadius:8,
                              padding:'4px 8px',fontSize:11,color:'var(--amber)',cursor:'help',whiteSpace:'nowrap'}}>
                            ⚠ {pending.length}
                          </div>
                        )}
                      </td>
                      <td style={{padding:'8px 6px',whiteSpace:'nowrap'}}>
                        {can('reports.print') && <>
                          <button className="btn ghost xs" title="Print / Save as PDF"
                            onClick={()=>setPrintContact(c)} style={{fontSize:11,padding:'3px 7px'}}>🖨️</button>
                          <button className="btn ghost xs" title="Download as Word"
                            onClick={()=>downloadScheduleWord(c,store,activeEventId)}
                            style={{fontSize:11,padding:'3px 7px',marginLeft:3}}>📄</button>
                        </>}
                      </td>
                    </tr>

                    {isExpanded && (
                      <tr>
                        <td colSpan={11} style={{background:'#FAFAF7',borderBottom:'2px solid var(--teal)',padding:0}}>
                          <div style={{display:'flex',gap:16,padding:'16px 20px',alignItems:'flex-start'}}>
                            <div style={{flex:1,overflowX:'auto'}}>

                              {/* Header with Save button */}
                              <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:10}}>
                                <div>
                                  <span style={{fontWeight:600,fontSize:13,color:'var(--teal)'}}>Day-by-day schedule</span>
                                  {pending.length>0 && (
                                    <span style={{fontSize:11,color:'var(--amber)',marginLeft:10}}>
                                      ⚠ Pending: {pending.join(', ')}
                                    </span>
                                  )}
                                </div>
                                {can('reports.edit') && (
                                  <button className="btn primary sm"
                                    onClick={()=>saveContact(c.id)}
                                    disabled={saving[c.id]}>
                                    {saving[c.id]?'Saving…':'💾 Save schedule'}
                                  </button>
                                )}
                              </div>

                              <table style={{width:'100%',borderCollapse:'collapse',fontSize:12.5}}>
                                <thead>
                                  <tr style={{background:'var(--teal-wash)'}}>
                                    <th style={{padding:'6px 10px',textAlign:'left',fontSize:11,fontWeight:600}}>Date</th>
                                    <th style={{padding:'6px 10px',textAlign:'left',fontSize:11,fontWeight:600}}>Time</th>
                                    <th style={{padding:'6px 10px',textAlign:'left',fontSize:11,fontWeight:600}}>Event</th>
                                    <th style={{padding:'6px 10px',textAlign:'center',fontSize:11,fontWeight:600}}>POC?</th>
                                    <th style={{padding:'6px 10px',textAlign:'left',fontSize:11,fontWeight:600}}>Source</th>
                                    <th style={{padding:'6px 8px',width:80}}></th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {getAllRows(c.id).map((row,idx,allArr)=>(
                                    <React.Fragment key={row.id}>
                                      <tr style={{borderBottom:'1px solid var(--line)',background:row.auto?'#EAF7F1':'white'}}>
                                        <td style={{padding:'4px 6px'}}>
                                          {row.auto && EDITABLE_SOURCES.includes(row.source) && can('reports.edit')
                                            ? <input className="input" type="date" value={row.date||''}
                                                onChange={e=>updateAutoLocal(c.id,row,'date',e.target.value)}
                                                style={{fontSize:12,padding:'3px 6px',borderColor:row.changed?'var(--amber)':undefined}}/>
                                            : row.auto
                                            ? <span style={{color:'var(--teal)',fontWeight:500,fontSize:12}}>{row.date}</span>
                                            : <input className="input" type="date" value={row.date||''}
                                                min={L.arrivalDate||undefined}
                                                max={L.departureDate||undefined}
                                                onChange={e=>{
                                                  const d = e.target.value;
                                                  if (L.arrivalDate && d < L.arrivalDate) { toast('Date is before guest arrival ('+L.arrivalDate+')'); return; }
                                                  if (L.departureDate && d > L.departureDate) { toast('Date is after guest departure ('+L.departureDate+')'); return; }
                                                  updateRowLocal(c.id,row.id,'date',d);
                                                }}
                                                style={{fontSize:12,padding:'3px 6px'}}/>}
                                        </td>
                                        <td style={{padding:'4px 6px'}}>
                                          {row.auto && EDITABLE_SOURCES.includes(row.source) && can('reports.edit')
                                            ? <TimePicker value={row.time||''} onChange={v=>updateAutoLocal(c.id,row,'time',v)}/>
                                            : row.auto
                                            ? <span style={{color:'var(--muted)',fontSize:12}}>{row.time}</span>
                                            : <TimePicker value={row.time||''} onChange={v=>updateRowLocal(c.id,row.id,'time',v)}/>}
                                        </td>
                                        <td style={{padding:'4px 6px'}}>
                                          {row.auto
                                            ? <div>
                                                <span style={{fontWeight:500,fontSize:12}}>{row.event}
                                                  <span style={{fontSize:10,color:'var(--teal)',marginLeft:6,
                                                    background:'var(--teal-wash)',padding:'1px 5px',borderRadius:8}}>⟳ linked</span>
                                                </span>
                                                {row.changed && row.source==='Scheduling' && (
                                                  <select className="input ps-scope" value={row.scope||'all'} onChange={e=>setAutoScope(c.id,row.id,e.target.value)}>
                                                    <option value="all">Move session for everyone ({assignments.filter(a=>a.sessionId===row.sessionId).length})</option>
                                                    <option value="me">Only for this guest</option>
                                                  </select>
                                                )}
                                                {row.changed && row.source==='Logistics' && <div className="ps-note">Saves to Logistics (arrival)</div>}
                                                {row.changed && row.source==='Sahebji' && <div className="ps-note">Saves to the Sahebji meeting</div>}
                                                {row.overridden && !row.changed && (
                                                  <div className="ps-note warn">Differs from main schedule ({row.srcDate} {row.srcTime})
                                                    {can('reports.edit') && <button className="linkbtn" style={{fontSize:11,marginLeft:6}} onClick={()=>resetAutoLocal(c.id,row)}>Reset</button>}
                                                  </div>
                                                )}
                                                {row.pendingReset && <div className="ps-note">Will return to {row.srcDate} {row.srcTime} on save</div>}
                                              </div>
                                            : <select className="input" value={row.event||''}
                                                onChange={e=>updateRowLocal(c.id,row.id,'event',e.target.value)}
                                                style={{fontSize:12,padding:'3px 6px'}}>
                                                <option value="">— Select event —</option>
                                                <optgroup label="Activities">
                                                  {EVENT_OPTIONS.map(o=><option key={o} value={o}>{o}</option>)}
                                                </optgroup>
                                                {(()=>{
                                                  const mine = new Set(assignments.filter(a=>a.contactId===c.id).map(a=>a.sessionId));
                                                  const avail = sessions.filter(x=>!mine.has(x.id)).sort((a,b)=>(a.date+a.start)>(b.date+b.start)?1:-1);
                                                  return avail.length ? <optgroup label="Add to a session (updates Scheduling)">
                                                    {avail.map(x=><option key={x.id} value={'__session__:'+x.id}>{shortDate(x.date)} {x.start} · {x.title}</option>)}
                                                  </optgroup> : null;
                                                })()}
                                              </select>}
                                          {!row.auto && (row.event||'').startsWith('__session__:') && <div className="ps-note">Will add this guest to the session in Scheduling on save</div>}
                                        </td>
                                        <td style={{padding:'4px 6px',textAlign:'center'}}>
                                          <input type="checkbox"
                                            checked={row.pocRequired||false}
                                            onChange={e=>row.auto
                                              ? updateAutoPocLocal(c.id,row.id,e.target.checked)
                                              : updateRowLocal(c.id,row.id,'pocRequired',e.target.checked)}
                                            style={{accentColor:'var(--teal)'}}/>
                                        </td>
                                        <td style={{padding:'4px 6px'}}>
                                          {row.auto
                                            ? <span style={{fontSize:10,color:'var(--teal)',background:'var(--teal-wash)',padding:'1px 6px',borderRadius:8}}>{row.source}</span>
                                            : <span style={{fontSize:10,color:'var(--muted)',background:'#f5f5f5',padding:'1px 6px',borderRadius:8}}>Manual</span>}
                                        </td>
                                        <td style={{padding:'4px 6px',textAlign:'right'}}>
                                          {can('reports.edit') && (
                                            <div className="rowacts">
                                              <button className="btn ghost xs"
                                                title="Add row below"
                                                onClick={()=>addRowLocal(c.id,row)}
                                                style={{fontWeight:700,color:'var(--teal)'}}>+</button>
                                              <button className="btn ghost xs"
                                                title={row.auto?'Remove auto row':'Delete row'}
                                                onClick={()=>deleteRowLocal(c.id,row)}
                                                style={{color:'var(--rose)'}}>
                                                {ICON.trash}
                                              </button>
                                            </div>
                                          )}
                                        </td>
                                      </tr>
                                    </React.Fragment>
                                  ))}
                                  {getAllRows(c.id).length===0 && (
                                    <tr>
                                      <td colSpan={6} style={{padding:'12px',textAlign:'center',color:'var(--muted)',fontSize:13}}>
                                        No schedule rows yet.
                                      </td>
                                    </tr>
                                  )}
                                </tbody>
                              </table>
                              {can('reports.edit') && (
                                <button onClick={()=>addRowLocal(c.id, getAllRows(c.id).slice(-1)[0]||null)}
                                  style={{marginTop:8,border:'1px dashed var(--line)',background:'none',cursor:'pointer',
                                    borderRadius:6,padding:'4px 14px',fontSize:12,color:'var(--teal)'}}>
                                  {ICON.plus} Add row
                                </button>
                              )}
                            </div>
                            <PSInfoCard c={c} store={store}/>
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Personalised Schedule Summary Popup */}
      {summaryId && (()=>{
        const sc = contacts.find(c=>c.id===summaryId);
        if (!sc) return null;
        const sL = getL(summaryId);
        const allRows = getAllRows(summaryId, new Set());
        const sessions_s = getContactSessions(summaryId);
        const pocRecs = (store.poc||[]).filter(p=>p.contactId===summaryId&&p.eventId===activeEventId);
        const byDate = {};
        allRows.forEach(r=>{ if(r.date){ if(!byDate[r.date]) byDate[r.date]=[]; byDate[r.date].push(r); }});
        return (
          <div className="scrim" onMouseDown={()=>setSummaryId(null)}>
            <div className="modal" onMouseDown={e=>e.stopPropagation()} style={{maxWidth:600,maxHeight:'85vh',overflowY:'auto'}}>
              <div className="modal-head" style={{background:'var(--teal)',color:'#fff',position:'sticky',top:0,zIndex:2}}>
                <div>
                  <h2 style={{color:'#fff',margin:0}}>{displayName(sc)}</h2>
                  <div style={{fontSize:12,opacity:.85}}>{sc.type} · {sc.desig} · {sc.org}</div>
                </div>
                <button className="x" style={{color:'#fff',opacity:.8}} onClick={()=>setSummaryId(null)}>✕</button>
              </div>
              <div className="modal-body" style={{padding:0}}>

                {/* Travel info */}
                <div style={{padding:'12px 20px',background:'var(--teal-wash)',borderBottom:'1px solid var(--line)'}}>
                  <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8,fontSize:12.5}}>
                    <div>
                      <span style={{color:'var(--muted)'}}>Hotel: </span>
                      <strong>{sL.hotelName||'—'}</strong>
                    </div>
                    <div>
                      <span style={{color:'var(--muted)'}}>Arrival: </span>
                      <strong>{sL.arrivalDate||'—'} {sL.arrivalTime||''}</strong>
                      {sL.arrivalFlight&&<span style={{color:'var(--muted)'}}> · {sL.arrivalFlight}</span>}
                    </div>
                    <div>
                      <span style={{color:'var(--muted)'}}>Departure: </span>
                      <strong>{sL.departureDate||'—'} {sL.departureTime||''}</strong>
                      {sL.departureFlight&&<span style={{color:'var(--muted)'}}> · {sL.departureFlight}</span>}
                    </div>
                    <div>
                      <span style={{color:'var(--muted)'}}>Sessions: </span>
                      <strong>{sessions_s.length}</strong>
                      {' · '}
                      <span style={{color:'var(--muted)'}}>POC days: </span>
                      <strong>{pocRecs.length}</strong>
                    </div>
                  </div>
                </div>

                {/* POC summary */}
                {pocRecs.length>0&&(
                  <div style={{padding:'10px 20px',background:'#EAF7F1',borderBottom:'1px solid var(--line)'}}>
                    <div style={{fontSize:12,fontWeight:600,color:'var(--teal)',marginBottom:6}}>POC Assignments</div>
                    {pocRecs.map(p=>{
                      const vol=(store.volunteers||[]).find(v=>v.id===p.volunteerId);
                      return (
                        <div key={p.id} style={{fontSize:12,marginBottom:3}}>
                          <strong>{fmtDate(p.day)}</strong>
                          {' · '}{p.fromTime}–{p.toTime}
                          {' · '}{vol?`${vol.name} (${vol.phone||'no phone'})`:'Unassigned'}
                          {p.frozen&&' 🔒'}
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Day-by-day schedule */}
                {Object.entries(byDate).sort(([a],[b])=>a>b?1:-1).map(([date,dayRows])=>(
                  <div key={date}>
                    <div style={{padding:'8px 20px',background:'var(--paper)',borderBottom:'1px solid var(--line)',
                      fontSize:12,fontWeight:600,color:'var(--teal)',position:'sticky',top:60}}>
                      {fmtDate(date)}
                    </div>
                    {dayRows.sort((a,b)=>(a.time||'')>(b.time||'')?1:-1).map((r,i)=>(
                      <div key={r.id||i} style={{
                        display:'flex',gap:12,padding:'8px 20px',
                        borderBottom:'1px solid var(--line)',
                        background: r.auto ? '#FAFFF9' : '#fff',
                      }}>
                        <div style={{width:50,flexShrink:0,fontSize:12.5,fontWeight:500,color:'var(--teal)'}}>
                          {r.time||'—'}
                        </div>
                        <div style={{flex:1,fontSize:12.5}}>{r.event}</div>
                        {r.auto&&<span style={{fontSize:10,color:'var(--muted)',alignSelf:'center'}}>⟳</span>}
                        {r.pocRequired&&<span style={{fontSize:10,color:'var(--amber)',alignSelf:'center'}}>POC req.</span>}
                      </div>
                    ))}
                  </div>
                ))}

                {!Object.keys(byDate).length&&(
                  <div style={{padding:32,textAlign:'center',color:'var(--muted)',fontSize:13}}>
                    No schedule rows yet. Add rows or tick sessions in Scheduling.
                  </div>
                )}
              </div>
              <div className="modal-foot" style={{position:'sticky',bottom:0,background:'#fff'}}>
                <button className="btn" onClick={()=>setSummaryId(null)}>Close</button>
                <button className="btn primary" onClick={()=>{setPrintContact(sc);setSummaryId(null);}}>🖨️ Print</button>
                <button className="btn primary" onClick={()=>{downloadScheduleWord(sc,store,activeEventId);setSummaryId(null);}}>📄 Word</button>
              </div>
            </div>
          </div>
        );
      })()}

      {delChoice && (
        <Modal title="Remove session row" onClose={()=>setDelChoice(null)} footer={null} size="sm">
          <p style={{fontSize:13.5,marginTop:0}}><b>{delChoice.row.event}</b> comes from Scheduling. What should happen?</p>
          <div className="slot-del-actions">
            <button className="btn danger" onClick={()=>{ unassignLocal(delChoice.cid, delChoice.row); setDelChoice(null); }}>Remove this guest from the session (updates Scheduling)</button>
            <button className="btn" onClick={()=>{ deleteRowLocal(delChoice.cid, delChoice.row, true); setDelChoice(null); }}>Hide in this schedule only</button>
            <button className="btn ghost" onClick={()=>setDelChoice(null)}>Cancel</button>
          </div>
          <p className="muted-sm" style={{margin:'10px 0 0'}}>Nothing changes until you click Save schedule.</p>
        </Modal>
      )}
      {printContact && <VKSchedulePrint contact={printContact} store={store} activeEventId={activeEventId} onClose={()=>setPrintContact(null)}/>}
    </>
  );
}


/* ============================ FELICITATION KITS ============================ */
export function FelicitationKits({ store, activeEventId }) {
  const toast = useToast();
  const contacts = (store.contacts||[]).filter(c=>c.status==='Confirmed'||c.status==='VIP');
  const kits = store.felicitation || [];
  const getKit = cid => kits.find(k=>k.contactId===cid) || {contactId:cid, eventId:activeEventId};
  const ITEMS = ['Momento','Shawl','Kumkum','Cover','Gold Coin','Silver Coin','Frame'];
  const key = item => (item||'').toLowerCase().replace(/ /g,'_');

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
/* VolModal — volunteer profile (shared across all events) */
function VolModal({ item, onClose, toast, vols = [], canSetAvailability = false, onNext }) {
  const [f, setF] = useState(()=>({name:'',phone:'',city:'',area:'',skills:'',...item}));
  const set = k => e => setF(p=>({...p,[k]:e.target.value}));
  const [err, setErr] = useState('');
  const [next, setNext] = useState(!item && canSetAvailability);
  const cities = [...new Set(vols.map(v=>(v.city||'').trim()).filter(Boolean))].sort();
  const areas  = [...new Set(vols.filter(v=>!f.city||(v.city||'').trim().toLowerCase()===f.city.trim().toLowerCase()).map(v=>(v.area||'').trim()).filter(Boolean))].sort();
  async function save() {
    if (!f.name.trim()) { setErr('Name is required'); return; }
    const dup = !item && vols.find(v=>(v.name||'').trim().toLowerCase()===f.name.trim().toLowerCase());
    if (dup) { setErr(`${dup.name} is already in the list.`); return; }
    const data = { ...f, name:f.name.trim(), phone:(f.phone||'').trim(), city:(f.city||'').trim(), area:(f.area||'').trim() };
    const id = await saveItem('volunteers', data);
    onClose();
    toast(item ? 'Volunteer updated.' : `${data.name} added.`);
    if (!item && next && onNext) onNext({ ...data, id });
  }
  return (
    <Modal title={item?'Edit volunteer':'Add volunteer'} onClose={onClose} onSave={save}
      saveLabel={item?'Save changes':(next?'Add & set availability':'Add volunteer')}>
      <p className="muted-sm" style={{marginTop:0}}>Profile details apply to every event.</p>
      <Field label="Name *">
        <input className="input" value={f.name} onChange={e=>{set('name')(e);setErr('');}} autoFocus
          style={err?{borderColor:'var(--rose)'}:{}}/>
        {err && <span style={{color:'var(--rose)',fontSize:11.5}}>{err}</span>}
      </Field>
      <div className="grid2">
        <Field label="Contact"><input className="input" type="tel" value={f.phone} onChange={set('phone')} placeholder="Phone number"/></Field>
        <Field label="City"><input className="input" list="vk-vol-cities" value={f.city} onChange={set('city')} placeholder="e.g. Mumbai"/></Field>
        <Field label="Area"><input className="input" list="vk-vol-areas" value={f.area} onChange={set('area')} placeholder="e.g. Mulund"/></Field>
        <Field label="Skills"><input className="input" value={f.skills||''} onChange={set('skills')} placeholder="e.g. POC, Hospitality"/></Field>
      </div>
      <datalist id="vk-vol-cities">{cities.map(c=><option key={c} value={c}/>)}</datalist>
      <datalist id="vk-vol-areas">{areas.map(a=><option key={a} value={a}/>)}</datalist>
      {!item && canSetAvailability && (
        <label className="chk"><input type="checkbox" checked={next} onChange={e=>setNext(e.target.checked)}/>Set their availability for this event next</label>
      )}
    </Modal>
  );
}

/* ══════════════════════════════════════════════════════════════════
   VOLUNTEER AVAILABILITY
   Event-specific. Pulled from Volunteer Directory.
   Records: days available, pre-event availability, departments.
   Shows assignments as badges with navigation links.
══════════════════════════════════════════════════════════════════ */

/* ══════════════════════════════════════════════════════════════════
   AVAILABILITY SLOTS
   A day can have up to MAX_SLOTS separate windows, e.g. 09:00–13:00 and 17:00–22:00.
   Stored on each availability record as `slots: [{start,end}]`.
   `start`/`end` are also written with the FIRST slot, so an old cached build only ever
   sees a smaller window (never the gap between slots as free).
   Old records that only have start/end read as one slot — no migration needed.
   Every check in the app goes through availSlots().
══════════════════════════════════════════════════════════════════ */
const MAX_SLOTS = 2;
const SHIFT_PRESETS = { morning: { start: '09:00', end: '13:00', label: 'Morning (9–1)' }, evening: { start: '17:00', end: '22:00', label: 'Evening (5–10)' } };
const slotMin = t => { if (!t) return 0; const [h, m] = String(t).split(':'); return (parseInt(h, 10) || 0) * 60 + (parseInt(m, 10) || 0); };
const sortSlotList = list => [...list].sort((a, b) => slotMin(a.start) - slotMin(b.start));
const presetSlot = k => ({ start: SHIFT_PRESETS[k].start, end: SHIFT_PRESETS[k].end });
const slotsText = slots => slots.map(s => `${s.start}–${s.end}`).join(', ');

/* Complete slots for a record, sorted. `fallback` ({start,end}) is used when the day is ticked but has no times. */
function availSlots(a, fallback) {
  if (!a || !a.checked) return [];
  if (!a.fullDay && Array.isArray(a.slots) && a.slots.length) {
    const s = a.slots.filter(x => x && x.start && x.end);
    if (s.length) return sortSlotList(s);
  }
  if (a.start && a.end) return [{ start: a.start, end: a.end }];
  return fallback ? [fallback] : [];
}
/* Slots as stored, including half-filled ones — for editors only. */
function rawSlots(a) {
  if (Array.isArray(a?.slots) && a.slots.length) return a.slots.map(x => ({ start: x?.start || '', end: x?.end || '' }));
  if (a?.start || a?.end) return [{ start: a.start || '', end: a.end || '' }];
  return [];
}
/* '' when valid, otherwise a short reason. */
function slotsError(slots) {
  if (!slots.length) return 'Add a time slot';
  for (const x of slots) {
    if (!x.start || !x.end) return 'Pick a start and end time';
    if (slotMin(x.end) <= slotMin(x.start)) return `${x.start}–${x.end}: end must be after start`;
  }
  const s = sortSlotList(slots);
  for (let i = 1; i < s.length; i++)
    if (slotMin(s[i].start) < slotMin(s[i - 1].end)) return `${slotsText([s[i - 1]])} and ${slotsText([s[i]])} overlap`;
  return '';
}
/* Fields to write on an availability record. */
function slotFields(slots) {
  const done = slots.every(x => x.start && x.end);
  const list = done ? sortSlotList(slots) : slots;
  const first = list.find(x => x.start && x.end) || list[0] || { start: '', end: '' };
  return { slots: list, start: first.start, end: first.end };
}
/* Suggested second slot: Evening if the first one ends before it, otherwise blank. */
function nextSlot(slots) {
  const ends = slots.map(x => x.end).filter(Boolean);
  const lastEnd = ends.length ? Math.max(...ends.map(slotMin)) : null;
  if (lastEnd !== null && lastEnd <= slotMin(SHIFT_PRESETS.evening.start)) return presetSlot('evening');
  return { start: '', end: '' };
}

/* Edit a day's slots: start–end rows, ✕ to remove, "+ Add slot" up to MAX_SLOTS. */
function SlotEditor({ slots, onChange }) {
  const list = slots.length ? slots : [{ start: '', end: '' }];
  const upd = (i, k, v) => onChange(list.map((x, j) => j === i ? { ...x, [k]: v } : x));
  const err = list.every(x => x.start && x.end) ? slotsError(list) : '';
  return (
    <div className="slot-ed">
      {list.map((x, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap', marginBottom: 4 }}>
          <TimePicker value={x.start} onChange={v => upd(i, 'start', v)} />
          <span className="muted-sm">to</span>
          <TimePicker value={x.end} onChange={v => upd(i, 'end', v)} />
          {list.length > 1 && <button type="button" className="btn ghost xs" title="Remove this slot" aria-label="Remove slot"
            onClick={() => onChange(list.filter((_, j) => j !== i))}>✕</button>}
        </div>
      ))}
      {list.length < MAX_SLOTS && <button type="button" className="linkbtn" style={{ fontSize: 12 }}
        onClick={() => onChange([...list, nextSlot(list)])}>+ Add slot</button>}
      {err && <div style={{ fontSize: 11, color: 'var(--rose)', marginTop: 2 }}>{err}</div>}
    </div>
  );
}

/* Time choice used by the Add / edit availability form: a preset, or custom slots. */
const SHIFT_CHOICES = fd => [
  ['full', `Full day (${fd.start || '09:00'}–${fd.end || '22:00'})`],
  ['morning', SHIFT_PRESETS.morning.label],
  ['evening', SHIFT_PRESETS.evening.label],
  ['both', 'Morning + Evening'],
  ['custom', 'Custom'],
];
function choiceSlots(ch, fd) {
  if (ch.shift === 'full') return [{ start: fd.start || '09:00', end: fd.end || '22:00' }];
  if (ch.shift === 'morning') return [presetSlot('morning')];
  if (ch.shift === 'evening') return [presetSlot('evening')];
  if (ch.shift === 'both') return [presetSlot('morning'), presetSlot('evening')];
  return ch.slots || [];
}
function choiceFromRecord(a) {
  if (!a || !a.checked) return null;
  if (a.fullDay) return { shift: 'full', slots: [] };
  const s = availSlots(a);
  const eq = (x, k) => x.start === SHIFT_PRESETS[k].start && x.end === SHIFT_PRESETS[k].end;
  if (s.length === 1 && eq(s[0], 'morning')) return { shift: 'morning', slots: s };
  if (s.length === 1 && eq(s[0], 'evening')) return { shift: 'evening', slots: s };
  if (s.length === 2 && eq(s[0], 'morning') && eq(s[1], 'evening')) return { shift: 'both', slots: s };
  return { shift: 'custom', slots: s.length ? s : [{ start: '09:00', end: '18:00' }] };
}
const sameChoice = (a, b, fd) => !!a && !!b && a.shift === b.shift && slotsText(choiceSlots(a, fd)) === slotsText(choiceSlots(b, fd));

function TimeChoice({ value, onChange, fd }) {
  const pick = k => {
    if (k === value.shift) return;
    // Switching to Custom starts from the times currently shown
    onChange({ shift: k, slots: k === 'custom' ? choiceSlots(value, fd).map(x => ({ ...x })) : value.slots });
  };
  return (<>
    <div className="av-chips">
      {SHIFT_CHOICES(fd).map(([k, l]) => (
        <button type="button" key={k} className={'av-chip' + (value.shift === k ? ' on' : '')} onClick={() => pick(k)}>{l}</button>
      ))}
    </div>
    {value.shift === 'custom' && (
      <div style={{ marginTop: 6 }}><SlotEditor slots={value.slots || []} onChange={slots => onChange({ ...value, slots })} /></div>
    )}
  </>);
}

export function Volunteers({ store, activeEventId }) {
  const toast  = useToast();
  const vols   = (store.volunteers || []).sort((a,b)=>(a.name||'').localeCompare(b.name||''));
  const avail  = store.availability || [];
  const depts  = store.departments  || [];
  const poc    = store.poc          || [];
  const tasks  = store.tasks        || [];
  const contacts = (store.contacts||[]).filter(c=>c.status==='Confirmed');

  // Full Day config from Settings
  const fdConfig = (store.appConfig||[]).find(c=>c.id==='fullDayHours')||{start:'09:00',end:'22:00'};

  // Build event days
  const activeEvent = (store.events||[]).find(e=>e.id===activeEventId);
  const eventDays = [];
  if (activeEvent?.startDate && activeEvent?.endDate) {
    let d = new Date(activeEvent.startDate+'T12:00:00');
    const end = new Date(activeEvent.endDate+'T12:00:00');
    let g = 0;
    while (d <= end && g < 20) {
      eventDays.push(localISO(d));
      d = new Date(d); d.setDate(d.getDate()+1); g++;
    }
  }

  const getAvail    = (volId, day)  => avail.find(a=>a.volId===volId&&a.day===day&&a.eventId===activeEventId)||{};
  const getPreEvent = volId         => avail.find(a=>a.volId===volId&&a.day==='pre-event'&&a.eventId===activeEventId)||{};
  const getDeptIds  = volId         => (avail.find(a=>a.volId===volId&&a.day==='depts'&&a.eventId===activeEventId)?.deptIds)||[];

  async function setDayAvail(volId, day, field, val) {
    const ex = getAvail(volId, day);
    await saveItem('availability',{
      id: ex.id||`${volId}_${day}_${activeEventId}`,
      volId, day, eventId: activeEventId, ...ex, [field]: val,
    });
  }

  async function setFullDay(volId, day, checked) {
    const ex = getAvail(volId, day);
    const update = { ...ex, fullDay: checked };
    if (checked) Object.assign(update, slotFields([{ start: fdConfig.start||'09:00', end: fdConfig.end||'22:00' }]));
    await saveItem('availability',{
      id: ex.id||`${volId}_${day}_${activeEventId}`,
      volId, day, eventId: activeEventId, ...update,
    });
  }

  /* Replace a day's time slots (detail popup + grid). Saves as typed, like the other inline edits. */
  async function setDaySlots(volId, day, slots) {
    const ex = getAvail(volId, day);
    await saveItem('availability',{
      id: ex.id||`${volId}_${day}_${activeEventId}`,
      volId, day, eventId: activeEventId, ...ex, fullDay: false, ...slotFields(slots),
    });
  }

  async function setPreEvent(volId, field, val) {
    const ex = getPreEvent(volId);
    await saveItem('availability',{
      id: ex.id||`${volId}_pre-event_${activeEventId}`,
      volId, day:'pre-event', eventId:activeEventId, ...ex, [field]:val,
    });
  }

  async function setDeptIds(volId, deptId, checked) {
    const ex = avail.find(a=>a.volId===volId&&a.day==='depts'&&a.eventId===activeEventId)||{};
    const current = ex.deptIds||[];
    const updated = checked ? [...current,deptId] : current.filter(id=>id!==deptId);
    await saveItem('availability',{
      id: ex.id||`${volId}_depts_${activeEventId}`,
      volId, day:'depts', eventId:activeEventId, ...ex, deptIds:updated,
    });
  }

  // Get assignments for a volunteer on a day (POC + tasks)
  const getAssignments = (volId, day) => {
    const results = [];
    poc.filter(p=>p.volunteerId===volId&&p.day===day&&p.eventId===activeEventId).forEach(p=>{
      const contact = contacts.find(c=>c.id===p.contactId);
      if (contact) results.push({
        type:'poc',
        label:`POC: ${displayName(contact)}`,
        time: p.fromTime&&p.toTime ? `${p.fromTime}–${p.toTime}` : '',
        nav:'pocallocation',
      });
    });
    tasks.filter(t=>t.assigneeId===volId&&t.due===day).forEach(t=>{
      results.push({ type:'task', label:`Task: ${t.title}`, time:'', nav:'depts' });
    });
    return results;
  };

  /* ── New: filters, view toggle, add-availability form ── */
  const { can } = usePerm();
  const canEdit = can('availability.edit');
  const [view, setView] = useState(() => { try { return localStorage.getItem('vk_avail_view') || 'cards'; } catch { return 'cards'; } });
  const setViewSaved = v => { setView(v); try { localStorage.setItem('vk_avail_view', v); } catch {} };
  const [q, setQ] = useState('');
  const [fCity, setFCity] = useState('');
  const [fArea, setFArea] = useState('');
  const [fDept, setFDept] = useState('');
  const [fDay, setFDay] = useState('');
  const [formFor, setFormFor] = useState(null); // null | 'new' | volunteer object

  const norm = s => (s || '').trim().toLowerCase();
  const cities = [...new Set(vols.map(v => (v.city || '').trim()).filter(Boolean))].sort();
  const areas  = [...new Set(vols.filter(v => !fCity || norm(v.city) === norm(fCity)).map(v => (v.area || '').trim()).filter(Boolean))].sort();
  const isUnsetFn = volId => !getPreEvent(volId).checked && !eventDays.some(d => getAvail(volId, d).checked);
  const isAvailOn = (volId, d) => d === 'pre-event' ? !!getPreEvent(volId).checked : !!getAvail(volId, d).checked;
  const shownVols = vols.filter(v =>
    (!q || [v.name, v.phone, v.city, v.area].some(x => norm(x).includes(norm(q)))) &&
    (!fCity || norm(v.city) === norm(fCity)) &&
    (!fArea || norm(v.area) === norm(fArea)) &&
    (!fDept || getDeptIds(v.id).includes(fDept)) &&
    (!fDay || (fDay === 'unset' ? (eventDays.length > 0 && isUnsetFn(v.id)) : isAvailOn(v.id, fDay))));
  const anyFilter = q || fCity || fArea || fDept || fDay;
  const dayLabel = d => d.state === 'full' ? 'Full day' : d.state === 'time' ? d.text : '—';
  const dayState = (volId, day) => {
    const a = getAvail(volId, day);
    if (!a.checked) return { state: 'off' };
    if (a.fullDay) return { state: 'full' };
    const s = availSlots(a);
    return { state: 'time', text: s.length ? slotsText(s) : 'Available' };
  };
  /* ── Merged directory features: profile add/edit/delete, import, detail panel ── */
  const { profile: myProfile } = useAuth();
  const [volModal, setVolModal] = useState(null);   // {type:'add'} | {type:'edit', vol}
  const [detailId, setDetailId] = useState(null);
  const [delVol, setDelVol] = useState(null);
  const [importing, setImporting] = useState(false);
  const noDays = !eventDays.length;
  const canAddVol = can('people.add'), canEditVol = can('people.edit'), canDelVol = can('people.delete');
  const isUnset = volId => !getPreEvent(volId).checked && !eventDays.some(d => getAvail(volId, d).checked);

  async function downloadSample() {
    const XLSX = await import('xlsx');
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([
      ['Name','Contact','City','Area','Skills','Pre Event','Event Days','Time Slot','Departments'],
      ['Raj Doshi','9876543210','Mumbai','Mulund','POC, Hospitality','Yes','16,17,18','Full Day','POC Team'],
      ['Priya Shah','9876543211','Thane','Ghodbunder','Logistics','No','17-19','10:00-14:00','Logistics'],
      ['Amit Mehta','9876543212','Mumbai','Borivali','POC','No','16,17','09:00-13:00, 17:00-22:00','POC Team'],
    ]);
    ws['!cols'] = [{wch:18},{wch:14},{wch:12},{wch:14},{wch:18},{wch:10},{wch:12},{wch:12},{wch:18}];
    XLSX.utils.book_append_sheet(wb, ws, 'Volunteers');
    XLSX.writeFile(wb, 'VK_Volunteers_Sample.xlsx');
  }

  /* Import: creates/updates profiles, and (if the sheet has Event Days / Time Slot / Pre Event /
     Departments columns) the availability for the CURRENT event. Existing profiles are never blanked. */
  async function handleImport(file) {
    if (!file) return;
    setImporting(true);
    try {
      const XLSX = await import('xlsx');
      const wb = XLSX.read(await file.arrayBuffer());
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
      const pick = (row, ...keys) => {
        const map = Object.fromEntries(Object.keys(row).map(k => [k.toLowerCase().replace(/[^a-z]/g, ''), row[k]]));
        for (const k of keys) { const v = map[k]; if (v !== undefined && String(v).trim() !== '') return String(v).trim(); }
        return '';
      };
      const dayNum = d => parseInt(d.slice(8, 10), 10);
      const parseDays = txt => {
        const t = txt.toLowerCase();
        if (!t) return [];
        if (/\ball\b/.test(t)) return [...eventDays];
        const nums = new Set();
        t.replace(/(\d{1,2})\s*(?:-|–|to)\s*(\d{1,2})/g, (m, a, b) => { for (let n = +a; n <= +b; n++) nums.add(n); return ''; })
         .replace(/\d{1,2}/g, m => { nums.add(+m); return ''; });
        return eventDays.filter(d => nums.has(dayNum(d)));
      };
      /* Time Slot cell → slots. "9-13, 17-22", "morning & evening", "Full Day" … */
      const parseSlot = txt => {
        const full = { fullDay:true, ...slotFields([{ start: fdConfig.start || '09:00', end: fdConfig.end || '22:00' }]) };
        const t = txt.toLowerCase();
        if (!t.trim() || /full/.test(t)) return full;
        const hhmm = (h, m) => `${String(h).padStart(2,'0')}:${m||'00'}`;
        const slots = [];
        t.replace(/(\d{1,2})[:.]?(\d{2})?\s*(?:-|–|to)\s*(\d{1,2})[:.]?(\d{2})?/g, (_, h1, m1, h2, m2) => {
          slots.push({ start: hhmm(h1, m1), end: hhmm(h2, m2) }); return '';
        });
        if (!slots.length) {
          if (t.includes('morning')) slots.push(presetSlot('morning'));
          if (t.includes('evening')) slots.push(presetSlot('evening'));
        }
        if (!slots.length) return full;
        return { fullDay:false, ...slotFields(slots.slice(0, MAX_SLOTS)) };
      };
      let added = 0, updated = 0, skipped = 0, availRows = [];
      const known = [...vols];
      for (const row of rows) {
        const name = pick(row, 'name', 'volunteername', 'fullname');
        if (!name) { skipped++; continue; }
        const fields = { phone: pick(row, 'contact', 'phone', 'mobile', 'number'), city: pick(row, 'city'), area: pick(row, 'area', 'location'), skills: pick(row, 'skills', 'skill', 'expertise') };
        let vol = known.find(v => (v.name || '').trim().toLowerCase() === name.toLowerCase());
        if (vol) {
          const fill = Object.fromEntries(Object.entries(fields).filter(([k, v]) => v && !vol[k]));
          if (Object.keys(fill).length) { await saveItem('volunteers', { ...vol, ...fill }); updated++; }
        } else {
          const id = await saveItem('volunteers', { name, ...fields });
          vol = { id, name, ...fields }; known.push(vol); added++;
        }
        if (!activeEventId || noDays) continue;
        const days = parseDays(pick(row, 'eventdays', 'days', 'availabledays'));
        const slot = parseSlot(pick(row, 'timeslot', 'time', 'shift', 'availability'));
        days.forEach(day => availRows.push({ id:`${vol.id}_${day}_${activeEventId}`, volId:vol.id, day, eventId:activeEventId, checked:true, ...slot }));
        const pre = pick(row, 'preevent', 'beforeevent');
        if (pre && !/^(no|n|false|0)$/i.test(pre)) availRows.push({ id:`${vol.id}_pre-event_${activeEventId}`, volId:vol.id, day:'pre-event', eventId:activeEventId, checked:true, remark: /^(yes|y|true|1)$/i.test(pre) ? '' : pre });
        const dNames = pick(row, 'departments', 'department', 'dept').split(/[,;/]/).map(x => x.trim().toLowerCase()).filter(Boolean);
        const dIds = depts.filter(d => dNames.includes((d.name || '').toLowerCase())).map(d => d.id);
        if (dIds.length) availRows.push({ id:`${vol.id}_depts_${activeEventId}`, volId:vol.id, day:'depts', eventId:activeEventId, deptIds:[...new Set([...getDeptIds(vol.id), ...dIds])] });
      }
      if (availRows.length) await batchUpsert('availability', availRows);
      toast(`Import done — ${added} added, ${updated} updated${skipped ? `, ${skipped} skipped` : ''}${availRows.length ? `, availability set for this event` : ''}.`);
    } catch (e) { toast('Import failed: ' + e.message); }
    setImporting(false);
  }

  async function deleteVolunteer(vol) {
    const vAvail = avail.filter(a => a.volId === vol.id);
    const allAvail = (store.availability || []).filter(a => a.volId === vol.id);
    const vPocs = (store.poc || []).filter(p => p.volunteerId === vol.id);
    const vTasks = (store.tasks || []).filter(t => t.assigneeId === vol.id);
    const linked = [...new Map([...vAvail, ...allAvail].map(a => [a.id, a])).values()].map(a => ({ collection: 'availability', data: a }));
    await trashItem('volunteers', vol, linked, myProfile?.email || '');
    for (const { data } of linked) await removeItem('availability', data.id);
    for (const p of vPocs) await saveItem('poc', { ...p, volunteerId: null, status: 'Unassigned' });
    for (const t of vTasks) await saveItem('tasks', { ...t, assigneeId: null });
    await removeItem('volunteers', vol.id);
    toast(`${vol.name} moved to trash.${vPocs.length ? ` ${vPocs.length} POC slot${vPocs.length > 1 ? 's' : ''} now need someone new.` : ''}`);
  }

  const eventName = (store.events||[]).find(e=>e.id===activeEventId)?.name || 'this event';
  return (
    <>
      <div className="page-head">
        <div className="ph-txt">
          <h1>Volunteers</h1>
          <p>Your volunteer directory, with each person's availability for {eventName}. Profiles apply to all events; availability is per event.</p>
        </div>
        <div className="vol-actions">
          <button className="btn sm" onClick={downloadSample} title="Download a sample Excel sheet">⬇ Sample</button>
          {canAddVol && (
            <label className="btn sm" style={{ cursor: 'pointer', margin: 0 }} title="Import from Excel">
              {ICON.upload}{importing ? 'Importing…' : 'Import'}
              <input type="file" accept=".xlsx,.xls,.csv" style={{ display: 'none' }} disabled={importing}
                onChange={e => { if (e.target.files[0]) handleImport(e.target.files[0]); e.target.value = ''; }} />
            </label>
          )}
          {canEdit && !noDays && vols.length > 0 && <button className="btn sm" onClick={() => setFormFor('new')}>{ICON.cal}Add availability</button>}
          {canAddVol && <button className="btn primary sm" onClick={() => setVolModal({ type: 'add' })}>{ICON.plus}Add volunteer</button>}
        </div>
      </div>

      {noDays && vols.length > 0 && <div className="mtg-note">This event has no start/end dates yet, so availability can't be recorded. Edit the event to add its dates.</div>}
      {!vols.length && <div className="panel"><Empty title="No volunteers yet" sub="Add volunteers one by one, or import an Excel sheet (download the sample for the column format)." /></div>}

      {vols.length > 0 && <div className="av-filters">
        <SearchBox value={q} onChange={setQ} />
        <select className="statsel" value={fCity} onChange={e => { setFCity(e.target.value); setFArea(''); }} aria-label="City">
          <option value="">All cities</option>{cities.map(c => <option key={c}>{c}</option>)}
        </select>
        <select className="statsel" value={fArea} onChange={e => setFArea(e.target.value)} aria-label="Area" disabled={!areas.length}>
          <option value="">All areas</option>{areas.map(a => <option key={a}>{a}</option>)}
        </select>
        <select className="statsel" value={fDept} onChange={e => setFDept(e.target.value)} aria-label="Department">
          <option value="">All departments</option>{depts.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
        <select className="statsel" value={fDay} onChange={e => setFDay(e.target.value)} aria-label="Available on">
          <option value="">Any day</option>
          {!noDays && <option value="unset">Availability not set</option>}
          <option value="pre-event">Pre-event</option>
          {eventDays.map(d => <option key={d} value={d}>{shortDate(d)}</option>)}
        </select>
        {anyFilter && <button className="btn ghost sm" onClick={() => { setQ(''); setFCity(''); setFArea(''); setFDept(''); setFDay(''); }}>Clear</button>}
        <span className="muted-sm av-count">{shownVols.length} of {vols.length}</span>
        <div className="seg hide-sm" role="group" aria-label="View">
          <button className={view === 'cards' ? 'on' : ''} onClick={() => setViewSaved('cards')}>Cards</button>
          <button className={view === 'list' ? 'on' : ''} onClick={() => setViewSaved('list')}>List</button>
          {!noDays && <button className={view === 'grid' ? 'on' : ''} onClick={() => setViewSaved('grid')}>Grid</button>}
        </div>
      </div>}

      {vols.length > 0 && !shownVols.length && <div className="panel"><Empty title="No volunteers match" sub="Change or clear the filters above." /></div>}

      {(view === 'cards' || (view === 'grid' && noDays) || window.matchMedia?.('(max-width: 900px)').matches) && shownVols.length > 0 && (
        <div className="av-grid">
          {shownVols.map(v => {
            const deptIds = getDeptIds(v.id);
            const pre = getPreEvent(v.id);
            const nDays = eventDays.filter(d => getAvail(v.id, d).checked).length;
            return (
              <div className="av-card clickable" key={v.id} role="button" tabIndex={0}
                onClick={() => setDetailId(v.id)} onKeyDown={e => { if (e.key === 'Enter') setDetailId(v.id); }}>
                <div className="av-head">
                  <div style={{ minWidth: 0 }}>
                    <div className="nm">{v.name}</div>
                    <div className="muted-sm av-sub">{[v.area, v.city].filter(Boolean).join(', ') || 'No location'}{v.phone ? ` · ${v.phone}` : ''}</div>
                    {v.skills && <div className="muted-sm av-sub">Skills: {v.skills}</div>}
                  </div>
                  {!noDays && isUnset(v.id) && <span className="badge b-pending">Not set for this event</span>}
                </div>
                <div className="av-depts">
                  {deptIds.length ? deptIds.map(id => <span key={id} className="badge b-type">{depts.find(d => d.id === id)?.name || '—'}</span>)
                                  : <span className="muted-sm">No department</span>}
                </div>
                {!noDays && <div className="av-days">
                  <div className={'av-day' + (pre.checked ? ' on' : '')} title={pre.remark || ''}>
                    <span className="av-d">Pre-event</span><span className="av-t">{pre.checked ? (pre.remark || 'Yes') : '—'}</span>
                  </div>
                  {eventDays.map(day => {
                    const st = dayState(v.id, day);
                    const asg = getAssignments(v.id, day);
                    return (
                      <div key={day} className={'av-day' + (st.state !== 'off' ? ' on' : '')}
                        title={asg.map(a => a.label + (a.time ? ' ' + a.time : '')).join('\n')}>
                        <span className="av-d">{shortDate(day)}</span>
                        <span className="av-t">{dayLabel(st)}</span>
                        {asg.length > 0 && <span className="av-asg">{asg.length} assigned</span>}
                      </div>
                    );
                  })}
                </div>}
                {!noDays && <div className="muted-sm" style={{ marginTop: 6 }}>{nDays} of {eventDays.length} event days</div>}
              </div>
            );
          })}
        </div>
      )}

      {view === 'list' && !window.matchMedia?.('(max-width: 900px)').matches && shownVols.length > 0 && (
        <div className="panel"><div className="panel-body">
          <table>
            <thead><tr><th>Name</th><th>Contact</th><th>City</th><th>Area</th><th>Departments</th><th>This event</th><th></th></tr></thead>
            <tbody>
              {shownVols.map(v => {
                const nDays = eventDays.filter(d => getAvail(v.id, d).checked).length;
                return (
                  <tr key={v.id} style={{ cursor: 'pointer' }} onClick={() => setDetailId(v.id)}>
                    <td><div className="person"><div className="avatar" style={{ width: 30, height: 30, fontSize: 11 }}>{initials(v.name)}</div><div><div className="nm">{v.name}</div>{v.skills && <div className="role">{v.skills}</div>}</div></div></td>
                    <td className="muted-sm">{v.phone || '—'}</td>
                    <td className="muted-sm">{v.city || '—'}</td>
                    <td className="muted-sm">{v.area || '—'}</td>
                    <td className="muted-sm">{getDeptIds(v.id).map(id => depts.find(d => d.id === id)?.name).filter(Boolean).join(', ') || '—'}</td>
                    <td>{noDays ? '—' : isUnset(v.id) ? <span className="badge b-pending">Not set</span> : <span className="muted-sm">{nDays} of {eventDays.length} days{getPreEvent(v.id).checked ? ' + pre-event' : ''}</span>}</td>
                    <td><div className="rowacts" onClick={e => e.stopPropagation()}>
                      {canEditVol && <button className="btn ghost xs" aria-label="Edit profile" onClick={() => setVolModal({ type: 'edit', vol: v })}>{ICON.edit}</button>}
                      {canDelVol && <button className="btn ghost xs" aria-label="Delete volunteer" onClick={() => setDelVol(v)}>{ICON.trash}</button>}
                    </div></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div></div>
      )}

      {view === 'grid' && !noDays && !window.matchMedia?.('(max-width: 900px)').matches && shownVols.length > 0 && (
      <div className="panel">
        <div className="panel-body" style={{overflowX:'auto'}}>
          <fieldset disabled={!canEdit} style={{border:0,padding:0,margin:0,minWidth:0}}>
          <table style={{borderCollapse:'collapse',fontSize:12.5,width:'100%',minWidth:360+eventDays.length*170}}>
            <thead>
              <tr style={{background:'var(--teal-wash)'}}>
                <th style={{padding:'8px 12px',textAlign:'left',minWidth:160,position:'sticky',left:0,background:'var(--teal-wash)',zIndex:2}}>Volunteer</th>
                <th style={{padding:'8px 12px',textAlign:'left',minWidth:180}}>Departments</th>
                <th style={{padding:'8px 10px',textAlign:'center',minWidth:150,background:'#EAF7F1'}}>Pre-event</th>
                {eventDays.map(day=>(
                  <th key={day} style={{padding:'8px 10px',textAlign:'center',minWidth:170,whiteSpace:'nowrap'}}>
                    <div style={{fontWeight:600}}>{fmtDate(day)}</div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shownVols.map((v,vi)=>{
                const preEv  = getPreEvent(v.id);
                const deptIds = getDeptIds(v.id);
                return (
                  <tr key={v.id} style={{borderBottom:'1px solid var(--line)',background:vi%2===0?'#fff':'#fafaf7'}}>
                    {/* Name */}
                    <td style={{padding:'8px 12px',position:'sticky',left:0,background:vi%2===0?'#fff':'#fafaf7',zIndex:1}}>
                      <div style={{fontWeight:500}}>{v.name}</div>
                      {v.phone&&<div style={{fontSize:11,color:'var(--muted)'}}>{v.phone}</div>}
                    </td>
                    {/* Departments */}
                    <td style={{padding:'6px 10px',verticalAlign:'top'}}>
                      <div style={{display:'flex',flexDirection:'column',gap:3}}>
                        {depts.map(d=>(
                          <label key={d.id} style={{display:'flex',alignItems:'center',gap:5,fontSize:11.5,cursor:'pointer'}}>
                            <input type="checkbox" checked={deptIds.includes(d.id)}
                              onChange={e=>setDeptIds(v.id,d.id,e.target.checked)}
                              style={{accentColor:'var(--teal)'}}/>
                            {d.name}
                          </label>
                        ))}
                        {!depts.length&&<span style={{color:'var(--faint)',fontSize:11}}>No depts</span>}
                      </div>
                    </td>
                    {/* Pre-event */}
                    <td style={{padding:'6px 8px',textAlign:'center',background:'#EAF7F1',verticalAlign:'top'}}>
                      <label style={{display:'flex',alignItems:'center',justifyContent:'center',gap:4,marginBottom:4,cursor:'pointer'}}>
                        <input type="checkbox" checked={!!preEv.checked}
                          onChange={e=>setPreEvent(v.id,'checked',e.target.checked)}
                          style={{accentColor:'var(--teal)'}}/>
                        <span style={{fontSize:11.5}}>Available</span>
                      </label>
                      {preEv.checked&&(
                        <input className="input" style={{fontSize:11,padding:'2px 6px',width:'100%'}}
                          placeholder="e.g. 10–15 Sep evenings"
                          defaultValue={preEv.remark||''}
                          onBlur={e=>setPreEvent(v.id,'remark',e.target.value)}/>
                      )}
                    </td>
                    {/* Event days */}
                    {eventDays.map(day=>{
                      const a = getAvail(v.id, day);
                      const assignments = getAssignments(v.id, day);
                      return (
                        <td key={day} style={{padding:'6px 8px',verticalAlign:'top'}}>
                          {/* Available checkbox */}
                          <label style={{display:'flex',alignItems:'center',gap:4,marginBottom:4,cursor:'pointer'}}>
                            <input type="checkbox" checked={!!a.checked}
                              onChange={e=>setDayAvail(v.id,day,'checked',e.target.checked)}
                              style={{accentColor:'var(--teal)'}}/>
                            <span style={{fontSize:11}}>Available</span>
                          </label>
                          {a.checked&&(<>
                            {/* Full Day checkbox */}
                            <label style={{display:'flex',alignItems:'center',gap:4,marginBottom:4,cursor:'pointer'}}>
                              <input type="checkbox" checked={!!a.fullDay}
                                onChange={e=>setFullDay(v.id,day,e.target.checked)}
                                style={{accentColor:'var(--teal)'}}/>
                              <span style={{fontSize:11}}>Full Day</span>
                            </label>
                            {/* Time slots (up to MAX_SLOTS) */}
                            {!a.fullDay&&<SlotEditor slots={rawSlots(a)} onChange={sl=>setDaySlots(v.id,day,sl)}/>}
                            {/* Show availability window(s) */}
                            {availSlots(a).length>0&&(
                              <div style={{fontSize:10.5,color:'var(--teal)',fontWeight:500,marginBottom:3}}>
                                {slotsText(availSlots(a))}
                              </div>
                            )}
                          </>)}
                          {/* Assignment badges */}
                          {assignments.map((asgn,i)=>(
                            <div key={i}
                              style={{fontSize:10,padding:'2px 5px',borderRadius:6,marginTop:2,cursor:'pointer',
                                background:asgn.type==='poc'?'var(--teal-wash)':'var(--amber-wash)',
                                color:asgn.type==='poc'?'var(--teal)':'var(--amber)',
                                border:`1px solid ${asgn.type==='poc'?'var(--teal)':'#E8D5A3'}`,
                                whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}
                              title={`${asgn.label}${asgn.time?' '+asgn.time:''} — click to navigate`}
                              onClick={()=>{ if(window.__jyotGo) window.__jyotGo(asgn.nav); }}>
                              🔗 {asgn.label}{asgn.time?` ${asgn.time}`:''}
                            </div>
                          ))}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
          </fieldset>
        </div>
      </div>
      )}

      {volModal && <VolModal item={volModal.type === 'edit' ? volModal.vol : null} vols={vols} toast={toast}
        canSetAvailability={canEdit && !noDays} onNext={v => setFormFor(v)} onClose={() => setVolModal(null)} />}
      {delVol && <DeleteModal label={delVol.name} onClose={() => setDelVol(null)}
        onConfirm={async () => { const v = delVol; setDelVol(null); setDetailId(null); await deleteVolunteer(v); }} />}
      {detailId && vols.find(v => v.id === detailId) && (
        <VolunteerDetail vol={vols.find(v => v.id === detailId)} depts={depts} eventDays={eventDays} noDays={noDays}
          getAvail={getAvail} getPreEvent={getPreEvent} getDeptIds={getDeptIds} getAssignments={getAssignments}
          setDayAvail={setDayAvail} setFullDay={setFullDay} setDaySlots={setDaySlots} setPreEvent={setPreEvent} setDeptIds={setDeptIds}
          canEditAvail={canEdit} canEditVol={canEditVol} canDelVol={canDelVol} eventName={eventName}
          onEditProfile={v => setVolModal({ type: 'edit', vol: v })} onDelete={v => setDelVol(v)}
          onClose={() => setDetailId(null)} />
      )}
      {formFor && (
        <AvailabilityForm vols={vols} depts={depts} eventDays={eventDays} activeEventId={activeEventId}
          fdConfig={fdConfig} editVol={formFor === 'new' ? null : formFor}
          getAvail={getAvail} getPreEvent={getPreEvent} getDeptIds={getDeptIds}
          onClose={() => setFormFor(null)} toast={toast} />
      )}
    </>
  );
}

export const VolunteerAvailability = Volunteers;

/* ── Volunteer detail: profile (all events) + this event's availability, editable per day ── */
function VolunteerDetail({ vol, depts, eventDays, noDays, getAvail, getPreEvent, getDeptIds, getAssignments,
  setDayAvail, setFullDay, setDaySlots, setPreEvent, setDeptIds, canEditAvail, canEditVol, canDelVol, eventName, onEditProfile, onDelete, onClose }) {
  const pre = getPreEvent(vol.id);
  const deptIds = getDeptIds(vol.id);
  return (
    <Modal title={vol.name} onClose={onClose} footer={null}>
      <div className="vd-section">
        <div className="vd-head"><h3>Profile</h3><span className="muted-sm">applies to all events</span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            {canEditVol && <button className="btn sm" onClick={() => onEditProfile(vol)}>{ICON.edit}Edit</button>}
            {canDelVol && <button className="btn sm danger" onClick={() => onDelete(vol)}>{ICON.trash}Delete</button>}
          </div>
        </div>
        <div className="vd-grid">
          <div><span>Contact</span>{vol.phone ? <a href={`tel:${vol.phone}`}>{vol.phone}</a> : '—'}</div>
          <div><span>City</span>{vol.city || '—'}</div>
          <div><span>Area</span>{vol.area || '—'}</div>
          <div><span>Skills</span>{vol.skills || '—'}</div>
        </div>
      </div>

      <div className="vd-section">
        <div className="vd-head"><h3>{eventName}</h3><span className="muted-sm">availability for this event</span></div>
        {noDays ? <p className="muted-sm">This event has no dates yet. Add start and end dates to the event first.</p> : (
          <fieldset disabled={!canEditAvail} className="vd-fieldset">
            <div className="vd-day">
              <label className="vd-on"><input type="checkbox" checked={!!pre.checked} onChange={e => setPreEvent(vol.id, 'checked', e.target.checked)} /><b>Pre-event</b></label>
              {pre.checked && <input className="input vd-remark" key={'pre' + (pre.remark || '')} defaultValue={pre.remark || ''} placeholder="Note, e.g. weekday evenings"
                onBlur={e => { if (e.target.value !== (pre.remark || '')) setPreEvent(vol.id, 'remark', e.target.value); }} />}
            </div>
            {eventDays.map(day => {
              const a = getAvail(vol.id, day);
              const asg = getAssignments(vol.id, day);
              return (
                <div className="vd-day" key={day}>
                  <label className="vd-on"><input type="checkbox" checked={!!a.checked} onChange={e => setDayAvail(vol.id, day, 'checked', e.target.checked)} /><b>{shortDate(day)}</b></label>
                  {a.checked ? (
                    <div className="vd-times">
                      <label className="vd-full"><input type="checkbox" checked={!!a.fullDay} onChange={e => setFullDay(vol.id, day, e.target.checked)} />Full day</label>
                      {!a.fullDay && <SlotEditor slots={rawSlots(a)} onChange={sl => setDaySlots(vol.id, day, sl)} />}
                      {a.fullDay && <span className="muted-sm">{a.start}–{a.end}</span>}
                    </div>
                  ) : <span className="muted-sm">Not available</span>}
                  {asg.length > 0 && (
                    <div className="vd-asg">
                      {asg.map((x, i) => <button type="button" key={i} className="vd-asg-chip" onClick={() => { onClose(); window.__jyotGo && window.__jyotGo(x.nav); }}>
                        {x.label}{x.time ? ` · ${x.time}` : ''}</button>)}
                    </div>
                  )}
                </div>
              );
            })}
            <div className="vd-head" style={{ marginTop: 14 }}><h3>Departments</h3></div>
            <div className="av-chips">
              {depts.map(d => <button type="button" key={d.id} className={'av-chip' + (deptIds.includes(d.id) ? ' on' : '')}
                onClick={() => setDeptIds(vol.id, d.id, !deptIds.includes(d.id))}>{d.name}</button>)}
              {!depts.length && <span className="muted-sm">No departments yet.</span>}
            </div>
          </fieldset>
        )}
        <p className="muted-sm" style={{ margin: '12px 0 0' }}>Changes here save immediately.</p>
      </div>
    </Modal>
  );
}

/* ── Add / edit availability: pick volunteers by city → area, then days, time and departments ── */
function AvailabilityForm({ vols, depts, eventDays, activeEventId, fdConfig, editVol, getAvail, getPreEvent, getDeptIds, onClose, toast }) {
  const single = !!editVol;
  const norm = s => (s || '').trim().toLowerCase();
  const [city, setCity] = useState('');
  const [area, setArea] = useState('');
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState(() => new Set(single ? [editVol.id] : []));
  const [mode, setMode] = useState('available');
  const [days, setDays] = useState(() => new Set(single ? eventDays.filter(d => getAvail(editVol.id, d).checked) : []));
  const [pre, setPre] = useState(() => single ? !!getPreEvent(editVol.id).checked : false);
  const [preRemark, setPreRemark] = useState(() => single ? (getPreEvent(editVol.id).remark || '') : '');
  /* Time per day. `common` is used while "Same time for all days" is on; `perDay[day]` otherwise.
     Editing one volunteer loads each day's own saved slots. */
  const [init] = useState(() => {
    const perDay = {};
    if (single) eventDays.forEach(d => { const c = choiceFromRecord(getAvail(editVol.id, d)); if (c) perDay[d] = c; });
    const vals = Object.values(perDay);
    return { perDay, common: vals[0] || { shift: 'full', slots: [] }, same: vals.every(c => sameChoice(c, vals[0], fdConfig)) };
  });
  const [common, setCommon] = useState(init.common);
  const [perDay, setPerDay] = useState(init.perDay);
  const [sameAll, setSameAll] = useState(init.same);
  const choiceFor = d => (sameAll ? common : (perDay[d] || common));
  const tickedDays = eventDays.filter(d => days.has(d));
  function toggleSame(on) {
    // Turning it off starts every day from the shared time, so only the days that differ need changing
    if (!on) setPerDay(Object.fromEntries(eventDays.map(d => [d, common])));
    else if (tickedDays.length) setCommon(choiceFor(tickedDays[0]));
    setSameAll(on);
  }
  const [deptIds, setDeptIds] = useState(() => new Set(single ? getDeptIds(editVol.id) : []));
  const [deptMode, setDeptMode] = useState(single ? 'replace' : 'add');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const cities = [...new Set(vols.map(v => (v.city || '').trim()).filter(Boolean))].sort();
  const areas = [...new Set(vols.filter(v => !city || norm(v.city) === norm(city)).map(v => (v.area || '').trim()).filter(Boolean))].sort();
  const list = vols.filter(v => (!city || norm(v.city) === norm(city)) && (!area || norm(v.area) === norm(area)) && (!q || norm(v.name).includes(norm(q))));
  const allShownPicked = list.length > 0 && list.every(v => picked.has(v.id));
  const toggle = (setFn, id) => setFn(p => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });

  async function save() {
    setErr('');
    if (!picked.size) { setErr('Choose at least one volunteer.'); return; }
    if (single || mode === 'available') {
      const checkDays = sameAll ? (tickedDays.length ? [tickedDays[0]] : []) : tickedDays;
      for (const d of checkDays) {
        const e = slotsError(choiceSlots(choiceFor(d), fdConfig));
        if (e) { setErr(sameAll ? e : `${shortDate(d)}: ${e}`); return; }
      }
    }
    const rows = [];
    for (const volId of picked) {
      // In single-volunteer edit, the day chips are the full picture: unticked days become unavailable
      const dayList = single ? eventDays : [...days];
      for (const day of dayList) {
        const on = single ? days.has(day) : mode === 'available';
        const ex = getAvail(volId, day);
        if (single && !on && !ex.checked) continue;
        const ch = choiceFor(day);
        rows.push({ ...ex, id: ex.id || `${volId}_${day}_${activeEventId}`, volId, day, eventId: activeEventId,
          checked: on, fullDay: on && ch.shift === 'full', ...(on ? slotFields(choiceSlots(ch, fdConfig)) : {}) });
      }
      if (single || pre) {
        const ex = getPreEvent(volId);
        const on = single ? pre : mode === 'available';
        if (!(single && !on && !ex.checked)) {
          rows.push({ ...ex, id: ex.id || `${volId}_pre-event_${activeEventId}`, volId, day: 'pre-event', eventId: activeEventId,
            checked: on, remark: on ? preRemark : (ex.remark || '') });
        }
      }
      if (single || deptIds.size) {
        const current = getDeptIds(volId);
        const next = deptMode === 'replace' ? [...deptIds] : [...new Set([...current, ...deptIds])];
        rows.push({ id: `${volId}_depts_${activeEventId}`, volId, day: 'depts', eventId: activeEventId, deptIds: next });
      }
    }
    if (!rows.length) { setErr('Pick at least one day, Pre-event, or a department.'); return; }
    setBusy(true);
    try {
      await batchUpsert('availability', rows);
      toast(single ? `Availability saved for ${editVol.name}.` : `Availability saved for ${picked.size} volunteer${picked.size > 1 ? 's' : ''}.`);
      onClose();
    } catch (e) { setErr('Could not save: ' + (e.code || e.message)); setBusy(false); }
  }

  return (
    <Modal title={single ? `Availability — ${editVol.name}` : 'Add availability'} onClose={onClose} onSave={busy ? null : save} saveLabel={busy ? 'Saving…' : 'Save'}>
      {err && <div className="av-err">{err}</div>}

      {!single && <>
        <div className="av-step">1. Volunteers</div>
        <div className="grid2">
          <Field label="City">
            <select className="input" value={city} onChange={e => { setCity(e.target.value); setArea(''); }}>
              <option value="">All cities</option>{cities.map(c => <option key={c}>{c}</option>)}
            </select>
          </Field>
          <Field label="Area (optional)">
            <select className="input" value={area} onChange={e => setArea(e.target.value)} disabled={!areas.length}>
              <option value="">All areas</option>{areas.map(a => <option key={a}>{a}</option>)}
            </select>
          </Field>
        </div>
        <div className="av-pick-head">
          <input className="input" placeholder="Search name…" value={q} onChange={e => setQ(e.target.value)} />
          <button className="btn sm" type="button" disabled={!list.length}
            onClick={() => setPicked(p => { const n = new Set(p); list.forEach(v => allShownPicked ? n.delete(v.id) : n.add(v.id)); return n; })}>
            {allShownPicked ? 'Clear shown' : `Select all ${list.length}`}
          </button>
        </div>
        <div className="av-pick">
          {list.map(v => (
            <label key={v.id} className={'av-pick-row' + (picked.has(v.id) ? ' on' : '')}>
              <input type="checkbox" checked={picked.has(v.id)} onChange={() => toggle(setPicked, v.id)} />
              <span className="nm">{v.name}</span>
              <span className="muted-sm">{[v.area, v.city].filter(Boolean).join(', ')}</span>
            </label>
          ))}
          {!list.length && <div className="muted-sm" style={{ padding: 10 }}>No volunteers in this city/area.</div>}
        </div>
        <div className="muted-sm" style={{ margin: '6px 0 4px' }}>{picked.size} selected</div>
      </>}

      <div className="av-step">{single ? 'Days available' : '2. Days'}</div>
      {!single && (
        <div className="seg" style={{ marginBottom: 8 }} role="group" aria-label="Mark as">
          <button type="button" className={mode === 'available' ? 'on' : ''} onClick={() => setMode('available')}>Available</button>
          <button type="button" className={mode === 'unavailable' ? 'on' : ''} onClick={() => setMode('unavailable')}>Not available</button>
        </div>
      )}
      <div className="av-chips">
        <button type="button" className={'av-chip' + (pre ? ' on' : '')} onClick={() => setPre(p => !p)}>Pre-event</button>
        {eventDays.map(d => (
          <button type="button" key={d} className={'av-chip' + (days.has(d) ? ' on' : '')} onClick={() => toggle(setDays, d)}>{shortDate(d)}</button>
        ))}
        <button type="button" className="linkbtn" style={{ marginLeft: 4 }}
          onClick={() => setDays(p => p.size === eventDays.length ? new Set() : new Set(eventDays))}>
          {days.size === eventDays.length ? 'Clear days' : 'All days'}
        </button>
      </div>
      {pre && (mode === 'available' || single) && (
        <Field label="Pre-event note (optional)"><input className="input" value={preRemark} onChange={e => setPreRemark(e.target.value)} placeholder="e.g. weekday evenings" /></Field>
      )}

      {(mode === 'available' || single) && <>
        <div className="av-step">{single ? 'Time' : '3. Time'}</div>
        <label className="chk" style={{ marginBottom: 8 }}>
          <input type="checkbox" checked={sameAll} onChange={e => toggleSame(e.target.checked)} />Same time for all days
        </label>
        {sameAll ? <TimeChoice value={common} onChange={setCommon} fd={fdConfig} /> : (
          <div>
            {tickedDays.map(d => (
              <div key={d} style={{ padding: '8px 0', borderTop: '1px solid var(--line)' }}>
                <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 4 }}>{shortDate(d)}</div>
                <TimeChoice value={choiceFor(d)} onChange={c => setPerDay(p => ({ ...p, [d]: c }))} fd={fdConfig} />
              </div>
            ))}
            {!tickedDays.length && <div className="muted-sm">Tick the days above to set a time for each.</div>}
          </div>
        )}
        <p className="muted-sm" style={{ margin: '6px 0 0' }}>Two separate times on one day? Pick Morning + Evening, or Custom → “+ Add slot”.</p>
      </>}

      <div className="av-step">{single ? 'Departments' : '4. Departments (optional)'}</div>
      <div className="av-chips">
        {depts.map(d => <button type="button" key={d.id} className={'av-chip' + (deptIds.has(d.id) ? ' on' : '')} onClick={() => toggle(setDeptIds, d.id)}>{d.name}</button>)}
        {!depts.length && <span className="muted-sm">No departments yet.</span>}
      </div>
      {!single && deptIds.size > 0 && (
        <div className="seg" style={{ marginTop: 8 }} role="group" aria-label="Department mode">
          <button type="button" className={deptMode === 'add' ? 'on' : ''} onClick={() => setDeptMode('add')}>Add to existing</button>
          <button type="button" className={deptMode === 'replace' ? 'on' : ''} onClick={() => setDeptMode('replace')}>Replace</button>
        </div>
      )}
    </Modal>
  );
}

/* ══════════════════════════════════════════════════════════════════
   POC ALLOCATION
   - Requirements collapsed per panelist+day with time window
   - Volunteer cards show mini timeline bar
   - Time-aware assignment
══════════════════════════════════════════════════════════════════ */
/* ── POC Volunteer Card — standalone so it never re-mounts on parent re-render ── */

/* ══════════════════════════════════════════════════════════════════
   POC ALLOCATION — Compact table with day selector + inline dropdown
   Rules:
   - Not available that day → not shown in dropdown
   - Available but assigned elsewhere → shown greyed, not selectable
   - Available and free → shown normally
══════════════════════════════════════════════════════════════════ */
export function POCAllocation({ store, activeEventId }) {
  const toast = useToast();
  const { can } = usePerm();
  const { profile } = useAuth();
  const [selectedDay, setSelectedDay] = useState(null);
  const [confirmAssign, setConfirmAssign] = useState(null);
  const [openDropdown, setOpenDropdown] = useState(null); // req.key
  const [autoOpen, setAutoOpen] = useState(false);
  const [showIssues, setShowIssues] = useState(false);
  const [openGroups, setOpenGroups] = useState(() => new Set());
  const [manualFor, setManualFor] = useState(null);      // issue id with the manual picker open
  const [fixPreview, setFixPreview] = useState(null);    // { title, rows } for Fix all / Fix everything
  const [showIgnored, setShowIgnored] = useState(false);
  const [lastFix, setLastFix] = useState(null);          // { text, snap } — single fix that can be undone
  const [fixBusy, setFixBusy] = useState(false);

  const vols         = store.volunteers || [];
  const avail        = store.availability || [];
  const poc          = store.poc || [];
  const contacts     = (store.contacts||[]).filter(c=>c.status==='Confirmed');
  const depts        = store.departments || [];
  const personalised = store.personalisedSchedule || [];

  // Event days
  const activeEvent = (store.events||[]).find(e=>e.id===activeEventId);
  const eventDays = [];
  if (activeEvent?.startDate && activeEvent?.endDate) {
    let d = new Date(activeEvent.startDate+'T12:00:00');
    const end = new Date(activeEvent.endDate+'T12:00:00');
    while (d <= end && eventDays.length < 20) {
      eventDays.push(localISO(d));
      d = new Date(d); d.setDate(d.getDate()+1);
    }
  }

  // POC dept
  const pocDept = depts.find(d=>d.name.toLowerCase().includes('poc'));
  const pocVols = pocDept
    ? vols.filter(v=>{
        const rec = avail.find(a=>a.volId===v.id&&a.day==='depts'&&a.eventId===activeEventId);
        return (rec?.deptIds||[]).includes(pocDept.id);
      })
    : vols;

  const toMins = t => { if(!t) return 0; const [h,m]=(t||'00:00').split(':'); return parseInt(h)*60+parseInt(m||0); };
  const fromMins = m => `${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`;

  /* A volunteer's slots for a day, plus start/end of the whole span (used only to scale the timeline bar).
     A day can have two separate slots — the gap between them is NOT available. */
  const getVolAvail = (volId, day) => {
    const a = avail.find(x=>x.volId===volId&&x.day===day&&x.eventId===activeEventId);
    const slots = availSlots(a, { start:'09:00', end:'22:00' });
    if (!slots.length) return null;
    return { slots, start: slots[0].start, end: slots[slots.length-1].end };
  };
  // True if from–to (minutes) sits entirely inside ONE of the volunteer's slots
  const withinSlots = (va, from, to) => va.slots.some(x => toMins(x.start) <= from && toMins(x.end) >= to);

  const getVolAssignments = (volId, day) =>
    poc.filter(p=>p.volunteerId===volId&&p.day===day&&p.eventId===activeEventId&&p.fromTime&&p.toTime)
       .map(p=>({from:toMins(p.fromTime),to:toMins(p.toTime),contactId:p.contactId}));

  const getFreeSlots = (volId, day) => {
    const va = getVolAvail(volId, day);
    if (!va) return [];
    const assigned = getVolAssignments(volId, day).sort((a,b)=>a.from-b.from);
    const free = [];
    va.slots.forEach(sl => {
      const start = toMins(sl.start), end = toMins(sl.end);
      let cur = start;
      assigned.forEach(a=>{ if (a.to<=start || a.from>=end) return; if(a.from>cur) free.push({from:cur,to:a.from}); cur=Math.max(cur,a.to); });
      if (cur<end) free.push({from:cur,to:end});
    });
    return free;
  };

  const canCover = (volId, day, fromTime, toTime) => {
    const need = {from:toMins(fromTime), to:toMins(toTime)};
    return getFreeSlots(volId, day).some(s=>s.from<=need.from&&s.to>=need.to);
  };

  // Collapse POC requirements per panelist+day
  const getRequirements = () => {
    const byKey = {};
    personalised
      .filter(r=>r.pocRequired&&r.eventId===activeEventId&&r.date&&r.time&&!r.deleted)
      .forEach(r=>{
        const key=`${r.contactId}_${r.date}`;
        if(!byKey[key]) byKey[key]={contactId:r.contactId,date:r.date,rows:[]};
        byKey[key].rows.push(r);
      });
    return Object.values(byKey).map(g=>{
      const rows = g.rows.sort((a,b)=>a.time>b.time?1:-1);
      const fromTime = rows[0].time;
      const allRows = personalised
        .filter(r=>r.contactId===g.contactId&&r.date===g.date&&r.eventId===activeEventId&&!r.deleted)
        .sort((a,b)=>a.time>b.time?1:-1);
      const lastIdx = allRows.findIndex(r=>r.time===rows[rows.length-1].time&&r.pocRequired);
      const nextRow = allRows[lastIdx+1];
      const toTime = nextRow?.time || fromMins(toMins(rows[rows.length-1].time)+60);
      const contact = contacts.find(c=>c.id===g.contactId);
      return {
        key:`${g.contactId}_${g.date}`,
        contactId:g.contactId,
        contactName:contact?displayName(contact):'—',
        date:g.date, fromTime, toTime,
      };
    }).sort((a,b)=>a.date>b.date?1:a.date<b.date?-1:a.fromTime>b.fromTime?1:-1);
  };

  const requirements = getRequirements();
  const reqDays = [...new Set(requirements.map(r=>r.date))].sort();
  const day = selectedDay || reqDays[0];
  const dayReqs = requirements.filter(r=>r.date===day);

  const getAssignment = (contactId, day) =>
    poc.find(p=>p.contactId===contactId&&p.day===day&&p.eventId===activeEventId);

  async function assignPOC(req, volId) {
    const existing = getAssignment(req.contactId, req.date);
    if (existing?.frozen) { toast('Frozen — unfreeze first.'); return; }
    await writeAssignment(req, volId);
    const vol = vols.find(v=>v.id===volId);
    toast(`${vol?.name||'POC'} assigned — ${req.fromTime}–${req.toTime}`);
    setOpenDropdown(null);
  }

  async function writeAssignment(req, volId) {
    const existing = getAssignment(req.contactId, req.date);
    if (existing?.frozen) return null;
    const vol = vols.find(v=>v.id===volId);
    const contact = contacts.find(c=>c.id===req.contactId);
    const id = existing?.id||crypto.randomUUID();
    await saveItem('poc',{
      id,
      contactId:req.contactId, volunteerId:volId,
      day:req.date, fromTime:req.fromTime, toTime:req.toTime,
      slot:`${req.fromTime}–${req.toTime}`, status:'Active',
      eventId:activeEventId, frozen:false,
    });
    if (contact&&vol) {
      await saveItem('personalisedSchedule',{
        id:`poc_auto_${req.contactId}_${req.date}`,
        contactId:req.contactId, eventId:activeEventId,
        date:req.date, time:req.fromTime,
        event:`POC: ${vol.name}${vol.phone?' — '+vol.phone:''}`,
        pocRequired:false, auto:true,
      });
    }
    return id;
  }

  async function unassignPOC(req) {
    const existing = getAssignment(req.contactId, req.date);
    if (!existing||existing.frozen) { if(existing?.frozen) toast('Frozen — unfreeze first.'); return; }
    await removeItem('poc', existing.id);
    const psRec = personalised.find(r=>r.id===`poc_auto_${req.contactId}_${req.date}`);
    if (psRec) await removeItem('personalisedSchedule', psRec.id);
    toast('POC removed.');
  }

  async function toggleFreeze(req) {
    const existing = getAssignment(req.contactId, req.date);
    if (!existing) return;
    await saveItem('poc',{...existing,frozen:!existing.frozen});
    toast(existing.frozen?'Unfrozen.':'Frozen.');
  }


  /* ══ Warnings: computed live from requirements, assignments, availability and stay dates ══ */
  const maxPerDay = parseInt((store.appConfig||[]).find(c=>c.id==='pocMaxPerDay')?.value) || 3;
  const allContacts = store.contacts || [];
  const logiAll = store.logistics || [];
  const eventPoc = poc.filter(p=>p.eventId===activeEventId);
  const overlaps = (a,b) => toMins(a.fromTime) < toMins(b.toTime) && toMins(b.fromTime) < toMins(a.toTime);
  /* Each issue has a type (decides the automatic fix), the assignment it is about (pocId) and a signature.
     "Ignore" saves the signature on that assignment; if the assignment, the guest's timing or the
     message changes (e.g. the volunteer's hours), the signature no longer matches and the issue comes back. */
  const reqFor = (contactId, d) => requirements.find(r=>r.contactId===contactId && r.date===d) || null;
  const pocById = id => eventPoc.find(p=>p.id===id);
  const allIssues = [];
  const addIssue = (type, day, contactId, text, extra = {}) => {
    const p = extra.pocId ? pocById(extra.pocId) : null;
    const req = reqFor(contactId, day);
    const id = `${type}|${extra.pocId || contactId+'_'+day}|${extra.otherId || ''}`;
    const sig = [text, p?.volunteerId||'', p?.fromTime||'', p?.toTime||'', req?.fromTime||'', req?.toTime||''].join('|');
    allIssues.push({ id, type, sev: POC_ISSUE_SEV[type], day, contactId, key:`${contactId}_${day}`, text,
      pocId: extra.pocId || null, otherId: extra.otherId || null, sig, ignored: !!p && p.ignored?.[id] === sig });
  };
  const cName = id => { const c = allContacts.find(x=>x.id===id); return c ? displayName(c) : 'Unknown guest'; };
  requirements.forEach(r => { if (!getAssignment(r.contactId, r.date)) addIssue('unassigned', r.date, r.contactId, 'No POC assigned'); });
  eventPoc.forEach(p => {
    const vol = vols.find(v=>v.id===p.volunteerId);
    const c = allContacts.find(x=>x.id===p.contactId);
    const at = { pocId: p.id };
    if (!vol) addIssue('vol-missing', p.day, p.contactId, 'Assigned volunteer no longer exists', at);
    if (!c) addIssue('guest-deleted', p.day, p.contactId, 'Guest has been deleted', at);
    else if (c.status !== 'Confirmed') addIssue('guest-status', p.day, p.contactId, `Guest is now ${c.status}`, at);
    const req = reqFor(p.contactId, p.day);
    if (!req) addIssue('not-required', p.day, p.contactId, 'POC is no longer required for this day', at);
    else if (p.fromTime && (p.fromTime !== req.fromTime || p.toTime !== req.toTime)) addIssue('timing', p.day, p.contactId, `Timing changed — now needed ${req.fromTime}–${req.toTime} (assigned ${p.fromTime}–${p.toTime})`, at);
    if (vol) {
      const va = getVolAvail(vol.id, p.day);
      if (!va) addIssue('vol-unavailable', p.day, p.contactId, `${vol.name} is not available on this day`, at);
      else if (p.fromTime && p.toTime && !withinSlots(va, toMins(p.fromTime), toMins(p.toTime))) addIssue('outside-hours', p.day, p.contactId, `Outside ${vol.name}'s hours (${slotsText(va.slots)})`, at);
    }
    const L = logiAll.find(l=>l.contactId===p.contactId) || {};
    if ((L.arrivalDate && p.day < L.arrivalDate) || (L.departureDate && p.day > L.departureDate))
      addIssue('outside-stay', p.day, p.contactId, `Outside guest's stay (${L.arrivalDate||'?'} to ${L.departureDate||'?'})`, at);
  });
  // Double-booking and overload, per volunteer per day
  const byVolDay = {};
  eventPoc.filter(p=>p.fromTime&&p.toTime).forEach(p => { (byVolDay[p.volunteerId+'|'+p.day] = byVolDay[p.volunteerId+'|'+p.day] || []).push(p); });
  Object.values(byVolDay).forEach(list => {
    const vol = vols.find(v=>v.id===list[0].volunteerId);
    list.forEach((a,i) => list.slice(i+1).forEach(b => {
      if (overlaps(a,b)) {
        addIssue('double', a.day, a.contactId, `${vol?.name||'Volunteer'} double-booked with ${cName(b.contactId)}`, { pocId:a.id, otherId:b.id });
        addIssue('double', b.day, b.contactId, `${vol?.name||'Volunteer'} double-booked with ${cName(a.contactId)}`, { pocId:b.id, otherId:a.id });
      }
    }));
    if (list.length > maxPerDay) list.forEach(p => addIssue('over-limit', p.day, p.contactId, `${vol?.name||'Volunteer'} has ${list.length} guests this day (limit ${maxPerDay})`, { pocId:p.id }));
  });
  const issues = allIssues.filter(i=>!i.ignored);
  const ignoredIssues = allIssues.filter(i=>i.ignored);
  const issuesFor = key => issues.filter(i=>i.key===key);
  const badCount = issues.filter(i=>i.sev==='bad').length;

  /* ══ Fixing issues ═══════════════════════════════════════════════
     intentsFor(issue) → what has to change (assign / reassign / retime / remove).
     planFixes(issues) → merges intents per assignment and picks volunteers with the same rules as
     Auto-assign: POC department, free for the whole window inside one slot, not double-booked,
     under the daily limit; prefers the guest's POC from other days, then the least busy.
     Frozen assignments are never changed. */
  function makeLoad(skip) {
    const L = { busy:{}, count:{}, total:{}, chosen:{} };
    eventPoc.forEach(p => {
      if (skip.has(p.id)) return;
      const k = p.volunteerId+'|'+p.day;
      if (p.fromTime&&p.toTime) (L.busy[k] = L.busy[k] || []).push({ fromTime:p.fromTime, toTime:p.toTime });
      L.count[k] = (L.count[k]||0) + 1; L.total[p.volunteerId] = (L.total[p.volunteerId]||0) + 1;
      (L.chosen[p.contactId] = L.chosen[p.contactId] || new Set()).add(p.volunteerId);
    });
    return L;
  }
  // '' if the volunteer can take this window, otherwise why not
  const volBlock = (L, v, r) => {
    const va = getVolAvail(v.id, r.date);
    if (!va) return 'Not available this day';
    if (!withinSlots(va, toMins(r.fromTime), toMins(r.toTime))) return `Hours ${slotsText(va.slots)}`;
    const k = v.id+'|'+r.date;
    if ((L.busy[k]||[]).some(w => overlaps(w, r))) return 'Busy at this time';
    if ((L.count[k]||0) >= maxPerDay) return `Already has ${L.count[k]} guest${L.count[k]>1?'s':''}`;
    return '';
  };
  const bookLoad = (L, volId, r) => {
    const k = volId+'|'+r.date;
    (L.busy[k] = L.busy[k] || []).push({ fromTime:r.fromTime, toTime:r.toTime });
    L.count[k] = (L.count[k]||0) + 1; L.total[volId] = (L.total[volId]||0) + 1;
    (L.chosen[r.contactId] = L.chosen[r.contactId] || new Set()).add(volId);
  };
  function pickVol(L, r, avoidId) {
    const cs = pocVols.filter(v => v.id !== avoidId && !volBlock(L, v, r));
    if (!cs.length) return { volId:'', options:[] };
    const score = v => ((L.chosen[r.contactId]?.has(v.id)) ? 1000 : 0) - 10*(L.count[v.id+'|'+r.date]||0) - (L.total[v.id]||0);
    const best = [...cs].sort((a,b) => score(b) - score(a))[0];
    bookLoad(L, best.id, r);
    return { volId: best.id, options: cs.map(v=>v.id) };
  }
  const moveOrRemove = x => { const r = reqFor(x.contactId, x.day); return r ? { kind:'reassign', target:x.id, p:x, req:r } : { kind:'remove', target:x.id, p:x }; };
  function intentsFor(i) {
    const p = i.pocId ? pocById(i.pocId) : null;
    switch (i.type) {
      case 'unassigned': { const r = reqFor(i.contactId, i.day); return r ? [{ kind:'assign', target:i.key, req:r }] : []; }
      case 'guest-deleted': case 'guest-status': case 'not-required': case 'outside-stay':
        return p ? [{ kind:'remove', target:p.id, p }] : [];
      case 'vol-missing': case 'vol-unavailable': case 'outside-hours':
        return p ? [moveOrRemove(p)] : [];
      case 'timing': { const r = p && reqFor(p.contactId, p.day); return r ? [{ kind:'retime', target:p.id, p, req:r }] : []; }
      case 'double': {
        const o = pocById(i.otherId);
        if (!p) return [];
        if (!o) return [moveOrRemove(p)];
        if (p.frozen && o.frozen) return [{ kind:'blocked', target:p.id, p, reason:'Both guests are frozen on this volunteer — unfreeze one to fix' }];
        // Keep a frozen one; otherwise keep the earlier window and move the later one
        const later = (toMins(p.fromTime) > toMins(o.fromTime) || (p.fromTime === o.fromTime && p.contactId > o.contactId)) ? p : o;
        const move = p.frozen ? o : o.frozen ? p : later;
        return [moveOrRemove(move)];
      }
      case 'over-limit': {
        if (!p) return [];
        const list = eventPoc.filter(x => x.volunteerId===p.volunteerId && x.day===p.day && x.fromTime && x.toTime)
          .sort((a,b) => toMins(a.fromTime) - toMins(b.fromTime));
        const extra = list.length - maxPerDay;
        if (extra <= 0) return [];
        const movable = list.filter(x => !x.frozen).slice(-extra);   // the latest non-frozen guests move
        return movable.length ? movable.map(moveOrRemove) : [{ kind:'blocked', target:p.id, p, reason:'All of this volunteer\'s guests are frozen' }];
      }
      default: return [];
    }
  }
  const FIX_RANK = { remove:4, reassign:3, retime:2, assign:1, blocked:0 };
  function planFixes(list) {
    const byTarget = new Map();
    list.forEach(i => intentsFor(i).forEach(t0 => {
      const t = (t0.p?.frozen && t0.kind !== 'blocked') ? { ...t0, kind:'blocked', reason:'Frozen — unfreeze to fix' } : t0;
      const cur = byTarget.get(t.target);
      if (!cur) byTarget.set(t.target, { ...t, issueIds:[i.id] });
      else if (FIX_RANK[t.kind] > FIX_RANK[cur.kind]) byTarget.set(t.target, { ...t, issueIds:[...cur.issueIds, i.id] });
      else cur.issueIds.push(i.id);
    }));
    const intents = [...byTarget.values()];
    const L = makeLoad(new Set(intents.filter(t => t.kind !== 'assign' && t.kind !== 'blocked').map(t => t.target)));
    const rows = [];
    const add = (t, extra) => rows.push({ key:t.target, kind:t.kind, req:t.req||null, p:t.p||null,
      day:t.req?.date || t.p?.day, contactId:t.req?.contactId || t.p?.contactId, issueIds:t.issueIds, volId:'', options:[], reason:'', ...extra });
    intents.filter(t => t.kind === 'blocked').forEach(t => add(t, { reason:t.reason }));
    intents.filter(t => t.kind === 'remove').forEach(t => add(t, {}));
    const pending = intents.filter(t => t.kind === 'assign' || t.kind === 'reassign');
    intents.filter(t => t.kind === 'retime').forEach(t => {
      const v = vols.find(x => x.id === t.p.volunteerId);
      if (v && !volBlock(L, v, t.req)) { bookLoad(L, v.id, t.req); add(t, { volId:v.id, options:[v.id] }); }
      else pending.push({ ...t, kind:'reassign' });      // same volunteer can't do the new time → move
    });
    pending.map(t => ({ t, n: pocVols.filter(v => !volBlock(L, v, t.req)).length }))
      .sort((a,b) => a.n - b.n)
      .forEach(({ t }) => {
        const pk = pickVol(L, t.req, t.kind === 'reassign' ? t.p?.volunteerId : null);
        if (pk.volId) add(t, pk);
        else add(t, { kind:'blocked', reason:'Nobody in the POC team is free for this whole window — use Manual' });
      });
    return rows.sort((a,b) => (a.day||'') !== (b.day||'') ? ((a.day||'') > (b.day||'') ? 1 : -1) : ((a.req?.fromTime||'') > (b.req?.fromTime||'') ? 1 : -1));
  }
  const vNm = id => vols.find(v => v.id === id)?.name || 'volunteer';
  const describeFix = r =>
    r.kind === 'blocked'  ? r.reason
    : r.kind === 'remove' ? `Remove ${vNm(r.p?.volunteerId)} as POC for ${cName(r.contactId)}`
    : r.kind === 'retime' ? `Keep ${vNm(r.volId)}, change time to ${r.req.fromTime}–${r.req.toTime}`
    : r.kind === 'assign' ? `Assign ${vNm(r.volId)} (${r.req.fromTime}–${r.req.toTime})`
    : `Move ${cName(r.contactId)} from ${vNm(r.p?.volunteerId)} to ${vNm(r.volId)}`;

  const psKey = (contactId, d) => `poc_auto_${contactId}_${d}`;
  // Apply fix rows. Returns a snapshot of what was there before, so it can be undone.
  async function applyFixRows(rows) {
    const snap = []; let n = 0;
    for (const r of rows) {
      if (r.kind === 'blocked' || (r.kind !== 'remove' && !r.volId)) continue;
      const prevPoc = r.p ? (pocById(r.p.id) || r.p) : (getAssignment(r.contactId, r.day) || null);
      if (prevPoc?.frozen) continue;
      const prevPs = personalised.find(x => x.id === psKey(r.contactId, r.day)) || null;
      let newId = null;
      if (r.kind === 'remove') {
        await removeItem('poc', r.p.id);
        if (prevPs) await removeItem('personalisedSchedule', prevPs.id);
      } else {
        newId = await writeAssignment(r.req, r.volId);
      }
      snap.push({ kind:r.kind, prevPoc, prevPs, newId, ps: psKey(r.contactId, r.day) });
      n++;
    }
    return { n, snap };
  }
  async function undoFix(snap) {
    for (const x of [...snap].reverse()) {
      if (x.prevPoc) { const { _updated, ...rest } = x.prevPoc; await saveItem('poc', rest); }
      else if (x.newId) await removeItem('poc', x.newId);
      if (x.prevPs) { const { _updated, ...rest } = x.prevPs; await saveItem('personalisedSchedule', rest); }
      else if (x.kind !== 'remove') await removeItem('personalisedSchedule', x.ps);
    }
  }
  async function runFix(rows, label) {
    setFixBusy(true);
    try {
      const { n, snap } = await applyFixRows(rows);
      if (n) { setLastFix({ text: label, snap }); toast(label); } else toast('Nothing changed.');
      setManualFor(null);
    } catch (e) { toast('Could not fix: ' + (e.code || e.message)); }
    setFixBusy(false);
  }
  async function takeAction(i) {
    const rows = planFixes([i]).filter(r => r.kind !== 'blocked');
    if (!rows.length) return;
    await runFix(rows, rows.map(describeFix).join(' · '));
  }
  async function manualAssign(i, volId) {
    const p = i.pocId ? pocById(i.pocId) : getAssignment(i.contactId, i.day);
    const r = reqFor(i.contactId, i.day);
    if (!r) return;
    await runFix([{ kind: p ? 'reassign' : 'assign', p, req:r, day:r.date, contactId:r.contactId, volId }], `${vNm(volId)} assigned to ${cName(r.contactId)} (${r.fromTime}–${r.toTime})`);
  }
  async function manualRemove(i) {
    const p = i.pocId ? pocById(i.pocId) : null;
    if (!p) return;
    await runFix([{ kind:'remove', p, day:p.day, contactId:p.contactId }], `Removed ${vNm(p.volunteerId)} as POC for ${cName(p.contactId)}`);
  }
  async function setIgnored(i, on) {
    const p = pocById(i.pocId);
    if (!p) return;
    // '' instead of deleting the key: a merge write can't remove map keys, and '' never matches a signature
    await saveItem('poc', { id:p.id, ignored: { ...(p.ignored||{}), [i.id]: on ? i.sig : '' } });
    toast(on ? 'Issue ignored. It will come back if anything about it changes.' : 'Issue restored.');
  }
  // Manual picker: every POC-team volunteer, free ones first, with the reason the others can't take it
  function manualOptions(i) {
    const r = reqFor(i.contactId, i.day);
    if (!r) return [];
    const own = i.pocId ? pocById(i.pocId) : getAssignment(i.contactId, i.day);
    const L = makeLoad(new Set(own ? [own.id] : []));
    return pocVols.map(v => {
      const why = volBlock(L, v, r);
      const k = v.id+'|'+r.date;
      return { v, why, n:L.count[k]||0, overLimitOnly: why.startsWith('Already has'), current: own?.volunteerId === v.id };
    }).sort((a,b) => (!a.why ? 0 : a.overLimitOnly ? 1 : 2) - (!b.why ? 0 : b.overLimitOnly ? 1 : 2) || a.n - b.n || (a.v.name||'').localeCompare(b.v.name||''));
  }

  /* ══ Auto-assign: rule-based, most-constrained guest first, never touches frozen/existing ══ */
  function planAuto(scopeDays) {
    const busy = {}, count = {}, total = {};
    eventPoc.forEach(p => {
      const k = p.volunteerId+'|'+p.day;
      if (p.fromTime&&p.toTime) (busy[k] = busy[k] || []).push({ fromTime:p.fromTime, toTime:p.toTime });
      count[k] = (count[k]||0) + 1; total[p.volunteerId] = (total[p.volunteerId]||0) + 1;
    });
    const chosen = {}; // contactId -> Set(volId) used on other days, for continuity
    eventPoc.forEach(p => { (chosen[p.contactId] = chosen[p.contactId] || new Set()).add(p.volunteerId); });
    const candidates = r => pocVols.filter(v => {
      const va = getVolAvail(v.id, r.date); if (!va) return false;
      if (!withinSlots(va, toMins(r.fromTime), toMins(r.toTime))) return false;
      const k = v.id+'|'+r.date;
      if ((busy[k]||[]).some(w => overlaps(w, r))) return false;
      return (count[k]||0) < maxPerDay;
    });
    const open = requirements.filter(r => scopeDays.includes(r.date) && !getAssignment(r.contactId, r.date));
    const ordered = open.map(r => ({ r, n: candidates(r).length })).sort((a,b) => a.n - b.n || (a.r.date > b.r.date ? 1 : -1));
    const out = [];
    for (const { r } of ordered) {
      const cs = candidates(r);
      if (!cs.length) { out.push({ req:r, volId:'', options:[], reason:'Nobody in the POC team is free for this whole window' }); continue; }
      const score = v => ((chosen[r.contactId]?.has(v.id)) ? 1000 : 0) - 10*(count[v.id+'|'+r.date]||0) - (total[v.id]||0);
      const best = [...cs].sort((a,b) => score(b) - score(a))[0];
      const k = best.id+'|'+r.date;
      (busy[k] = busy[k] || []).push({ fromTime:r.fromTime, toTime:r.toTime });
      count[k] = (count[k]||0) + 1; total[best.id] = (total[best.id]||0) + 1;
      (chosen[r.contactId] = chosen[r.contactId] || new Set()).add(best.id);
      const cont = eventPoc.some(p => p.contactId===r.contactId && p.volunteerId===best.id) || out.some(o => o.req.contactId===r.contactId && o.volId===best.id);
      out.push({ req:r, volId:best.id, options:cs.map(v=>v.id),
        reason: cont ? 'Same POC as their other day' : `Least busy (${(count[k]||1)-1} other guest${(count[k]||1)-1===1?'':'s'} that day)` });
    }
    return out.sort((a,b) => a.req.date !== b.req.date ? (a.req.date > b.req.date ? 1 : -1) : (a.req.fromTime > b.req.fromTime ? 1 : -1));
  }

  async function applyPlan(rows) {
    let n = 0;
    for (const row of rows) { if (row.volId) { await writeAssignment(row.req, row.volId); n++; } }
    toast(n ? `Assigned ${n} POC${n>1?'s':''}.` : 'Nothing assigned.');
    setAutoOpen(false);
  }

  if (!requirements.length) return (
    <>
      <div className="page-head">
        <div className="ph-txt"><h1>POC Allocation</h1><p>Assign volunteers to panelists as Points of Contact per day.</p></div>
      </div>
      <div className="panel panel-pad">
        <Empty title="No POC requirements yet" sub="Tick 'POC Required' on rows in Personalised Schedule and save to see requirements here."/>
      </div>
    </>
  );

  return (
    <>
      <div className="page-head">
        <div className="ph-txt">
          <h1>POC Allocation</h1>
          <p>Assign Point of Contact volunteers to panelists per day. Warnings update live as schedules, availability and travel change.</p>
        </div>
        <label className="poc-limit" title="Warn when a volunteer has more guests than this in one day">
          Max guests per POC/day
          <select className="statsel" value={maxPerDay} disabled={!can('settings.config')}
            onChange={async e=>{ await saveItem('appConfig',{id:'pocMaxPerDay',value:String(e.target.value)}); toast('Limit updated.'); }}>
            {[1,2,3,4,5,6,8,10].map(n=><option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        {can('poc.assign') && <button className="btn primary" onClick={()=>setAutoOpen(true)}>⚡ Auto-assign</button>}
      </div>

      <div className={'poc-issues' + (issues.length ? (badCount ? ' bad' : ' warn') : ' ok')}>
        <div className="poc-issues-bar">
          <button className="poc-issues-head" onClick={()=>setShowIssues(v=>!v)} disabled={!issues.length && !ignoredIssues.length}>
            {issues.length ? <>⚠ {issues.length} issue{issues.length>1?'s':''}{badCount ? ` · ${badCount} need action` : ''}</> : <>✓ No issues — every POC need is covered and consistent</>}
            {ignoredIssues.length > 0 && <span style={{fontWeight:400,opacity:.8}}> · {ignoredIssues.length} ignored</span>}
            {(issues.length > 0 || ignoredIssues.length > 0) && <span style={{marginLeft:'auto'}}>{showIssues ? '▾ Hide' : '▸ Show'}</span>}
          </button>
          {can('poc.assign') && issues.length > 0 && (
            <button className="btn sm" disabled={fixBusy} onClick={()=>setFixPreview({ title:'Fix all issues', rows: planFixes(issues) })}>⚡ Fix everything</button>
          )}
        </div>
        {lastFix && (
          <div className="poc-undo">
            <span style={{flex:1}}>✓ {lastFix.text}</span>
            <button className="btn sm" disabled={fixBusy} onClick={async()=>{ setFixBusy(true); await undoFix(lastFix.snap); setLastFix(null); setFixBusy(false); toast('Undone — previous POC assignments restored.'); }}>↶ Undo</button>
            <button className="btn ghost xs" onClick={()=>setLastFix(null)} aria-label="Dismiss">✕</button>
          </div>
        )}
        {showIssues && (
          <div className="poc-issues-body">
            {POC_ISSUE_TYPES.map(([type, label, hint]) => {
              const list = issues.filter(i=>i.type===type).sort((a,b)=> a.day!==b.day ? (a.day>b.day?1:-1) : cName(a.contactId).localeCompare(cName(b.contactId)));
              if (!list.length) return null;
              const open = openGroups.has(type);
              const sev = POC_ISSUE_SEV[type];
              return (
                <div key={type} className={'poc-grp ' + sev}>
                  <div className="poc-grp-head">
                    <button className="poc-grp-toggle" onClick={()=>setOpenGroups(p=>{ const n=new Set(p); n.has(type)?n.delete(type):n.add(type); return n; })}>
                      <span style={{width:12}}>{open ? '▾' : '▸'}</span>{label}<span className="poc-grp-n">{list.length}</span>
                      <span className="poc-grp-hint">{sev==='bad' ? 'Needs action' : 'Warning'} · Fix: {hint}</span>
                    </button>
                    {can('poc.assign') && <button className="btn xs" disabled={fixBusy} onClick={()=>setFixPreview({ title:`Fix all — ${label}`, rows: planFixes(list) })}>Fix all ({list.length})</button>}
                  </div>
                  {open && list.map(i => {
                    const plan = planFixes([i]);
                    const doable = plan.filter(r=>r.kind!=='blocked');
                    const p = i.pocId ? pocById(i.pocId) : null;
                    return (
                      <div key={i.id} className="poc-irow">
                        <div className="poc-irow-main">
                          <button className="linkbtn" style={{fontWeight:600,color:'var(--ink)'}} title="Open this day" onClick={()=>setSelectedDay(i.day)}>
                            <span className="mono" style={{color:'var(--muted)',marginRight:8}}>{shortDate(i.day)}</span>{cName(i.contactId)}
                          </button>
                          <div className={i.sev==='bad'?'poc-irow-txt bad':'poc-irow-txt warn'}>{i.text}{p?.frozen ? ' · 🔒 frozen' : ''}</div>
                          <div className={'poc-irow-fix' + (doable.length ? '' : ' blocked')}>
                            {doable.length ? '→ ' + doable.map(describeFix).join(' · ') : '✕ ' + (plan[0]?.reason || 'No automatic fix — use Manual')}
                          </div>
                        </div>
                        {can('poc.assign') && (
                          <div className="poc-irow-acts">
                            <button className="btn primary xs" disabled={fixBusy || !doable.length} title={doable.length ? '' : (plan[0]?.reason || '')} onClick={()=>takeAction(i)}>Take action</button>
                            <button className={'btn xs' + (manualFor===i.id ? ' primary' : '')} onClick={()=>setManualFor(m=>m===i.id?null:i.id)}>Manual</button>
                            {i.pocId && <button className="btn ghost xs" onClick={()=>setIgnored(i, true)} title="Hide this issue until something about it changes">Ignore</button>}
                          </div>
                        )}
                        {manualFor===i.id && (() => {
                          const r = reqFor(i.contactId, i.day);
                          const opts = manualOptions(i);
                          return (
                            <div className="poc-manual">
                              {r ? <div className="muted-sm">Choose a POC for <b>{cName(i.contactId)}</b>, {shortDate(r.date)} {r.fromTime}–{r.toTime}{p?.frozen ? ' — frozen, unfreeze first' : ''}</div>
                                 : <div className="muted-sm">POC is no longer needed for this guest on this day.</div>}
                              {r && <div className="poc-manual-list">
                                {opts.map(o => (
                                  <button key={o.v.id} type="button" className={'poc-manual-opt' + (o.current ? ' on' : '')}
                                    disabled={fixBusy || p?.frozen || o.current || (!!o.why && !o.overLimitOnly)}
                                    title={o.why || 'Free for this window'} onClick={()=>manualAssign(i, o.v.id)}>
                                    {o.v.name}{o.current ? ' (current)' : ''}
                                    <small>{o.why ? (o.overLimitOnly ? `${o.why} — over limit` : o.why) : `Free · ${o.n} other guest${o.n===1?'':'s'} that day`}</small>
                                  </button>
                                ))}
                                {!opts.length && <span className="muted-sm">No volunteers in the POC department.</span>}
                              </div>}
                              <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
                                {p && !p.frozen && <button className="btn danger xs" disabled={fixBusy} onClick={()=>manualRemove(i)}>Remove assignment</button>}
                                <button className="btn xs" onClick={()=>{ setSelectedDay(i.day); setManualFor(null); }}>Go to day</button>
                                <button className="btn ghost xs" onClick={()=>setManualFor(null)}>Close</button>
                              </div>
                            </div>
                          );
                        })()}
                      </div>
                    );
                  })}
                </div>
              );
            })}
            {ignoredIssues.length > 0 && (
              <div className="poc-grp">
                <div className="poc-grp-head">
                  <button className="poc-grp-toggle" onClick={()=>setShowIgnored(v=>!v)}>
                    <span style={{width:12}}>{showIgnored ? '▾' : '▸'}</span>Ignored<span className="poc-grp-n">{ignoredIssues.length}</span>
                    <span className="poc-grp-hint">Hidden until something about them changes</span>
                  </button>
                </div>
                {showIgnored && ignoredIssues.map(i => (
                  <div key={i.id} className="poc-irow">
                    <div className="poc-irow-main">
                      <span className="mono" style={{color:'var(--muted)',marginRight:8}}>{shortDate(i.day)}</span><b>{cName(i.contactId)}</b>
                      <div className="poc-irow-txt">{i.text}</div>
                    </div>
                    {can('poc.assign') && <div className="poc-irow-acts"><button className="btn xs" onClick={()=>setIgnored(i, false)}>Restore</button></div>}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="poc-layout">

        {/* Day selector */}
        <div className="poc-days">
          <div className="poc-days-label">Day</div>
          {reqDays.map(d=>(
            <button key={d} onClick={()=>{ setSelectedDay(d); setOpenDropdown(null); }}
              style={{width:'100%',textAlign:'left',padding:'8px 12px',borderRadius:8,marginBottom:4,border:'none',
                background:d===day?'var(--teal)':'var(--paper)',
                color:d===day?'#fff':'var(--ink)',cursor:'pointer',fontSize:12.5,fontWeight:500}}>
              {fmtDate(d)}
              <span style={{float:'right',fontSize:11,opacity:.7}}>
                {requirements.filter(r=>r.date===d).length}
                {issues.some(i=>i.day===d&&i.sev==='bad') && <span style={{color:d===day?'#fff':'var(--rose)',marginLeft:4}}>⚠</span>}
              </span>
            </button>
          ))}
        </div>

        {/* Main table */}
        <div style={{flex:1,minWidth:0}}>
          <div style={{fontWeight:600,fontSize:13,color:'var(--teal)',marginBottom:12}}>{fmtDate(day)}</div>

          {dayReqs.length===0
            ? <div className="panel panel-pad"><p className="muted-sm">No POC requirements for {fmtDate(day)}.</p></div>
            : <div className="panel"><div className="panel-body">
                <table style={{width:'100%',borderCollapse:'collapse',fontSize:13,minWidth:560}}>
                  <thead>
                    <tr style={{background:'var(--teal-wash)'}}>
                      <th style={{padding:'10px 14px',textAlign:'left',width:'28%'}}>Panelist</th>
                      <th style={{padding:'10px 14px',textAlign:'left',width:'14%'}}>POC Window</th>
                      <th style={{padding:'10px 14px',textAlign:'left',width:'36%'}}>Assigned POC</th>
                      <th style={{padding:'10px 14px',textAlign:'left',width:'22%'}}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dayReqs.map((req,ri)=>{
                      const assignment  = getAssignment(req.contactId, day);
                      const assignedVol = assignment ? vols.find(v=>v.id===assignment.volunteerId) : null;
                      const isOpen      = openDropdown===req.key;
                      const availVols   = pocVols.filter(v=>getVolAvail(v.id,day));

                      return (
                        <React.Fragment key={req.key}>
                          <tr style={{borderBottom:isOpen?'none':'1px solid var(--line)',background:ri%2===0?'#fff':'#fafaf7'}}>
                            {/* Panelist */}
                            <td style={{padding:'10px 14px'}}>
                              <div className="nm" style={{fontSize:13}}>{req.contactName}</div>
                              {issuesFor(req.key).filter(i=>i.text!=='No POC assigned').map((i,ix)=>(
                                <div key={ix} className={'mtg-flag' + (i.sev==='bad'?' bad':'')} style={{display:'block'}}>⚠ {i.text}</div>
                              ))}
                            </td>

                            {/* Window */}
                            <td style={{padding:'10px 14px'}}>
                              <span style={{fontSize:12.5,fontWeight:600,color:'var(--teal)',whiteSpace:'nowrap'}}>
                                {req.fromTime} – {req.toTime}
                              </span>
                            </td>

                            {/* Assigned POC / dropdown trigger */}
                            <td style={{padding:'10px 14px',position:'relative'}}>
                              {assignment?.frozen ? (
                                /* Frozen — show name, no dropdown */
                                <div style={{display:'flex',alignItems:'center',gap:8}}>
                                  <div style={{width:28,height:28,borderRadius:'50%',background:'var(--teal)',
                                    color:'#fff',display:'flex',alignItems:'center',justifyContent:'center',fontSize:10,fontWeight:700}}>
                                    {initials(assignedVol?.name||'?')}
                                  </div>
                                  <div>
                                    <div style={{fontSize:12.5,fontWeight:500}}>{assignedVol?.name||'—'}</div>
                                    {assignedVol?.phone&&<div style={{fontSize:11,color:'var(--muted)'}}>{assignedVol.phone}</div>}
                                  </div>
                                  <span style={{fontSize:13,marginLeft:4}} title="Frozen">🔒</span>
                                </div>
                              ) : (
                                /* Dropdown trigger */
                                <button
                                  onClick={()=>setOpenDropdown(isOpen?null:req.key)}
                                  style={{
                                    width:'100%',textAlign:'left',padding:'7px 10px',
                                    border:`1px solid ${assignment?'var(--teal)':'var(--line)'}`,
                                    borderRadius:8,background:assignment?'var(--teal-wash)':'#fff',
                                    cursor:'pointer',display:'flex',alignItems:'center',gap:8,
                                    color:'var(--ink)',fontSize:12.5,
                                  }}>
                                  {assignedVol ? (
                                    <>
                                      <div style={{width:22,height:22,borderRadius:'50%',background:'var(--teal)',
                                        color:'#fff',display:'flex',alignItems:'center',justifyContent:'center',
                                        fontSize:9,fontWeight:700,flexShrink:0}}>
                                        {initials(assignedVol.name)}
                                      </div>
                                      <div style={{flex:1,minWidth:0}}>
                                        <div style={{fontWeight:500,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{assignedVol.name}</div>
                                        {assignedVol.phone&&<div style={{fontSize:11,color:'var(--muted)'}}>{assignedVol.phone}</div>}
                                      </div>
                                      <span style={{fontSize:11,color:'var(--teal)',fontWeight:600}}>✓</span>
                                    </>
                                  ) : (
                                    <span style={{color:'var(--muted)'}}>Select volunteer…</span>
                                  )}
                                  <span style={{marginLeft:'auto',fontSize:11,color:'var(--muted)'}}>▾</span>
                                </button>
                              )}
                            </td>

                            {/* Actions */}
                            <td style={{padding:'10px 14px'}}>
                              <div className="rowacts">
                                {assignment&&(
                                  <button className={`btn ghost xs`}
                                    onClick={()=>toggleFreeze(req)}
                                    style={{color:assignment.frozen?'var(--teal)':'var(--muted)'}}
                                    title={assignment.frozen?'Unfreeze':'Freeze'}>
                                    {assignment.frozen?'🔓':'🔒'}
                                  </button>
                                )}
                                {assignment&&!assignment.frozen&&(
                                  <button className="btn ghost xs" style={{color:'var(--rose)'}}
                                    onClick={()=>unassignPOC(req)} title="Remove POC">{ICON.trash}</button>
                                )}
                              </div>
                            </td>
                          </tr>

                          {/* Inline dropdown */}
                          {isOpen && (
                            <tr style={{borderBottom:'1px solid var(--line)'}}>
                              <td colSpan={4} style={{padding:0,background:'#FAFAF7'}}>
                                <div style={{padding:'8px 14px 12px',borderTop:'1px solid var(--line)'}}>
                                  <div style={{fontSize:11.5,color:'var(--muted)',marginBottom:8,fontWeight:500}}>
                                    Select POC for {req.fromTime}–{req.toTime}
                                    {availVols.length===0&&<span style={{color:'var(--amber)',marginLeft:8}}>— No volunteers available</span>}
                                  </div>
                                  <div style={{display:'flex',flexWrap:'wrap',gap:6}}>
                                    {availVols.map(v=>{
                                      const va = getVolAvail(v.id, day);
                                      const covers = canCover(v.id, day, req.fromTime, req.toTime);
                                      const assigned = !covers && getVolAssignments(v.id,day).length>0;
                                      const free = getFreeSlots(v.id,day);
                                      const isCurrentlyAssigned = assignment?.volunteerId===v.id;
                                      const totalMins = toMins(va.end)-toMins(va.start);

                                      return (
                                        <div key={v.id}
                                          onClick={()=>{
                                            if(!covers&&!isCurrentlyAssigned) return;
                                            setConfirmAssign({req,vol:v});
                                            setOpenDropdown(null);
                                          }}
                                          style={{
                                            padding:'8px 12px',borderRadius:8,border:`1px solid ${isCurrentlyAssigned?'var(--teal)':covers?'var(--line)':'var(--line)'}`,
                                            background:isCurrentlyAssigned?'var(--teal-wash)':covers?'#fff':'#f5f5f5',
                                            opacity:covers||isCurrentlyAssigned?1:0.5,
                                            cursor:covers||isCurrentlyAssigned?'pointer':'not-allowed',
                                            minWidth:160,maxWidth:220,
                                          }}
                                          title={covers?`Assign ${v.name}`:assigned?`${v.name} already assigned elsewhere`:`${v.name} not available for this window`}>
                                          {/* Name row */}
                                          <div style={{display:'flex',alignItems:'center',gap:6,marginBottom:5}}>
                                            <div style={{width:24,height:24,borderRadius:'50%',background:covers||isCurrentlyAssigned?'var(--teal)':'#999',
                                              color:'#fff',display:'flex',alignItems:'center',justifyContent:'center',fontSize:9,fontWeight:700,flexShrink:0}}>
                                              {initials(v.name)}
                                            </div>
                                            <div style={{flex:1,minWidth:0}}>
                                              <div style={{fontSize:12,fontWeight:500,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{v.name}</div>
                                              <div style={{fontSize:10,color:'var(--muted)'}}>{slotsText(va.slots)}</div>
                                            </div>
                                            {isCurrentlyAssigned&&<span style={{fontSize:10,color:'var(--teal)',fontWeight:700}}>✓</span>}
                                          </div>
                                          {/* Mini timeline bar */}
                                          <div style={{position:'relative',height:5,background:'#E8E8E8',borderRadius:3,overflow:'hidden',marginBottom:3}}>
                                            {/* Gaps between slots = not available (shown as a hole in the bar) */}
                                            {va.slots.slice(1).map((sl,i)=>{
                                              const gs=toMins(va.slots[i].end), ge=toMins(sl.start);
                                              if (ge<=gs) return null;
                                              return <div key={'gap'+i} title="Not available" style={{position:'absolute',left:`${((gs-toMins(va.start))/totalMins)*100}%`,width:`${((ge-gs)/totalMins)*100}%`,height:'100%',background:'#fff'}}/>;
                                            })}
                                            {getVolAssignments(v.id,day).map((a,i)=>{
                                              const left=((a.from-toMins(va.start))/totalMins)*100;
                                              const width=((a.to-a.from)/totalMins)*100;
                                              return <div key={i} style={{position:'absolute',left:`${left}%`,width:`${width}%`,height:'100%',background:a.contactId===req.contactId?'var(--teal)':'#aaa',borderRadius:2}}/>;
                                            })}
                                            {/* Requirement window marker */}
                                            {(()=>{
                                              const rf=toMins(req.fromTime),rt=toMins(req.toTime);
                                              const l=((rf-toMins(va.start))/totalMins)*100;
                                              const w=((rt-rf)/totalMins)*100;
                                              return <div style={{position:'absolute',left:`${l}%`,width:`${w}%`,height:'100%',border:'1.5px solid var(--amber)',borderRadius:2,boxSizing:'border-box'}}/>;
                                            })()}
                                          </div>
                                          {/* Free slots */}
                                          <div style={{fontSize:9.5,color:'var(--muted)'}}>
                                            {free.filter(s=>s.to>s.from).map((s,i)=>(
                                              <span key={i}>{i>0?' · ':''}{fromMins(s.from)}–{fromMins(s.to)}</span>
                                            ))}
                                            {free.filter(s=>s.to>s.from).length===0&&<span style={{color:'var(--rose)'}}>Fully assigned</span>}
                                          </div>
                                        </div>
                                      );
                                    })}
                                  </div>
                                  <button className="btn ghost xs" style={{marginTop:8,color:'var(--muted)'}}
                                    onClick={()=>setOpenDropdown(null)}>Cancel</button>
                                </div>
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div></div>
          }
        </div>
      </div>

      {/* Confirm assign modal */}
      {confirmAssign && (
        <div className="scrim" onMouseDown={()=>setConfirmAssign(null)}>
          <div className="modal" onMouseDown={e=>e.stopPropagation()} style={{maxWidth:380}}>
            <div className="modal-head">
              <h2>Assign POC?</h2>
              <button className="x" onClick={()=>setConfirmAssign(null)}>✕</button>
            </div>
            <div className="modal-body">
              <p style={{fontSize:13,marginBottom:8}}>Assign <strong>{confirmAssign.vol.name}</strong> as POC for</p>
              <p style={{fontSize:13,marginBottom:4}}><strong>{confirmAssign.req.contactName}</strong></p>
              <p style={{fontSize:13,color:'var(--teal)',fontWeight:600}}>
                {fmtDate(confirmAssign.req.date)} · {confirmAssign.req.fromTime} – {confirmAssign.req.toTime}
              </p>
              {confirmAssign.vol.phone&&<p style={{fontSize:12,color:'var(--muted)',marginTop:4}}>Contact: {confirmAssign.vol.phone}</p>}
            </div>
            <div className="modal-foot">
              <button className="btn" onClick={()=>setConfirmAssign(null)}>Cancel</button>
              <button className="btn primary" onClick={async()=>{
                await assignPOC(confirmAssign.req, confirmAssign.vol.id);
                setConfirmAssign(null);
              }}>Yes, Assign</button>
            </div>
          </div>
        </div>
      )}

      {autoOpen && <PocAutoAssignModal plan={planAuto} days={reqDays} day={day} vols={vols} cName={cName}
        onApply={applyPlan} onClose={()=>setAutoOpen(false)} />}
      {fixPreview && <PocFixPreviewModal title={fixPreview.title} rows={fixPreview.rows} vols={vols} cName={cName} describe={describeFix}
        onClose={()=>setFixPreview(null)}
        onApply={async rows=>{ const { n, snap } = await applyFixRows(rows); setLastFix(n ? { text:`Fixed ${n} item${n>1?'s':''}`, snap } : null); setShowIssues(true); toast(n ? `Fixed ${n} item${n>1?'s':''}.` : 'Nothing changed.'); setFixPreview(null); }} />}
    </>
  );
}

/* ── POC issue types: [type, group label, what the automatic fix does] — order = display order ── */
const POC_ISSUE_TYPES = [
  ['unassigned',      'No POC assigned',                  'assign the best free POC volunteer'],
  ['double',          'Double-booked',                    'keep one guest, move the other to a free volunteer'],
  ['vol-unavailable', 'Volunteer not available that day', 'move to a volunteer who is free'],
  ['vol-missing',     'Volunteer deleted',                'move to a volunteer who is free'],
  ['guest-deleted',   'Guest deleted',                    'remove the POC assignment'],
  ['guest-status',    'Guest no longer confirmed',        'remove the POC assignment'],
  ['outside-stay',    "Outside guest's stay",             'remove the POC assignment'],
  ['timing',          'Timing changed',                   'update the time, or move if the volunteer isn\'t free'],
  ['outside-hours',   "Outside volunteer's hours",        'move to a volunteer who is free'],
  ['not-required',    'POC no longer required',           'remove the POC assignment'],
  ['over-limit',      'Over daily limit',                 'move the extra guests to other volunteers'],
];
const POC_ISSUE_SEV = {
  'unassigned':'bad', 'double':'bad', 'vol-unavailable':'bad', 'vol-missing':'bad', 'guest-deleted':'bad', 'guest-status':'bad', 'outside-stay':'bad',
  'timing':'warn', 'outside-hours':'warn', 'not-required':'warn', 'over-limit':'warn',
};

/* ── Fix all / Fix everything preview: tick what to apply, change any volunteer, then Apply ── */
function PocFixPreviewModal({ title, rows: initial, vols, cName, describe, onApply, onClose }) {
  const [rows, setRows] = useState(() => initial.map(r => ({ ...r, on: r.kind !== 'blocked' })));
  const [busy, setBusy] = useState(false);
  const vName = id => vols.find(v => v.id === id)?.name || '—';
  const picked = rows.filter(r => r.on && r.kind !== 'blocked' && (r.kind === 'remove' || r.volId));
  const blocked = rows.filter(r => r.kind === 'blocked').length;
  const upd = (i, patch) => setRows(p => p.map((x, j) => j === i ? { ...x, ...patch } : x));
  return (
    <Modal title={title} onClose={onClose} footer={null}>
      <p className="muted-sm" style={{ margin: '0 0 10px' }}>
        Nothing is saved until you click Apply. Untick anything you want to handle yourself, or pick a different volunteer.
        Frozen assignments are never changed.
      </p>
      {!rows.length ? <Empty title="Nothing to fix" sub="These issues have no automatic fix." /> : (
        <div style={{ maxHeight: '50vh', overflow: 'auto', border: '1px solid var(--line)', borderRadius: 8 }}>
          <table className="import-tbl"><thead><tr><th></th><th>Guest</th><th>Change</th></tr></thead><tbody>
            {rows.map((r, i) => (
              <tr key={r.key} style={r.kind === 'blocked' ? { opacity: .6 } : {}}>
                <td><input type="checkbox" checked={r.on} disabled={r.kind === 'blocked'} onChange={e => upd(i, { on: e.target.checked })} style={{ accentColor: 'var(--teal)' }} /></td>
                <td><b>{cName(r.contactId)}</b><div className="muted-sm">{r.day ? shortDate(r.day) : ''}{r.req ? ` · ${r.req.fromTime}–${r.req.toTime}` : ''}</div></td>
                <td>
                  {r.kind === 'blocked' ? <span className="mtg-flag bad">⚠ {r.reason}</span>
                  : r.kind === 'remove' ? <span>{describe(r)}</span>
                  : <>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        <span className="muted-sm">{r.kind === 'assign' ? 'Assign' : r.kind === 'retime' ? 'Keep / change time' : `Move from ${vName(r.p?.volunteerId)} to`}</span>
                        <select className="input" style={{ padding: '4px 6px', fontSize: 12.5, width: 'auto' }} value={r.volId}
                          onChange={e => upd(i, { volId: e.target.value, kind: r.kind === 'retime' && e.target.value !== r.p?.volunteerId ? 'reassign' : r.kind })}>
                          {r.options.map(id => <option key={id} value={id}>{vName(id)}</option>)}
                        </select>
                      </div>
                    </>}
                </td>
              </tr>
            ))}
          </tbody></table>
        </div>
      )}
      {blocked > 0 && <div className="mtg-note" style={{ marginTop: 10 }}>⚠ {blocked} item{blocked > 1 ? 's' : ''} can't be fixed automatically — use Manual on those issues.</div>}
      <div className="modal-foot" style={{ padding: '12px 0 0' }}>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={busy || !picked.length} onClick={async () => { setBusy(true); await onApply(picked); }}>
          {busy ? 'Applying…' : `Apply ${picked.length} change${picked.length === 1 ? '' : 's'}`}
        </button>
      </div>
    </Modal>
  );
}

/* ── POC auto-assign preview: nothing is saved until Apply ── */
function PocAutoAssignModal({ plan, days, day, vols, cName, onApply, onClose }) {
  const [scope, setScope] = useState('day');
  const [rows, setRows] = useState(() => plan([day]));
  const [busy, setBusy] = useState(false);
  useEffect(() => { setRows(plan(scope === 'day' ? [day] : days)); /* eslint-disable-next-line */ }, [scope]);
  const vName = id => vols.find(v => v.id === id)?.name || '—';
  const willAssign = rows.filter(r => r.volId).length;
  const noOne = rows.filter(r => !r.options.length).length;
  return (
    <Modal title="Auto-assign POCs" onClose={onClose} footer={null}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
        <div className="seg" role="group" aria-label="Scope">
          <button type="button" className={scope === 'day' ? 'on' : ''} onClick={() => setScope('day')}>{fmtDate(day)}</button>
          <button type="button" className={scope === 'all' ? 'on' : ''} onClick={() => setScope('all')}>All days</button>
        </div>
        <span className="muted-sm">Only unassigned guests. Frozen and existing POCs are never changed.</span>
      </div>
      <p className="muted-sm" style={{ margin: '0 0 10px' }}>
        Picks volunteers from the POC department who are available for the whole window and free at that time,
        preferring the same POC a guest has on other days, then whoever is least busy. Change any pick before applying.
      </p>
      {!rows.length ? <Empty title="Nothing to assign" sub="Every POC need in this range already has someone." /> : (
        <div style={{ maxHeight: '46vh', overflow: 'auto', border: '1px solid var(--line)', borderRadius: 8 }}>
          <table className="import-tbl"><thead><tr><th>Guest</th><th>Window</th><th>POC</th></tr></thead><tbody>
            {rows.map((r, i) => (
              <tr key={r.req.key}>
                <td><b>{cName(r.req.contactId)}</b>{scope === 'all' && <div className="muted-sm">{shortDate(r.req.date)}</div>}</td>
                <td className="mono" style={{ whiteSpace: 'nowrap' }}>{r.req.fromTime}–{r.req.toTime}</td>
                <td>
                  {r.options.length ? (
                    <>
                      <select className="input" style={{ padding: '4px 6px', fontSize: 12.5 }} value={r.volId}
                        onChange={e => setRows(p => p.map((x, j) => j === i ? { ...x, volId: e.target.value, reason: e.target.value ? 'Chosen by you' : 'Skipped' } : x))}>
                        <option value="">Skip</option>
                        {r.options.map(id => <option key={id} value={id}>{vName(id)}</option>)}
                      </select>
                      <div className="muted-sm" style={{ fontSize: 11, marginTop: 2 }}>{r.reason}</div>
                    </>
                  ) : <span className="mtg-flag bad">⚠ {r.reason}</span>}
                </td>
              </tr>
            ))}
          </tbody></table>
        </div>
      )}
      {noOne > 0 && <div className="mtg-note" style={{ marginTop: 10 }}>⚠ {noOne} guest{noOne > 1 ? 's' : ''} can't be covered. Add volunteers to the POC department or widen their availability.</div>}
      <div className="modal-foot" style={{ padding: '12px 0 0' }}>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={busy || !willAssign} onClick={async () => { setBusy(true); await onApply(rows); }}>
          {busy ? 'Assigning…' : `Apply ${willAssign} assignment${willAssign === 1 ? '' : 's'}`}
        </button>
      </div>
    </Modal>
  );
}



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
  const { can } = usePerm();
  const { user, profile } = (typeof useAuth === 'function') ? useAuth() : {user:null,profile:null};
  const contacts = (store.contacts||[]).filter(c=>c.status==='Confirmed');
  const poc = store.poc||[];
  const vols = store.volunteers||[];
  const checklists = store.checklist||[];

  const today = todayISO();

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
    if (!can('checklist.edit')) { return; }
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

  const [dueDate, setDueDate] = useState('');
  async function addNote() {
    if (!text.trim()) return;
    setBusy(true);
    try {
      await saveItem('contact_notes', {
        contactId: contact.id,
        eventId: activeEventId,
        text: text.trim(),
        type,
        dueDate: dueDate || null,
        done: false,
        createdAt: {seconds: Math.floor(Date.now()/1000)},
        date: todayISO(),
      });
      setText(''); setDueDate(''); toast('Note added.');
    } finally { setBusy(false); }
  }

  return (
    <Modal title={`Follow-up log — ${displayName(contact)}`} onClose={onClose} footer={null}>
      <div style={{display:'flex',gap:8,marginBottom:8,flexWrap:'wrap'}}>
        <select className="statsel" value={type} onChange={e=>setType(e.target.value)} style={{width:'auto'}}>
          {NOTE_TYPES.map(t=><option key={t}>{t}</option>)}
        </select>
        <input className="input" style={{flex:1,minWidth:160}} value={text} onChange={e=>setText(e.target.value)}
          placeholder="e.g. Called, said will confirm by Friday…"
          onKeyDown={e=>e.key==='Enter'&&addNote()}/>
        <button className="btn primary sm" onClick={addNote} disabled={busy||!text.trim()}>Add</button>
      </div>
      <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:14}}>
        <span style={{fontSize:12,color:'var(--muted)',whiteSpace:'nowrap'}}>📅 Follow-up due:</span>
        <input className="input" type="date" value={dueDate} onChange={e=>setDueDate(e.target.value)} style={{width:160}}/>
        {dueDate&&<button className="btn ghost xs" onClick={()=>setDueDate('')}>Clear</button>}
        <span style={{fontSize:11.5,color:'var(--faint)'}}>Optional — shows on dashboard if set</span>
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
      <div className="split-2" style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12,marginBottom:16}}>
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
  const today = todayISO();

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
  const today = todayISO();

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
        <div className="notif-pop" style={{
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
      XLSX.writeFile(wb, `VK_${name}_${todayISO()}.xlsx`);
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
      label: 'Logistics',
      icon: '✈️',
      count: logi.length,
      cols: [['name','Guest Name'],['inbMode','Arrival Mode'],['inbDate','Arrival Date'],['inbTime','Arrival Time'],['inbLoc','Arrival Location'],['hotel','Hotel'],['checkin','Check-in Time'],['outDate','Departure Date'],['outDepart','Departs for Airport'],['outFlight','Outbound Flight'],['special','Special Requirements']],
      get allRows() { return logi.map(L => ({...L, name: contactName(L.contactId || L.id)})); },
      run: () => exportSheet('Logistics', logi.map(L => ({
        ...L, name: contactName(L.contactId || L.id),
      })), [
        ['name','Guest Name'],
        ['arrivalDate','Arrival Date'], ['arrivalTime','Arrival Time'], ['arrivalFlight','Arrival Flight'],
        ['hotelName','Hotel'], ['hotelCheckIn','Hotel Check-in'], ['hotelCheckOut','Hotel Check-out'],
        ['departureDate','Departure Date'], ['departureTime','Departure Time'], ['departureFlight','Departure Flight'],
        ['departureFrom','Departure From'],
        ['flightReq','Flight Required'], ['accomReq','Accommodation Required'], ['carReq','Car Required'],
        ['remarks','Special Requirements'],
      ]),
    },
    {
      label: 'Event Schedule',
      icon: '🗓️',
      count: sessions.length,
      cols: [['date','Date'],['start','Start Time'],['end','End Time'],['title','Session Title'],['topic','Topic'],['type','Type']],
      get allRows() { return sessions; },
      run: () => exportSheet('Sessions', sessions, [
        ['date','Date'], ['start','Start Time'], ['end','End Time'],
        ['title','Session Title'], ['topic','Topic'], ['type','Type'],
      ]),
    },
    {
      label: 'Volunteers',
      icon: '👥',
      count: vols.length,
      cols: [['name','Name'],['phone','Phone'],['city','City'],['area','Area']],
      get allRows() { return vols; },
      run: () => exportSheet('Volunteers', vols, [
        ['name','Name'], ['phone','Phone'], ['city','City'], ['area','Area'],
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
      cols: [['title','Task'],['deptName','Department'],['assigneeName','Owner'],['due','Due Date'],['status','Status'],['notes','Notes']],
      get allRows() { return tasks.map(t=>({...t,deptName:deptName(t.deptId),assigneeName:volName(t.assigneeId)})); },
      run: () => exportSheet('Tasks', tasks.map(t => ({
        ...t,
        deptName: deptName(t.deptId),
        assigneeName: volName(t.assigneeId),
      })), [
        ['title','Task'], ['deptName','Department'], ['assigneeName','Owner'],
        ['due','Due Date'], ['status','Status'], ['notes','Notes'],
      ]),
    },


  ];

  return (
    <>
      <div className="page-head"><div className="ph-txt">
        <h1>Export Data</h1>
        <p>Download any module as an Excel file — for sharing, reporting or backup. All exports include the data for the currently active event.</p>
      </div>
        <button className="btn primary sm" onClick={() => {
          import('xlsx').then(XLSX => {
            const wb = XLSX.utils.book_new();
            EXPORTS.forEach(ex => {
              if (!ex.allRows || !ex.allRows.length) return;
              const data = ex.allRows.map(r => {
                const o = {};
                ex.cols.forEach(([key, label]) => { o[label] = r[key] ?? ''; });
                return o;
              });
              const ws = XLSX.utils.json_to_sheet(data);
              XLSX.utils.book_append_sheet(wb, ws, ex.label.slice(0,31));
            });
            XLSX.writeFile(wb, 'VK_JYOT_Full_Export_' + todayISO() + '.xlsx');
            toast('Full export downloaded.');
          });
        }}>
          💾 Export all sheets
        </button>
      </div>
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
/* ══ VK Personalised Schedule — exact document format ═══════════════
   Matches the VK4 template: header banner, guest name, two-col table,
   date rows spanning full width, hotel at bottom, footer banner.
═══════════════════════════════════════════════════════════════════════ */
export function VKSchedulePrint({ contact, store, activeEventId, onClose }) {
  const logistics   = store.logistics   || [];
  const sessions    = store.sessions    || [];
  const assignments = store.assignments || [];
  const founder     = store.founder     || [];
  const personalised = store.personalisedSchedule || [];

  const L = logistics.find(l => l.contactId === contact.id) || {};
  const sahebji = founder.find(f => f.contactId === contact.id);

  // Build schedule rows from personalisedSchedule rows + auto session rows
  const allRows = [];

  // Auto rows from assignments
  const assignedSessionIds = assignments.filter(a => a.contactId === contact.id).map(a => a.sessionId);
  const assignedSessions = sessions.filter(s => assignedSessionIds.includes(s.id));

  // Auto rows from personalisedSchedule — exclude POC auto rows from print
  const savedRows = personalised.filter(r => r.contactId === contact.id && !r.id?.startsWith('poc_auto_'));

  // Merge: saved rows take precedence, add session rows if not already there
  const rowsWithDates = [];

  savedRows.forEach(r => {
    if (r.date && r.time && r.event) {
      rowsWithDates.push({ date: r.date, time: r.time, event: r.event, auto: !!r.auto });
    }
  });

  // Add logistics rows
  if (L.arrivalDate && L.arrivalFlightTime) {
    rowsWithDates.push({ date: L.arrivalFlightDate || L.arrivalDate, time: L.arrivalFlightTime, event: `Arrival at ${L.arrivalLocation || 'Mumbai Airport'}` });
  }
  if (L.arrivalDate && L.arrivalTime) {
    rowsWithDates.push({ date: L.arrivalDate, time: L.arrivalTime, event: `Journey towards Hotel` });
  }
  if (L.departureDate && L.departureTime) {
    rowsWithDates.push({ date: L.departureDate, time: L.departureTime, event: 'Departure towards Airport' });
  }
  if (L.departureFlightDate && L.departureFlightTime) {
    rowsWithDates.push({ date: L.departureFlightDate, time: L.departureFlightTime, event: `Outbound Flight${L.departureFlightNo ? ' ' + L.departureFlightNo : ''}` });
  }

  // Add sahebji row
  if (sahebji?.date && sahebji?.time) {
    rowsWithDates.push({ date: sahebji.date, time: sahebji.time, event: 'One on One Meeting with His Holiness Spiritual Sovereign Jainacharya Yugbhushan Suri, 79th Successor to Tirthankar Shri Mahavir Swami\n\nat VIP Lounge' });
  }

  // Add assigned sessions
  assignedSessions.forEach(s => {
    const exists = rowsWithDates.some(r => r.date === s.date && r.time === s.start);
    if (!exists) {
      rowsWithDates.push({ date: s.date, time: s.start, event: s.title + (s.topic ? '\n\nTopic: ' + s.topic : '') });
    }
  });

  // Sort by date then time
  rowsWithDates.sort((a, b) => {
    const ad = (a.date + a.time).replace(/[^0-9]/g,'');
    const bd = (b.date + b.time).replace(/[^0-9]/g,'');
    return ad > bd ? 1 : -1;
  });

  // Group by date
  const byDate = {};
  rowsWithDates.forEach(r => {
    const d = r.date || 'No date';
    if (!byDate[d]) byDate[d] = [];
    byDate[d].push(r);
  });

  // Format date like "18th January 2026"
  function formatDateLong(iso) {
    if (!iso) return '';
    const d = new Date(iso + 'T12:00:00');
    const day = d.getDate();
    const suffix = day === 1||day===21||day===31?'st':day===2||day===22?'nd':day===3||day===23?'rd':'th';
    return `${day}${suffix} ${d.toLocaleDateString('en-IN',{month:'long'})} ${d.getFullYear()}`;
  }

  const printRef = React.useRef();

  function handlePrint() {
    const printContents = printRef.current.innerHTML;
    const w = window.open('','_blank','width=900,height=700');
    w.document.write(`<!DOCTYPE html><html><head><title>Schedule - ${displayName(contact)}</title>
    <style>
      @import url('https://fonts.googleapis.com/css2?family=EB+Garamond:wght@400;600;700&family=Cinzel:wght@400;600&display=swap');
      * { margin:0; padding:0; box-sizing:border-box; }
      body { font-family:'EB Garamond',Georgia,serif; font-size:13pt; color:#1a1a1a; background:#fff; }
      .schedule-wrap { max-width:750px; margin:0 auto; padding:24px 32px; }
      .header-bar { width:100%; margin-bottom:18px; }
      .heading { font-family:'Cinzel',serif; font-size:16pt; font-weight:400; letter-spacing:.08em; color:#2C1810; text-align:center; margin:10px 0 4px; }
      .guest-name { font-family:'EB Garamond',serif; font-size:20pt; font-weight:600; color:#0F6E56; text-align:center; margin-bottom:10px; }
      .divider { width:100%; margin-bottom:18px; border:none; border-top:2px solid #0F6E56; }
      table { width:100%; border-collapse:collapse; }
      td { padding:7px 10px; vertical-align:top; border:1px solid #ccc; }
      .time-col { width:90px; font-weight:600; white-space:nowrap; }
      .date-row td { background:#F5F0E8; font-weight:700; font-size:13pt; border:1px solid #ccc; padding:7px 10px; }
      .event-text { white-space:pre-line; }
      .hotel-line { margin-top:14px; font-size:12pt; }
      .hotel-line b { color:#0F6E56; }
      .footer-bar { width:100%; margin-top:20px; }
      @media print { body { -webkit-print-color-adjust:exact; print-color-adjust:exact; } }
    </style></head><body><div class="schedule-wrap">${printContents}</div></body></html>`);
    w.document.close();
    setTimeout(()=>{ w.focus(); w.print(); }, 500);
  }

  return (
    <Modal title={`Schedule — ${displayName(contact)}`} onClose={onClose} footer={null} size="lg">
      <div style={{display:'flex',justifyContent:'flex-end',gap:8,marginBottom:12}}>
        <button className="btn primary sm" onClick={handlePrint}>🖨️ Print / Save PDF</button>
        <button className="btn" onClick={onClose}>Close</button>
      </div>

      {/* Preview */}
      <div ref={printRef} style={{background:'#fff',padding:'24px 32px',border:'1px solid var(--line)',borderRadius:8,maxHeight:'70vh',overflow:'auto'}}>
        {/* Header banner */}
        <div style={{background:'#0F6E56',height:12,borderRadius:4,marginBottom:14}}/>
        <div style={{textAlign:'center',marginBottom:6}}>
          <div style={{fontFamily:'Georgia,serif',fontSize:13,letterSpacing:'.1em',color:'#2C1810',textTransform:'uppercase',marginBottom:4}}>
            Personalised Schedule
          </div>
          <div style={{fontFamily:'Georgia,serif',fontSize:18,fontWeight:600,color:'#0F6E56',marginBottom:10}}>
            {displayName(contact)}
          </div>
        </div>
        <div style={{height:2,background:'#0F6E56',marginBottom:16}}/>

        {/* Schedule table */}
        <table style={{width:'100%',borderCollapse:'collapse',fontSize:12.5}}>
          <tbody>
            {Object.entries(byDate).map(([date, rows]) => (
              <React.Fragment key={date}>
                {/* Date row */}
                <tr>
                  <td colSpan={2} style={{
                    background:'#F5F0E8', fontWeight:700, fontSize:13,
                    padding:'7px 10px', border:'1px solid #ccc',
                    fontFamily:'Georgia,serif'
                  }}>
                    {formatDateLong(date !== 'No date' ? date : '')}
                  </td>
                </tr>
                {/* Time rows */}
                {rows.map((r, i) => (
                  <tr key={i}>
                    <td style={{width:80,fontWeight:600,padding:'7px 10px',border:'1px solid #ccc',verticalAlign:'top',whiteSpace:'nowrap',fontFamily:'Georgia,serif'}}>
                      {r.time}
                    </td>
                    <td style={{padding:'7px 10px',border:'1px solid #ccc',verticalAlign:'top',fontFamily:'Georgia,serif',whiteSpace:'pre-line'}}>
                      {r.event}
                    </td>
                  </tr>
                ))}
              </React.Fragment>
            ))}
          </tbody>
        </table>

        {/* Hotel */}
        {L.hotelName && (
          <div style={{marginTop:14,fontSize:12.5,fontFamily:'Georgia,serif'}}>
            <b style={{color:'#0F6E56'}}>Stay</b>: {L.hotelName}
          </div>
        )}

        {/* Footer banner */}
        <div style={{background:'linear-gradient(135deg,#0F6E56,#1D9E75)',height:8,borderRadius:4,marginTop:20}}/>
      </div>
    </Modal>
  );
}

export function HelpGuide({ profile }) {
  const role = profile?.role || 'Volunteer';
  const [tab, setTab] = useState('features');

  const ALL_FEATURES = [
    { roles: ['Master', 'HOD', 'Volunteer'], icon: '🏠', title: 'Dashboard', desc: 'Your personalised home screen. Masters see the full event picture. HODs see their department tasks. Volunteers see their POC duties and assigned tasks.' },
    { roles: ['Master', 'HOD'], icon: '📋', title: 'Outreach', desc: 'The permanent expert directory. Add contacts, track confirmation status (Pending → Contacted → Tentative → Confirmed), log follow-up notes, and import from Excel. Confirming someone automatically creates a Logistics record.' },
    { roles: ['Master', 'HOD'], icon: '✈️', title: 'Logistics', desc: 'Travel and stay details for confirmed guests. Appears automatically when someone is confirmed. Fill in arrival mode, time, hotel check-in, and departure details.' },
    { roles: ['Master', 'HOD'], icon: '🗓️', title: 'Scheduling', desc: 'Three tabs: Event schedule (add/edit sessions), Session assignments (tick which panelist speaks at which session), and Sahebji one-on-ones (schedule individual meetings).' },
    { roles: ['Master', 'HOD', 'Volunteer'], icon: '👥', title: 'Volunteers & POC', desc: 'The volunteer directory and the per-day POC duty roster. Assign a volunteer to escort a VIP on a specific day. Swapping a sick POC only affects that day — other days are untouched.' },
    { roles: ['Master', 'HOD'], icon: '🙋', title: 'Volunteers', desc: 'One place for your volunteer directory and each person\'s availability for this event. Filter by city, area, department or day; tap a volunteer to edit their profile or day-by-day hours; import everyone (with availability) from Excel.' },
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
    { step: 7, title: 'Schedule founder meetings', desc: 'Scheduling → Sahebji one-on-ones. Set date and time for each VIP\'s meeting.' },
    { step: 8, title: 'Set volunteer availability', desc: 'Go to Volunteers → Add availability. Pick volunteers by city/area and mark the days and hours they are free.' },
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
  const [results, setResults] = useState([]);

  // Use effect instead of useMemo to avoid stale closure issues
  useEffect(() => {
    if (!q.trim() || q.length < 2) { setResults([]); return; }
    const t = q.toLowerCase();
    const out = [];
    try {
      const safe = k => Array.isArray(store?.[k]) ? store[k] : [];
      safe('contacts').forEach(c => {
        if (!c?.name) return;
        if ((c.name||'').toLowerCase().includes(t)||(c.org||'').toLowerCase().includes(t)||(c.phone||'').includes(t))
          out.push({type:'Contact', label:[c.honor,c.name,c.suffix].filter(Boolean).join(' '), sub:c.org||c.field||'', view:'outreach'});
      });
      safe('volunteers').forEach(v => {
        if (!v?.name) return;
        if ((v.name||'').toLowerCase().includes(t)||(v.skills||'').toLowerCase().includes(t))
          out.push({type:'Volunteer', label:v.name, sub:v.skills||'', view:'people'});
      });
      safe('sessions').forEach(s => {
        if (!s?.title) return;
        if ((s.title||'').toLowerCase().includes(t)||(s.topic||'').toLowerCase().includes(t))
          out.push({type:'Session', label:s.title, sub:s.topic||s.date||'', view:'schedule'});
      });
      safe('tasks').forEach(t2 => {
        if (!t2?.title) return;
        if (t2.title.toLowerCase().includes(t))
          out.push({type:'Task', label:t2.title, sub:t2.status||'', view:'depts'});
      });
      safe('departments').forEach(d => {
        if (!d?.name) return;
        if (d.name.toLowerCase().includes(t))
          out.push({type:'Department', label:d.name, sub:d.desc||'', view:'depts'});
      });
    } catch(e) { console.warn('Search error:', e); }
    setResults(out.slice(0, 20));
  }, [q, store]);

  useEffect(() => {
    const h = e => { if (e.key==='Escape') onClose(); };
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  const typeColor = { Contact:'var(--teal)', Volunteer:'var(--blue)', Session:'var(--purple)', Task:'var(--amber)', Department:'var(--muted)' };

  return (
    <div style={{position:'fixed',inset:0,background:'rgba(33,48,44,.42)',zIndex:80,display:'flex',alignItems:'flex-start',justifyContent:'center',padding:'60px 12px 20px'}}
      onMouseDown={onClose}>
      <div style={{background:'#fff',borderRadius:16,width:'100%',maxWidth:560,boxShadow:'0 24px 60px rgba(0,0,0,.25)',overflow:'hidden'}}
        onMouseDown={e=>e.stopPropagation()}>
        <div style={{display:'flex',alignItems:'center',gap:12,padding:'14px 18px',borderBottom:'1px solid var(--line)'}}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--muted)" strokeWidth="2"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>
          <input autoFocus style={{flex:1,border:'none',outline:'none',fontSize:16,fontFamily:'var(--sans)',color:'var(--ink)'}}
            placeholder="Search contacts, volunteers, sessions, tasks…"
            value={q} onChange={e=>setQ(e.target.value)}/>
          <button style={{border:'none',background:'none',color:'var(--muted)',cursor:'pointer',fontSize:13}} onClick={onClose}>Esc</button>
        </div>
        {results.length > 0 && (
          <div style={{maxHeight:400,overflow:'auto'}}>
            {results.map((r,i) => (
              <button key={i} onClick={()=>{onNavigate(r.view);onClose();}}
                style={{width:'100%',display:'flex',alignItems:'center',gap:12,padding:'11px 18px',border:'none',background:'none',cursor:'pointer',textAlign:'left',borderBottom:'1px solid var(--line)'}}>
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
        {q.length >= 2 && !results.length &&
          <div style={{padding:'24px',textAlign:'center',color:'var(--muted)',fontSize:13}}>No results for "<b>{q}</b>"</div>}
        {q.length < 2 &&
          <div style={{padding:'16px 18px',color:'var(--muted)',fontSize:13}}>Type at least 2 characters to search across all modules.</div>}
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
  const [picks, setPicks] = useState({}); // row index → chosen contactId ('' = skip)
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function handleFile(file) {
    setErr('');
    try {
      const { parseLogisticsFile, planLogisticsImport } = await import('./excel');
      const { items } = await parseLogisticsFile(file);
      if (!items.length) { setErr('No matching rows found. Make sure your sheet has a Name or Phone column.'); return; }
      const p = planLogisticsImport(items, store.contacts||[], store.logistics||[]);
      setPlan(p); setPicks({}); setStep('preview');
    } catch(e) { setErr('Could not read file: ' + (e.message||e)); }
  }

  async function commit() {
    setBusy(true);
    try {
      const { resolveLogisticsRow } = await import('./excel');
      const contacts = store.contacts||[];
      const rows = [];
      plan.plan.forEach((p, i) => {
        if (p.mode === 'new' || p.mode === 'update') rows.push(p);
        else if (p.mode === 'ambiguous' && picks[i]) {
          const c = contacts.find(x => x.id === picks[i]);
          if (c) rows.push(resolveLogisticsRow(p.row, c, store.logistics||[]));
        }
      });
      for (const row of rows) await saveItem('logistics', { ...row.item, eventId: activeEventId });
      onClose();
      const skipped = plan.plan.length - rows.length;
      toast(`Logistics imported — ${rows.length} saved${skipped?`, ${skipped} skipped`:''}.`);
    } catch(e) { setErr('Save failed: '+(e.message||e)); setBusy(false); }
  }

  const modeColor = m => m==='new'?'var(--teal)':m==='update'?'var(--amber)':m==='ambiguous'?'var(--blue)':'var(--rose)';
  const modeLabel = m => m==='new'?'New':m==='update'?'Update':m==='ambiguous'?'Choose':'No match';
  const pickedCount = plan ? plan.plan.filter((p,i)=>p.mode==='ambiguous'&&picks[i]).length : 0;
  const total = plan ? plan.newCount + plan.updateCount + pickedCount : 0;

  return (
    <Modal title="Import logistics from Excel" onClose={onClose} footer={null}>
      {err&&<div style={{background:'var(--rose-wash)',color:'var(--rose)',padding:'9px 12px',borderRadius:8,fontSize:13,marginBottom:12}}>{err}</div>}
      {step==='choose'&&<>
        <p className="muted-sm" style={{marginTop:0}}>Upload your travel sheet. Each row is matched to an existing contact by phone number or exact name. Close-but-not-exact matches are shown for you to confirm. Columns recognised: Name, Phone, Arrival Mode, Arrival Date, Arrival Time, Arrival Location, Hotel, Check-in, Departure Date, Departs for Airport, Flight Time, Special Requirements.</p>
        <label className="dropzone">
          <span style={{display:'flex',justifyContent:'center'}}>{ICON.upload}</span>
          <div>Click to choose a file (.xlsx or .csv)</div>
          <input type="file" accept=".xlsx,.xls,.csv" style={{display:'none'}} onChange={e=>handleFile(e.target.files[0])}/>
        </label>
        <div className="modal-foot" style={{padding:'12px 0 0'}}><button className="btn" onClick={onClose}>Cancel</button></div>
      </>}
      {step==='preview'&&plan&&<>
        <div style={{display:'flex',gap:16,marginBottom:12,flexWrap:'wrap'}}>
          <div><div style={{fontFamily:'var(--serif)',fontSize:24,color:'var(--teal)'}}>{plan.newCount}</div><div className="muted-sm">new</div></div>
          <div><div style={{fontFamily:'var(--serif)',fontSize:24,color:'var(--amber)'}}>{plan.updateCount}</div><div className="muted-sm">update</div></div>
          <div><div style={{fontFamily:'var(--serif)',fontSize:24,color:'var(--blue)'}}>{plan.ambiguousCount}</div><div className="muted-sm">need a choice</div></div>
          <div><div style={{fontFamily:'var(--serif)',fontSize:24,color:'var(--rose)'}}>{plan.unmatchedCount}</div><div className="muted-sm">no match</div></div>
        </div>
        {plan.ambiguousCount>0&&<div style={{background:'var(--blue-wash)',padding:'8px 12px',borderRadius:8,fontSize:12.5,color:'var(--blue)',marginBottom:10}}>
          Pick the right contact for rows marked "Choose". Rows left on "Skip" are not imported.
        </div>}
        {plan.unmatchedCount>0&&<div style={{background:'var(--amber-wash)',padding:'8px 12px',borderRadius:8,fontSize:12.5,color:'var(--amber)',marginBottom:10}}>
          ⚠ Unmatched rows will be skipped. Add these contacts in Outreach first, then import again.
        </div>}
        <div style={{maxHeight:'40vh',overflow:'auto',border:'1px solid var(--line)',borderRadius:8}}>
          <table className="import-tbl"><thead><tr><th>Name in sheet</th><th>Matched contact</th><th>Result</th></tr></thead><tbody>
            {plan.plan.map((p,i)=>(
              <tr key={i}>
                <td>{p.sheetName||'—'}</td>
                <td className="muted-sm">
                  {p.mode==='ambiguous'
                    ? <><select className="input" style={{padding:'4px 6px',fontSize:12.5}} value={picks[i]||''} onChange={e=>setPicks(x=>({...x,[i]:e.target.value}))}>
                        <option value="">Skip this row</option>
                        {p.candidates.map(c=><option key={c.id} value={c.id}>{c.name}{c.org?` — ${c.org}`:''}</option>)}
                      </select><div style={{fontSize:11,marginTop:2}}>{p.reason}</div></>
                    : p.mode!=='unmatched'?p.contactName:'—'}
                </td>
                <td><span style={{fontSize:11,fontWeight:700,color:modeColor(p.mode)}}>{modeLabel(p.mode)}</span></td>
              </tr>
            ))}
          </tbody></table>
        </div>
        <div className="modal-foot" style={{padding:'12px 0 0'}}>
          <button className="btn" onClick={()=>setStep('choose')}>Back</button>
          <button className="btn primary" onClick={commit} disabled={busy||total===0}>
            {busy?'Importing…':`Import ${total} row${total===1?'':'s'}`}
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
  const logiDone = conf.filter(c=>logi.some(l=>(l.contactId===c.id||l.id===c.id)&&(l.hotelName||l.arrivalDate||l.arrivalTime||l.hotel||l.inbTime)));
  const today = todayISO();
  const eventDays = [];
  if (event.startDate && event.endDate) {
    let d=new Date(event.startDate+'T12:00:00'); const end=new Date(event.endDate+'T12:00:00'); let g=0;
    while(d<=end&&g<20){eventDays.push(localISO(d));d=new Date(d);d.setDate(d.getDate()+1);g++;}
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

/* ============================ FEATURE 1: DATA MIGRATION TOOL ============================ */
export function MigrationTool({ store, activeEventId }) {
  const toast = useToast();
  const [files, setFiles] = useState([]); // [{file, detected, parsed, plan}]
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [step, setStep] = useState('upload'); // upload | preview | done

  const SHEET_TYPES = ['contacts','sessions','volunteers','tasks','logistics','departments'];

  async function detectAndParse(file) {
    const { parseContactsFile, parseSessionsFile, parseVolunteersFile, parseTasksFile, parseLogisticsFile } = await import('./excel');
    const PARSERS = { contacts: parseContactsFile, sessions: parseSessionsFile, volunteers: parseVolunteersFile, tasks: parseTasksFile, logistics: parseLogisticsFile };

    // Try each parser and pick the one that returns the most rows
    let best = { type: 'contacts', items: [], score: 0 };
    for (const [type, parser] of Object.entries(PARSERS)) {
      try {
        const result = await parser(file);
        if (result.items.length > best.score) {
          best = { type, items: result.items, score: result.items.length };
        }
      } catch {}
    }

    // Also check column headers for a definitive match
    try {
      const XLSX = await import('xlsx');
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: 'array' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const raw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
      const headers = (raw[0] || []).map(h => String(h).toLowerCase());
      const headerStr = headers.join(' ');
      if (headerStr.includes('hotel') || headerStr.includes('arrival') || headerStr.includes('departure')) best.type = 'logistics';
      else if (headerStr.includes('session') || headerStr.includes('topic') || (headerStr.includes('start') && headerStr.includes('end'))) best.type = 'sessions';
      else if (headerStr.includes('department') || headerStr.includes('dept') || headerStr.includes('hod')) best.type = 'departments';
      else if (headerStr.includes('task') || headerStr.includes('due date') || headerStr.includes('assignee')) best.type = 'tasks';
      else if (headerStr.includes('skills') || headerStr.includes('volunteer')) best.type = 'volunteers';
    } catch {}

    return { file, detected: best.type, items: best.items, score: best.score };
  }

  async function handleFiles(fileList) {
    const arr = Array.from(fileList);
    if (!arr.length) return;
    setBusy(true);
    try {
      const results = await Promise.all(arr.map(detectAndParse));
      setFiles(results);
      setStep('preview');
    } catch(e) { toast('Error reading files: ' + (e.message||e)); }
    finally { setBusy(false); }
  }

  function changeType(idx, type) {
    setFiles(prev => prev.map((f,i) => i===idx ? {...f, detected:type} : f));
  }

  async function commitAll() {
    setBusy(true);
    const { batchUpsert } = await import('./data');
    const { planImport, contactKey, planLogisticsImport, planSessionsImport, planVolunteersImport, planTasksImport } = await import('./excel');
    let totals = { contacts:0, sessions:0, volunteers:0, tasks:0, logistics:0, departments:0 };

    try {
      const { matchDept, matchVolunteer } = await import('./excel');
      const withIds = arr => arr.map(i => ({ ...i, id: i.id || crypto.randomUUID() }));
      const of = type => files.filter(f => f.detected === type);
      // Order matters: things that others link to are imported first, with known ids.
      // 1. Contacts (logistics links to them)
      let allContacts = [...(store.contacts||[])];
      for (const f of of('contacts')) {
        const plan = planImport(f.items, allContacts);
        const items = withIds(plan.plan.map(p => ({...p.item, eventId: activeEventId})));
        await batchUpsert('contacts', items);
        allContacts = [...allContacts.filter(c => !items.some(i => i.id === c.id)), ...items];
        totals.contacts += items.length;
      }
      // 2. Departments (tasks link to them)
      let allDepts = [...(store.departments||[])];
      for (const f of of('departments')) {
        const newDepts = withIds(f.items.filter(d => d.name && !matchDept(d.name, allDepts)));
        await batchUpsert('departments', newDepts);
        allDepts = [...allDepts, ...newDepts];
        totals.departments += newDepts.length;
      }
      // 3. Volunteers (task owners link to them)
      let allVols = [...(store.volunteers||[])];
      for (const f of of('volunteers')) {
        const plan = planVolunteersImport(f.items, allVols);
        const items = withIds(plan.plan.map(p => p.item));
        await batchUpsert('volunteers', items);
        allVols = [...allVols.filter(v => !items.some(i => i.id === v.id)), ...items];
        totals.volunteers += items.length;
      }
      // 4. Tasks — Department/Owner names linked to real records; unknown departments are created
      let ownerMisses = 0;
      for (const f of of('tasks')) {
        const plan = planTasksImport(f.items, store.tasks||[]);
        const items = [];
        for (const p of plan.plan) {
          const it = p.item;
          let dept = it.deptName ? matchDept(it.deptName, allDepts) : null;
          if (!dept && it.deptName) {
            dept = { id: crypto.randomUUID(), name: it.deptName.trim(), desc: '', hodIds: [] };
            await batchUpsert('departments', [dept]); allDepts.push(dept); totals.departments++;
          }
          const vol = it.assigneeName ? matchVolunteer(it.assigneeName, allVols) : null;
          if (it.assigneeName && !vol) ownerMisses++;
          items.push({ ...it, eventId: activeEventId, deptId: dept?.id || it.deptId || allDepts[0]?.id || '',
            assigneeId: vol?.id || it.assigneeId || '', deptName: '', assigneeName: vol || !it.assigneeName ? '' : it.assigneeName });
        }
        await batchUpsert('tasks', items);
        totals.tasks += items.length;
      }
      if (ownerMisses) toast(`${ownerMisses} task owner name${ownerMisses>1?'s':''} didn't match a volunteer — see the banner in Departments & Tasks.`);
      // 5. Logistics and sessions
      for (const f of of('logistics')) {
        const plan = planLogisticsImport(f.items, allContacts, store.logistics||[]);
        const items = plan.plan.filter(p => p.mode==='new' || p.mode==='update').map(p => ({...p.item, eventId: activeEventId}));
        await batchUpsert('logistics', items);
        totals.logistics += items.length;
      }
      for (const f of of('sessions')) {
        const plan = planSessionsImport(f.items, store.sessions||[]);
        const items = plan.plan.map(p => ({...p.item, eventId: activeEventId}));
        await batchUpsert('sessions', items);
        totals.sessions += items.length;
      }
      setDone(true); setStep('done');
      toast(`Migration complete! ${Object.entries(totals).filter(([,v])=>v>0).map(([k,v])=>`${v} ${k}`).join(', ')}.`);
    } catch(e) { toast('Migration failed: '+(e.message||e)); }
    finally { setBusy(false); }
  }

  const typeColor = {contacts:'var(--teal)',sessions:'var(--blue)',volunteers:'var(--purple)',tasks:'var(--amber)',logistics:'var(--amber)',departments:'var(--muted)'};
  const totalRows = files.reduce((s,f)=>s+f.score,0);

  return (
    <>
      <div className="page-head"><div className="ph-txt">
        <h1>Data Migration Tool</h1>
        <p>Upload all your existing Google Sheets at once. The tool auto-detects what each file contains and imports everything in one go.</p>
      </div></div>

      {step==='upload' && (
        <div className="panel">
          <div className="panel-head"><h2>Upload your sheets</h2><div className="desc">Upload up to 6 files — one per sheet type</div></div>
          <div className="panel-pad">
            <div className="flow-note" style={{marginBottom:20}}>{ICON.info}<div>Upload your existing Google Sheets exported as .xlsx files. You can upload all of them at once — contacts, logistics, sessions, volunteers, departments, and tasks. The tool will auto-detect what each file contains.</div></div>
            <label className="dropzone" style={{cursor:busy?'wait':'pointer'}}>
              <span style={{fontSize:32}}>📂</span>
              <div style={{fontWeight:600,fontSize:15,marginTop:4}}>Drop all your sheets here</div>
              <div style={{fontSize:13,color:'var(--muted)'}}>or click to choose files (.xlsx or .csv)</div>
              <input type="file" accept=".xlsx,.xls,.csv" multiple style={{display:'none'}} onChange={e=>handleFiles(e.target.files)} disabled={busy}/>
            </label>
            {busy && <div style={{textAlign:'center',padding:20,color:'var(--muted)'}}>Reading files…</div>}
          </div>
        </div>
      )}

      {step==='preview' && (
        <>
          <div className="flow-note">{ICON.info}<div>Review what was detected in each file. Change the type if the auto-detection is wrong. Then click <b>Import all</b> to migrate everything.</div></div>
          {files.map((f,i) => (
            <div className="panel" key={i} style={{marginBottom:14}}>
              <div className="panel-head">
                <div>
                  <div className="nm">{f.file.name}</div>
                  <div className="muted-sm">{f.score} rows detected</div>
                </div>
                <div className="right" style={{alignItems:'center',gap:10}}>
                  <span style={{fontSize:12,color:'var(--muted)'}}>Type:</span>
                  <select className="statsel" value={f.detected} onChange={e=>changeType(i,e.target.value)}
                    style={{background:typeColor[f.detected]+'18',color:typeColor[f.detected],fontWeight:600}}>
                    {SHEET_TYPES.map(t=><option key={t} value={t}>{t.charAt(0).toUpperCase()+t.slice(1)}</option>)}
                  </select>
                </div>
              </div>
              {f.items.length > 0 && (
                <div style={{padding:'8px 16px 12px'}}>
                  <div style={{fontSize:12,color:'var(--muted)',marginBottom:6}}>Preview (first 3 rows):</div>
                  <div style={{overflowX:'auto'}}>
                    <table className="import-tbl" style={{fontSize:12}}>
                      <thead><tr>{Object.keys(f.items[0]||{}).slice(0,6).map(k=><th key={k}>{k}</th>)}</tr></thead>
                      <tbody>{f.items.slice(0,3).map((row,j)=><tr key={j}>{Object.keys(f.items[0]).slice(0,6).map(k=><td key={k}>{String(row[k]||'').slice(0,40)}</td>)}</tr>)}</tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          ))}
          <div style={{display:'flex',gap:12,justifyContent:'flex-end',marginTop:8,paddingBottom:40}}>
            <button className="btn" onClick={()=>{setFiles([]);setStep('upload');}}>Start over</button>
            <button className="btn primary" onClick={commitAll} disabled={busy||!totalRows}>
              {busy?'Importing…':`Import all ${totalRows} rows across ${files.length} files`}
            </button>
          </div>
        </>
      )}

      {step==='done' && (
        <div className="panel panel-pad" style={{textAlign:'center',padding:'40px 20px'}}>
          <div style={{fontSize:48,marginBottom:12}}>✅</div>
          <div style={{fontFamily:'var(--serif)',fontSize:22,marginBottom:8}}>Migration complete</div>
          <p style={{color:'var(--muted)',fontSize:14,marginBottom:20}}>All your data has been imported. Go to Outreach to verify your contacts, Logistics to check travel details, and Scheduling to review sessions.</p>
          <div style={{display:'flex',gap:10,justifyContent:'center',flexWrap:'wrap'}}>
            <button className="btn" onClick={()=>{setFiles([]);setStep('upload');}}>Import more files</button>
          </div>
        </div>
      )}
    </>
  );
}

/* ============================================================
   FEATURE 5: WHATSAPP BROADCAST LIST GENERATOR
   ============================================================ */
export function WhatsAppBroadcast({ contacts, onClose }) {
  const [selected, setSelected] = useState(new Set(contacts.map(c=>c.id)));
  const [msgTemplate, setMsgTemplate] = useState('invite');
  const [copied, setCopied] = useState('');

  const TEMPLATES = {
    invite: 'Jai Jinendra! We cordially invite you to Vasudhaiva Kutumbakam Ki Oar — a gathering of eminent experts in law, geopolitics and economics. Kindly confirm your participation.',
    confirm: 'Jai Jinendra! Thank you for confirming your participation in VK 4.0. We are truly honoured. Our team will reach out with further details shortly.',
    followup: 'Jai Jinendra! This is a gentle follow-up regarding your participation in VK 4.0. We would be grateful to receive your confirmation at your earliest convenience.',
    reminder: 'Jai Jinendra! A reminder that VK 4.0 is approaching. Please confirm your attendance so we can make the necessary arrangements.',
  };

  const sel = contacts.filter(c=>selected.has(c.id));

  const phoneList = sel.map(c=>`${displayName(c)}: ${c.phone||'—'}`).join('\n');
  const numbersOnly = sel.map(c=>String(c.phone||'').replace(/[^\d+]/g,'')).filter(p=>p.length>=7).join('\n');
  const fullMessage = sel.map((c,i)=>`${i+1}. ${displayName(c)}\n   ${c.phone||'—'}\n   ${TEMPLATES[msgTemplate]}`).join('\n\n');

  function copy(text, key) {
    navigator.clipboard.writeText(text);
    setCopied(key);
    setTimeout(()=>setCopied(''), 2000);
  }

  return (
    <Modal title={`WhatsApp Broadcast — ${sel.length} contacts`} onClose={onClose} footer={null}>
      <div style={{display:'flex',gap:8,marginBottom:12,flexWrap:'wrap'}}>
        {contacts.map(c=>(
          <label key={c.id} style={{display:'flex',alignItems:'center',gap:5,padding:'4px 10px',borderRadius:20,
            border:`1.5px solid ${selected.has(c.id)?'var(--teal)':'var(--line)'}`,
            background:selected.has(c.id)?'var(--teal-wash)':'#fff',cursor:'pointer',fontSize:12.5}}>
            <input type="checkbox" checked={selected.has(c.id)} onChange={()=>{
              const s=new Set(selected); s.has(c.id)?s.delete(c.id):s.add(c.id); setSelected(s);
            }} style={{accentColor:'var(--teal)',marginRight:2}}/>{c.name}
          </label>
        ))}
      </div>
      <div style={{display:'flex',gap:6,marginBottom:12,flexWrap:'wrap'}}>
        {Object.entries({invite:'Invitation',confirm:'Confirmation',followup:'Follow-up',reminder:'Reminder'}).map(([k,v])=>(
          <button key={k} className={'btn sm'+(msgTemplate===k?' primary':'')} onClick={()=>setMsgTemplate(k)}>{v}</button>
        ))}
      </div>
      <div className="split-2" style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10,marginBottom:12}}>
        <div>
          <div style={{fontSize:11.5,fontWeight:600,color:'var(--muted)',marginBottom:6}}>NAMES + PHONES</div>
          <div style={{background:'#F9F8F4',borderRadius:8,padding:'10px 12px',fontSize:12,fontFamily:'var(--mono)',whiteSpace:'pre-wrap',maxHeight:120,overflow:'auto',border:'1px solid var(--line)'}}>{phoneList||'—'}</div>
          <button className="btn sm" style={{marginTop:6,width:'100%'}} onClick={()=>copy(phoneList,'names')}>
            {copied==='names'?'✓ Copied!':'📋 Copy list'}
          </button>
        </div>
        <div>
          <div style={{fontSize:11.5,fontWeight:600,color:'var(--muted)',marginBottom:6}}>NUMBERS ONLY</div>
          <div style={{background:'#F9F8F4',borderRadius:8,padding:'10px 12px',fontSize:12,fontFamily:'var(--mono)',whiteSpace:'pre-wrap',maxHeight:120,overflow:'auto',border:'1px solid var(--line)'}}>{numbersOnly||'—'}</div>
          <button className="btn sm" style={{marginTop:6,width:'100%'}} onClick={()=>copy(numbersOnly,'nums')}>
            {copied==='nums'?'✓ Copied!':'📋 Copy numbers'}
          </button>
        </div>
      </div>
      <div>
        <div style={{fontSize:11.5,fontWeight:600,color:'var(--muted)',marginBottom:6}}>PERSONALISED MESSAGE (paste into WhatsApp one by one)</div>
        <div style={{background:'#ECF8ED',borderRadius:8,padding:'10px 12px',fontSize:12,lineHeight:1.5,whiteSpace:'pre-wrap',maxHeight:180,overflow:'auto',border:'1px solid #D4EDDA'}}>{fullMessage||'—'}</div>
        <button className="btn primary sm" style={{marginTop:6,width:'100%'}} onClick={()=>copy(fullMessage,'full')}>
          {copied==='full'?'✓ Copied!':'📋 Copy personalised messages'}
        </button>
      </div>
      <div className="modal-foot" style={{padding:'12px 0 0'}}>
        <button className="btn" onClick={onClose}>Close</button>
      </div>
    </Modal>
  );
}

/* ============================================================
   FEATURE 6: FOLLOW-UP DUE DATES
   ============================================================ */
export function FollowUpDueToday({ store, go }) {
  const today = todayISO();
  const notes = store.contact_notes || [];
  const contacts = store.contacts || [];
  const due = notes.filter(n => n.dueDate && n.dueDate <= today && !n.done);
  const overdue = due.filter(n => n.dueDate < today);
  const todayDue = due.filter(n => n.dueDate === today);
  if (!due.length) return null;
  return (
    <div className="panel" style={{borderColor:overdue.length?'var(--rose)':'var(--amber)',borderWidth:2,marginBottom:18}}>
      <div className="panel-head" style={{background:overdue.length?'var(--rose-wash)':'var(--amber-wash)'}}>
        <h2 style={{color:overdue.length?'var(--rose)':'var(--amber)'}}>
          {overdue.length?`⚠ ${overdue.length} overdue follow-up${overdue.length>1?'s':''}`:`📅 ${todayDue.length} follow-up${todayDue.length>1?'s':''} due today`}
        </h2>
      </div>
      <div className="panel-body"><table><tbody>
        {due.slice(0,5).map(n=>{
          const c=contacts.find(x=>x.id===n.contactId);
          const isOverdue = n.dueDate < today;
          return <tr key={n.id}>
            <td><div className="person"><div className="avatar" style={isOverdue?{background:'var(--rose-wash)',color:'var(--rose)'}:{}}>{initials(c?.name||'?')}</div>
              <div><div className="nm">{c?displayName(c):'Unknown'}</div>
              <div className="role">{n.text?.slice(0,60)}{n.text?.length>60?'…':''}</div></div></div></td>
            <td><span style={{fontSize:12,fontWeight:600,color:isOverdue?'var(--rose)':'var(--amber)'}}>{isOverdue?`Overdue (${n.dueDate})`:`Due today`}</span></td>
            <td style={{textAlign:'right'}}><button className="btn sm" onClick={()=>go('outreach')}>Open Outreach</button></td>
          </tr>;
        })}
        {due.length>5&&<tr><td colSpan="3"><span className="muted-sm">+{due.length-5} more</span></td></tr>}
      </tbody></table></div>
    </div>
  );
}

/* ============================================================
   FEATURE 9: VIP ARRIVAL COUNTDOWN WIDGET
   ============================================================ */
/* ── ArrivalCountdown widget (standalone) ─────────────────────── */
function ArrivalWidget({label, count, color, names}) {
  return (
    <div style={{background:'var(--surface)',border:`2px solid ${color}20`,borderTop:`3px solid ${color}`,borderRadius:'var(--r-lg)',padding:'12px 14px',flex:1,minWidth:120}}>
      <div style={{fontSize:28,fontFamily:'var(--serif)',color,lineHeight:1,fontWeight:500}}>{count}</div>
      <div style={{fontSize:11.5,fontWeight:600,color:'var(--muted)',marginTop:3,marginBottom:6,textTransform:'uppercase',letterSpacing:'.05em'}}>{label}</div>
      {names.slice(0,3).map((n,i)=><div key={i} style={{fontSize:11,color:'var(--muted)',lineHeight:1.4}}>{n}</div>)}
      {names.length>3&&<div style={{fontSize:11,color:'var(--faint)'}}>+{names.length-3} more</div>}
    </div>
  );
}


export function ArrivalCountdown({ store }) {
  const contacts = store.contacts || [];
  const logi = store.logistics || [];
  const today = todayISO();
  const tomorrow = tomorrowISO();

  const getL = cid => { const L = logi.find(l=>l.contactId===cid||l.id===cid)||{}; return { ...L, inbDate: L.arrivalDate||L.inbDate, outDate: L.departureDate||L.outDate, inbTime: L.arrivalTime||L.inbTime, outDepart: L.departureTime||L.outDepart }; };
  const conf = contacts.filter(c=>c.status==='Confirmed');
  const arriving_today = conf.filter(c=>getL(c.id).inbDate===today);
  const arriving_tomorrow = conf.filter(c=>getL(c.id).inbDate===tomorrow);
  const on_site = conf.filter(c=>{const L=getL(c.id);return L.inbDate&&L.outDate&&L.inbDate<=today&&L.outDate>=today;});
  const departing_today = conf.filter(c=>getL(c.id).outDate===today);

  // ArrivalWidget is defined as standalone function

  return (
    <div style={{display:'flex',gap:10,flexWrap:'wrap',marginBottom:18}}>
      <ArrivalWidget label="Arriving today" count={arriving_today.length} color="var(--teal)" names={arriving_today.map(c=>`${c.name} · ${getL(c.id).inbTime||'—'}`)}/>
      <ArrivalWidget label="On-site now" count={on_site.length} color="var(--blue)" names={on_site.map(c=>c.name)}/>
      <ArrivalWidget label="Arriving tomorrow" count={arriving_tomorrow.length} color="var(--amber)" names={arriving_tomorrow.map(c=>c.name)}/>
      <ArrivalWidget label="Departing today" count={departing_today.length} color="var(--rose)" names={departing_today.map(c=>`${c.name} · ${getL(c.id).outDepart||'—'}`)}/>
    </div>
  );
}

/* ============================================================
   FEATURE 8: DEPARTMENT COMPLETION NOTIFICATION
   ============================================================ */
export function DeptCompletionBanner({ store }) {
  const depts = store.departments || [];
  const tasks = store.tasks || [];
  const justCompleted = depts.filter(d=>{
    const dt = tasks.filter(t=>t.deptId===d.id);
    return dt.length > 0 && dt.every(t=>t.status==='Done') && !d.notified;
  });
  if (!justCompleted.length) return null;
  return (
    <div style={{background:'var(--teal-wash)',border:'2px solid var(--teal)',borderRadius:'var(--r-lg)',padding:'12px 16px',marginBottom:18,display:'flex',alignItems:'center',gap:12,flexWrap:'wrap'}}>
      <span style={{fontSize:20}}>🎉</span>
      <div style={{flex:1}}>
        <div style={{fontWeight:600,fontSize:14,color:'var(--teal)'}}>All tasks complete!</div>
        <div style={{fontSize:13,color:'var(--muted)',marginTop:2}}>
          {justCompleted.map(d=>d.name).join(', ')} {justCompleted.length===1?'has':'have'} completed all tasks.
          {justCompleted.some(d=>!d.ready)&&' HODs can now mark their department as ready in Department Master.'}
        </div>
      </div>
    </div>
  );
}
