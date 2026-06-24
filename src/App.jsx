import { useState, useEffect, useMemo } from 'react';
import './styles.css';
import { useLiveData, scopedStore, seedSampleData, setActiveEventId, saveItem, removeItem, COLLECTIONS } from './data';
import { useAuth, LoginScreen, PendingScreen } from './auth';
import { ICON, Modal, Field, useToast } from './ui';
import { initials, displayName, shortDate } from './schedule';
import { Dashboard, Outreach, Logistics, Scheduling, People, Depts, Reports, ControlRoom,
         FelicitationKits, VolunteerAvailability, SmartPOC, EventDayChecklist,
         DepartmentMaster, AllEventsDashboard, NotificationBell, ExportData, HelpGuide,
         GlobalSearch } from './views';
import { Settings } from './settings';

const NAV = [
  { id:'dash',         label:'Dashboard',           icon:'dash'     },
  { id:'controlroom',  label:'Control Room',         icon:'inbox'    },
  { id:'outreach',     label:'Outreach',             icon:'outreach', count: s=>(s.contacts||[]).length },
  { id:'logistics',    label:'Logistics',            icon:'truck',    count: s=>(s.contacts||[]).filter(c=>c.status==='Confirmed').length },
  { id:'schedule',     label:'Scheduling',           icon:'cal'      },
  { id:'people',       label:'Volunteers & POC',     icon:'users',    count: s=>(s.volunteers||[]).length },
  { id:'depts',        label:'Departments & Tasks',  icon:'dept',     count: s=>(s.tasks||[]).filter(t=>t.status!=='Done').length },
  { id:'reports',      label:'Generate',             icon:'doc'      },
  { id:'checklist',    label:'Event Checklist',      icon:'check'    },
  { id:'felicitation', label:'Felicitation Kits',    icon:'doc'      },
  { id:'availability', label:'Vol. Availability',    icon:'users'    },
  { id:'smartpoc',     label:'Smart POC',            icon:'users'    },
  { id:'allevents',    label:'All Events',           icon:'dash'     },
  { id:'deptmaster',   label:'Department Master',    icon:'dept'     },
  { id:'export',       label:'Export Data',          icon:'doc'      },
  { id:'help',         label:'Help & Guide',         icon:'info'     },
  { id:'events',       label:'Events',               icon:'cal'      },
  { id:'settings',     label:'Settings',             icon:'users'    },
];

export default function App() {
  const { user, profile, ready, logout } = useAuth();
  if (!ready) return <div className="loading">Loading…</div>;
  if (!user)  return <LoginScreen />;
  if (user && profile === null) return <div className="loading">Setting up your account…</div>;
  if (user && profile?.status === 'pending')  return <PendingScreen user={user} logout={logout} />;
  if (user && profile?.status === 'rejected') return (
    <div className="auth-wrap"><div className="auth-card">
      <h1>Access denied</h1>
      <p style={{color:'var(--muted)',margin:'10px 0 16px'}}>Your account request was rejected. Contact your Master admin.</p>
      <button className="btn ghost" onClick={logout}>Sign out</button>
    </div></div>
  );
  if (user && profile?.role === 'Volunteer') return <VolunteerShell user={user} profile={profile} logout={logout}/>;
  return <Shell user={user} profile={profile} logout={logout}/>;
}

