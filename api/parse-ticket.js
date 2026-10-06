/* ══════════════════════════════════════════════════════════════════
   POST /api/parse-ticket  — Vercel serverless function
   Reads a flight ticket (PDF or photo) with Google Gemini and returns the flights on it.
   Nothing is stored: the file is sent to Gemini, the answer comes back, the file is dropped.

   Vercel → Project → Settings → Environment Variables:
     GEMINI_API_KEY   required  — key from https://aistudio.google.com/apikey
     GEMINI_MODEL     optional  — defaults to gemini-2.5-flash (falls back to gemini-flash-latest)
     VITE_FB_API_KEY  already set for the app — used here to check the caller is signed in

   Request:  { data: <base64>, mimeType: 'application/pdf' | 'image/…', guestName?: string }
             Authorization: Bearer <Firebase ID token>
   Response: { passengers: [..], pnr, airline, isInternational, legs: [{ flightNo, from:{city,code,terminal},
               to:{…}, departDate:'YYYY-MM-DD', departTime:'HH:MM', arriveDate, arriveTime }] }
══════════════════════════════════════════════════════════════════ */

const ALLOWED = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
const MAX_B64 = 4_300_000;   // Vercel's request limit is 4.5 MB

const PLACE = {
  type: 'OBJECT',
  properties: {
    city: { type: 'STRING', description: 'City name, e.g. Mumbai' },
    code: { type: 'STRING', description: 'IATA airport code, e.g. BOM' },
    terminal: { type: 'STRING', description: 'Terminal number or name if printed, e.g. 2. Empty if not shown.' },
  },
};
const SCHEMA = {
  type: 'OBJECT',
  properties: {
    isFlightTicket: { type: 'BOOLEAN' },
    passengers: { type: 'ARRAY', items: { type: 'STRING' } },
    pnr: { type: 'STRING' },
    airline: { type: 'STRING' },
    isInternational: { type: 'BOOLEAN', description: 'true if any flight crosses a country border' },
    legs: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          flightNo: { type: 'STRING', description: 'Airline code + number with a space, e.g. AI 631' },
          from: PLACE,
          to: PLACE,
          departDate: { type: 'STRING', description: 'YYYY-MM-DD, local time at the departure airport' },
          departTime: { type: 'STRING', description: 'HH:MM 24-hour, local time at the departure airport' },
          arriveDate: { type: 'STRING', description: 'YYYY-MM-DD, local time at the arrival airport' },
          arriveTime: { type: 'STRING', description: 'HH:MM 24-hour, local time at the arrival airport' },
        },
        required: ['flightNo', 'from', 'to', 'departDate', 'departTime'],
      },
    },
  },
  required: ['isFlightTicket', 'legs'],
};

const PROMPT = `You read airline tickets / e-tickets / boarding passes / booking confirmations.
Extract every flight segment (leg) exactly as printed, in travel order, including both directions of a return ticket and every leg of a connection.
Rules:
- Dates as YYYY-MM-DD, times as 24-hour HH:MM, in the LOCAL time of that airport, as printed. Never convert time zones.
- If the arrival date is not printed, it is the departure date unless the arrival time is earlier than the departure time on an overnight flight (then the next day).
- Flight numbers as airline code + space + number (e.g. "6E 2134", "AI 631").
- Terminal only if printed; otherwise leave it empty.
- Passengers: names as printed. PNR / booking reference if printed.
- Do not invent anything. If it is not a flight ticket, set isFlightTicket to false and return no legs.`;

const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
const isTime = s => /^\d{2}:\d{2}$/.test(s || '');
const fixTime = s => { const m = String(s || '').match(/^(\d{1,2})[:.](\d{2})/); return m ? `${m[1].padStart(2, '0')}:${m[2]}` : ''; };
const str = (s, n = 80) => String(s ?? '').trim().slice(0, n);
const place = p => ({ city: str(p?.city, 60), code: str(p?.code, 4).toUpperCase(), terminal: str(p?.terminal, 10).replace(/^terminal\s*/i, '') });

async function signedIn(req) {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const fbKey = process.env.VITE_FB_API_KEY || process.env.FB_API_KEY;
  if (!token || !fbKey) return false;
  try {
    const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(fbKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(req.headers.origin ? { Referer: req.headers.origin + '/' } : {}) },
      body: JSON.stringify({ idToken: token }),
    });
    if (!r.ok) return false;
    const j = await r.json();
    return Array.isArray(j.users) && j.users.length > 0;
  } catch { return false; }
}

async function askGemini(key, data, mimeType) {
  const models = [...new Set([process.env.GEMINI_MODEL, 'gemini-2.5-flash', 'gemini-flash-latest'].filter(Boolean))];
  let lastErr = '';
  for (const model of models) {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: PROMPT }, { inline_data: { mime_type: mimeType, data } }] }],
        generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema: SCHEMA },
      }),
    });
    if (r.status === 404) { lastErr = `Model ${model} not available`; continue; }   // try the next model name
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j?.error?.message || `Gemini error ${r.status}`);
    const text = (j.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
    if (!text) throw new Error('The AI returned no answer for this file.');
    return JSON.parse(text);
  }
  throw new Error(lastErr || 'No Gemini model available');
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });

  const key = process.env.GEMINI_API_KEY;
  if (!key) return res.status(503).json({ error: 'Ticket reading isn’t switched on yet — add GEMINI_API_KEY in Vercel and redeploy.' });
  if (!(await signedIn(req))) return res.status(401).json({ error: 'Please sign in again, then retry.' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const data = String(body?.data || '');
  const mimeType = String(body?.mimeType || '').toLowerCase();
  if (!data) return res.status(400).json({ error: 'No file received.' });
  if (!ALLOWED.includes(mimeType)) return res.status(400).json({ error: 'Upload a PDF, JPG, PNG, WEBP or HEIC file.' });
  if (data.length > MAX_B64) return res.status(413).json({ error: 'File too large (max about 3 MB). Try a screenshot instead.' });

  try {
    const out = await askGemini(key, data, mimeType);
    if (out?.isFlightTicket === false) return res.status(422).json({ error: 'This doesn’t look like a flight ticket.' });
    const legs = (Array.isArray(out?.legs) ? out.legs : []).slice(0, 12).map(l => {
      const departTime = fixTime(l.departTime), arriveTime = fixTime(l.arriveTime);
      return {
        flightNo: str(l.flightNo, 20).toUpperCase().replace(/^([A-Z0-9]{2})\s*-?\s*(\d+)/, '$1 $2'),
        from: place(l.from), to: place(l.to),
        departDate: isDate(l.departDate) ? l.departDate : '', departTime: isTime(departTime) ? departTime : '',
        arriveDate: isDate(l.arriveDate) ? l.arriveDate : (isDate(l.departDate) ? l.departDate : ''),
        arriveTime: isTime(arriveTime) ? arriveTime : '',
      };
    }).filter(l => l.departDate || l.arriveDate);
    return res.status(200).json({
      passengers: (Array.isArray(out?.passengers) ? out.passengers : []).map(p => str(p, 80)).filter(Boolean).slice(0, 9),
      pnr: str(out?.pnr, 12).toUpperCase(),
      airline: str(out?.airline, 60),
      isInternational: !!out?.isInternational,
      legs,
    });
  } catch (e) {
    return res.status(502).json({ error: `Couldn’t read the ticket: ${e.message || e}` });
  }
}
