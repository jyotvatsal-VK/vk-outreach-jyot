import { useState, useEffect } from 'react';
import './styles.css';
import {
  useLiveData, scopedStore, seedSampleData, setActiveEventId, setMyActiveEventId,
  saveItem, softDeleteEvent, COLLECTIONS,
} from './data';
import { useAuth, LoginScreen, PendingScreen, VerifyEmailScreen } from './auth';
import { ICON, Modal, Field, useToast } from './ui';
import { initials, todayISO } from './schedule';
import { hasPermission } from './permissions';
import { Dashboard, Outreach, Logistics, Scheduling, Volunteers, Depts, Reports,
         POCAllocation, ExportData, NotificationBell, GlobalSearch } from './views';
import { Settings } from './settings';

const NAV = [
  { id:'dash',         label:'Dashboard',            icon:'dash'     },
  { id:'outreach',     label:'Outreach',              icon:'outreach', count: s=>(s.contacts||[]).length },
  { id:'logistics',    label:'Logistics',             icon:'truck',    count: s=>(s.contacts||[]).filter(c=>c.status==='Confirmed').length },
  { id:'schedule',     label:'Scheduling',            icon:'cal'      },
  // 'people' covers the old Volunteer Directory and Vol. Availability screens (merged)
  { id:'people',       label:'Volunteers',            icon:'users',    count: s=>(s.volunteers||[]).length, also:['availability'] },
  { id:'depts',        label:'Departments & Tasks',   icon:'dept',     count: s=>(s.tasks||[]).filter(t=>t.status!=='Done').length },
  { id:'reports',      label:'Personalised Schedule', icon:'doc'      },
  { id:'pocallocation',label:'POC Allocation',        icon:'users'    },
  { id:'export',       label:'Export Data',           icon:'doc'      },
  { id:'settings',     label:'Settings',              icon:'users'    },
];

/* Single breakpoint shared with styles.css (@media max-width:900px) */
const MOBILE_QUERY = '(max-width: 900px)';
function useIsMobile() {
  const get = () => typeof window !== 'undefined' && window.matchMedia(MOBILE_QUERY).matches;
  const [m, setM] = useState(get);
  useEffect(() => {
    const mq = window.matchMedia(MOBILE_QUERY);
    const h = () => setM(mq.matches);
    mq.addEventListener ? mq.addEventListener('change', h) : mq.addListener(h);
    return () => { mq.removeEventListener ? mq.removeEventListener('change', h) : mq.removeListener(h); };
  }, []);
  return m;
}

function AuthMessage({ title, children, logout, action }) {
  return (
    <div className="auth-wrap"><div className="auth-card">
      <h1>{title}</h1>
      <div style={{color:'var(--muted)',margin:'10px 0 16px',fontSize:13.5}}>{children}</div>
      {action}
      <button className="btn ghost" style={{width:'100%',justifyContent:'center'}} onClick={logout}>Sign out</button>
    </div></div>
  );
}

export default function App() {
  const { user, profile, ready, logout, needsVerification, profileError, retryProfile } = useAuth();
  if (!ready) return <div className="loading">Loading…</div>;
  if (!user)  return <LoginScreen />;
  if (needsVerification) return <VerifyEmailScreen user={user} logout={logout} retry={retryProfile} />;
  if (profileError && !profile) return (
    <AuthMessage title="Couldn't set up your account" logout={logout}
      action={<button className="btn primary" style={{width:'100%',justifyContent:'center',marginBottom:8}} onClick={retryProfile}>Try again</button>}>
      {profileError}. Check your connection and try again. If this keeps happening, ask your Master admin to check your account.
    </AuthMessage>
  );
  if (profile === null) return <div className="loading">Setting up your account…</div>;
  if (profile.status === 'pending')  return <PendingScreen user={user} logout={logout} />;
  if (profile.status === 'rejected') return (
    <AuthMessage title="Access denied" logout={logout}>Your account request was rejected. Contact your Master admin.</AuthMessage>
  );
  return <Shell user={user} profile={profile} logout={logout}/>;
}

