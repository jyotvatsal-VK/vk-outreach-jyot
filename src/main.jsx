import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { AuthProvider } from './auth';
import { ToastProvider } from './ui';

/* Wipe service workers + caches, then reload. Fixes phones stuck on an old build. */
async function hardReset() {
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map(r => r.unregister()));
    }
    if (window.caches) {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
    }
  } catch { /* best effort */ }
  location.reload();
}
window.__vkHardReset = hardReset;

/* After a new deploy, a phone with the old page open asks for old file names
   that no longer exist → blank screen. Vite fires this event; reload once. */
window.addEventListener('vite:preloadError', (e) => {
  e.preventDefault?.();
  if (!sessionStorage.getItem('vk_reloaded_for_chunk')) {
    sessionStorage.setItem('vk_reloaded_for_chunk', '1');
    location.reload();
  }
});

/* Plain-HTML error panel: works even if React itself never starts */
function showFatal(msg) {
  const root = document.getElementById('root');
  if (!root || root.dataset.fatal) return;
  if (root.children.length && !root.querySelector('.fatal-err')) {
    // React already drew something — only take over if the screen is effectively empty
    if ((root.innerText || '').trim().length > 20) return;
  }
  root.dataset.fatal = '1';
  root.innerHTML = '';
  const box = document.createElement('div');
  box.className = 'fatal-err';
  box.style.cssText = 'font-family:system-ui,sans-serif;max-width:420px;margin:12vh auto;padding:22px;border:1px solid #E9C9D2;background:#F8E9EE;border-radius:14px;color:#21302C';
  box.innerHTML = '<div style="font-size:18px;font-weight:600;color:#9A3550;margin-bottom:8px">The app couldn\u2019t load</div>'
    + '<div style="font-size:14px;margin-bottom:12px">Tap <b>Reset &amp; reload</b>. If it still fails, send a screenshot of this box.</div>'
    + '<pre style="white-space:pre-wrap;font-size:11.5px;background:#fff;border-radius:8px;padding:10px;max-height:30vh;overflow:auto;margin:0 0 14px"></pre>';
  box.querySelector('pre').textContent = String(msg || 'Unknown error') + '\n\n' + navigator.userAgent;
  const btn = document.createElement('button');
  btn.textContent = 'Reset & reload';
  btn.style.cssText = 'width:100%;padding:12px;border:none;border-radius:10px;background:#0F6E56;color:#fff;font-size:16px;font-weight:600';
  btn.onclick = hardReset;
  box.appendChild(btn);
  root.appendChild(box);
}
window.addEventListener('error', (e) => setTimeout(() => showFatal(e.message + (e.filename ? `\n${e.filename}:${e.lineno}` : '')), 300));
window.addEventListener('unhandledrejection', (e) => setTimeout(() => showFatal('Unhandled: ' + (e.reason?.message || e.reason)), 300));

/* Catches crashes during rendering (React otherwise unmounts everything → blank) */
class RootBoundary extends React.Component {
  constructor(p) { super(p); this.state = { err: null }; }
  static getDerivedStateFromError(err) { return { err }; }
  componentDidCatch(err, info) { console.error('App crashed:', err, info?.componentStack); }
  render() {
    if (!this.state.err) return this.props.children;
    const e = this.state.err;
    return (
      <div style={{fontFamily:'system-ui,sans-serif',maxWidth:420,margin:'12vh auto',padding:22,border:'1px solid #E9C9D2',background:'#F8E9EE',borderRadius:14,color:'#21302C'}}>
        <div style={{fontSize:18,fontWeight:600,color:'#9A3550',marginBottom:8}}>Something went wrong</div>
        <div style={{fontSize:14,marginBottom:12}}>Tap <b>Reset &amp; reload</b>. If it still fails, send a screenshot of this box.</div>
        <pre style={{whiteSpace:'pre-wrap',fontSize:11.5,background:'#fff',borderRadius:8,padding:10,maxHeight:'30vh',overflow:'auto',margin:'0 0 14px'}}>
          {String(e?.message || e)}{'\n'}{String(e?.stack || '').split('\n').slice(0, 4).join('\n')}{'\n\n'}{navigator.userAgent}
        </pre>
        <button onClick={hardReset} style={{width:'100%',padding:12,border:'none',borderRadius:10,background:'#0F6E56',color:'#fff',fontSize:16,fontWeight:600}}>Reset &amp; reload</button>
      </div>
    );
  }
}

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <RootBoundary>
      <AuthProvider>
        <ToastProvider>
          <App />
        </ToastProvider>
      </AuthProvider>
    </RootBoundary>
  </React.StrictMode>
);
