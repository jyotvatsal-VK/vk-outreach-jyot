import React, { useState, useEffect } from 'react';
import { db } from './firebase';
import { collection, onSnapshot, doc, updateDoc, deleteDoc, getDocs, writeBatch, serverTimestamp, setDoc } from 'firebase/firestore';
import { getAuth, createUserWithEmailAndPassword, sendPasswordResetEmail } from 'firebase/auth';
import { useAuth, inviteKey } from './auth';
import { hasActiveFilter, filterSummary } from './contactFilter';
import { CarVendorMaster, TimePicker } from './views';
import { useActivityLog, logAction } from './activity';
import { useToast, Modal, Field, ICON } from './ui';
import { COLLECTIONS, saveItem, removeItem } from './data';
import { restoreTrashItem, purgeExpiredTrash, purgeTrashItem, restoreTrashBundle, purgeTrashBundle } from './trash_utils';
import { PERMISSION_GROUPS, hasPermission } from './permissions';

const ROLES = ['Master', 'User'];

/* ---- Settings root ---- */
const APP_VERSION = '2.0.0';
const BUILD_DATE = new Date().toLocaleDateString('en-IN', {day:'numeric',month:'short',year:'numeric'});

export function Settings({ rawStore }) {
  const [tab, setTab] = useState('users');
  const { user, profile } = useAuth();
  const isMaster = profile?.role === 'Master';
  if (!db) return <div className="panel panel-pad"><p className="muted-sm">Firebase not connected.</p></div>;
  if (!profile) return <div className="panel panel-pad"><p className="muted-sm">Loading your profile…</p></div>;
  return (
    <>
      <div className="page-head"><div className="ph-txt"><h1>Settings</h1><p>User management, activity log, and data tools. Master access required for destructive actions.</p></div></div>
      <div className="subnav">
        <button className={tab==='users'?'active':''} onClick={()=>setTab('users')}>Users</button>
        <button className={tab==='log'?'active':''} onClick={()=>setTab('log')}>Activity log</button>
        {isMaster && <button className={tab==='data'?'active':''} onClick={()=>setTab('data')}>Data management</button>}
        {isMaster && <button className={tab==='health'?'active':''} onClick={()=>setTab('health')}>🔍 Health check</button>}
        {isMaster && <button className={tab==='trash'?'active':''} onClick={()=>setTab('trash')}>🗑 Trash</button>}
        <button className={tab==='config'?'active':''} onClick={()=>setTab('config')}>Configurations</button>
        {isMaster && <button className={tab==='sidebar'?'active':''} onClick={()=>setTab('sidebar')}>Sidebar</button>}
      </div>
      {tab==='users' && <UsersTab isMaster={isMaster} currentUid={user?.uid}/>}
      {tab==='log' && <ActivityTab/>}
      {tab==='data' && isMaster && <DataTab rawStore={rawStore}/>}
      {tab==='health' && isMaster && <HealthCheckTab rawStore={rawStore}/>}
      {tab==='trash' && isMaster && <TrashTab rawStore={rawStore}/>}
      {tab==='config' && <ConfigurationsTab rawStore={rawStore}/>}
      {tab==='sidebar' && isMaster && <SidebarTab rawStore={rawStore}/>}
      <div style={{marginTop:24,padding:'12px 16px',background:'var(--paper)',borderRadius:10,border:'1px solid var(--line)',display:'flex',alignItems:'center',gap:12,fontSize:12.5,color:'var(--muted)'}}>
        <span style={{fontSize:18}}>⚙️</span>
        <div>
          <div><b style={{color:'var(--ink)'}}>VK Outreach Program — JYOT</b></div>
          <div>Version {APP_VERSION} · Built {BUILD_DATE}</div>
          <div style={{marginTop:2}}>
            <a href="https://vk-outreach-jyot.vercel.app" target="_blank" rel="noopener" style={{color:'var(--teal)'}}>vk-outreach-jyot.vercel.app</a>
            {' · '}
            <a href="https://github.com/jyotvatsal-VK/vk-outreach-jyot" target="_blank" rel="noopener" style={{color:'var(--teal)'}}>GitHub</a>
          </div>
        </div>
      </div>
    </>
  );
}

/* ---- Users tab ---- */
/* ---- Sidebar Tab — drag to reorder nav items (Master only) ---- */
const NAV_LABELS = {
  dash:'Dashboard', outreach:'Outreach',
  logistics:'Logistics', schedule:'Scheduling', people:'Volunteers',
  depts:'Departments & Tasks', reports:'Personalised Schedule',
  pocallocation:'POC Allocation',
  export:'Export Data', settings:'Settings',
};

function SidebarTab({ rawStore }) {
  const saved    = (rawStore.appConfig||[]).find(c=>c.id==='navOrder');
  const DEFAULT  = Object.keys(NAV_LABELS);
  const [items, setItems] = useState(() => saved?.order || DEFAULT);
  const [drag, setDrag]   = useState(null);
  const [saving, setSaving] = useState(false);
  const toast = useToast();

  function onDragStart(id) { setDrag(id); }
  function onDragOver(e, id) {
    e.preventDefault();
    if (drag === id) return;
    const from = items.indexOf(drag);
    const to   = items.indexOf(id);
    if (from === -1 || to === -1) return;
    const next = [...items];
    next.splice(from, 1);
    next.splice(to, 0, drag);
    setItems(next);
  }

  async function save() {
    setSaving(true);
    await saveItem('appConfig', { ...saved, id:'navOrder', order:items });
    toast('Sidebar order saved. Refresh to see changes.');
    setSaving(false);
  }

  function reset() { setItems(DEFAULT); }

  return (
    <div className="panel panel-pad" style={{maxWidth:480}}>
      <h3 style={{fontFamily:'var(--serif)',fontSize:15,marginBottom:4}}>Sidebar arrangement</h3>
      <p style={{fontSize:13,color:'var(--muted)',marginBottom:16}}>
        Drag to reorder. Changes apply to all users.
      </p>
      <div style={{marginBottom:16}}>
        {items.map(id=>(
          <div key={id}
            draggable
            onDragStart={()=>onDragStart(id)}
            onDragOver={e=>onDragOver(e,id)}
            onDragEnd={()=>setDrag(null)}
            style={{display:'flex',alignItems:'center',gap:10,padding:'9px 14px',
              borderRadius:8,marginBottom:6,background:drag===id?'var(--teal-wash)':'var(--paper)',
              border:`1px solid ${drag===id?'var(--teal)':'var(--line)'}`,
              cursor:'grab',userSelect:'none'}}>
            <span style={{color:'var(--muted)',fontSize:14}}>⠿</span>
            <span style={{fontSize:13,fontWeight:500}}>{NAV_LABELS[id]||id}</span>
          </div>
        ))}
      </div>
      <div style={{display:'flex',gap:8}}>
        <button className="btn primary sm" onClick={save} disabled={saving}>
          {saving?'Saving…':'Save order'}
        </button>
        <button className="btn ghost sm" onClick={reset}>Reset to default</button>
      </div>
    </div>
  );
}

