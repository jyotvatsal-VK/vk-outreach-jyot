# VK Outreach — security, bug & mobile fixes

## Changed files (copy into your repo's `src/`)
App.jsx · auth.jsx · data.js · excel.js · schedule.js · settings.jsx · styles.css · trash_utils.js · ui.jsx · views.jsx
Plus `firestore.rules` (repo root, or paste into Firebase console).
Unchanged: activity.js, contactFilter.js, firebase.js, main.jsx, permissions.js.

## Deploy ORDER — follow exactly
1. **Firebase console → Authentication → Templates**: confirm the "Email address verification" template is enabled (it is by default).
2. **Push the code** (Vercel auto-redeploys). Old rules are still active at this point, so nothing breaks.
3. **Log in once as the Master** on the new build (hard refresh: Ctrl+Shift+R).
   This automatically:
   - creates `meta/bootstrap` (stops any new signup from becoming Master)
   - moves old `users/invite_*` docs into the new `invites` collection
   Verify in Firestore console that `meta/bootstrap` now exists before step 4.
4. **Test the rules** in Firebase console → Firestore → Rules → *Rules Playground*, using a normal user's UID:
   - get `users/<their uid>` → allowed
   - get `contacts/<any id>` → allowed if they are active
   - update `users/<their uid>` setting `role` → **denied**
   - create `contacts/x` for a user WITHOUT outreach add/edit → **denied**
5. **Publish `firestore.rules`.**
6. Ask 1–2 normal team members to do their usual work for 10 minutes. If anyone gets a "permission denied" toast on a legitimate action, tell me which screen + action and I'll adjust the write map.

## Optional (recommended)
- **Trash auto-expiry**: Firestore console → TTL policies → collection `trash`, field `expireAt`. Expired items then get deleted server-side; the in-app cleanup remains as a fallback.

## Behaviour changes your team will notice
- Switching events only changes **your** view. Admins can tick "Make this the default event for everyone" in the event dialog.
- New / edit event needs the *Settings → Edit configurations* permission (or Master). Deleting an event is Master-only and goes to Trash (restorable for 30 days as one item).
- New signups must verify their email before anything else happens. Existing accounts are unaffected.
- Invited people still sign up normally; their invite applies only after they verify their email.
- Users without *Manage users* permission see a short notice instead of the user list.
- Logistics import asks you to choose when a name match isn't exact.

## Known gaps (not in this release)
- Per-user contact filter is still applied in the browser only (needs Cloud Functions to enforce server-side).
- Logistics records still link to contacts two ways (`contactId` or same `id`); needs a data migration when no event is live.
