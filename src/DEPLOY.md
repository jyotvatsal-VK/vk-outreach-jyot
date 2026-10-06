# VK Outreach — update: 7 features + fixes

Contains every changed file (safe to copy over the previous fix release too).

## 1. Copy files (cmd)
    cd /d D:\User\Downloads
    rmdir /s /q vk-outreach-update
    tar -xf vk-outreach-update.zip
    cd /d C:\Users\user\Desktop\VK_Outreach_Program_JYOT\vk-jyot
    xcopy /Y "D:\User\Downloads\vk-outreach-update\src\*" "src\"
    copy /Y "D:\User\Downloads\vk-outreach-update\firestore.rules" "firestore.rules"
    dir src

## 2. Deploy
    vercel --prod

## 3. Publish rules (required — Dashboard "Customise → Save" fails without it)
Firebase console → Firestore → Rules → paste firestore.rules → Publish.
Only change vs last time: users may now save their own `dashboard` layout.

## 4. Test on a test event first
- Scheduling → Sahebji one-on-ones: delete a slot that has meetings (try both options), then restore it from Settings → Trash.
- POC Allocation → Auto-assign → Apply.
- Personalised Schedule: change a session time ("for everyone" and "only this guest"), add a row from "Add to a session", remove a session row → Save schedule. Check Scheduling reflects it.
- Vol. Availability → Add availability for 2 volunteers.

## Notes
- Old personalised-schedule rows migrate per guest the next time that guest's schedule is saved.
- POC daily limit: POC Allocation → "Max guests per POC/day" (needs Edit configurations permission).
