/* ══════════════════════════════════════════════════════════════════
   POST /api/ask — "Ask AI" over the event's data.
   The app sends the question and a CODED copy of the data the user is allowed to see:
   guests are G1, G2…, volunteers V1…, hotels H1… — no names, phones, emails, PNRs or flight numbers.
   The answer comes back in those codes and the app puts the real names back on the user's screen.
   Only users given "Ask AI questions" (ai.ask), or Master, can call it.

   Request:  { question, context: {…coded data…}, history: [{ q, a }] (coded, last few turns), today }
   Response: { answer }
══════════════════════════════════════════════════════════════════ */
import { requireUser, geminiKey, gemini, readBody } from './_lib.js';

const MAX_CONTEXT = 900_000;   // characters of JSON

const SYSTEM = `You answer questions from an event-operations team about their event, using ONLY the JSON data provided.

About the data:
- People and places are codes: guests G#, volunteers V#, hotels H#. Always refer to them by these exact codes (e.g. "G14"). Never invent names.
- guests[]: code, type, status, field (area of expertise), arrival / departure { date, time, at (airport or place), by ("flight" | "car" | "planned" = dates typed before booking) }, stay { hotel, checkIn, checkOut }, car { required, pickup, drop }, plan (travel steps: land, pickup = car pickup at the airport or guest's city, reach = arrives at hotel or venue, leave = leaves hotel for the airport, report = must be at the airport, depart = flight or car departure), sessions (session ids), sahebji { date, time, minutes, frozen }, poc { "YYYY-MM-DD": { vol, from, to, frozen } }, pocNeeded { "YYYY-MM-DD": { from, to } }, pending (what is still missing in logistics), warnings.
- sessions[]: id, title, type, date, start, end, venue.
- volunteers[]: code, departments, availability { "YYYY-MM-DD": ["09:00-13:00", …] | "full" }.
- event: name and dates. "today" is given separately.
- Times are 24-hour local time. "Reach the venue" = the plan step "reach" when the hotel is the venue, otherwise the arrival time plus the hotel→venue step if present; if the data does not say, say so.

How to answer:
- Answer the question directly first, then the supporting facts. Short sentences. Use a bullet list when listing several guests or days.
- Only state what the data shows. If something is missing or unknown, say exactly what is missing (e.g. "G14 has no departure flight yet").
- Do not give advice beyond the data unless asked.
- If the question names a guest the data does not contain, say you could not find them.`;

const clean = s => String(s ?? '').slice(0, 2000);

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });
  const key = geminiKey();
  if (!key) return res.status(503).json({ error: 'Ask AI isn’t switched on yet — add the Gemini key in Vercel and redeploy.' });
  const who = await requireUser(req, 'ai.ask');
  if (!who.ok) return res.status(who.status).json({ error: who.error });

  const body = readBody(req);
  const question = clean(body.question).trim();
  if (!question) return res.status(400).json({ error: 'Type a question first.' });
  const ctx = JSON.stringify(body.context || {});
  if (ctx.length > MAX_CONTEXT) return res.status(413).json({ error: 'Too much data for one question. Try asking about one day or one guest.' });
  const history = (Array.isArray(body.history) ? body.history : []).slice(-4)
    .flatMap(h => [{ role: 'user', parts: [{ text: clean(h.q) }] }, { role: 'model', parts: [{ text: clean(h.a) }] }]);

  try {
    const { text } = await gemini(key, {
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [
        { role: 'user', parts: [{ text: `Today is ${clean(body.today) || 'unknown'}.\nDATA:\n${ctx}` }] },
        { role: 'model', parts: [{ text: 'Understood. I will answer only from this data, using the codes.' }] },
        ...history,
        { role: 'user', parts: [{ text: question }] },
      ],
      generationConfig: { temperature: 0.1, maxOutputTokens: 2048 },
    }, { deadlineMs: 54_000, thinking: 0, perTryMs: 22_000 });   // no thinking step: answers in seconds
    if (!text) throw new Error('the AI returned an empty answer.');
    return res.status(200).json({ answer: text.trim() });
  } catch (e) {
    return res.status(502).json({ error: `Couldn’t answer: ${e.message || e}` });
  }
}
