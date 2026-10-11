/* ══════════════════════════════════════════════════════════════════
   POST /api/parse-ticket  — Vercel serverless function
   Reads a flight ticket (PDF or photo) with Google Gemini and returns the flights on it.
   Nothing is stored: the file is sent to Gemini, the answer comes back, the file is dropped.

   Vercel → Project → Settings → Environment Variables:
     Gemini key (any capitalisation of GEMINI_KEY / GEMINI_API_KEY), VITE_FB_API_KEY, VITE_FB_PROJECT_ID — see _lib.js
   Only users given "Read flight tickets with AI" (ai.ticket), or Master, can call it — checked here on the server.
   Note: on the Gemini free tier, Google may use what is sent to improve its products. The ticket includes the
   passenger's name and PNR, which is why this is limited to the people you choose.

   Request:  { data: <base64>, mimeType: 'application/pdf' | 'image/…' }
             Authorization: Bearer <Firebase ID token>
   Response: { passengers: [..], pnr, airline, isInternational, legs: [{ flightNo, from:{city,code,terminal},
               to:{…}, departDate:'YYYY-MM-DD', departTime:'HH:MM', arriveDate, arriveTime }] }
══════════════════════════════════════════════════════════════════ */

import { requireUser, geminiKey, gemini, readBody } from './_lib.js';

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

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });

  const key = geminiKey();
  if (!key) return res.status(503).json({ error: 'Ticket reading isn’t switched on yet — add the Gemini key in Vercel and redeploy.' });
  const who = await requireUser(req, 'ai.ticket');          // only people given "Read flight tickets with AI"
  if (!who.ok) return res.status(who.status).json({ error: who.error });

  const body = readBody(req);
  const data = String(body.data || '');
  const mimeType = String(body.mimeType || '').toLowerCase();
  if (!data) return res.status(400).json({ error: 'No file received.' });
  if (!ALLOWED.includes(mimeType)) return res.status(400).json({ error: 'Upload a PDF, JPG, PNG, WEBP or HEIC file.' });
  if (data.length > MAX_B64) return res.status(413).json({ error: 'File too large (max about 3 MB). Try a screenshot instead.' });

  try {
    const { text } = await gemini(key, {
      contents: [{ role: 'user', parts: [{ text: PROMPT }, { inline_data: { mime_type: mimeType, data } }] }],
      generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema: SCHEMA },
    }, { deadlineMs: 55_000, thinking: 0 });
    if (!text) throw new Error('The AI returned no answer for this file.');
    const out = JSON.parse(text);
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