function UsersTab({ isMaster, currentUid }) {
  const [users, setUsers] = useState([]);
  const [invites, setInvites] = useState([]);
  const { user, profile } = useAuth();
  const toast = useToast();
  const canSeeUsers = isMaster || hasPermission(profile, 'settings.users');

  useEffect(() => {
    if (!db || !canSeeUsers) return;
    const u1 = onSnapshot(collection(db, 'users'), snap =>
      setUsers(snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(u => !u.isInvite)), () => {});
    const u2 = isMaster ? onSnapshot(collection(db, 'invites'), snap =>
      setInvites(snap.docs.map(d => ({ id: d.id, ...d.data() }))), () => {}) : () => {};
    return () => { u1(); u2(); };
  }, [canSeeUsers, isMaster]);

  const [filterModal, setFilterModal] = useState(null);
  const [accessModal, setAccessModal] = useState(null);
  const [addUserOpen, setAddUserOpen] = useState(false);
  const [addUserEmail, setAddUserEmail] = useState('');
  const [addUserRole, setAddUserRole] = useState('User');
  const [addUserLoading, setAddUserLoading] = useState(false);

  async function addUserManually() {
    if (!addUserEmail.trim()) return;
    const email = addUserEmail.trim().toLowerCase();
    setAddUserLoading(true);
    try {
      // Check if already in Firestore
      const existing = users.find(u => u.email.toLowerCase() === email);
      if (existing) {
        // Just update their role and approve them
        await updateDoc(doc(db, 'users', existing.id), {
          role: addUserRole,
          status: 'active',
          approved: true,
          approvedBy: currentUid,
          approvedAt: serverTimestamp(),
        });
        await logAction(user, profile, 'Updated user', email + ' → ' + addUserRole);
        toast(`${email} updated to ${addUserRole} and approved.`);
        setAddUserEmail(''); setAddUserOpen(false);
        setAddUserLoading(false);
        return;
      }

      // Invite lives in its own collection. It is applied only after the person
      // signs up AND verifies they own this email address (enforced by Firestore rules).
      await setDoc(doc(db, 'invites', inviteKey(email)), {
        email,
        role: addUserRole,
        status: 'active',
        approved: true,
        allowedModules: null,
        permissions: null,
        contactFilter: null,
        invitedBy: currentUid,
        createdAt: serverTimestamp(),
      });
      await logAction(user, profile, 'Invited user', email + ' as ' + addUserRole);
      toast(`Invite created for ${email}. They sign up at the app URL, verify their email, and are approved as ${addUserRole}.`);
      setAddUserEmail(''); setAddUserOpen(false);
    } catch(e) {
      toast('Error: ' + e.message);
    }
    setAddUserLoading(false);
  }
  const pending = users.filter(u => u.status === 'pending');
  const active = users.filter(u => u.status !== 'pending');

  async function approve(u) {
    await updateDoc(doc(db, 'users', u.id), { status: 'active', approved: true, approvedBy: currentUid, approvedAt: serverTimestamp() });
    await logAction(user, profile, 'Approved user', u.email);
    toast(`Approved ${u.email}`);
  }
  async function reject(u) {
    await updateDoc(doc(db, 'users', u.id), { status: 'rejected', approved: false });
    await logAction(user, profile, 'Rejected user', u.email);
    toast(`Rejected ${u.email}`);
  }
  async function setRole(u, role) {
    await updateDoc(doc(db, 'users', u.id), { role });
    await logAction(user, profile, 'Changed role', `${u.email} → ${role}`);
    toast(`${u.email} is now ${role}`);
  }
  async function revoke(u) {
    await updateDoc(doc(db, 'users', u.id), { status: 'pending', approved: false });
    await logAction(user, profile, 'Revoked access', u.email);
    toast(`Access revoked for ${u.email}`);
  }

  async function cancelInvite(inv) {
    await deleteDoc(doc(db, 'invites', inv.id));
    await logAction(user, profile, 'Cancelled invite', inv.email);
    toast(`Invite for ${inv.email} cancelled.`);
  }

  if (!canSeeUsers) return (
    <div className="panel panel-pad"><p className="muted-sm" style={{margin:0}}>User management is restricted to the Master admin. Ask them if you need someone added or approved.</p></div>
  );

  return (
    <>
      {isMaster && invites.length > 0 && (
        <div className="panel">
          <div className="panel-head"><h2>Invited — not signed up yet ({invites.length})</h2><div className="desc">Approved automatically once they sign up and verify their email.</div></div>
          <div className="panel-body"><table><thead><tr><th>Email</th><th>Role</th><th></th></tr></thead><tbody>
            {invites.map(inv=>(
              <tr key={inv.id}>
                <td><div className="nm">{inv.email}</div></td>
                <td><span className="badge b-type">{inv.role||'User'}</span></td>
                <td><div className="rowacts" style={{opacity:1}}><button className="btn ghost xs" onClick={()=>cancelInvite(inv)}>Cancel invite</button></div></td>
              </tr>
            ))}
          </tbody></table></div>
        </div>
      )}
      {pending.length > 0 && (
        <div className="panel" style={{borderColor:'var(--amber)',borderWidth:2}}>
          <div className="panel-head" style={{background:'var(--amber-wash)'}}>
            <h2 style={{color:'var(--amber)'}}>⏳ Pending approval ({pending.length})</h2>
            <div className="desc">These users signed up and are waiting for access.</div>
          </div>
          <div className="panel-body"><table><thead><tr><th>Email</th><th>Device</th><th>Signed up</th><th></th></tr></thead><tbody>
            {pending.map(u=>(
              <tr key={u.id}>
                <td><div className="nm">{u.email}</div></td>
                <td style={{fontSize:12}}>{hasActiveFilter(u.contactFilter)?<span style={{color:'var(--amber)',fontWeight:500}}>🔒 {filterSummary(u.contactFilter)}</span>:<span style={{color:'var(--teal)'}}>✓ All contacts</span>}</td>
                <td className="muted-sm">{u.createdAt?.toDate?.()?.toLocaleDateString()||'—'}</td>
                <td><div className="rowacts" style={{opacity:1}}>
                  <button className="btn primary sm" onClick={()=>approve(u)}>Approve</button>
                  <button className="btn danger sm" onClick={()=>reject(u)}>Reject</button>
                </div></td>
              </tr>
            ))}
          </tbody></table></div>
        </div>
      )}

      <div className="panel">
        <div className="panel-head"><h2>Team members</h2><div className="desc">{active.length} active</div>
          {isMaster && <div className="right"><button className="btn primary sm" onClick={()=>setAddUserOpen(true)}>{ICON.plus} Add user</button></div>}
        </div>
        <div className="panel-body"><table><thead><tr><th>Email</th><th>Role</th><th>Contact access</th><th>Status</th><th></th></tr></thead><tbody>
          {active.map(u=>(
            <tr key={u.id}>
              <td><div className="nm">{u.email}{u.id===currentUid&&<span className="badge b-confirmed" style={{marginLeft:8,fontSize:10}}>You</span>}</div></td>
              <td>
                {isMaster && u.id!==currentUid
                  ? <select className="statsel" value={u.role||'User'} onChange={e=>setRole(u,e.target.value)}>{ROLES.map(r=><option key={r}>{r}</option>)}</select>
                  : <span className="badge b-type">{u.role||'User'}</span>}
              </td>
              <td style={{fontSize:12}}>{hasActiveFilter(u.contactFilter)?<span style={{color:'var(--amber)',fontWeight:500}}>🔒 {filterSummary(u.contactFilter)}</span>:<span style={{color:'var(--teal)'}}>✓ All contacts</span>}</td>
              <td>{u.status==='active'?<span className="badge b-confirmed">Active</span>:u.status==='rejected'?<span className="badge b-declined">Rejected</span>:<span className="badge b-pending">Pending</span>}</td>
              <td><div className="rowacts">
                {isMaster && u.id!==currentUid && u.status==='active' && <><button className="btn ghost xs" onClick={()=>setFilterModal(u)} title="Set contact filter">🔒 Filter</button><button className="btn ghost xs" onClick={()=>setAccessModal(u)} title="Set access & permissions">⚙ Access</button><button className="btn ghost xs" onClick={()=>revoke(u)}>Revoke</button></> }
              </div></td>
            </tr>
          ))}
          {!active.length&&<tr><td colSpan="5"><div className="empty"><h3>No active users yet</h3></div></td></tr>}
        </tbody></table></div>
      </div>

      {accessModal && <AccessModal targetUser={accessModal} onClose={()=>setAccessModal(null)} toast={toast} currentUser={user} currentProfile={profile}/>}
      {filterModal && <ContactFilterModal targetUser={filterModal} onClose={()=>setFilterModal(null)} toast={toast} currentUser={user} currentProfile={profile}/>}
      {addUserOpen && (
        <div className="scrim" onMouseDown={()=>setAddUserOpen(false)}>
          <div className="modal" onMouseDown={e=>e.stopPropagation()} style={{maxWidth:400}}>
            <div className="modal-head"><h2>Add team member</h2><button className="x" onClick={()=>setAddUserOpen(false)}>✕</button></div>
            <div className="modal-body">
              <div style={{background:'var(--teal-wash)',borderRadius:8,padding:'10px 14px',fontSize:13,marginBottom:14,color:'#1c4d3e'}}>
                Enter their email and role. Share the app URL with them — after they sign up and verify their email they're approved with this role. No email is sent from here.
              </div>
              <div style={{marginBottom:12}}>
                <label style={{fontSize:12,fontWeight:600,display:'block',marginBottom:4}}>Email address</label>
                <input className="input" type="email" value={addUserEmail}
                  onChange={e=>setAddUserEmail(e.target.value)}
                  placeholder="name@example.com" autoFocus/>
              </div>
              <div>
                <label style={{fontSize:12,fontWeight:600,display:'block',marginBottom:4}}>Role</label>
                <select className="input" value={addUserRole} onChange={e=>setAddUserRole(e.target.value)}>
                  {ROLES.map(r=><option key={r}>{r}</option>)}
                </select>
              </div>
            </div>
            <div className="modal-foot">
              <button className="btn" onClick={()=>setAddUserOpen(false)}>Cancel</button>
              <button className="btn primary" onClick={addUserManually} disabled={addUserLoading||!addUserEmail.trim()}>
                {addUserLoading?'Saving…':'Pre-approve this email'}
              </button>
            </div>
          </div>
        </div>
      )}
      <div className="panel panel-pad">
        <h3 style={{fontFamily:'var(--serif)',fontSize:15,marginBottom:8}}>Role permissions</h3>
        <table style={{minWidth:'unset'}}><thead><tr><th>Role</th><th>Can do</th></tr></thead><tbody>
          <tr><td><span className="badge b-confirmed">Master</span></td><td className="muted-sm">Full access to everything · manage users · delete data · view activity log · bypasses all permission checks</td></tr>
          <tr><td><span className="badge b-type">User</span></td><td className="muted-sm">Access controlled entirely by ⚙ Access settings · locked out by default</td></tr>
        </tbody></table>
      </div>
    </>
  );
}

/* ---- Activity log tab ---- */
function ActivityTab() {
  const log = useActivityLog(200);
  const fmt = ts => {
    if (!ts) return '—';
    const d = ts.toDate ? ts.toDate() : new Date(ts);
    return d.toLocaleString();
  };
  return (
    <div className="panel">
      <div className="panel-head"><h2>Activity log</h2><div className="desc">Last 200 actions across all users</div></div>
      <div className="panel-body"><table><thead><tr><th>Time</th><th>User</th><th>Role</th><th>Action</th><th>Detail</th><th>Device</th></tr></thead><tbody>
        {log.map(l=>(
          <tr key={l.id}>
            <td className="mono" style={{fontSize:11.5,whiteSpace:'nowrap'}}>{fmt(l.ts)}</td>
            <td className="muted-sm">{l.email}</td>
            <td><span className="badge b-type" style={{fontSize:10}}>{l.role}</span></td>
            <td style={{fontSize:13.5}}>{l.action}</td>
            <td className="muted-sm">{l.detail||'—'}</td>
            <td className="muted-sm">{l.deviceLabel||'—'}</td>
          </tr>
        ))}
        {!log.length&&<tr><td colSpan="6"><div className="empty"><h3>No activity yet</h3><p>Actions will appear here as your team uses the app.</p></div></td></tr>}
      </tbody></table></div>
    </div>
  );
}

/* ---- Trash Tab (Master only) ---- */
const COLL_LABELS = {
  contacts:'Contact', volunteers:'Volunteer', sessions:'Session',
  departments:'Department', tasks:'Task', sahebjiSlots:'Sahebji Slot',
  founder:'Sahebji Meeting', carVendors:'Car Vendor', logistics:'Logistics',
};
const DAYS_30 = 30 * 24 * 60 * 60 * 1000;

