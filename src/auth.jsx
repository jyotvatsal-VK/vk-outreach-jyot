import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { auth, db, configured } from './firebase';
import {
  onAuthStateChanged, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, signOut, sendEmailVerification,
  sendPasswordResetEmail,
} from 'firebase/auth';
import {
  doc, getDoc, getDocs, setDoc, onSnapshot, serverTimestamp,
  writeBatch, collection, query, where, updateDoc,
} from 'firebase/firestore';
import { setAuditContext } from './data';

const AuthCtx = createContext(null);
export const useAuth = () => useContext(AuthCtx);

/* Invite doc id derived from email — must match emailKey() in firestore.rules */
export const inviteKey = (email) => String(email || '').toLowerCase().replace(/[^a-z0-9]/g, '_');

function deviceId() {
  const key = 'vkjyot_did';
  try {
    let id = localStorage.getItem(key);
    if (!id) { id = 'dev_' + Math.random().toString(36).slice(2) + Date.now().toString(36); localStorage.setItem(key, id); }
    return id;
  } catch { return 'dev_nostorage'; }
}
function deviceLabel() {
  const ua = navigator.userAgent;
  if (/iPhone|iPad/.test(ua)) return 'iPhone/iPad';
  if (/Android/.test(ua)) return 'Android';
  if (/Windows/.test(ua)) return 'Windows PC';
  if (/Mac/.test(ua)) return 'Mac';
  return 'Browser';
}

/* ------------------------------------------------------------------
   The ONLY place a profile is created. Order:
   1. Invite exists for this (verified) email  → profile copies the invite
   2. No bootstrap doc yet                     → this user becomes Master (atomic batch)
   3. Otherwise                                → pending User, waits for Master approval
   Firestore rules enforce exactly these three shapes, so a client cannot
   create itself as Master or give itself permissions.
   ------------------------------------------------------------------ */
async function createProfile(u) {
  const userRef = doc(db, 'users', u.uid);
  const base = { email: u.email, deviceId: deviceId(), deviceLabel: deviceLabel(), createdAt: serverTimestamp() };

  // 1. Invite
  const invRef = doc(db, 'invites', inviteKey(u.email));
  let invite = null;
  try { const s = await getDoc(invRef); invite = s.exists() ? s.data() : null; } catch { invite = null; }
  if (invite) {
    const batch = writeBatch(db);
    batch.set(userRef, {
      ...base,
      role: invite.role || 'User',
      approved: invite.approved === true,
      status: invite.status || 'active',
      allowedModules: invite.allowedModules ?? null,
      permissions: invite.permissions ?? null,
      contactFilter: invite.contactFilter ?? null,
    });
    batch.delete(invRef);
    await batch.commit();
    return;
  }

  // 2. Bootstrap — first ever account on a fresh project
  const bootRef = doc(db, 'meta', 'bootstrap');
  let bootExists = true;
  try { bootExists = (await getDoc(bootRef)).exists(); } catch { bootExists = true; }
  if (!bootExists) {
    try {
      const batch = writeBatch(db);
      batch.set(userRef, { ...base, role: 'Master', approved: true, status: 'active', allowedModules: null, permissions: null, contactFilter: null });
      batch.set(bootRef, { uid: u.uid, at: serverTimestamp() });
      await batch.commit();
      return;
    } catch { /* someone else bootstrapped first — fall through to pending */ }
  }

  // 3. Pending
  await setDoc(userRef, { ...base, role: 'User', approved: false, status: 'pending', allowedModules: null, permissions: null, contactFilter: null });
}

/* One-time housekeeping a Master performs on login:
   - make sure meta/bootstrap exists (closes "first signup becomes Master" on existing projects)
   - move legacy users/invite_* docs into the invites collection */