/* ---- Main shell (Master / HOD) ---- */
function Shell({ user, profile, logout }) {
  const rawStore = useLiveData();
  const toast = useToast();
  const [view, setView] = useState('dash');
  const [sideOpen, setSideOpen] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [eventModal, setEventModal] = useState(null);
  const [online, setOnline] = useState(navigator.onLine);

  useEffect(() => {
    const on = () => setOnline(true), off = () => setOnline(false);
    window.addEventListener('online', on); window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);

  useEffect(() => {
    const h = e => { if ((e.metaKey||e.ctrlKey) && e.key==='k') { e.preventDefault(); setShowSearch(true); } };
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h);
  }, []);

  const loaded = COLLECTIONS.every(c => rawStore[c] !== null);
  const { activeEventId } = rawStore;
  const store = scopedStore(rawStore, activeEventId);
  const activeEvent = (rawStore.events||[]).find(e => e.id === activeEventId);

  const go = v => { setView(v); setSideOpen(false); window.scrollTo(0,0); };

  async function maybeSeed() {
    if ((rawStore.contacts||[]).length > 0) { toast('There is already data — sample data not added.'); return; }
    await seedSampleData(); toast('Sample data added.');
  }

  async function saveEvent(ev) {
    const isNew = !ev.id;
    const id = await saveItem('events', ev);
    if (isNew) { await setActiveEventId(id); toast(`Event "${ev.name}" created and set as active.`); }
    else toast('Event updated.');
    setEventModal(null);
  }

  async function deleteEvent(ev) {
    const cols = ['contacts','logistics','sessions','assignments','founder','poc','tasks'];
    for (const col of cols) {
      const rows = (rawStore[col]||[]).filter(r => r.eventId === ev.id);
      for (const r of rows) await removeItem(col, r.id);
    }
    await removeItem('events', ev.id);
    if (activeEventId === ev.id) {
      const remaining = (rawStore.events||[]).filter(e => e.id !== ev.id);
      await setActiveEventId(remaining[0]?.id || null);
    }
    toast(`Event "${ev.name}" deleted.`);
    setEventModal(null);
  }

  const VIEWS = {
    dash: Dashboard, controlroom: ControlRoom, outreach: Outreach,
    logistics: Logistics, schedule: Scheduling, people: People,
    depts: Depts, reports: Reports, checklist: EventDayChecklist,
    felicitation: FelicitationKits, availability: VolunteerAvailability,
    smartpoc: SmartPOC, allevents: AllEventsDashboard, deptmaster: DepartmentMaster,
    export: ExportData, help: HelpGuide, events: EventsView, settings: Settings,
  };
  const Active = VIEWS[view] || Dashboard;

  return (
    <div className="app">
      <div className={'side-overlay'+(sideOpen?' open':'')} onClick={()=>setSideOpen(false)}/>
      <aside className={'side'+(sideOpen?' open':'')}>
        <div className="brand">
          <div className="mark">वि</div>
          <div><div className="name">VK Outreach</div><div className="sub">Program · JYOT</div></div>
        </div>
        <div className="nav-label">Workflow</div>
        <nav>
          {NAV.map(n => {
            const ct = n.count ? n.count(store) : null;
            return (
              <button key={n.id} className={'nav-item'+(view===n.id?' active':'')} onClick={()=>go(n.id)}>
                {ICON[n.icon]||ICON.doc}<span>{n.label}</span>
                {ct!=null && <span className="ct">{ct}</span>}
              </button>
            );
          })}
        </nav>
        <div className="side-foot">Live sync · changes are shared with the team instantly.</div>
      </aside>

      <div className="main">
        <header className="topbar">
          <button className="btn ghost sm" onClick={()=>setSideOpen(o=>!o)} aria-label="Menu">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M3 12h18M3 6h18M3 18h18"/>
            </svg>
          </button>
          <div style={{display:'flex',alignItems:'center',gap:6,flex:1,minWidth:0}}>
            <select className="statsel" style={{maxWidth:180,fontFamily:'var(--serif)',fontWeight:500,fontSize:13}}
              value={activeEventId||''}
              onChange={e=>{setActiveEventId(e.target.value);toast('Event switched.');}}>
              {!(rawStore.events||[]).length && <option value="">No events</option>}
              {(rawStore.events||[]).map(ev=><option key={ev.id} value={ev.id}>{ev.name}</option>)}
            </select>
            <button className="btn ghost sm" title="Edit event" onClick={()=>activeEvent&&setEventModal({type:'edit',item:activeEvent})}>{ICON.edit}</button>
            <button className="btn primary sm" onClick={()=>setEventModal({type:'add'})} style={{whiteSpace:'nowrap'}}>
              {ICON.plus}<span className="hide-xs">New event</span>
            </button>
          </div>
          {online
            ? <span className="synced"><span className="d"/>Live</span>
            : <span style={{display:'inline-flex',alignItems:'center',gap:5,fontSize:11,color:'var(--amber)',background:'var(--amber-wash)',padding:'3px 10px',borderRadius:20,fontWeight:500}}>⚡ Offline — changes saved locally</span>}
          <button className="btn ghost sm" onClick={()=>setShowSearch(true)} title="Search (⌘K)">🔍</button>
          <NotificationBell store={store} profile={profile}/>
          <button className="btn ghost sm" onClick={()=>go('help')} title="Help">?</button>
          <div className="top-actions">
            {loaded && !(rawStore.events||[]).length && <button className="btn sm" onClick={maybeSeed}>Sample data</button>}
            <div className="userchip"><div className="av">{initials(user.email)}</div><span>{user.email}</span></div>
            <button className="btn ghost sm" onClick={logout}>Out</button>
          </div>
        </header>

        <div className="content">
          {!loaded
            ? <div className="loading">Connecting…</div>
            : !activeEventId && view !== 'events'
              ? <NoEvent onGo={()=>go('events')} onSeed={maybeSeed}/>
              : <Active store={store} rawStore={rawStore} activeEventId={activeEventId}
                        go={go} profile={profile}
                        onEditEvent={ev=>setEventModal({type:'edit',item:ev})}
                        onDeleteEvent={deleteEvent}/>}
        </div>
      </div>

      {showSearch && <GlobalSearch store={store} onNavigate={v=>{go(v);}} onClose={()=>setShowSearch(false)}/>}
      {eventModal && <EventModal item={eventModal.item} events={rawStore.events||[]} onClose={()=>setEventModal(null)} onSave={saveEvent} onDelete={eventModal.type==='edit'?()=>deleteEvent(eventModal.item):null}/>}
    </div>
  );
}