function TrashTab({ rawStore }) {
  const toast = useToast();
  const [restoring, setRestoring] = useState(null);
  const [conflictModal, setConflictModal] = useState(null);
  const trashItems = (rawStore.trash || []).sort((a,b) => (b.deletedAt||0) - (a.deletedAt||0));
  const now = Date.now();

  React.useEffect(() => {
    // Purge expired on open
    const expired = trashItems.filter(t => t.expiresAt && t.expiresAt < now);
    if (expired.length) {
      purgeExpiredTrash(trashItems).then(n => { if(n) toast(`${n} expired item${n>1?'s':''} permanently deleted.`); });
    }
  }, []);

  const daysLeft = t => Math.max(0, Math.ceil((t.expiresAt - now) / (24*60*60*1000)));

  async function doRestore(trashRecord, skipPOC = false) {
    setRestoring(trashRecord.id);
    try {
      // Check for POC conflicts
      if (!skipPOC) {
        const pocLinked = (trashRecord.linked||[]).filter(l=>l.collection==='poc');
        const conflicts = pocLinked.filter(l => {
          const currentPOC = (rawStore.poc||[]).find(p =>
            p.contactId === l.data.contactId && p.day === l.data.day && p.volunteerId !== l.data.volunteerId
          );
          return !!currentPOC;
        });
        if (conflicts.length > 0) {
          setConflictModal({ trashRecord, conflicts });
          setRestoring(null);
          return;
        }
      }
      await restoreTrashItem(trashRecord, !skipPOC);
      toast(`${COLL_LABELS[trashRecord.originalCollection]||trashRecord.originalCollection} restored successfully.`);
    } catch(e) {
      toast('Restore failed: ' + e.message);
    }
    setRestoring(null);
  }

  async function doPurge(trashId) {
    if (!confirm('Permanently delete this item? This cannot be undone.')) return;
    await purgeTrashItem(trashId);
    toast('Permanently deleted.');
  }

  async function emptyTrash() {
    if (!confirm('Permanently delete ALL items in trash? This cannot be undone.')) return;
    await purgeTrashBundle(trashItems);
    toast('Trash emptied.');
  }

  const live = trashItems.filter(t => !t.expiresAt || t.expiresAt > now);
  // Records deleted together (e.g. a whole event) are shown and restored as one item
  const bundles = {};
  live.forEach(t => { if (t.bundleId) (bundles[t.bundleId] = bundles[t.bundleId] || []).push(t); });
  const active = [
    ...live.filter(t => !t.bundleId),
    ...Object.entries(bundles).map(([bid, recs]) => {
      const head = recs.find(r => r.bundleHead) || recs[0];
      return { ...head, id: 'bundle:' + bid, _bundle: recs };
    }),
  ].sort((a,b) => (b.deletedAt||0) - (a.deletedAt||0));

  async function doRestoreBundle(t) {
    if (!confirm(`Restore "${t.bundleLabel}" and ${t._bundle.length - 1} linked records?`)) return;
    setRestoring(t.id);
    try { await restoreTrashBundle(t._bundle); toast(`Event "${t.bundleLabel}" restored.`); }
    catch (e) { toast('Restore failed: ' + e.message); }
    setRestoring(null);
  }
  async function doPurgeBundle(t) {
    if (!confirm(`Permanently delete "${t.bundleLabel}" and all ${t._bundle.length} records? This cannot be undone.`)) return;
    await purgeTrashBundle(t._bundle);
    toast('Permanently deleted.');
  }

  return (
    <div>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:16}}>
        <div>
          <div style={{fontFamily:'var(--serif)',fontSize:16,fontWeight:500}}>Trash</div>
          <div style={{fontSize:13,color:'var(--muted)'}}>
            Deleted items are kept for 30 days. Restore anytime before expiry.
          </div>
        </div>
        {active.length > 0 && (
          <button className="btn ghost sm" style={{color:'var(--rose)'}} onClick={emptyTrash}>
            🗑 Empty trash
          </button>
        )}
      </div>

      {!active.length && (
        <div className="panel panel-pad" style={{textAlign:'center',color:'var(--muted)',fontSize:13}}>
          Trash is empty.
        </div>
      )}

      {active.map(t => {
        const isBundle = !!t._bundle;
        const label = isBundle ? t.bundleLabel : (t.data?.name || t.data?.title || t.data?.date || t.originalId);
        const collLabel = isBundle ? 'Event + all data' : (COLL_LABELS[t.originalCollection] || t.originalCollection);
        const dl = daysLeft(t);
        const urgent = dl <= 3;
        const linkedCount = isBundle ? t._bundle.length - 1 : (t.linked||[]).length;
        return (
          <div key={t.id} className="panel" style={{marginBottom:8,borderLeft:`3px solid ${urgent?'var(--rose)':'var(--line)'}`}}>
            <div className="panel-head">
              <div>
                <div style={{display:'flex',alignItems:'center',gap:8}}>
                  <span className="badge b-type">{collLabel}</span>
                  <span style={{fontWeight:500,fontSize:13}}>{label}</span>
                  {linkedCount > 0 && (
                    <span style={{fontSize:11,color:'var(--muted)'}}>+{linkedCount} linked record{linkedCount>1?'s':''}</span>
                  )}
                </div>
                <div style={{fontSize:11.5,color:'var(--muted)',marginTop:3}}>
                  Deleted by {t.deletedBy||'unknown'} · {new Date(t.deletedAt).toLocaleDateString('en-IN')}
                  {' · '}
                  <span style={{color:urgent?'var(--rose)':'var(--muted)',fontWeight:urgent?600:400}}>
                    {dl === 0 ? 'Expires today' : `${dl} day${dl>1?'s':''} left`}
                  </span>
                </div>
              </div>
              <div className="right rowacts">
                <button className="btn primary xs"
                  disabled={restoring===t.id}
                  onClick={()=>isBundle?doRestoreBundle(t):doRestore(t)}>
                  {restoring===t.id ? '...' : '↩ Restore'}
                </button>
                <button className="btn ghost xs" style={{color:'var(--rose)'}}
                  onClick={()=>isBundle?doPurgeBundle(t):doPurge(t.id)}>
                  {ICON.trash}
                </button>
              </div>
            </div>
          </div>
        );
      })}

      {/* POC Conflict Modal */}
      {conflictModal && (
        <div className="scrim" onMouseDown={()=>setConflictModal(null)}>
          <div className="modal" onMouseDown={e=>e.stopPropagation()} style={{maxWidth:420}}>
            <div className="modal-head">
              <h2>⚠ POC Conflict Detected</h2>
              <button className="x" onClick={()=>setConflictModal(null)}>✕</button>
            </div>
            <div className="modal-body">
              <p style={{fontSize:13,marginBottom:12}}>
                Some POC assignments from this record conflict with current assignments made after deletion.
              </p>
              {conflictModal.conflicts.map((c,i) => (
                <div key={i} style={{fontSize:12.5,padding:'8px 12px',background:'var(--amber-wash)',borderRadius:8,marginBottom:6}}>
                  ⚠ POC on {c.data.day} — volunteer was reassigned after deletion
                </div>
              ))}
            </div>
            <div className="modal-foot">
              <button className="btn" onClick={()=>setConflictModal(null)}>Cancel</button>
              <button className="btn" onClick={async()=>{
                const tr = conflictModal.trashRecord;
                setConflictModal(null);
                await doRestore(tr, true); // restore WITHOUT POC
                toast('Restored without conflicting POC assignments. Please reassign POC manually.');
              }}>Restore without POC</button>
              <button className="btn danger" onClick={async()=>{
                const tr = conflictModal.trashRecord;
                setConflictModal(null);
                // Restore with POC — override current assignments
                await restoreTrashItem(tr, true);
                await removeItem('trash', tr.id);
                toast('Restored with original POC assignments (current assignments overridden).');
              }}>Restore & Override POC</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---- Health Check Tab ---- */
function HealthCheckTab({ rawStore }) {
  const toast = useToast();
  const [issues, setIssues] = useState(null);
  const [fixing, setFixing] = useState(false);

  function runCheck() {
    const contacts   = rawStore.contacts   || [];
    const volunteers = rawStore.volunteers || [];
    const sessions   = rawStore.sessions   || [];
    const assignments= rawStore.assignments|| [];
    const poc        = rawStore.poc        || [];
    const availability=rawStore.availability||[];
    const tasks      = rawStore.tasks       || [];
    const logistics  = rawStore.logistics  || [];
    const ps         = rawStore.personalisedSchedule || [];

    const contactIds  = new Set(contacts.map(c=>c.id));
    const volIds      = new Set(volunteers.map(v=>v.id));
    const sessionIds  = new Set(sessions.map(s=>s.id));

    const found = [];

    // POC assignments with no matching contact
    poc.filter(p=>p.contactId && !contactIds.has(p.contactId))
      .forEach(p=>found.push({type:'POC → missing contact', id:p.id, desc:`POC record ${p.id} references deleted contact`, fix:()=>removeItem('poc',p.id)}));

    // POC assignments with no matching volunteer
    poc.filter(p=>p.volunteerId && !volIds.has(p.volunteerId))
      .forEach(p=>found.push({type:'POC → missing volunteer', id:p.id, desc:`POC record on ${p.day} — volunteer was deleted`, fix:()=>saveItem('poc',{...p,volunteerId:null,status:'Unassigned'})}));

    // Session assignments with no matching session
    assignments.filter(a=>a.sessionId && !sessionIds.has(a.sessionId))
      .forEach(a=>found.push({type:'Assignment → missing session', id:a.id, desc:`Assignment for contact ${a.contactId} — session was deleted`, fix:()=>removeItem('assignments',a.id)}));

    // Session assignments with no matching contact
    assignments.filter(a=>a.contactId && !contactIds.has(a.contactId))
      .forEach(a=>found.push({type:'Assignment → missing contact', id:a.id, desc:`Assignment to session ${a.sessionId} — contact was deleted`, fix:()=>removeItem('assignments',a.id)}));

    // Availability records for deleted volunteers
    availability.filter(a=>a.volId && !volIds.has(a.volId) && a.day !== 'depts' && a.day !== 'pre-event')
      .forEach(a=>found.push({type:'Availability → missing volunteer', id:a.id, desc:`Availability record for deleted volunteer`, fix:()=>removeItem('availability',a.id)}));

    // Task assignments with no matching volunteer
    tasks.filter(t=>t.assigneeId && !volIds.has(t.assigneeId))
      .forEach(t=>found.push({type:'Task → missing assignee', id:t.id, desc:`Task "${t.title}" assigned to deleted volunteer`, fix:()=>saveItem('tasks',{...t,assigneeId:null})}));

    // Logistics with no matching contact
    logistics.filter(l=>l.contactId && !contactIds.has(l.contactId))
      .forEach(l=>found.push({type:'Logistics → missing contact', id:l.id, desc:`Logistics record for deleted contact`, fix:()=>removeItem('logistics',l.id)}));

    // Personalised schedule rows for deleted contacts
    ps.filter(r=>r.contactId && !contactIds.has(r.contactId))
      .forEach(r=>found.push({type:'Schedule → missing contact', id:r.id, desc:`Schedule row for deleted contact`, fix:()=>removeItem('personalisedSchedule',r.id)}));

    setIssues(found);
    if (!found.length) toast('✓ All clean — no issues found.');
  }

  async function fixAll() {
    if (!issues?.length) return;
    setFixing(true);
    for (const issue of issues) {
      try { await issue.fix(); } catch(e) { console.error(e); }
    }
    toast(`Fixed ${issues.length} issue${issues.length>1?'s':''}.`);
    setIssues(null);
    setFixing(false);
  }

  const grouped = issues ? issues.reduce((acc,i)=>{
    if(!acc[i.type]) acc[i.type]=[];
    acc[i.type].push(i); return acc;
  },{}) : {};

  return (
    <div>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:16}}>
        <div>
          <div style={{fontFamily:'var(--serif)',fontSize:16,fontWeight:500}}>Data Health Check</div>
          <div style={{fontSize:13,color:'var(--muted)'}}>
            Scans for orphaned or inconsistent records across all collections.
          </div>
        </div>
        <div style={{display:'flex',gap:8}}>
          <button className="btn primary sm" onClick={runCheck}>🔍 Run check</button>
          {issues?.length>0 && (
            <button className="btn sm" style={{background:'var(--teal)',color:'#fff'}}
              onClick={fixAll} disabled={fixing}>
              {fixing?'Fixing…':`✓ Fix all (${issues.length})`}
            </button>
          )}
        </div>
      </div>

      {issues === null && (
        <div className="panel panel-pad" style={{textAlign:'center',color:'var(--muted)',fontSize:13}}>
          Click "Run check" to scan your data for issues.
        </div>
      )}

      {issues?.length === 0 && (
        <div className="panel panel-pad" style={{textAlign:'center',color:'var(--teal)',fontSize:13,fontWeight:500}}>
          ✓ All clean — no issues found.
        </div>
      )}

      {Object.entries(grouped).map(([type, items]) => (
        <div key={type} className="panel" style={{marginBottom:10}}>
          <div className="panel-head" style={{background:'var(--amber-wash)'}}>
            <div style={{fontWeight:600,fontSize:13,color:'var(--amber)'}}>
              ⚠ {type} <span style={{fontWeight:400,color:'var(--muted)'}}>({items.length})</span>
            </div>
          </div>
          <div className="panel-body">
            {items.map((issue,i) => (
              <div key={i} style={{display:'flex',justifyContent:'space-between',alignItems:'center',
                padding:'6px 0',borderBottom:i<items.length-1?'1px solid var(--line)':'none'}}>
                <div style={{fontSize:12.5,color:'var(--muted)'}}>{issue.desc}</div>
                <button className="btn ghost xs" onClick={async()=>{
                  await issue.fix();
                  setIssues(prev=>prev.filter((_,idx)=>idx!==issues.indexOf(issue)));
                  toast('Fixed.');
                }}>Fix</button>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ---- Data management tab (Master only) ---- */
function DataTab({ rawStore }) {
  const { user, profile } = useAuth();
  const toast = useToast();
  const [modal, setModal] = useState(null);

  const DATA_COLLECTIONS = [
    { id:'contacts', label:'Contacts (Outreach)', desc:'All delegate and VIP records' },
    { id:'logistics', label:'Logistics', desc:'Travel and accommodation records' },
    { id:'sessions', label:'Sessions', desc:'Event schedule sessions' },
    { id:'assignments', label:'Session assignments', desc:'Panelist–session links' },
    { id:'founder', label:'Founder meetings', desc:'One-on-one meeting records' },
    { id:'volunteers', label:'Volunteers', desc:'Volunteer directory' },
    { id:'poc', label:'POC assignments', desc:'VIP escort duty records' },
    { id:'departments', label:'Departments', desc:'Department master list' },
    { id:'tasks', label:'Tasks', desc:'All task records' },
    { id:'events', label:'Events', desc:'All event records' },
    { id:'activity_log', label:'Activity log', desc:'Full audit trail' },
  ];
  // IMPORTANT: users collection is never wiped — it would lock everyone out

  async function wipeCollection(colId) {
    const snap = await getDocs(collection(db, colId));
    const batch = writeBatch(db);
    snap.docs.forEach(d => batch.delete(d.ref));
    await batch.commit();
    await logAction(user, profile, 'Wiped collection', colId);
    toast(`${colId} cleared.`);
    setModal(null);
  }

  async function wipeAll(keepOptions) {
    const ALWAYS_WIPE = [
      'contacts','logistics','sessions','assignments','founder','sahebjiSlots',
      'poc','tasks','felicitation','checklist','contact_notes','activity_log',
      'minuteItems','personalisedSchedule','personalisedMandatory','availability',
    ];
    const OPTIONAL = [
      { id:'volunteers',  label:'Volunteers directory' },
      { id:'departments', label:'Departments' },
      { id:'carVendors',  label:'Car vendors' },
      { id:'appConfig',   label:'Configurations & settings' },
      { id:'events',      label:'Events list' },
      // users is NEVER wiped
    ];

    const toWipe = [
      ...ALWAYS_WIPE,
      ...OPTIONAL.filter(o => keepOptions[o.id] === false).map(o => o.id),
    ];

    for (const col of toWipe) {
      try {
        const snap = await getDocs(collection(db, col));
        if (col === 'users') {
          // Only delete non-Master users — never delete Master
          const batch = writeBatch(db);
          snap.docs.forEach(d => {
            if (d.data().role !== 'Master') batch.delete(d.ref);
          });
          await batch.commit();
        } else {
          const batch = writeBatch(db);
          snap.docs.forEach(d => batch.delete(d.ref));
          await batch.commit();
        }
      } catch(e) { console.warn('could not wipe', col, e); }
    }
    // Clear app_state
    try {
      const snap = await getDocs(collection(db,'app_state'));
      const b = writeBatch(db);
      snap.docs.forEach(d => b.delete(d.ref));
      await b.commit();
    } catch {}

    await logAction(user, profile, 'SYSTEM WIPE', 'Data wiped with options: ' + JSON.stringify(keepOptions));
    toast('System wipe complete.');
    setModal(null);
  }

  const OPTIONAL_KEEP = [
    { id:'users',       label:'User accounts',          desc:'Keep all team member accounts (Master is never deleted)' },
    { id:'volunteers',  label:'Volunteers directory',   desc:'Keep your volunteer list' },
    { id:'departments', label:'Departments',            desc:'Keep department structure' },
    { id:'carVendors',  label:'Car vendors',            desc:'Keep vendor & driver list' },
    { id:'appConfig',   label:'Configurations',         desc:'Keep column settings, event types, etc.' },
    { id:'events',      label:'Events list',            desc:'Keep the events list' },
  ];

  const counts = col => (rawStore[col]||[]).length;

  return (
    <>
      <div className="flow-note">{ICON.info}<div><b>Destructive actions.</b> All deletes are permanent and cannot be undone. You will be asked to type a confirmation phrase before any delete proceeds.</div></div>
      <div className="panel">
        <div className="panel-head"><h2>Clear individual collections</h2></div>
        <div className="panel-body"><table><thead><tr><th>Collection</th><th>Description</th><th>Records</th><th></th></tr></thead><tbody>
          {DATA_COLLECTIONS.map(col=>(
            <tr key={col.id}>
              <td><div className="nm">{col.label}</div></td>
              <td className="muted-sm">{col.desc}</td>
              <td className="mono">{counts(col.id)}</td>
              <td><button className="btn danger xs" onClick={()=>setModal({type:'col',col})}>Clear</button></td>
            </tr>
          ))}
        </tbody></table></div>
      </div>
      <div className="panel panel-pad" style={{borderColor:'var(--rose)',borderWidth:2}}>
        <h2 style={{color:'var(--rose)',marginBottom:8}}>⚠ System wipe</h2>
        <p className="muted-sm" style={{marginBottom:14}}>
          Wipes all event data — contacts, logistics, sessions, schedules, tasks, POC, etc.
          User accounts are never deleted. You choose what else to keep.
        </p>
        <button className="btn danger" onClick={()=>setModal({type:'wipe'})}>{ICON.trash} Wipe system data</button>
      </div>

      {modal?.type==='col' && <ConfirmDelete
        title={`Clear "${modal.col.label}"?`}
        phrase="delete forever"
        warning={`This will permanently delete all ${counts(modal.col.id)} records in ${modal.col.label}. This cannot be undone.`}
        onClose={()=>setModal(null)}
        onConfirm={()=>wipeCollection(modal.col.id)}
      />}
      {modal?.type==='wipe' && <WipeModal
        optionalKeep={OPTIONAL_KEEP}
        onClose={()=>setModal(null)}
        onConfirm={keepOptions=>wipeAll(keepOptions)}
      />}
    </>
  );
}

/* ---- Wipe Modal with keep options ---- */
function WipeModal({ optionalKeep, onClose, onConfirm }) {
  const [keepOptions, setKeepOptions] = useState(
    Object.fromEntries(optionalKeep.map(o=>[o.id, true])) // default: keep everything
  );
  const [phrase, setPhrase] = useState('');
  const [wiping, setWiping] = useState(false);

  const CONFIRM_PHRASE = 'wipe data';
  const valid = phrase.trim().toLowerCase() === CONFIRM_PHRASE;

  async function doWipe() {
    if (!valid) return;
    setWiping(true);
    await onConfirm(keepOptions);
    setWiping(false);
  }

  const keptCount = Object.values(keepOptions).filter(Boolean).length;

  return (
    <div className="scrim" onMouseDown={onClose}>
      <div className="modal" onMouseDown={e=>e.stopPropagation()} style={{maxWidth:480}}>
        <div className="modal-head">
          <h2 style={{color:'var(--rose)'}}>⚠ System wipe</h2>
          <button className="x" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          {/* Always wiped */}
          <div style={{background:'#FFF5F5',border:'1px solid #FCA5A5',borderRadius:8,padding:'10px 14px',marginBottom:16}}>
            <div style={{fontWeight:600,fontSize:13,marginBottom:6,color:'var(--rose)'}}>Always wiped:</div>
            <div style={{fontSize:12.5,color:'var(--muted)',lineHeight:1.7}}>
              Contacts · Logistics · Sessions · Assignments · Sahebji meetings · POC allocations · Personalised schedules · Volunteer availability · Tasks · Checklist · Activity log
            </div>
            <div style={{fontSize:12,color:'var(--rose)',marginTop:6,fontWeight:500}}>
              ✓ Master account is never deleted regardless
            </div>
          </div>

          {/* Optional keep */}
          <div style={{fontWeight:600,fontSize:13,marginBottom:8}}>What do you want to keep?</div>
          {optionalKeep.map(o=>(
            <label key={o.id} style={{display:'flex',alignItems:'center',gap:10,padding:'8px 12px',
              borderRadius:8,marginBottom:6,cursor:'pointer',
              border:`1px solid ${keepOptions[o.id]?'var(--teal)':'var(--line)'}`,
              background:keepOptions[o.id]?'var(--teal-wash)':'#fff'}}>
              <input type="checkbox" checked={keepOptions[o.id]}
                onChange={e=>setKeepOptions(prev=>({...prev,[o.id]:e.target.checked}))}
                style={{accentColor:'var(--teal)',width:16,height:16}}/>
              <div>
                <div style={{fontWeight:600,fontSize:13}}>{o.label}</div>
                <div style={{fontSize:11.5,color:'var(--muted)'}}>{o.desc}</div>
              </div>
              {keepOptions[o.id]
                ? <span style={{marginLeft:'auto',fontSize:11,color:'var(--teal)',fontWeight:600}}>KEEP</span>
                : <span style={{marginLeft:'auto',fontSize:11,color:'var(--rose)',fontWeight:600}}>DELETE</span>}
            </label>
          ))}

          {/* Confirmation phrase */}
          <div style={{marginTop:16,padding:'12px 14px',background:'#FFF5F5',borderRadius:8,border:'1px solid #FCA5A5'}}>
            <div style={{fontSize:13,marginBottom:8,color:'var(--rose)'}}>
              Type <b>"{CONFIRM_PHRASE}"</b> to confirm. {keptCount < optionalKeep.length &&
                <span>This will permanently delete {optionalKeep.filter(o=>!keepOptions[o.id]).map(o=>o.label).join(', ')}.</span>}
            </div>
            <input className="input" value={phrase} onChange={e=>setPhrase(e.target.value)}
              placeholder={`Type "${CONFIRM_PHRASE}" to continue`}
              style={{borderColor:valid?'var(--teal)':phrase?'var(--rose)':'var(--line)'}}/>
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn danger" onClick={doWipe} disabled={!valid||wiping}>
            {wiping?'Wiping…':'⚠ Wipe now'}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---- Confirm delete modal with typed phrase ---- */
function ScheduleTemplateSection({ rawStore, toast }) {
  const saved = (rawStore.appConfig||[]).find(c=>c.id==='scheduleTemplate')||{};
  const MAX_LOGO_BYTES = 300 * 1024; // 300KB

  const [f, setF] = useState({
    headerTitle:    saved.headerTitle    || 'VK Outreach Program — JYOT',
    headerSub:      saved.headerSub      || '',
    headerBg:       saved.headerBg       || '#0F6E56',
    headerTextColor:saved.headerTextColor|| '#ffffff',
    logoPosition:   saved.logoPosition   || 'left',
    logoSize:       saved.logoSize       || 'medium',
    headerLogo:     saved.headerLogo     || '',
    footerLine1:    saved.footerLine1    || '',
    footerLine2:    saved.footerLine2    || '',
    footerLogo:     saved.footerLogo     || '',
    footerBorderColor:saved.footerBorderColor||'#0F6E56',
    showPageNumber: saved.showPageNumber !== false,
    tableHeaderBg:  saved.tableHeaderBg  || '',
    tableHeaderText:saved.tableHeaderText|| '#ffffff',
    altRowColor:    saved.altRowColor    || '#F0FAF6',
    fontFamily:     saved.fontFamily     || 'Calibri',
    timeColWidth:   saved.timeColWidth   || 'normal',
    showHotel:      saved.showHotel      !== false,
    showPOC:        saved.showPOC        !== false,
    showAutoTag:    saved.showAutoTag     !== false,
  });

  const set = k => e => setF(p=>({...p,[k]: e.target.type==='checkbox'?e.target.checked:e.target.value}));
  const [saving, setSaving] = useState(false);
  const [logoError, setLogoError] = useState('');
  const [footerLogoError, setFooterLogoError] = useState('');

  // Effective table header colour falls back to headerBg
  const tableHdrBg = f.tableHeaderBg || f.headerBg;

  function handleLogoUpload(file, field, setErr) {
    setErr('');
    if (!file) return;
    if (file.size > MAX_LOGO_BYTES) {
      setErr(`File too large (${(file.size/1024).toFixed(0)}KB). Max 300KB. Use a compressed PNG or SVG.`);
      return;
    }
    const reader = new FileReader();
    reader.onload = e => setF(p=>({...p,[field]:e.target.result}));
    reader.readAsDataURL(file);
  }

  async function saveTemplate() {
    setSaving(true);
    await saveItem('appConfig', {...saved, id:'scheduleTemplate', ...f});
    toast('Template saved.');
    setSaving(false);
  }

  const LOGO_SIZES = {small:'40px', medium:'60px', large:'90px'};
  const logoH = LOGO_SIZES[f.logoSize]||'60px';
  const TIME_WIDTHS = {narrow:'70pt', normal:'90pt', wide:'120pt'};
  const fonts = ['Calibri','Arial','Times New Roman','Georgia','Verdana'];

  return (
    <div style={{display:'flex',gap:24,alignItems:'flex-start',flexWrap:'wrap'}}>

      {/* Left — settings panel */}
      <div className="tpl-col" style={{flex:'1 1 400px',minWidth:320}}>
        <div className="panel panel-pad" style={{marginBottom:12}}>
          <h3 style={{fontFamily:'var(--serif)',fontSize:14,marginBottom:12,color:'var(--teal)'}}>Header</h3>
          <div style={{display:'flex',flexDirection:'column',gap:10}}>

            <Field label="Header logo (max 300KB — PNG, JPG or SVG)">
              <div style={{display:'flex',gap:8,alignItems:'center'}}>
                {f.headerLogo && <img src={f.headerLogo} alt="logo" style={{height:36,objectFit:'contain',border:'1px solid var(--line)',borderRadius:4,padding:2}}/>}
                <label className="btn sm" style={{cursor:'pointer',margin:0}}>
                  {f.headerLogo?'Change logo':'Upload logo'}
                  <input type="file" accept="image/*" style={{display:'none'}}
                    onChange={e=>handleLogoUpload(e.target.files[0],'headerLogo',setLogoError)}/>
                </label>
                {f.headerLogo && <button className="btn ghost sm" style={{color:'var(--rose)'}} onClick={()=>setF(p=>({...p,headerLogo:''}))}>Remove</button>}
              </div>
              {logoError && <div style={{color:'var(--rose)',fontSize:11.5,marginTop:4}}>{logoError}</div>}
            </Field>

            <div className="grid2">
              <Field label="Logo position">
                <select className="statsel" value={f.logoPosition} onChange={set('logoPosition')}>
                  <option value="left">Left</option>
                  <option value="center">Centre</option>
                  <option value="right">Right</option>
                </select>
              </Field>
              <Field label="Logo size">
                <select className="statsel" value={f.logoSize} onChange={set('logoSize')}>
                  <option value="small">Small (40px)</option>
                  <option value="medium">Medium (60px)</option>
                  <option value="large">Large (90px)</option>
                </select>
              </Field>
            </div>

            <Field label="Header title">
              <input className="input" value={f.headerTitle} onChange={set('headerTitle')} placeholder="VK Outreach Program — JYOT"/>
            </Field>
            <Field label="Header subtitle / tagline">
              <input className="input" value={f.headerSub} onChange={set('headerSub')} placeholder="e.g. National Conclave 2026 · Mumbai"/>
            </Field>

            <div className="grid2">
              <Field label="Header background colour">
                <div style={{display:'flex',gap:6,alignItems:'center'}}>
                  <input type="color" value={f.headerBg} onChange={set('headerBg')}
                    style={{width:36,height:32,border:'1px solid var(--line)',borderRadius:6,cursor:'pointer',padding:2}}/>
                  <input className="input" value={f.headerBg} onChange={set('headerBg')} style={{fontFamily:'monospace',fontSize:12}}/>
                </div>
              </Field>
              <Field label="Header text colour">
                <div style={{display:'flex',gap:6,alignItems:'center'}}>
                  <input type="color" value={f.headerTextColor} onChange={set('headerTextColor')}
                    style={{width:36,height:32,border:'1px solid var(--line)',borderRadius:6,cursor:'pointer',padding:2}}/>
                  <input className="input" value={f.headerTextColor} onChange={set('headerTextColor')} style={{fontFamily:'monospace',fontSize:12}}/>
                </div>
              </Field>
            </div>
          </div>
        </div>

        <div className="panel panel-pad" style={{marginBottom:12}}>
          <h3 style={{fontFamily:'var(--serif)',fontSize:14,marginBottom:12,color:'var(--teal)'}}>Table</h3>
          <div style={{display:'flex',flexDirection:'column',gap:10}}>
            <div className="grid2">
              <Field label="Table header colour (defaults to header bg)">
                <div style={{display:'flex',gap:6,alignItems:'center'}}>
                  <input type="color" value={f.tableHeaderBg||f.headerBg} onChange={set('tableHeaderBg')}
                    style={{width:36,height:32,border:'1px solid var(--line)',borderRadius:6,cursor:'pointer',padding:2}}/>
                  <input className="input" value={f.tableHeaderBg} onChange={set('tableHeaderBg')} placeholder="Same as header" style={{fontFamily:'monospace',fontSize:12}}/>
                </div>
              </Field>
              <Field label="Alternating row colour">
                <div style={{display:'flex',gap:6,alignItems:'center'}}>
                  <input type="color" value={f.altRowColor} onChange={set('altRowColor')}
                    style={{width:36,height:32,border:'1px solid var(--line)',borderRadius:6,cursor:'pointer',padding:2}}/>
                  <input className="input" value={f.altRowColor} onChange={set('altRowColor')} style={{fontFamily:'monospace',fontSize:12}}/>
                </div>
              </Field>
              <Field label="Font">
                <select className="statsel" value={f.fontFamily} onChange={set('fontFamily')}>
                  {fonts.map(fn=><option key={fn}>{fn}</option>)}
                </select>
              </Field>
              <Field label="Time column width">
                <select className="statsel" value={f.timeColWidth} onChange={set('timeColWidth')}>
                  <option value="narrow">Narrow (70pt)</option>
                  <option value="normal">Normal (90pt)</option>
                  <option value="wide">Wide (120pt)</option>
                </select>
              </Field>
            </div>
          </div>
        </div>

        <div className="panel panel-pad" style={{marginBottom:12}}>
          <h3 style={{fontFamily:'var(--serif)',fontSize:14,marginBottom:12,color:'var(--teal)'}}>Footer</h3>
          <div style={{display:'flex',flexDirection:'column',gap:10}}>

            <Field label="Footer logo (max 300KB — optional, can differ from header)">
              <div style={{display:'flex',gap:8,alignItems:'center'}}>
                {f.footerLogo && <img src={f.footerLogo} alt="footer logo" style={{height:28,objectFit:'contain',border:'1px solid var(--line)',borderRadius:4,padding:2}}/>}
                <label className="btn sm" style={{cursor:'pointer',margin:0}}>
                  {f.footerLogo?'Change':'Upload footer logo'}
                  <input type="file" accept="image/*" style={{display:'none'}}
                    onChange={e=>handleLogoUpload(e.target.files[0],'footerLogo',setFooterLogoError)}/>
                </label>
                {f.footerLogo && <button className="btn ghost sm" style={{color:'var(--rose)'}} onClick={()=>setF(p=>({...p,footerLogo:''}))}>Remove</button>}
              </div>
              {footerLogoError && <div style={{color:'var(--rose)',fontSize:11.5,marginTop:4}}>{footerLogoError}</div>}
            </Field>

            <Field label="Footer line 1">
              <input className="input" value={f.footerLine1} onChange={set('footerLine1')} placeholder="e.g. Strictly confidential — for delegate use only"/>
            </Field>
            <Field label="Footer line 2">
              <input className="input" value={f.footerLine2} onChange={set('footerLine2')} placeholder="e.g. Contact: events@vkoutreach.org · +91 98xxx xxxxx"/>
            </Field>
            <div className="grid2">
              <Field label="Footer border colour">
                <div style={{display:'flex',gap:6,alignItems:'center'}}>
                  <input type="color" value={f.footerBorderColor} onChange={set('footerBorderColor')}
                    style={{width:36,height:32,border:'1px solid var(--line)',borderRadius:6,cursor:'pointer',padding:2}}/>
                  <input className="input" value={f.footerBorderColor} onChange={set('footerBorderColor')} style={{fontFamily:'monospace',fontSize:12}}/>
                </div>
              </Field>
              <Field label="Show page number">
                <label style={{display:'flex',alignItems:'center',gap:6,marginTop:6,cursor:'pointer'}}>
                  <input type="checkbox" checked={f.showPageNumber} onChange={set('showPageNumber')} style={{accentColor:'var(--teal)'}}/>
                  Yes
                </label>
              </Field>
            </div>
          </div>
        </div>

        <div className="panel panel-pad" style={{marginBottom:16}}>
          <h3 style={{fontFamily:'var(--serif)',fontSize:14,marginBottom:12,color:'var(--teal)'}}>Content</h3>
          <div style={{display:'flex',flexDirection:'column',gap:8}}>
            {[
              ['showHotel',  'Show hotel & travel info block'],
              ['showPOC',    'Show POC assignment rows'],
              ['showAutoTag','Show auto-row tag (⟳)'],
            ].map(([key,label])=>(
              <label key={key} style={{display:'flex',alignItems:'center',gap:8,fontSize:13,cursor:'pointer'}}>
                <input type="checkbox" checked={f[key]} onChange={set(key)} style={{accentColor:'var(--teal)'}}/>
                {label}
              </label>
            ))}
          </div>
        </div>

        <button className="btn primary" onClick={saveTemplate} disabled={saving}>
          {saving?'Saving…':'Save template'}
        </button>
      </div>

      {/* Right — live preview */}
      <div className="tpl-col tpl-preview" style={{flex:'1 1 340px',minWidth:300,position:'sticky',top:24}}>
        <div style={{fontWeight:600,fontSize:12,color:'var(--muted)',marginBottom:8,textTransform:'uppercase',letterSpacing:'0.05em'}}>Live preview</div>
        <div style={{border:'1px solid var(--line)',borderRadius:10,overflow:'hidden',fontFamily:f.fontFamily+',sans-serif',fontSize:11}}>

          {/* Header */}
          <div style={{background:f.headerBg,color:f.headerTextColor,padding:'10px 14px',
            display:'flex',alignItems:'center',gap:10,
            flexDirection:f.logoPosition==='right'?'row-reverse':f.logoPosition==='center'?'column':'row',
            justifyContent:f.logoPosition==='center'?'center':'flex-start'}}>
            {f.headerLogo && <img src={f.headerLogo} alt="logo" style={{height:logoH,objectFit:'contain',flexShrink:0}}/>}
            <div style={{textAlign:f.logoPosition==='center'?'center':'left'}}>
              <div style={{fontWeight:700,fontSize:13,color:f.headerTextColor}}>{f.headerTitle||'Header Title'}</div>
              {f.headerSub&&<div style={{fontSize:10,opacity:.85,marginTop:2,color:f.headerTextColor}}>{f.headerSub}</div>}
            </div>
          </div>

          {/* Contact info */}
          <div style={{padding:'8px 14px',borderBottom:'1px solid #eee'}}>
            <div style={{fontWeight:600,fontSize:12,color:'#1a1a1a'}}>Panelist Name</div>
            <div style={{fontSize:10,color:'#666'}}>Type · Designation · Organisation</div>
            {f.showHotel&&<div style={{fontSize:10,color:'#888',marginTop:3}}>Hotel: Taj Mahal Palace · Arrival: 15 Oct · Departure: 18 Oct</div>}
          </div>

          {/* Day header */}
          <div style={{padding:'5px 14px',background:'#f5f5f5',fontSize:11,fontWeight:600,color:f.headerBg}}>
            15th October 2026
          </div>

          {/* Table */}
          <table style={{width:'100%',borderCollapse:'collapse',fontSize:10}}>
            <thead>
              <tr style={{background:tableHdrBg,color:f.tableHeaderText||'#fff'}}>
                <th style={{padding:'4px 10px',textAlign:'left',width:TIME_WIDTHS[f.timeColWidth],color:f.tableHeaderText||'#fff'}}>Time</th>
                <th style={{padding:'4px 10px',textAlign:'left',color:f.tableHeaderText||'#fff'}}>Programme</th>
              </tr>
            </thead>
            <tbody>
              {[
                ['09:00','Inauguration Ceremony',false,false],
                ['10:30','Keynote Address',true,false],
                ['12:00',f.showPOC?'POC: Rajesh Mehta — 9870001001':'Lunch Break',false,f.showPOC],
                ['14:00','Panel Discussion',false,false],
              ].map(([time,event,alt,isPoc],i)=>(
                <tr key={i} style={{background:alt?f.altRowColor:'#fff'}}>
                  <td style={{padding:'3px 10px',borderBottom:'1px solid #eee',color:isPoc?f.headerBg:'#1a1a1a',fontWeight:isPoc?500:400}}>{time}</td>
                  <td style={{padding:'3px 10px',borderBottom:'1px solid #eee',color:isPoc?f.headerBg:'#1a1a1a'}}>
                    {event}{f.showAutoTag&&i===1?<span style={{fontSize:8,color:'#aaa',marginLeft:4}}>⟳</span>:''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* Footer */}
          {(f.footerLine1||f.footerLine2||f.footerLogo)&&(
            <div style={{borderTop:`2px solid ${f.footerBorderColor}`,padding:'6px 14px',
              display:'flex',alignItems:'center',justifyContent:'space-between'}}>
              <div>
                {f.footerLine1&&<div style={{fontSize:9,color:'#888'}}>{f.footerLine1}</div>}
                {f.footerLine2&&<div style={{fontSize:9,color:'#888'}}>{f.footerLine2}</div>}
                {f.showPageNumber&&<div style={{fontSize:9,color:'#aaa',marginTop:2}}>Page 1</div>}
              </div>
              {f.footerLogo&&<img src={f.footerLogo} alt="footer logo" style={{height:24,objectFit:'contain'}}/>}
            </div>
          )}
        </div>
        <p style={{fontSize:11,color:'var(--muted)',marginTop:8}}>
          Preview updates live. Click Save template to apply to all Print and Word downloads.
        </p>
      </div>
    </div>
  );
}

function EventTypesSection({ rawStore, toast }) {
  const saved = (rawStore.appConfig||[]).find(c=>c.id==='eventTypes')?.items;
  const types = saved || ['Conclave','Precursor','Exhibition','Podcast','Other'];
  const [newType, setNewType] = useState('');

  async function removeType(t) {
    const updated = types.filter(x=>x!==t);
    await saveItem('appConfig', {id:'eventTypes', items:updated});
    toast('Event type removed.');
  }
  async function addType() {
    if (!newType.trim()) return;
    const updated = [...types, newType.trim()];
    await saveItem('appConfig', {id:'eventTypes', items:updated});
    setNewType('');
    toast('Event type added.');
  }
  return (
    <div className="panel panel-pad">
      <h3 style={{fontFamily:'var(--serif)',fontSize:15,marginBottom:4}}>Event types</h3>
      <p style={{fontSize:13,color:'var(--muted)',marginBottom:16}}>
        These appear in the Type dropdown when creating or editing an event.
      </p>
      {types.map(t => (
        <div key={t} style={{display:'flex',alignItems:'center',gap:10,padding:'7px 12px',
          background:'var(--paper)',borderRadius:8,marginBottom:6,border:'1px solid var(--line)'}}>
          <span style={{flex:1,fontSize:13}}>{t}</span>
          <button className="btn ghost xs" style={{color:'var(--rose)'}} onClick={()=>removeType(t)}>Remove</button>
        </div>
      ))}
      <div style={{display:'flex',gap:8,marginTop:12}}>
        <input className="input" style={{flex:1}} value={newType}
          onChange={e=>setNewType(e.target.value)} placeholder="Add new event type…"
          onKeyDown={e=>e.key==='Enter'&&addType()}/>
        <button className="btn primary sm" onClick={addType}>Add</button>
      </div>
    </div>
  );
}

function ConfigurationsTab({ rawStore }) {
  const toast = useToast();
  const [section, setSection] = useState('vendors');

  // Column config stored in Firestore
  const colConfig = (rawStore.appConfig || []).find(c => c.id === 'columnConfig') || {};

  const DEFAULT_COLS = {
    overallSchedule: ['date','start','end','title','venue','type'],
    minuteToMinute:  ['detail','schedule','duration','speakerId'],
    volunteerAvail:  ['checked','slot','deptIds','preEventAvail','preEventRemark'],
  };

  const AVAILABLE_COLS = {
    overallSchedule: [
      { key:'date', label:'Date' }, { key:'start', label:'Start time' },
      { key:'end', label:'End time' }, { key:'title', label:'Session title' },
      { key:'venue', label:'Venue' }, { key:'type', label:'Type' },
      { key:'topic', label:'Topic/Description' },
    ],
    minuteToMinute: [
      { key:'detail', label:'Session details' }, { key:'schedule', label:'Schedule time' },
      { key:'duration', label:'Duration' }, { key:'speakerId', label:'Speaker' },
    ],
    volunteerAvail: [
      { key:'checked', label:'Available (checkbox)' }, { key:'slot', label:'Time slot' },
      { key:'deptIds', label:'Department(s)' }, { key:'preEventAvail', label:'Pre-event availability' },
      { key:'preEventRemark', label:'Pre-event remarks' },
    ],
  };

  const MANDATORY_ITEMS_DEFAULT = [
    { key:'arrivalAtVenue', label:'Arrival at Venue', locked: true },
    { key:'guidedTour', label:'Guided tour of Exhibition', locked: false },
    { key:'mediaBytes', label:'Media Bytes', locked: false },
    { key:'sahebji', label:'One-on-one Meeting with Sahebji', locked: false },
    { key:'podcast', label:'Podcast', locked: false },
  ];

  const [customMandatory, setCustomMandatory] = useState(
    (rawStore.appConfig || []).find(c => c.id === 'mandatoryItems')?.items || []
  );
  const [newMandatoryLabel, setNewMandatoryLabel] = useState('');

  const getCols = (module) => colConfig[module] || DEFAULT_COLS[module] || [];
  const toggleCol = async (module, key) => {
    const current = getCols(module);
    const updated = current.includes(key) ? current.filter(k => k !== key) : [...current, key];
    await saveItem('appConfig', { id: 'columnConfig', ...colConfig, [module]: updated });
    toast('Column preference saved.');
  };

  const addMandatory = async () => {
    if (!newMandatoryLabel.trim()) return;
    const key = newMandatoryLabel.toLowerCase().replace(/[^a-z0-9]/g,'_');
    const updated = [...customMandatory, { key, label: newMandatoryLabel.trim(), locked: false }];
    setCustomMandatory(updated);
    await saveItem('appConfig', { id: 'mandatoryItems', items: updated });
    setNewMandatoryLabel('');
    toast('Mandatory item added.');
  };

  const removeMandatory = async (key) => {
    const updated = customMandatory.filter(m => m.key !== key);
    setCustomMandatory(updated);
    await saveItem('appConfig', { id: 'mandatoryItems', items: updated });
    toast('Item removed.');
  };

  const EVENT_DROPDOWN_OPTIONS = [
    'Arrival at the Airport','Departure Flight','Journey towards Hotel',
    'Journey towards Venue','Arrival at Venue','One-on-One Meeting with Sahebji',
    'Media Bytes','Guided tour of Exhibition','Breakfast','Podcast',
    'Lunch','Journey towards Airport','High Tea','Checkout from Hotel',
  ];
  const [customEventOptions, setCustomEventOptions] = useState(
    (rawStore.appConfig || []).find(c => c.id === 'eventOptions')?.items || EVENT_DROPDOWN_OPTIONS
  );
  const [newEventOption, setNewEventOption] = useState('');

  const addEventOption = async () => {
    if (!newEventOption.trim()) return;
    const updated = [...customEventOptions, newEventOption.trim()];
    setCustomEventOptions(updated);
    await saveItem('appConfig', { id: 'eventOptions', items: updated });
    setNewEventOption('');
    toast('Event option added.');
  };
  const removeEventOption = async (opt) => {
    const updated = customEventOptions.filter(o => o !== opt);
    setCustomEventOptions(updated);
    await saveItem('appConfig', { id: 'eventOptions', items: updated });
  };

  const sections = [
    { key:'vendors',     label:'Car Vendor Master' },
    { key:'cols',        label:'Column visibility' },
    { key:'mandatory',   label:'Mandatory schedule items' },
    { key:'eventOptions',label:'Event dropdown options' },
    { key:'eventTypes',  label:'Event types' },
    { key:'fullDayHours',    label:'Full Day Hours' },
    { key:'scheduleTemplate',label:'Schedule Template' },
  ];

  return (
    <div>
      <div style={{display:'flex',gap:8,marginBottom:16,flexWrap:'wrap'}}>
        {sections.map(s=>(
          <button key={s.key} className={'btn sm'+(section===s.key?' primary':'')}
            onClick={()=>setSection(s.key)}>{s.label}</button>
        ))}
      </div>

      {section==='vendors' && <div className="panel panel-pad"><CarVendorMaster store={rawStore}/></div>}

      {section==='cols' && (
        <div className="panel panel-pad">
          <h3 style={{fontFamily:'var(--serif)',fontSize:15,marginBottom:4}}>Column visibility</h3>
          <p style={{fontSize:13,color:'var(--muted)',marginBottom:16}}>Choose which columns appear in each module.</p>
          {Object.entries(AVAILABLE_COLS).map(([module, cols]) => (
            <div key={module} style={{marginBottom:20}}>
              <div style={{fontWeight:600,fontSize:13,marginBottom:8,textTransform:'capitalize',color:'var(--teal)'}}>
                {module.replace(/([A-Z])/g,' $1').trim()}
              </div>
              <div style={{display:'flex',flexWrap:'wrap',gap:8}}>
                {cols.map(col => {
                  const active = getCols(module).includes(col.key);
                  return (
                    <label key={col.key} style={{display:'flex',alignItems:'center',gap:6,padding:'5px 12px',
                      borderRadius:20,border:`1.5px solid ${active?'var(--teal)':'var(--line)'}`,
                      background:active?'var(--teal-wash)':'#fff',cursor:'pointer',fontSize:12.5}}>
                      <input type="checkbox" checked={active} onChange={()=>toggleCol(module, col.key)}
                        style={{accentColor:'var(--teal)'}}/>
                      {col.label}
                    </label>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      {section==='mandatory' && (
        <div className="panel panel-pad">
          <h3 style={{fontFamily:'var(--serif)',fontSize:15,marginBottom:4}}>Mandatory schedule items</h3>
          <p style={{fontSize:13,color:'var(--muted)',marginBottom:16}}>
            These items appear as checkboxes in the Personalised Schedule for each panelist.
            Locked items cannot be removed.
          </p>
          {[...MANDATORY_ITEMS_DEFAULT, ...customMandatory].map(item=>(
            <div key={item.key} style={{display:'flex',alignItems:'center',gap:10,padding:'8px 12px',
              background:'var(--paper)',borderRadius:8,marginBottom:6,border:'1px solid var(--line)'}}>
              <span style={{flex:1,fontSize:13}}>{item.label}</span>
              {item.locked
                ? <span style={{fontSize:11,color:'var(--muted)'}}>🔒 Locked</span>
                : <button className="btn ghost xs" style={{color:'var(--rose)'}}
                    onClick={()=>removeMandatory(item.key)}>Remove</button>}
            </div>
          ))}
          <div style={{display:'flex',gap:8,marginTop:12}}>
            <input className="input" style={{flex:1}} value={newMandatoryLabel}
              onChange={e=>setNewMandatoryLabel(e.target.value)}
              placeholder="Add new mandatory item…"
              onKeyDown={e=>e.key==='Enter'&&addMandatory()}/>
            <button className="btn primary sm" onClick={addMandatory}>Add</button>
          </div>
        </div>
      )}

      {section==='eventTypes' && <EventTypesSection rawStore={rawStore} toast={toast}/>}

      {section==='fullDayHours' && (() => {
        const saved = (rawStore.appConfig||[]).find(c=>c.id==='fullDayHours')||{start:'09:00',end:'22:00'};
        return (
          <div className="panel panel-pad">
            <h3 style={{fontFamily:'var(--serif)',fontSize:15,marginBottom:4}}>Full Day Hours</h3>
            <p style={{fontSize:13,color:'var(--muted)',marginBottom:16}}>
              When a volunteer ticks "Full Day" in Volunteer Availability, these times are auto-filled.
            </p>
            <div className="grid2" style={{maxWidth:320}}>
              <Field label="Full Day Start">
                <TimePicker value={saved.start||'09:00'} onChange={async v=>{
                  await saveItem('appConfig',{...saved,id:'fullDayHours',start:v});
                  toast('Full Day start saved.');
                }}/>
              </Field>
              <Field label="Full Day End">
                <TimePicker value={saved.end||'22:00'} onChange={async v=>{
                  await saveItem('appConfig',{...saved,id:'fullDayHours',end:v});
                  toast('Full Day end saved.');
                }}/>
              </Field>
            </div>
          </div>
        );
      })()}

      {section==='scheduleTemplate' && <ScheduleTemplateSection rawStore={rawStore} toast={toast} saveItem={saveItem}/>}


      {section==='eventOptions' && (
        <div className="panel panel-pad">
          <h3 style={{fontFamily:'var(--serif)',fontSize:15,marginBottom:4}}>Event dropdown options</h3>
          <p style={{fontSize:13,color:'var(--muted)',marginBottom:16}}>
            These appear in the Event dropdown in the Personalised Schedule expanded rows.
          </p>
          {customEventOptions.map(opt=>(
            <div key={opt} style={{display:'flex',alignItems:'center',gap:10,padding:'7px 12px',
              background:'var(--paper)',borderRadius:8,marginBottom:6,border:'1px solid var(--line)'}}>
              <span style={{flex:1,fontSize:13}}>{opt}</span>
              <button className="btn ghost xs" style={{color:'var(--rose)'}}
                onClick={()=>removeEventOption(opt)}>Remove</button>
            </div>
          ))}
          <div style={{display:'flex',gap:8,marginTop:12}}>
            <input className="input" style={{flex:1}} value={newEventOption}
              onChange={e=>setNewEventOption(e.target.value)}
              placeholder="Add new event option…"
              onKeyDown={e=>e.key==='Enter'&&addEventOption()}/>
            <button className="btn primary sm" onClick={addEventOption}>Add</button>
          </div>
        </div>
      )}
    </div>
  );
}

function ConfirmDelete({ title, phrase, warning, danger, onClose, onConfirm }) {
  const [typed, setTyped] = useState('');
  const [authed, setAuthed] = useState(false);
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  const { user } = useAuth();

  async function checkPassword() {
    setErr('');
    try {
      const { signInWithEmailAndPassword: signIn } = await import('firebase/auth');
      const { auth: fbAuth } = await import('./firebase');
      await signIn(fbAuth, user.email, pw);
      setAuthed(true);
    } catch { setErr('Incorrect password. Try again.'); }
  }

  return (
    <Modal title={title} onClose={onClose} footer={null} size="sm">
      <div style={{background:danger?'var(--rose-wash)':'var(--amber-wash)',borderRadius:8,padding:'10px 14px',fontSize:13,marginBottom:14,color:danger?'var(--rose)':'var(--amber)'}}>
        {warning}
      </div>
      {!authed ? (
        <>
          <p className="muted-sm" style={{marginBottom:10}}>Re-enter your Master password to continue:</p>
          <div className="field"><label>Password</label><input className="input" type="password" value={pw} onChange={e=>setPw(e.target.value)} placeholder="Your password"/></div>
          {err && <div style={{color:'var(--rose)',fontSize:12.5,marginBottom:8}}>{err}</div>}
          <div className="modal-foot" style={{padding:'12px 0 0'}}>
            <button className="btn" onClick={onClose}>Cancel</button>
            <button className="btn primary" onClick={checkPassword} disabled={!pw}>Verify identity</button>
          </div>
        </>
      ) : (
        <>
          <p className="muted-sm" style={{marginBottom:10}}>Type <b>"{phrase}"</b> to confirm:</p>
          <div className="field"><input className="input" value={typed} onChange={e=>setTyped(e.target.value)} placeholder={phrase}/></div>
          <div className="modal-foot" style={{padding:'12px 0 0'}}>
            <button className="btn" onClick={onClose}>Cancel</button>
            <button className="btn danger" disabled={typed!==phrase} onClick={onConfirm}>{danger?'Wipe everything':'Delete permanently'}</button>
          </div>
        </>
      )}
    </Modal>
  );
}

/* ---- Contact Filter Modal ---- */
/* ── Module Access Modal ─────────────────────────────────────────── */
const ALL_NAV_MODULES = [
  { id:'dash',         label:'Dashboard' },
  { id:'outreach',     label:'Outreach' },
  { id:'logistics',    label:'Logistics' },
  { id:'schedule',     label:'Scheduling' },
  { id:'people',       label:'Volunteers & POC' },
  { id:'depts',        label:'Departments & Tasks' },
  { id:'reports',      label:'Personalised Schedule' },
  { id:'checklist',    label:'Event Checklist' },
  { id:'felicitation', label:'Felicitation Kits' },
  { id:'availability', label:'Vol. Availability' },
  { id:'pocallocation',label:'POC Allocation' },
  { id:'allevents',    label:'All Events' },
  { id:'deptmaster',   label:'Department Master' },
  { id:'export',       label:'Export Data' },
  { id:'help',         label:'Help & Guide' },
  { id:'events',       label:'Events' },
  { id:'settings',     label:'Settings' },
];

/* ══ Unified Access Modal ════════════════════════════════════════════
   One modal for both module visibility + per-module action permissions.
   Flow: pick modules → each module asks Full / Custom
         → Custom expands that module's action checkboxes inline
════════════════════════════════════════════════════════════════════ */
function AccessModal({ targetUser, onClose, toast, currentUser, currentProfile }) {
  const existingModules = targetUser.allowedModules || ALL_NAV_MODULES.map(m => m.id);
  const existingPerms   = targetUser.permissions || {};

  // moduleState: { [moduleId]: 'off' | 'full' | 'custom' }
  const hasExistingPerms = targetUser.permissions != null; // null/undefined = never set
  const [moduleState, setModuleState] = useState(() => {
    const s = {};
    ALL_NAV_MODULES.forEach(m => {
      const hasModule = existingModules.includes(m.id);
      if (!hasModule) { s[m.id] = 'off'; return; }
      const group = PERMISSION_GROUPS.find(g => g.module === m.id);
      if (!group) { s[m.id] = 'full'; return; }
      if (!hasExistingPerms) {
        // No permissions ever set — default to custom with nothing ticked (locked out)
        s[m.id] = 'custom';
        return;
      }
      const allTrue = group.actions.every(a => existingPerms[a.key] === true);
      const allFalse = group.actions.every(a => existingPerms[a.key] === false);
      s[m.id] = allTrue ? 'full' : 'custom';
    });
    return s;
  });

  // perms: { [actionKey]: bool } — only relevant for custom modules
  const [perms, setPerms] = useState(() => {
    const p = {};
    PERMISSION_GROUPS.forEach(g => g.actions.forEach(a => {
      // If permissions have never been set, default to false (locked out)
      p[a.key] = hasExistingPerms ? (existingPerms[a.key] === true) : false;
    }));
    return p;
  });

  const [saving, setSaving] = useState(false);
  const [expandedModule, setExpandedModule] = useState(null);

  function setModState(id, val) {
    setModuleState(prev => ({ ...prev, [id]: val }));
    if (val === 'custom') {
      setExpandedModule(id);
    } else if (val === 'full') {
      // Grant all actions for this module
      const group = PERMISSION_GROUPS.find(g => g.module === id);
      if (group) {
        setPerms(prev => {
          const next = { ...prev };
          group.actions.forEach(a => { next[a.key] = true; });
          return next;
        });
      }
      setExpandedModule(null);
    } else {
      setExpandedModule(null);
    }
  }

  async function save() {
    setSaving(true);
    const allowedModules = ALL_NAV_MODULES
      .filter(m => moduleState[m.id] !== 'off')
      .map(m => m.id);

    // Build final permissions — locked out by default
    const finalPerms = {};
    PERMISSION_GROUPS.forEach(g => {
      const state = moduleState[g.module];
      g.actions.forEach(a => {
        if (state === 'full')   finalPerms[a.key] = true;
        else if (state === 'custom') finalPerms[a.key] = perms[a.key] === true;
        else finalPerms[a.key] = false; // module is off
      });
    });

    await updateDoc(doc(db, 'users', targetUser.id), {
      allowedModules,
      permissions: finalPerms,
    });
    await logAction(currentUser, currentProfile, 'Set access', targetUser.email);
    toast(`Access saved for ${targetUser.email}`);
    setSaving(false);
    onClose();
  }

  const LOCKED = ['dash', 'help'];

  return (
    <div className="scrim" onMouseDown={onClose}>
      <div className="modal" onMouseDown={e => e.stopPropagation()}
        style={{ maxWidth: 520, maxHeight: '90vh', display: 'flex', flexDirection: 'column' }}>
        <div className="modal-head">
          <div>
            <h2 style={{ marginBottom: 2 }}>Access — {targetUser.email}</h2>
            <div style={{ fontSize: 12, color: 'var(--muted)' }}>
              Select which modules this user can see, and what they can do inside each.
            </div>
          </div>
          <button className="x" onClick={onClose}>✕</button>
        </div>

        <div style={{ overflowY: 'auto', flex: 1, padding: '12px 20px' }}>
          {ALL_NAV_MODULES.map(m => {
            const locked  = LOCKED.includes(m.id);
            const state   = locked ? 'full' : (moduleState[m.id] || 'off');
            const group   = PERMISSION_GROUPS.find(g => g.module === m.id);
            const isExpanded = expandedModule === m.id && state === 'custom';

            return (
              <div key={m.id} style={{ marginBottom: 6, borderRadius: 10,
                border: `1px solid ${state !== 'off' ? 'var(--teal)' : 'var(--line)'}`,
                background: state !== 'off' ? 'var(--teal-wash)' : '#fafafa',
                overflow: 'hidden' }}>

                {/* Module row */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px' }}>
                  {/* ON/OFF toggle */}
                  <input type="checkbox"
                    checked={state !== 'off'}
                    disabled={locked}
                    onChange={e => setModState(m.id, e.target.checked ? 'full' : 'off')}
                    style={{ accentColor: 'var(--teal)', width: 16, height: 16, flexShrink: 0 }} />

                  {/* Module name */}
                  <span style={{ flex: 1, fontWeight: 600, fontSize: 13,
                    color: state !== 'off' ? 'var(--ink)' : 'var(--muted)' }}>
                    {m.label}
                    {locked && <span style={{ fontSize: 10, color: 'var(--muted)', marginLeft: 6 }}>🔒 always on</span>}
                  </span>

                  {/* Full / Custom toggle — only when module is ON and has actions */}
                  {state !== 'off' && !locked && group && (
                    <div style={{ display: 'flex', border: '1px solid var(--line)',
                      borderRadius: 6, overflow: 'hidden', fontSize: 12 }}>
                      <button
                        onClick={() => setModState(m.id, 'full')}
                        style={{ padding: '3px 10px', border: 'none', cursor: 'pointer',
                          background: state === 'full' ? 'var(--teal)' : '#fff',
                          color: state === 'full' ? '#fff' : 'var(--muted)', fontWeight: 500 }}>
                        Full
                      </button>
                      <button
                        onClick={() => setModState(m.id, 'custom')}
                        style={{ padding: '3px 10px', border: 'none', cursor: 'pointer',
                          background: state === 'custom' ? 'var(--teal)' : '#fff',
                          color: state === 'custom' ? '#fff' : 'var(--muted)', fontWeight: 500 }}>
                        Custom
                      </button>
                    </div>
                  )}
                  {state !== 'off' && !locked && !group && (
                    <span style={{ fontSize: 11, color: 'var(--teal)', fontWeight: 500 }}>Full access</span>
                  )}
                </div>

                {/* Expanded custom actions */}
                {isExpanded && group && (
                  <div style={{ borderTop: '1px solid var(--line)', padding: '10px 14px 12px',
                    background: '#fff', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                    {group.actions.map(action => (
                      <label key={action.key}
                        style={{ display: 'flex', alignItems: 'center', gap: 8,
                          padding: '6px 10px', borderRadius: 6, cursor: 'pointer',
                          border: `1px solid ${perms[action.key] ? 'var(--teal)' : 'var(--line)'}`,
                          background: perms[action.key] ? 'var(--teal-wash)' : '#fff',
                          fontSize: 12.5 }}>
                        <input type="checkbox"
                          checked={perms[action.key] || false}
                          onChange={e => setPerms(prev => ({ ...prev, [action.key]: e.target.checked }))}
                          style={{ accentColor: 'var(--teal)', flexShrink: 0 }} />
                        {action.label}
                      </label>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="modal-foot">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Save access'}
          </button>
        </div>
      </div>
    </div>
  );
}


function ContactFilterModal({ targetUser, onClose, toast, currentUser, currentProfile }) {
  const existing = targetUser.contactFilter || {};
  const [f, setF] = useState({
    fields:   existing.fields   || [],
    pocNames: existing.pocNames || [],
    types:    existing.types    || [],
    statuses: existing.statuses || [],
    tags:     existing.tags     || [],
  });

  // Text input states for adding values
  const [fieldInput,  setFieldInput]  = useState('');
  const [pocInput,    setPocInput]    = useState('');
  const [tagInput,    setTagInput]    = useState('');

  const TYPES    = ['VIP', 'Panelist', 'Podcast Guest', 'Guest'];
  const STATUSES = ['Pending', 'Contacted', 'Tentative', 'Confirmed', 'Declined'];
  const FIELDS   = ['Geopolitics', 'Legal', 'Economics', 'Business', 'Media', 'Politics', 'Social'];

  const toggleArr = (key, val) => setF(p => ({
    ...p,
    [key]: p[key].includes(val) ? p[key].filter(x=>x!==val) : [...p[key], val]
  }));
  const addText = (key, val, setter) => {
    const v = val.trim();
    if (!v || f[key].includes(v)) return;
    setF(p => ({ ...p, [key]: [...p[key], v] }));
    setter('');
  };
  const removeVal = (key, val) => setF(p => ({ ...p, [key]: p[key].filter(x=>x!==val) }));

  async function save() {
    // Remove empty arrays to keep the doc clean
    const filter = {};
    if (f.fields.length)   filter.fields   = f.fields;
    if (f.pocNames.length) filter.pocNames = f.pocNames;
    if (f.types.length)    filter.types    = f.types;
    if (f.statuses.length) filter.statuses = f.statuses;
    if (f.tags.length)     filter.tags     = f.tags;

    await updateDoc(doc(db, 'users', targetUser.id), {
      contactFilter: Object.keys(filter).length ? filter : null
    });
    await logAction(currentUser, currentProfile, 'Set contact filter',
      `${targetUser.email} — ${Object.keys(filter).length ? JSON.stringify(filter) : 'cleared'}`);
    toast(Object.keys(filter).length
      ? `Filter set for ${targetUser.email}`
      : `Filter cleared for ${targetUser.email} — they now see all contacts`);
    onClose();
  }

  const Chip = ({ val, onRemove }) => (
    <span style={{display:'inline-flex',alignItems:'center',gap:5,background:'var(--teal-wash)',color:'var(--teal)',borderRadius:20,padding:'3px 10px',fontSize:12.5,fontWeight:500,margin:'2px'}}>
      {val}
      <button onClick={onRemove} style={{border:'none',background:'none',cursor:'pointer',color:'var(--teal)',fontSize:14,lineHeight:1,padding:0}}>×</button>
    </span>
  );

  const Section = ({ title, desc, children }) => (
    <div style={{marginBottom:18,paddingBottom:18,borderBottom:'1px solid var(--line)'}}>
      <div style={{fontWeight:600,fontSize:13.5,marginBottom:3}}>{title}</div>
      <div style={{fontSize:12,color:'var(--muted)',marginBottom:8}}>{desc}</div>
      {children}
    </div>
  );

  const hasAny = Object.values(f).some(a=>a.length>0);

  return (
    <div className="scrim" onMouseDown={onClose}>
      <div className="modal" onMouseDown={e=>e.stopPropagation()} style={{maxWidth:500}}>
        <div className="modal-head">
          <h2>Contact access — {targetUser.email}</h2>
          <button className="x" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <div style={{background:'var(--teal-wash)',borderRadius:8,padding:'10px 14px',fontSize:13,color:'#1c4d3e',marginBottom:16}}>
            {hasAny
              ? <>This user will <b>only see contacts</b> that match ALL active filters below.</>
              : <>No filters active — this user sees <b>all contacts</b>. Add filters below to restrict access.</>}
          </div>

          <Section title="Field / Domain" desc="Only show contacts in these fields. Leave empty to show all fields.">
            <div style={{display:'flex',flexWrap:'wrap',gap:4,marginBottom:8}}>
              {FIELDS.map(fi=>(
                <button key={fi} onClick={()=>toggleArr('fields',fi)}
                  style={{padding:'4px 12px',borderRadius:20,border:`1.5px solid ${f.fields.includes(fi)?'var(--teal)':'var(--line)'}`,background:f.fields.includes(fi)?'var(--teal-wash)':'#fff',color:f.fields.includes(fi)?'var(--teal)':'var(--ink)',fontSize:12.5,fontWeight:f.fields.includes(fi)?600:400,cursor:'pointer'}}>
                  {fi}
                </button>
              ))}
            </div>
            <div style={{display:'flex',gap:6}}>
              <input className="input" style={{flex:1}} value={fieldInput} onChange={e=>setFieldInput(e.target.value)} placeholder="Add custom field…" onKeyDown={e=>e.key==='Enter'&&addText('fields',fieldInput,setFieldInput)}/>
              <button className="btn sm" onClick={()=>addText('fields',fieldInput,setFieldInput)}>Add</button>
            </div>
            {f.fields.length>0&&<div style={{marginTop:6}}>{f.fields.map(v=><Chip key={v} val={v} onRemove={()=>removeVal('fields',v)}/>)}</div>}
          </Section>

          <Section title="POC / Liaison name" desc="Only show contacts whose POC name contains one of these words.">
            <div style={{display:'flex',gap:6}}>
              <input className="input" style={{flex:1}} value={pocInput} onChange={e=>setPocInput(e.target.value)} placeholder="e.g. Jinalben, Tejas…" onKeyDown={e=>e.key==='Enter'&&addText('pocNames',pocInput,setPocInput)}/>
              <button className="btn sm" onClick={()=>addText('pocNames',pocInput,setPocInput)}>Add</button>
            </div>
            {f.pocNames.length>0&&<div style={{marginTop:6}}>{f.pocNames.map(v=><Chip key={v} val={v} onRemove={()=>removeVal('pocNames',v)}/>)}</div>}
          </Section>

          <Section title="Contact type" desc="Only show selected types. Leave empty to show all types.">
            <div style={{display:'flex',flexWrap:'wrap',gap:4}}>
              {TYPES.map(t=>(
                <button key={t} onClick={()=>toggleArr('types',t)}
                  style={{padding:'4px 12px',borderRadius:20,border:`1.5px solid ${f.types.includes(t)?'var(--teal)':'var(--line)'}`,background:f.types.includes(t)?'var(--teal-wash)':'#fff',color:f.types.includes(t)?'var(--teal)':'var(--ink)',fontSize:12.5,fontWeight:f.types.includes(t)?600:400,cursor:'pointer'}}>
                  {t}
                </button>
              ))}
            </div>
          </Section>

          <Section title="Confirmation status" desc="Only show contacts at these stages.">
            <div style={{display:'flex',flexWrap:'wrap',gap:4}}>
              {STATUSES.map(s=>(
                <button key={s} onClick={()=>toggleArr('statuses',s)}
                  style={{padding:'4px 12px',borderRadius:20,border:`1.5px solid ${f.statuses.includes(s)?'var(--teal)':'var(--line)'}`,background:f.statuses.includes(s)?'var(--teal-wash)':'#fff',color:f.statuses.includes(s)?'var(--teal)':'var(--ink)',fontSize:12.5,fontWeight:f.statuses.includes(s)?600:400,cursor:'pointer'}}>
                  {s}
                </button>
              ))}
            </div>
          </Section>

          <Section title="Custom tags" desc="Only show contacts that have at least one of these tags. Add tags to contacts in Outreach.">
            <div style={{display:'flex',gap:6}}>
              <input className="input" style={{flex:1}} value={tagInput} onChange={e=>setTagInput(e.target.value)} placeholder="e.g. Priority, Bangalore batch…" onKeyDown={e=>e.key==='Enter'&&addText('tags',tagInput,setTagInput)}/>
              <button className="btn sm" onClick={()=>addText('tags',tagInput,setTagInput)}>Add</button>
            </div>
            {f.tags.length>0&&<div style={{marginTop:6}}>{f.tags.map(v=><Chip key={v} val={v} onRemove={()=>removeVal('tags',v)}/>)}</div>}
          </Section>
        </div>
        <div className="modal-foot">
          {hasAny && <button className="btn danger sm" onClick={()=>setF({fields:[],pocNames:[],types:[],statuses:[],tags:[]})}>Clear all filters</button>}
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={save}>Save access settings</button>
        </div>
      </div>
    </div>
  );
}