async function masterHousekeeping(u) {
  try {
    const bootRef = doc(db, 'meta', 'bootstrap');
    if (!(await getDoc(bootRef)).exists()) await setDoc(bootRef, { uid: u.uid, at: serverTimestamp() });
  } catch (e) { console.warn('bootstrap check', e?.code || e); }
  try {
    const legacy = await getDocs(query(collection(db, 'users'), where('isInvite', '==', true)));
    if (!legacy.empty) {
      const batch = writeBatch(db);
      legacy.docs.forEach((d) => {
        const { isInvite, ...rest } = d.data();
        batch.set(doc(db, 'invites', inviteKey(rest.email)), rest, { merge: true });
        batch.delete(d.ref);
      });
      await batch.commit();
    }
  } catch (e) { console.warn('invite migration', e?.code || e); }
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [profile, setProfile] = useState(null);
  const [ready, setReady] = useState(false);
  const [needsVerification, setNeedsVerification] = useState(false);
  const [profileError, setProfileError] = useState('');
  const [tick, setTick] = useState(0); // bump to retry profile setup

  useEffect(() => {
    if (!configured) { setReady(true); return; }
    let unsub = () => {};
    try {
      unsub = onAuthStateChanged(auth, (u) => { setUser(u); if (!u) { setProfile(null); setNeedsVerification(false); setReady(true); } });
    } catch { setReady(true); }
    return () => unsub();
  }, []);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    let profileUnsub = () => {};
    let housekeepingDone = false;
    (async () => {
      setProfileError('');
      const userRef = doc(db, 'users', user.uid);
      try {
        const snap = await getDoc(userRef);
        if (!snap.exists()) {
          if (!user.emailVerified) {
            if (!cancelled) { setNeedsVerification(true); setProfile(null); setReady(true); }
            return;
          }
          await user.getIdToken(true); // make sure the token carries the current email_verified claim
          await createProfile(user);
        }
      } catch (e) {
        console.warn('profile init error', e);
        if (!cancelled) { setProfileError(e?.code || e?.message || 'Could not set up your account'); setReady(true); }
        return;
      }
      if (cancelled) return;
      setNeedsVerification(false);
      profileUnsub = onSnapshot(userRef, (s) => {
        const p = s.exists() ? { id: s.id, ...s.data() } : null;
        setProfile(p);
        setAuditContext(user, p);
        setReady(true);
        if (p?.role === 'Master' && p?.status === 'active' && !housekeepingDone) { housekeepingDone = true; masterHousekeeping(user); }
      }, (e) => { setProfileError(e?.code || 'Could not load your profile'); setProfile(null); setReady(true); });
    })();
    return () => { cancelled = true; profileUnsub(); };
  }, [user, tick]);

  const retryProfile = useCallback(async () => {
    if (auth.currentUser) {
      await auth.currentUser.reload();
      await auth.currentUser.getIdToken(true); // refresh the email_verified claim the rules check
    }
    setTick((t) => t + 1);
  }, []);

  const logout = () => { setAuditContext(null); signOut(auth); setProfile(null); };
  const value = { user, profile, ready, logout, needsVerification, profileError, retryProfile, deviceId: deviceId(), deviceLabel: deviceLabel() };
  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

export function LoginScreen() {
  const [mode, setMode] = useState('signin');
  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  const [info, setInfo] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault(); setErr(''); setInfo(''); setBusy(true);
    try {
      if (mode === 'signin') {
        await signInWithEmailAndPassword(auth, email.trim(), pw);
      } else {
        const cred = await createUserWithEmailAndPassword(auth, email.trim(), pw);
        try { await sendEmailVerification(cred.user); } catch { /* VerifyEmailScreen offers resend */ }
      }
      // Profile creation happens in AuthProvider — single code path.
    } catch (ex) {
      const m = String(ex.code || ex.message || '');
      if (m.includes('invalid-credential') || m.includes('wrong-password')) setErr('Email or password is incorrect.');
      else if (m.includes('email-already-in-use')) setErr('That email already has an account — sign in instead.');
      else if (m.includes('weak-password')) setErr('Password must be at least 6 characters.');
      else if (m.includes('invalid-email')) setErr('That email address is not valid.');
      else if (m.includes('too-many-requests')) setErr('Too many attempts. Wait a few minutes and try again.');
      else setErr('Could not ' + (mode === 'signin' ? 'sign in' : 'register') + '. ' + m);
    } finally { setBusy(false); }
  }

  async function forgot() {
    setErr(''); setInfo('');
    if (!email.trim()) { setErr('Enter your email above first.'); return; }
    try { await sendPasswordResetEmail(auth, email.trim()); setInfo('Password reset link sent. Check your inbox.'); }
    catch { setInfo('If that email has an account, a reset link has been sent.'); }
  }

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="mark">वि</div>
        <h1>VK Outreach Program</h1>
        <p className="sub">JYOT · Event Operations</p>
        {!configured && <div className="err">Firebase not configured — add your keys to .env and redeploy.</div>}
        {err && <div className="err">{err}</div>}
        {info && <div className="ok">{info}</div>}
        <form onSubmit={submit}>
          <div className="field"><label>Email</label><input className="input" type="email" autoComplete="email" value={email} onChange={e=>setEmail(e.target.value)} placeholder="you@jyot.org" required/></div>
          <div className="field"><label>Password</label><input className="input" type="password" autoComplete={mode==='signin'?'current-password':'new-password'} value={pw} onChange={e=>setPw(e.target.value)} placeholder="••••••••" required/></div>
          <button className="btn primary" style={{width:'100%',justifyContent:'center'}} disabled={busy||!configured}>
            {busy ? 'Please wait…' : mode === 'signin' ? 'Sign in' : 'Create account'}
          </button>
        </form>
        {mode==='signin' && <div className="auth-toggle" style={{marginTop:10}}><button onClick={forgot}>Forgot password?</button></div>}
        <div className="auth-toggle">
          {mode==='signin'
            ? <>New team member? <button onClick={()=>{setMode('signup');setErr('');setInfo('');}}>Create account</button></>
            : <>Already have an account? <button onClick={()=>{setMode('signin');setErr('');setInfo('');}}>Sign in</button></>}
        </div>
      </div>
    </div>
  );
}

