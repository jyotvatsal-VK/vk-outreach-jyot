import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  getFirestore,
} from 'firebase/firestore';

const cfg = {
  apiKey:            import.meta.env.VITE_FB_API_KEY,
  authDomain:        import.meta.env.VITE_FB_AUTH_DOMAIN,
  projectId:         import.meta.env.VITE_FB_PROJECT_ID,
  storageBucket:     import.meta.env.VITE_FB_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FB_MESSAGING_SENDER_ID,
  appId:             import.meta.env.VITE_FB_APP_ID,
};

export const configured =
  !!cfg.apiKey &&
  !cfg.apiKey.startsWith('your-') &&
  cfg.apiKey !== 'undefined' &&
  cfg.apiKey.length > 10;

let app, auth, db;

if (configured) {
  try {
    app  = initializeApp(cfg);
    auth = getAuth(app);

    // Try the best offline mode first (multi-tab + persistent cache).
    // Falls back to basic Firestore if the browser doesn't support it
    // (e.g. Safari private mode, some mobile browsers).
    try {
      db = initializeFirestore(app, {
        localCache: persistentLocalCache({
          tabManager: persistentMultipleTabManager(),
        }),
      });
    } catch (offlineErr) {
      console.warn('Multi-tab persistence not supported, using basic Firestore:', offlineErr.message);
      try {
        // Second attempt: persistent cache without multi-tab manager
        db = initializeFirestore(app, {
          localCache: persistentLocalCache({}),
        });
      } catch (e2) {
        // Final fallback: plain Firestore with no offline cache
        console.warn('Persistent cache failed, using online-only Firestore:', e2.message);
        db = getFirestore(app);
      }
    }
  } catch (e) {
    console.warn('Firebase init failed:', e.message);
    auth = null; db = null;
  }
} else {
  auth = null; db = null;
}

export { auth, db };
