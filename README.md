# VK Outreach Program (JYOT)

A web app to run VK event operations — outreach, logistics, scheduling, volunteers & POC,
departments & tasks, and one-click schedule generation. Built with **React (Vite)** and
**Firebase** (Firestore + Authentication).

- **Live multi-user sync** — when one person edits, everyone else sees it within a second.
- **Secure login** — only people with an account in your Firebase project can see the data.
- **Excel import** — upload your existing sheet; matching records are overwritten with the
  latest values, new ones are added.
- **Works offline** — keeps working if the connection drops and re-syncs when it returns.

---

## What you need

- A free **Google account** (for Firebase).
- **Node.js 18+** installed on the computer doing the setup — https://nodejs.org
- A free **Vercel** account for hosting (optional but recommended) — https://vercel.com

You only do the setup once. After that, your team just visits the website and logs in.

---

## Step 1 — Create the Firebase project

1. Go to https://console.firebase.google.com and click **Add project**. Name it e.g. `vk-outreach-jyot`. (You can skip Google Analytics.)
2. In the left menu, open **Build → Authentication → Get started**, choose **Email/Password**, and enable it.
3. Open **Build → Firestore Database → Create database**. Choose a location near you (e.g. `asia-south1` for Mumbai) and start in **Production mode**.

## Step 2 — Get your config keys

1. Click the gear icon → **Project settings**.
2. Scroll to **Your apps**, click the **`</>` (Web)** icon, register an app (any nickname).
3. Firebase shows a `firebaseConfig` block. Copy these six values.
4. In this project folder, copy `.env.example` to a new file named **`.env`** and paste the values:

```
VITE_FB_API_KEY=...
VITE_FB_AUTH_DOMAIN=...
VITE_FB_PROJECT_ID=...
VITE_FB_STORAGE_BUCKET=...
VITE_FB_MESSAGING_SENDER_ID=...
VITE_FB_APP_ID=...
```

## Step 3 — Set the security rules

1. In Firebase, open **Firestore Database → Rules**.
2. Replace everything with the contents of **`firestore.rules`** (in this folder) and click **Publish**.
   This makes the data readable/writable **only by signed-in team members**.
   (The file has a commented example for restricting access to a specific list of emails once your team is set up.)

## Step 4 — Run it locally

In a terminal, inside this folder:

```bash
npm install
npm run dev
```

Open the URL it prints (usually http://localhost:5173). You'll see the login screen.

- Click **Create an account** and register the first team member with email + password.
- Once signed in, click **Add sample data** (top right) to load the example VK 4.0 records,
  or go straight to **Outreach → Import from Excel** to load your real data.

Each teammate creates their own account the same way and sees the same shared data live.

## Step 5 — Importing your Excel sheet

In **Outreach → Import from Excel**:

- Upload an `.xlsx` or `.csv`. Columns are matched by name (Name, Designation, Organisation,
  Phone, POC, Confirmation, Remarks, etc.) — capitalisation and small wording differences are fine.
- The app shows a preview: how many rows are **new** vs will be **overwritten**.
  Matching is by phone number, or by name + organisation when there's no phone.
- Click Import. You can download a blank template from the same screen.

## Step 6 — Deploy so the team can use it (Vercel)

**Easiest (GitHub):**
1. Put this folder in a GitHub repository.
2. On https://vercel.com → **Add New → Project → Import** your repo.
3. Vercel auto-detects Vite. Before deploying, open **Environment Variables** and add the same
   six `VITE_FB_...` values from your `.env`.
4. Click **Deploy**. You get a public URL (e.g. `vk-outreach-jyot.vercel.app`) to share with the team.

**Or via command line:**
```bash
npm i -g vercel
vercel        # follow prompts
vercel env add VITE_FB_API_KEY   # repeat for each of the six keys
vercel --prod
```

**One extra step:** in Firebase → Authentication → Settings → **Authorized domains**, add your
Vercel domain so login works on the live site.

---

## Good to know

- **Backups.** Your data lives in Firestore. For a downloadable backup, use the Firebase console
  (Firestore → Import/Export) or `gcloud firestore export`. Worth doing before big changes.
- **Restricting who can sign up.** By default anyone who knows the URL can create an account
  (they still can't see data until their account exists). To limit it to specific people, use the
  email allow-list shown in `firestore.rules`, and/or disable open sign-up by creating accounts
  yourself in Firebase → Authentication → Users.
- **Cost.** For ~20–30 users this comfortably fits Firebase's free (Spark) tier. If you ever exceed
  it, set a Google Cloud **budget alert** so there are no surprises. Use email/password login
  (already set up) — SMS/phone login is the part that costs money, and this app doesn't use it.
- **How sync works.** Every change writes to Firestore and streams to all open browsers instantly —
  no refresh needed. If two people edit the *same field* at the same time, the last save wins.

## Project structure

```
src/
  firebase.js     Firebase init (reads .env)
  auth.jsx        login / sign-up + auth state
  data.js         Firestore live hooks, save/delete/import helpers, sample data
  excel.js        Excel parsing + new-vs-overwrite logic
  schedule.js     schedule generation (event / founder / personalised)
  ui.jsx          icons, modal, toast, shared bits
  views.jsx       all screens (Outreach, Logistics, Scheduling, People, Depts, Reports)
  App.jsx         shell, navigation, auth gate
  styles.css      all styling
firestore.rules   security rules to paste into Firebase
.env.example      template for your Firebase keys
```