/* ---- Main shell ---- */
function Shell({ user, profile, logout }) {
  const rawStore = useLiveData();
  const toast = useToast();
  const isMobile = useIsMobile();
  const [view, setView] = useState('dash');
  const [sideOpen, setSideOpen] = useState(false);
  const [sideCollapsed, setSideCollapsed] = useState(() => {
    try { return localStorage.getItem('jyot_side_collapsed') === '1'; } catch(e) { return false; }
  });
  const [showSearch, setShowSearch] = useState(false);
  const [eventModal, setEventModal] = useState(null);
  const [online, setOnline] = useState(navigator.onLine);

  const isMaster = profile?.role === 'Master';
  const canManageEvents = hasPermission(profile, 'settings.config');

  function toggleCollapse() {
    setSideCollapsed(prev => {
      const next = !prev;
      try { localStorage.setItem('jyot_side_collapsed', next ? '1' : '0'); } catch(e) {}
      return next;
    });
  }
  function toggleMenu() { if (isMobile) setSideOpen(o => !o); else toggleCollapse(); }

  // Close the drawer if the viewport grows past the breakpoint
  useEffect(() => { if (!isMobile) setSideOpen(false); }, [isMobile]);
  // Lock background scroll while the mobile drawer is open
  useEffect(() => {
    document.body.style.overflow = isMobile && sideOpen ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
  }, [isMobile, sideOpen]);

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
  const events = rawStore.events || [];
  const exists = id => !!id && events.some(e => e.id === id);
  // Personal selection first, then the org default, then the first event
  const activeEventId = exists(profile?.activeEventId) ? profile.activeEventId
    : exists(rawStore.defaultEventId) ? rawStore.defaultEventId
    : (events[0]?.id || null);
  const store = scopedStore(rawStore, activeEventId, profile?.contactFilter);
  const activeEvent = events.find(e => e.id === activeEventId);

  const go = v => { setView(v); setSideOpen(false); window.scrollTo(0,0); document.querySelector('.main')?.scrollTo?.(0,0); };
  window.__jyotGo = go;

  async function switchEvent(id) {
    try { await setMyActiveEventId(user.uid, id); toast('Event switched.'); }
    catch (e) { toast('Could not switch event: ' + (e.code || e.message)); }
  }

  async function maybeSeed() {
    if ((rawStore.contacts||[]).length > 0) { toast('There is already data — sample data not added.'); return; }
    await seedSampleData(); toast('Sample data added.');
  }

  async function saveEvent(ev, makeDefault = false) {
    const isNew = !ev.id;
    try {
      const id = await saveItem('events', ev);
      if (isNew) await setMyActiveEventId(user.uid, id);
      if (makeDefault || !exists(rawStore.defaultEventId)) {
        try { await setActiveEventId(id); } catch { /* not allowed for this user */ }
      }
      toast(isNew ? `Event "${ev.name}" created and selected.` : 'Event updated.');
      setEventModal(null);
    } catch (e) { toast('Could not save event: ' + (e.code || e.message)); }
  }

  async function deleteEvent(ev) {
    if (!isMaster) { toast('Only the Master admin can delete events.'); return; }
    try {
      const n = await softDeleteEvent(ev, user.email);
      const remaining = events.filter(e => e.id !== ev.id);
      const next = remaining[0]?.id || null;
      if (rawStore.defaultEventId === ev.id) await setActiveEventId(next);
      if (profile?.activeEventId === ev.id) await setMyActiveEventId(user.uid, next);
      toast(`Event "${ev.name}" and ${n} record${n===1?'':'s'} moved to trash (restorable for 30 days).`);
      setEventModal(null);
    } catch (e) { toast('Delete failed: ' + (e.code || e.message)); }
  }

  const VIEWS = {
    dash: Dashboard, outreach: Outreach,
    logistics: Logistics, schedule: Scheduling, people: Volunteers,
    depts: Depts, reports: Reports,
    availability: Volunteers,
    pocallocation: POCAllocation,
    export: ExportData, settings: Settings,
  };
  const Active = VIEWS[view] || Dashboard;

  const navOrder = (rawStore.appConfig||[]).find(c=>c.id==='navOrder')?.order;
  const orderedNav = navOrder
    ? [...NAV].sort((a,b)=>{const ai=navOrder.indexOf(a.id),bi=navOrder.indexOf(b.id);return(ai===-1?999:ai)-(bi===-1?999:bi);})
    : NAV;
  const visibleNav = orderedNav.filter(n => !profile?.allowedModules || [n.id, ...(n.also||[])].some(id => profile.allowedModules.includes(id)));

  const collapsed = sideCollapsed && !isMobile;

  return (
    <div className={'app' + (collapsed ? ' collapsed' : '')}>
      <div className={'side-overlay'+(sideOpen?' open':'')} onClick={()=>setSideOpen(false)}/>

      <aside className={'side'+(sideOpen?' open':'')} aria-hidden={collapsed || (isMobile && !sideOpen)}>
        <div className="brand">
          <div className="mark">वि</div>
          <div><div className="name">VK Outreach</div><div className="sub">Program · JYOT</div></div>
          {isMobile && <button className="side-close" onClick={()=>setSideOpen(false)} aria-label="Close menu">✕</button>}
        </div>
        <div className="nav-label nav-label-row">
          <span>Workflow</span>
          {!isMobile && <button className="side-collapse" onClick={toggleCollapse} title="Collapse sidebar" aria-label="Collapse sidebar">‹</button>}
        </div>
        <nav>
          {visibleNav.map(n => {
            const ct = n.count ? n.count(store) : null;
            return (
              <button key={n.id} className={'nav-item'+(view===n.id?' active':'')} onClick={()=>go(n.id)}>
                {ICON[n.icon]||ICON.doc}<span>{n.label}</span>
                {ct!=null && <span className="ct">{ct}</span>}
              </button>
            );
          })}
        </nav>
        <div className="side-foot">
          <div className="side-user">{user.email}</div>
          Live sync · changes are shared with the team instantly.
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <button className="btn ghost sm menu-btn" onClick={toggleMenu} aria-label="Toggle menu">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 12h18M3 6h18M3 18h18"/></svg>
          </button>
          <div className="topbar-event">
            <select className="statsel event-select" aria-label="Active event"
              value={activeEventId||''}
              onChange={e=>switchEvent(e.target.value)}>
              {!events.length && <option value="">No events</option>}
              {events.map(ev=><option key={ev.id} value={ev.id}>{ev.name}{ev.id===rawStore.defaultEventId?' (default)':''}</option>)}
            </select>
            {canManageEvents && <button className="btn ghost sm" title="Edit event" aria-label="Edit event" onClick={()=>activeEvent&&setEventModal({type:'edit',item:activeEvent})}>{ICON.edit}</button>}
            {canManageEvents && <button className="btn primary sm" onClick={()=>setEventModal({type:'add'})} aria-label="New event">
              {ICON.plus}<span className="hide-sm">New event</span>
            </button>}
          </div>
          <div className="top-actions">
            {online
              ? <span className="synced" title="Live"><span className="d"/><span className="hide-sm">Live</span></span>
              : <span className="offline-pill">⚡<span className="hide-sm"> Offline</span></span>}
            <button className="btn ghost sm" onClick={()=>setShowSearch(true)} title="Search (⌘K)" aria-label="Search">🔍</button>
            <NotificationBell store={store} profile={profile}/>
            {loaded && !events.length && isMaster && <button className="btn sm hide-sm" onClick={maybeSeed}>Sample data</button>}
            <div className="userchip" title={user.email}><div className="av">{initials(user.email)}</div><span className="hide-sm">{user.email}</span></div>
            <button className="btn ghost sm" onClick={logout}>Out</button>
          </div>
        </header>

        <div className="content">
          {!loaded
            ? <div className="loading">Connecting…</div>
            : !activeEventId && view !== 'settings'
              ? <NoEvent canCreate={canManageEvents} onCreate={()=>setEventModal({type:'add'})} onSeed={isMaster?maybeSeed:null}/>
              : <Active store={store} rawStore={rawStore} activeEventId={activeEventId}
                        go={go} profile={profile}
                        saveEvent={saveEvent} deleteEvent={deleteEvent}
                        setEventModal={setEventModal}
                        onEditEvent={ev=>setEventModal({type:'edit',item:ev})}
                        onDeleteEvent={deleteEvent}/>}
        </div>
      </div>

      {showSearch && <GlobalSearch store={rawStore} onNavigate={v=>{go(v);}} onClose={()=>setShowSearch(false)}/>}
      {eventModal && <EventModal item={eventModal.item} events={events} rawStore={rawStore}
        canSetDefault={canManageEvents}
        isDefault={eventModal.item && eventModal.item.id===rawStore.defaultEventId}
        onClose={()=>setEventModal(null)} onSave={saveEvent}
        onDelete={eventModal.type==='edit' && isMaster ? ()=>deleteEvent(eventModal.item) : null}/>}
    </div>
  );
}

