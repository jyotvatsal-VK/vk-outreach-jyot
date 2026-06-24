import { useState, useEffect } from 'react';
import { db } from './firebase';
import { collection, onSnapshot, doc, updateDoc, deleteDoc, getDocs, writeBatch, serverTimestamp } from 'firebase/firestore';
import { useAuth } from './auth';
import { useActivityLog, logAction } from './activity';
import { useToast, Modal, Field, ICON } from './ui';
import { COLLECTIONS } from './data';

const ROLES = ['Master', 'HOD', 'Volunteer'];

/* ---- Settings root ---- */
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
      </div>
      {tab==='users' && <UsersTab isMaster={isMaster} currentUid={user?.uid}/>}
      {tab==='log' && <ActivityTab/>}
      {tab==='data' && isMaster && <DataTab rawStore={rawStore}/>}
    </>
  );
}

/* ---- Users tab ---- */
function UsersTab({ isMaster, currentUid }) {
  const [users, setUsers] = useState([]);
  const { user, profile } = useAuth();
  const toast = useToast();

  useEffect(() => {
    if (!db) return;
    return onSnapshot(collection(db, 'users'), snap =>
      setUsers(snap.docs.map(d => ({ id: d.id, ...d.data() }))), () => {});
  }, []);

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

  return (
    <>
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
                <td className="muted-sm">{u.deviceLabel||'—'}</td>
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
        <div className="panel-head"><h2>Team members</h2><div className="desc">{active.length} active</div></div>
        <div className="panel-body"><table><thead><tr><th>Email</th><th>Role</th><th>Device</th><th>Status</th><th></th></tr></thead><tbody>
          {active.map(u=>(
            <tr key={u.id}>
              <td><div className="nm">{u.email}{u.id===currentUid&&<span className="badge b-confirmed" style={{marginLeft:8,fontSize:10}}>You</span>}</div></td>
              <td>
                {isMaster && u.id!==currentUid
                  ? <select className="statsel" value={u.role||'Volunteer'} onChange={e=>setRole(u,e.target.value)}>{ROLES.map(r=><option key={r}>{r}</option>)}</select>
                  : <span className="badge b-type">{u.role||'Volunteer'}</span>}
              </td>
              <td className="muted-sm">{u.deviceLabel||'—'}</td>
              <td>{u.status==='active'?<span className="badge b-confirmed">Active</span>:u.status==='rejected'?<span className="badge b-declined">Rejected</span>:<span className="badge b-pending">Pending</span>}</td>
              <td><div className="rowacts">
                {isMaster && u.id!==currentUid && u.status==='active' && <button className="btn ghost xs" onClick={()=>revoke(u)}>Revoke</button>}
              </div></td>
            </tr>
          ))}
          {!active.length&&<tr><td colSpan="5"><div className="empty"><h3>No active users yet</h3></div></td></tr>}
        </tbody></table></div>
      </div>

      <div className="panel panel-pad">
        <h3 style={{fontFamily:'var(--serif)',fontSize:15,marginBottom:8}}>Role permissions</h3>
        <table style={{minWidth:'unset'}}><thead><tr><th>Role</th><th>Can do</th></tr></thead><tbody>
          <tr><td><span className="badge b-confirmed">Master</span></td><td className="muted-sm">Full access · manage users · delete data · view activity log</td></tr>
          <tr><td><span className="badge b-type">HOD</span></td><td className="muted-sm">Add/edit/delete in all modules · cannot manage users or wipe data</td></tr>
          <tr><td><span className="badge b-pending">Volunteer</span></td><td className="muted-sm">View all data · update task status only · no add/edit/delete</td></tr>
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

  async function wipeAll() {
    // Never wipe users — it would lock everyone out of the system
    const SAFE_TO_WIPE = DATA_COLLECTIONS.filter(c => c.id !== 'users');
    for (const col of SAFE_TO_WIPE) {
      try {
        const snap = await getDocs(collection(db, col.id));
        const batch = writeBatch(db);
        snap.docs.forEach(d => batch.delete(d.ref));
        await batch.commit();
      } catch(e) { console.warn('could not wipe', col.id, e); }
    }
    // also clear app_state
    try { await getDocs(collection(db,'app_state')).then(s=>{ const b=writeBatch(db); s.docs.forEach(d=>b.delete(d.ref)); return b.commit(); }); } catch {}
    await logAction(user, profile, 'FULL SYSTEM WIPE', 'All data deleted');
    toast('Full system wipe complete. User accounts were preserved.');
    setModal(null);
  }

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
        <h2 style={{color:'var(--rose)',marginBottom:8}}>⚠ Full system wipe</h2>
        <p className="muted-sm" style={{marginBottom:14}}>Deletes every record in every collection including events, all data, and the activity log. The app will be completely empty. User accounts are not deleted.</p>
        <button className="btn danger" onClick={()=>setModal({type:'wipe'})}>{ICON.trash}Wipe entire system</button>
      </div>

      {modal?.type==='col' && <ConfirmDelete
        title={`Clear "${modal.col.label}"?`}
        phrase="delete forever"
        warning={`This will permanently delete all ${counts(modal.col.id)} records in ${modal.col.label}. This cannot be undone.`}
        onClose={()=>setModal(null)}
        onConfirm={()=>wipeCollection(modal.col.id)}
      />}
      {modal?.type==='wipe' && <ConfirmDelete
        title="Full system wipe?"
        phrase="wipe everything"
        warning="This deletes ALL data in the entire system — every event, contact, session, volunteer, task, and log entry. The app will be completely empty. This absolutely cannot be undone."
        danger
        onClose={()=>setModal(null)}
        onConfirm={wipeAll}
      />}
    </>
  );
}

/* ---- Confirm delete modal with typed phrase ---- */
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
