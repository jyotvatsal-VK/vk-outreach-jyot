/* Shared helpers for the /api functions (files starting with "_" are not exposed as URLs on Vercel).

   requireUser(req, permKey)
     1. checks the Firebase ID token sent by the app (Authorization: Bearer …)
     2. reads that user's own profile from Firestore with the same token (the rules allow reading your own profile)
     3. allows the call only if the profile is active and is Master or has `permKey` ticked
   So an AI feature can't be used by someone just because they know the URL — the same permission
   ticks you set in Settings → Users decide it, checked on the server.

   Env (Vercel → Settings → Environment Variables):
     Gemini key under any capitalisation of GEMINI_KEY / GEMINI_API_KEY (e.g. Gemini_key)
     VITE_FB_API_KEY, VITE_FB_PROJECT_ID — already set for the app
     GEMINI_MODEL (optional)
*/

export function geminiKey() {
  const name = Object.keys(process.env).find(k => /^gemini(_api)?_key$/i.test(k));
  return name ? process.env[name] : '';
}

export async function requireUser(req, permKey) {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const fbKey = process.env.VITE_FB_API_KEY || process.env.FB_API_KEY;
  const project = process.env.VITE_FB_PROJECT_ID || process.env.FB_PROJECT_ID;
  if (!token || !fbKey) return { ok: false, status: 401, error: 'Please sign in again, then retry.' };
  const ref = req.headers.origin ? { Referer: req.headers.origin + '/' } : {};
  let uid = '';
  try {
    const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(fbKey)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...ref }, body: JSON.stringify({ idToken: token }),
    });
    if (!r.ok) return { ok: false, status: 401, error: 'Please sign in again, then retry.' };
    uid = (await r.json())?.users?.[0]?.localId || '';
  } catch { return { ok: false, status: 401, error: 'Please sign in again, then retry.' }; }
  if (!uid) return { ok: false, status: 401, error: 'Please sign in again, then retry.' };
  if (!permKey) return { ok: true, uid };
  if (!project) return { ok: false, status: 500, error: 'VITE_FB_PROJECT_ID is not set in Vercel.' };
  try {
    const r = await fetch(`https://firestore.googleapis.com/v1/projects/${encodeURIComponent(project)}/databases/(default)/documents/users/${encodeURIComponent(uid)}`, {
      headers: { Authorization: `Bearer ${token}`, ...ref },
    });
    if (!r.ok) return { ok: false, status: 403, error: 'Your account could not be checked. Ask the Master admin.' };
    const f = (await r.json())?.fields || {};
    const role = f.role?.stringValue || '';
    const status = f.status?.stringValue || '';
    const perm = f.permissions?.mapValue?.fields?.[permKey]?.booleanValue === true;
    if (status && status !== 'active') return { ok: false, status: 403, error: 'Your account is not active.' };
    if (role !== 'Master' && !perm) return { ok: false, status: 403, error: 'You don’t have permission for this. Ask the Master admin.' };
    return { ok: true, uid, role };
  } catch { return { ok: false, status: 403, error: 'Your account could not be checked. Try again.' }; }
}

/* Call Gemini with a time limit.
   - thinking: 0 turns off the model's "thinking" step (much quicker); falls back for a model that refuses the setting.
   - Models are tried in order. If one is slow (perTryMs), overloaded (503) or missing (404), the next one is tried
     while time remains, so a busy free-tier model doesn't make the user wait for nothing. */
export async function gemini(key, body, { deadlineMs = 50_000, thinking = 0, perTryMs = 25_000, models: list } = {}) {
  const deadline = Date.now() + deadlineMs;
  const models = [...new Set([process.env.GEMINI_MODEL, ...(list || ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-flash-latest'])].filter(Boolean))];
  const withThinking = { ...body, generationConfig: { ...(body.generationConfig || {}), thinkingConfig: { thinkingBudget: thinking } } };
  const call = async (model, b, ms) => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ms);
    try {
      return await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST', signal: ctl.signal,
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify(b),
      });
    } catch (e) {
      if (e.name === 'AbortError') return { timedOut: true };
      throw e;
    } finally { clearTimeout(t); }
  };
  let lastErr = '';
  for (let i = 0; i < models.length; i++) {
    const left = deadline - Date.now();
    if (left < 6_000) break;
    const isLast = i === models.length - 1 || left < perTryMs + 8_000;
    const ms = isLast ? left : Math.min(perTryMs, left);
    const model = models[i];
    let r = await call(model, withThinking, ms);
    if (r.timedOut) { lastErr = 'the AI took too long'; continue; }
    if (r.status === 400) {
      const j0 = await r.clone().json().catch(() => ({}));
      if (/thinking/i.test(j0?.error?.message || '')) {
        r = await call(model, body, Math.max(5_000, deadline - Date.now()));
        if (r.timedOut) { lastErr = 'the AI took too long'; continue; }
      }
    }
    if (r.status === 404) { lastErr = `Model ${model} not available`; continue; }
    if (r.status === 503 || r.status === 500) { lastErr = 'the AI service is busy'; continue; }
    const j = await r.json().catch(() => ({}));
    if (r.status === 429) throw new Error('the free AI quota is used up for now. Try again in a minute.');
    if (!r.ok) throw new Error(j?.error?.message || `Gemini error ${r.status}`);
    const cand = j.candidates?.[0] || {};
    const text = (cand.content?.parts || []).map(p => p.text || '').join('');
    return { text, grounding: cand.groundingMetadata || null, model };
  }
  throw new Error(lastErr === 'the AI took too long' ? 'the AI took too long. Please try again in a moment.' : (lastErr || 'No Gemini model available'));
}

export function readBody(req) {
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  return body || {};
}