/* New accounts must verify their email before a profile is created.
   This stops someone registering an invited address they don't own. */
export function VerifyEmailScreen({ user, logout, retry }) {
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  async function resend() {
    setMsg(''); setBusy(true);
    try { await sendEmailVerification(user); setMsg('Verification email sent again.'); }
    catch (e) { setMsg(String(e.code||'').includes('too-many') ? 'Please wait a minute before resending.' : 'Could not send. Try again shortly.'); }
    finally { setBusy(false); }
  }
  async function done() {
    setMsg(''); setBusy(true);
    try {
      await user.reload();
      if (!user.emailVerified) setMsg('Not verified yet. Open the link in the email, then tap this again.');
      else await retry();
    } finally { setBusy(false); }
  }
  return (
    <div className="auth-wrap">
      <div className="auth-card" style={{textAlign:'center'}}>
        <div className="mark" style={{margin:'0 auto 16px'}}>वि</div>
        <h1 style={{fontSize:19,marginBottom:8}}>Verify your email</h1>
        <p style={{color:'var(--muted)',fontSize:13.5,marginBottom:16}}>
          We sent a link to <b>{user.email}</b>. Open it to confirm this address is yours, then continue. Check spam if it isn't in your inbox.
        </p>
        {msg && <div className="ok" style={{textAlign:'left'}}>{msg}</div>}
        <button className="btn primary" style={{width:'100%',justifyContent:'center',marginBottom:8}} disabled={busy} onClick={done}>I've verified — continue</button>
        <button className="btn" style={{width:'100%',justifyContent:'center',marginBottom:8}} disabled={busy} onClick={resend}>Resend email</button>
        <button className="btn ghost" style={{width:'100%',justifyContent:'center'}} onClick={logout}>Sign out</button>
      </div>
    </div>
  );
}

/* Shown to users whose account is pending Master approval */
export function PendingScreen({ user, logout }) {
  return (
    <div className="auth-wrap">
      <div className="auth-card" style={{textAlign:'center'}}>
        <div className="mark" style={{margin:'0 auto 16px'}}>वि</div>
        <h1 style={{fontSize:19,marginBottom:8}}>Waiting for approval</h1>
        <p style={{color:'var(--muted)',fontSize:13.5,marginBottom:20}}>
          Your account (<b>{user.email}</b>) is pending approval from the Master admin. You'll be able to access the app as soon as they approve your request.
        </p>
        <div style={{background:'var(--teal-wash)',borderRadius:10,padding:'12px 16px',fontSize:13,color:'#1c4d3e',marginBottom:20}}>
          Ask your Master admin to open <b>Settings → Users</b> and approve your account.
        </div>
        <button className="btn ghost" style={{width:'100%',justifyContent:'center'}} onClick={logout}>Sign out</button>
      </div>
    </div>
  );
}

/* Used by the topbar event switcher */
export async function updateMyProfile(uid, fields) {
  await updateDoc(doc(db, 'users', uid), fields);
}
