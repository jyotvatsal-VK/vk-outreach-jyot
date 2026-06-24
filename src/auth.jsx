import { createContext, useContext, useEffect, useState } from 'react';
import { auth, db, configured } from './firebase';
import {
  onAuthStateChanged, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, signOut,
} from 'firebase/auth';
import { doc, getDoc, setDoc, onSnapshot, serverTimestamp } from 'firebase/firestore';

const AuthCtx = createContext(null);
export const useAuth = () => useContext(AuthCtx);

/* fingerprint: browser+OS string used as a device identifier */
function deviceId() {
  const key = 'vkjyot_did';
  let id = localStorage.getItem(key);
  if (!id) { id = 'dev_' + Math.random().toString(36).slice(2) + Date.now().toString(36); localStorage.setItem(key, id); }
  return id;
}
function deviceLabel() {
  const ua = navigator.userAgent;
  if (/iPhone|iPad/.test(ua)) return 'iPhone/iPad';
  if (/Android/.test(ua)) return 'Android';
  if (/Windows/.test(ua)) return 'Windows PC';
  if (/Mac/.test(ua)) return 'Mac';
  return 'Browser';
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [profile, setProfile] = useState(null); // Firestore user record
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!configured) { setReady(true); return; }
    let profileUnsub = () => {};
    let unsub = () => {};
    try {
      unsub = onAuthStateChanged(auth, async (u) => {
        setUser(u);
        profileUnsub();
        if (u) {
          try {
            // Auto-create profile if it does not exist yet
            // (handles accounts created before the role system was built)
            const userRef = doc(db, 'users', u.uid);
            const snap = await getDoc(userRef);
            if (!snap.exists()) {
              const { getDocs, collection: col } = await import('firebase/firestore');
              const existing = await getDocs(col(db, 'users'));
              const isFirst = existing.empty;
              await setDoc(userRef, {
                email: u.email,
                role: isFirst ? 'Master' : 'Volunteer',
                approved: isFirst,
                status: isFirst ? 'active' : 'pending',
                deviceId: deviceId(),
                deviceLabel: deviceLabel(),
                createdAt: serverTimestamp(),
              });
            }
            profileUnsub = onSnapshot(userRef, (snap) => {
              if (snap.exists()) setProfile({ id: snap.id, ...snap.data() });
              else setProfile(null);
              setReady(true);
            }, () => { setProfile(null); setReady(true); });
          } catch (e) { console.warn('profile init error', e); setProfile(null); setReady(true); }
        } else {
          setProfile(null);
          setReady(true);
        }
      }, () => setReady(true));
    } catch { setReady(true); }
    return () => { unsub(); profileUnsub(); };
  }, []);

  const logout = () => { signOut(auth); setProfile(null); };
  const value = { user, profile, ready, logout, deviceId: deviceId(), deviceLabel: deviceLabel() };
  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

export function LoginScreen() {
  const [mode, setMode] = useState('signin');
  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault(); setErr(''); setBusy(true);
    try {
      let cred;
      if (mode === 'signin') cred = await signInWithEmailAndPassword(auth, email.trim(), pw);
      else cred = await createUserWithEmailAndPassword(auth, email.trim(), pw);
      const uid = cred.user.uid;
      const ref = doc(db, 'users', uid);
      const snap = await getDoc(ref);
      if (!snap.exists()) {
        // first user ever → auto-Master; subsequent users → pending
        const allSnap = await import('firebase/firestore').then(({getDocs,collection})=>getDocs(collection(db,'users')));
        const isFirst = allSnap.empty;
        await setDoc(ref, {
          email: cred.user.email, role: isFirst ? 'Master' : 'Volunteer',
          approved: isFirst, status: isFirst ? 'active' : 'pending',
          deviceId: deviceId(), deviceLabel: deviceLabel(),
          createdAt: serverTimestamp(),
        });
      }
    } catch (ex) {
      const m = String(ex.code || ex.message || '');
      if (m.includes('invalid-credential') || m.includes('wrong-password')) setErr('Email or password is incorrect.');
      else if (m.includes('email-already-in-use')) setErr('That email already has an account — sign in instead.');
      else if (m.includes('weak-password')) setErr('Password must be at least 6 characters.');
      else if (m.includes('invalid-email')) setErr('That email address is not valid.');
      else setErr('Could not ' + (mode === 'signin' ? 'sign in' : 'register') + '. ' + m);
    } finally { setBusy(false); }
  }

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="mark">वि</div>
        <h1>VK Outreach Program</h1>
        <p className="sub">JYOT · Event Operations</p>
        {!configured && <div className="err">Firebase not configured — add your keys to .env and redeploy.</div>}
        {err && <div className="err">{err}</div>}
        <form onSubmit={submit}>
          <div className="field"><label>Email</label><input className="input" type="email" value={email} onChange={e=>setEmail(e.target.value)} placeholder="you@jyot.org" required/></div>
          <div className="field"><label>Password</label><input className="input" type="password" value={pw} onChange={e=>setPw(e.target.value)} placeholder="••••••••" required/></div>
          <button className="btn primary" style={{width:'100%',justifyContent:'center'}} disabled={busy||!configured}>
            {busy ? 'Please wait…' : mode === 'signin' ? 'Sign in' : 'Create account'}
          </button>
        </form>
        <div className="auth-toggle">
          {mode==='signin'
            ? <>New team member? <button onClick={()=>{setMode('signup');setErr('');}}>Create account</button></>
            : <>Already have an account? <button onClick={()=>{setMode('signin');setErr('');}}>Sign in</button></>}
        </div>
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
          Ask your Master admin to open <b>Settings → User Management</b> and approve your account.
        </div>
        <button className="btn ghost" style={{width:'100%',justifyContent:'center'}} onClick={logout}>Sign out</button>
      </div>
    </div>
  );
}
