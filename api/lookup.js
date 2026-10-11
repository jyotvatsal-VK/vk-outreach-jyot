/* ══════════════════════════════════════════════════════════════════
   POST /api/lookup — public information about one guest, from Google Search via Gemini.
   Only the guest's NAME, ORGANISATION and DESIGNATION are sent — nothing else from the app.
   The "is this the same person?" check is done back in the browser against the app's own data,
   so that data never leaves the app.
   Only users given "Look up guests online" (ai.lookup), or Master, can call it.

   Request:  { name, organisation, designation }
   Response: { found, ambiguous, summary, currentRole, organisation, location, expertise, highlights[], sources[{title,uri}] }
══════════════════════════════════════════════════════════════════ */
import { requireUser, geminiKey, gemini, readBody } from './_lib.js';

const s = (v, n = 160) => String(v ?? '').trim().slice(0, n);

function promptFor(name, org, desig) {
  return `Search the public web for this person and report what is publicly known about them professionally.
Person: ${name}${desig ? `, ${desig}` : ''}${org ? `, ${org}` : ''}.

Rules:
- Only use information about THIS person. Many people share a name: use the organisation and designation to make sure.
- If you find several different people with this name and cannot tell which is meant, set "ambiguous": true and describe the most likely one.
- If you find nothing reliable, set "found": false.
- No private information: no phone numbers, emails, home addresses, family details, health or anything personal. Professional and public-role information only.
- Do not guess. Every fact must come from the search results.

Reply with ONLY a JSON object, no other text:
{"found": true|false, "ambiguous": true|false,
 "summary": "2-3 sentences: who they are professionally",
 "currentRole": "current title", "organisation": "current organisation", "location": "city/country of their work",
 "expertise": "their field in a few words",
 "highlights": ["up to 5 short, factual points: notable roles, awards, books, recent public news"]}`;
}

function parseJson(text) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });
  const key = geminiKey();
  if (!key) return res.status(503).json({ error: 'Online lookup isn’t switched on yet — add the Gemini key in Vercel and redeploy.' });
  const who = await requireUser(req, 'ai.lookup');
  if (!who.ok) return res.status(who.status).json({ error: who.error });

  const body = readBody(req);
  const name = s(body.name, 120), org = s(body.organisation, 160), desig = s(body.designation, 120);
  if (!name) return res.status(400).json({ error: 'No name to look up.' });

  try {
    const { text, grounding } = await gemini(key, {
      contents: [{ role: 'user', parts: [{ text: promptFor(name, org, desig) }] }],
      tools: [{ googleSearch: {} }],
      generationConfig: { temperature: 0 },
    }, { deadlineMs: 50_000, thinking: 0 });
    const out = parseJson(text) || { found: false };
    const sources = [];
    (grounding?.groundingChunks || []).forEach(c => {
      const u = c?.web?.uri, t = c?.web?.title;
      if (u && !sources.some(x => x.uri === u)) sources.push({ uri: u, title: s(t || u, 120) });
    });
    return res.status(200).json({
      found: !!out.found,
      ambiguous: !!out.ambiguous,
      summary: s(out.summary, 700),
      currentRole: s(out.currentRole), organisation: s(out.organisation), location: s(out.location), expertise: s(out.expertise),
      highlights: (Array.isArray(out.highlights) ? out.highlights : []).map(h => s(h, 240)).filter(Boolean).slice(0, 5),
      sources: sources.slice(0, 8),
    });
  } catch (e) {
    return res.status(502).json({ error: `Couldn’t look this up: ${e.message || e}` });
  }
}