/* ---- Volunteer shell (simplified read-only view) ---- */
function VolunteerShell({ user, profile, logout }) {
  const rawStore = useLiveData();
  const { activeEventId } = rawStore;
  const store = scopedStore(rawStore, activeEventId);
  const [view, setView] = useState('checklist');
  const go = v => { setView(v); window.scrollTo(0,0); };

  return (
    <div className="app">
      <aside className="side">
        <div className="brand"><div className="mark">वि</div><div><div className="name">VK Outreach</div><div className="sub">Volunteer View</div></div></div>
        <div className="nav-label">My Work</div>
        <nav>
          <button className={'nav-item'+(view==='checklist'?' active':'')} onClick={()=>go('checklist')}>{ICON.check||ICON.doc}<span>Event Checklist</span></button>
          <button className={'nav-item'+(view==='help'?' active':'')} onClick={()=>go('help')}>{ICON.info}<span>Help & Guide</span></button>
        </nav>
        <div className="side-foot">Volunteer view · read-only</div>
      </aside>
      <div className="main">
        <header className="topbar">
          <div className="evt">VK Outreach <span>Volunteer</span></div>
          <div className="top-actions">
            <div className="userchip"><div className="av">{(user.email||'?')[0].toUpperCase()}</div><span>{user.email}</span></div>
            <button className="btn ghost sm" onClick={logout}>Sign out</button>
          </div>
        </header>
        <div className="content">
          {view==='checklist' && <EventDayChecklist store={store} activeEventId={activeEventId}/>}
          {view==='help' && <HelpGuide profile={profile}/>}
        </div>
      </div>
    </div>
  );
}

/* ---- No event placeholder ---- */
function NoEvent({ onGo, onSeed }) {
  return (
    <div style={{padding:'60px 20px',textAlign:'center',color:'var(--muted)'}}>
      <div style={{fontFamily:'var(--serif)',fontSize:22,marginBottom:10,color:'var(--ink)'}}>No event selected</div>
      <p style={{marginBottom:18}}>Create your first event or load sample data.</p>
      <div style={{display:'flex',gap:10,justifyContent:'center',flexWrap:'wrap'}}>
        <button className="btn primary" onClick={onGo}>{ICON.plus}Create event</button>
        <button className="btn" onClick={onSeed}>Add sample data</button>
      </div>
    </div>
  );
}