/* ---- No event placeholder ---- */
function NoEvent({ canCreate, onCreate, onSeed }) {
  return (
    <div style={{padding:'60px 20px',textAlign:'center',color:'var(--muted)'}}>
      <div style={{fontFamily:'var(--serif)',fontSize:22,marginBottom:10,color:'var(--ink)'}}>No event selected</div>
      <p style={{marginBottom:18}}>{canCreate ? 'Create your first event to get started.' : 'No events exist yet. Ask your Master admin to create one.'}</p>
      <div style={{display:'flex',gap:10,justifyContent:'center',flexWrap:'wrap'}}>
        {canCreate && <button className="btn primary" onClick={onCreate}>{ICON.plus}Create event</button>}
        {onSeed && <button className="btn" onClick={onSeed}>Add sample data</button>}
      </div>
    </div>
  );
}

/* ---- Event modal ---- */
function EventModal({ item, events, rawStore, onClose, onSave, onDelete, canSetDefault, isDefault }) {
  const configTypes = (rawStore?.appConfig||[]).find(c=>c.id==='eventTypes')?.items;
  const EVENT_TYPES = configTypes || ['Conclave','Precursor','Exhibition','Podcast','Other'];
  const STATUS_OPTS = ['Planning','Active','Completed','Cancelled'];
  function autoStatus(f) {
    if (!f.startDate) return f.status || 'Planning';
    const today = todayISO();
    if (f.endDate && f.endDate < today) return 'Completed';
    if (f.startDate <= today) return 'Active';
    return f.status || 'Planning';
  }
  const [f, setF] = useState(()=>{
    const base = {name:'',type:EVENT_TYPES[0]||'Conclave',startDate:'',endDate:'',venue:'',status:'Planning',parentId:'',notes:'',...item};
    if (!item) base.status = 'Planning';
    return base;
  });
  const set = k => e => setF(p=>({...p,[k]:e.target.value}));
  const [confirmDel, setConfirmDel] = useState(false);
  const [makeDefault, setMakeDefault] = useState(false);
  return (
    <Modal title={item?'Edit event':'New event'} onClose={onClose} onSave={()=>{ if(!f.name.trim()) return; onSave(f, makeDefault); }} saveLabel={item?'Save changes':'Create event'}>
      <Field label="Event name"><input className="input" value={f.name} onChange={set('name')} placeholder="e.g. VK 5.0"/></Field>
      <div className="grid2">
        <Field label="Type"><select className="input" value={f.type} onChange={set('type')}>{EVENT_TYPES.map(t=><option key={t}>{t}</option>)}</select></Field>
        <Field label="Status"><select className="input" value={f.status} onChange={set('status')}>{STATUS_OPTS.map(s=><option key={s}>{s}</option>)}</select></Field>
        <Field label="Start date"><input className="input" type="date" value={f.startDate} onChange={e=>{const nf={...f,startDate:e.target.value};setF({...nf,status:autoStatus(nf)});}}/></Field>
        <Field label="End date"><input className="input" type="date" value={f.endDate} onChange={e=>{const nf={...f,endDate:e.target.value};setF({...nf,status:autoStatus(nf)});}}/></Field>
        <Field label="Venue / City"><input className="input" value={f.venue} onChange={set('venue')} placeholder="Mumbai"/></Field>
        <Field label="Link to parent event">
          <select className="input" value={f.parentId} onChange={set('parentId')}>
            <option value="">— None —</option>
            {events.filter(e=>e.id!==item?.id).map(e=><option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
        </Field>
      </div>
      <Field label="Notes"><input className="input" value={f.notes} onChange={set('notes')}/></Field>
      {canSetDefault && (isDefault
        ? <p className="muted-sm" style={{margin:'0 0 8px'}}>This is the default event everyone sees until they pick another.</p>
        : <label className="chk"><input type="checkbox" checked={makeDefault} onChange={e=>setMakeDefault(e.target.checked)}/>Make this the default event for everyone</label>)}
      {onDelete && (
        <div style={{marginTop:14,padding:12,background:'var(--rose-wash)',borderRadius:8}}>
          {!confirmDel
            ? <button className="btn danger sm" onClick={()=>setConfirmDel(true)}>{ICON.trash}Delete this event</button>
            : <div style={{display:'flex',alignItems:'center',gap:8,flexWrap:'wrap'}}>
                <span style={{fontSize:13,color:'var(--rose)'}}>Move this event and all its data to trash? It can be restored for 30 days.</span>
                <button className="btn danger sm" onClick={onDelete}>Yes, delete</button>
                <button className="btn sm" onClick={()=>setConfirmDel(false)}>Cancel</button>
              </div>}
        </div>
      )}
    </Modal>
  );
}