/* ---- Events view ---- */
function EventsView({ rawStore, activeEventId, onEditEvent, onDeleteEvent }) {
  const toast = useToast();
  const events = rawStore.events||[];
  return (
    <>
      <div className="page-head"><div className="ph-txt"><h1>Events</h1><p>Manage all events. Switch the active event from the topbar.</p></div></div>
      <div className="panel">
        <div className="panel-head"><h2>All events</h2><div className="desc">{events.length} events</div></div>
        <div className="panel-body"><table><thead><tr><th>Event</th><th>Type</th><th>Dates</th><th>Venue</th><th>Linked to</th><th></th></tr></thead><tbody>
          {events.map(ev => {
            const parent = events.find(e=>e.id===ev.parentId);
            return (
              <tr key={ev.id}>
                <td><div className="nm">{ev.name}{activeEventId===ev.id&&<span className="badge b-confirmed" style={{marginLeft:7,fontSize:10}}>Active</span>}</div></td>
                <td><span className="badge b-type">{ev.type}</span></td>
                <td className="muted-sm">{ev.startDate}{ev.endDate&&ev.endDate!==ev.startDate?' – '+ev.endDate:''}</td>
                <td className="muted-sm">{ev.venue||'—'}</td>
                <td className="muted-sm">{parent?parent.name:'—'}</td>
                <td><div className="rowacts">
                  <button className="btn ghost xs" onClick={()=>{setActiveEventId(ev.id);toast(`Switched to "${ev.name}".`);}}>Switch</button>
                  <button className="btn ghost xs" onClick={()=>onEditEvent(ev)}>{ICON.edit}</button>
                  <button className="btn ghost xs" onClick={()=>onDeleteEvent(ev)}>{ICON.trash}</button>
                </div></td>
              </tr>
            );
          })}
          {!events.length&&<tr><td colSpan="6"><div className="empty">{ICON.inbox}<h3>No events yet</h3><p>Click "New event" in the topbar.</p></div></td></tr>}
        </tbody></table></div>
      </div>
    </>
  );
}

/* ---- Event modal ---- */
function EventModal({ item, events, onClose, onSave, onDelete }) {
  const EVENT_TYPES = ['Conclave','Precursor','Exhibition','Podcast','Other'];
  const STATUS_OPTS = ['Planning','Active','Completed','Cancelled'];
  const [f, setF] = useState(()=>({name:'',type:'Conclave',startDate:'',endDate:'',venue:'',status:'Planning',parentId:'',notes:'',...item}));
  const set = k => e => setF(p=>({...p,[k]:e.target.value}));
  const [confirmDel, setConfirmDel] = useState(false);
  return (
    <Modal title={item?'Edit event':'New event'} onClose={onClose} onSave={()=>onSave(f)} saveLabel={item?'Save changes':'Create event'}>
      <Field label="Event name"><input className="input" value={f.name} onChange={set('name')} placeholder="e.g. VK 5.0"/></Field>
      <div className="grid2">
        <Field label="Type"><select className="input" value={f.type} onChange={set('type')}>{EVENT_TYPES.map(t=><option key={t}>{t}</option>)}</select></Field>
        <Field label="Status"><select className="input" value={f.status} onChange={set('status')}>{STATUS_OPTS.map(s=><option key={s}>{s}</option>)}</select></Field>
        <Field label="Start date"><input className="input" type="date" value={f.startDate} onChange={set('startDate')}/></Field>
        <Field label="End date"><input className="input" type="date" value={f.endDate} onChange={set('endDate')}/></Field>
        <Field label="Venue / City"><input className="input" value={f.venue} onChange={set('venue')} placeholder="Mumbai"/></Field>
        <Field label="Link to parent event">
          <select className="input" value={f.parentId} onChange={set('parentId')}>
            <option value="">— None —</option>
            {events.filter(e=>e.id!==item?.id).map(e=><option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
        </Field>
      </div>
      <Field label="Notes"><input className="input" value={f.notes} onChange={set('notes')}/></Field>
      {onDelete && (
        <div style={{marginTop:14,padding:12,background:'var(--rose-wash)',borderRadius:8}}>
          {!confirmDel
            ? <button className="btn danger sm" onClick={()=>setConfirmDel(true)}>{ICON.trash}Delete this event and all its data</button>
            : <div style={{display:'flex',alignItems:'center',gap:8,flexWrap:'wrap'}}>
                <span style={{fontSize:13,color:'var(--rose)'}}>Delete all data for this event. Sure?</span>
                <button className="btn danger sm" onClick={onDelete}>Yes, delete</button>
                <button className="btn sm" onClick={()=>setConfirmDel(false)}>Cancel</button>
              </div>}
        </div>
      )}
    </Modal>
  );
}
