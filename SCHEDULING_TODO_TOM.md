# Scheduling Tool — Things For You To Do

The site is live and pulling from Airtable. Below are the things only you can do (Airtable API doesn't support these), in priority order.

## What changed on 2026-07-30 — Tab restructure (no action required)

Purely a frontend reorganization; no Airtable changes:

- New top-level **Courses** tab = the shared course catalog (formerly the leader-only "Available Courses" sub-tab). Same sort/teacher/weeks/topic filters. Signed-in teachers now edit their courses there ("Manage Your Courses" form below the catalog); signed-in leaders get a **"Request this course"** button on each card that pre-fills New Request.
- **Scheduling** (renamed from "Teacher Scheduling") is now just: My Availability + Incoming Requests (teachers); Teacher Availability grid + New Request + My Requests (leaders).
- **My Profile** moved to the **Teachers** tab (inline form when signed in as a teacher; clicking your roster card still opens the edit modal).
- Resources → "Online Courses" renamed to **"Online Studies"**.
- Also that day: ABF Classes cards are now text-only with colored class-name banners (leader photos removed), and the **facility map** PDF is linked from Home → Key Announcements.
- **Heads-up:** the two Vimeo walkthrough videos show the old tab layout — worth re-recording eventually (see `walkthroughs/INDEX.md`).

## What changed on 2026-05-01 — Course Topic Tags + filterable catalog

The Available Courses tab now has sort, teacher filter, weeks filter (1–12), and topic-tag filter chips. Teachers see a 2–3 tag picker on the My Courses form. **Both setup steps are already done** — no action required from you for the rollout itself:

- **Tags multi-select field** was created on the Courses table via API with all 10 options in the right colors (Old Testament, New Testament, Theology & Doctrine, Apologetics, Discipleship, Spiritual Formation, Marriage & Family, Church Life, Mission & Evangelism, Cultural Engagement).
- **All 23 existing courses backfilled** with 2–3 tags each. Open Airtable → Courses → Tags column to spot-check or edit.

If you want to revise any tags, edit them directly in Airtable; changes propagate to the site on next page load. The retroactive workflow doc in `walkthroughs/retroactive_course_tags.md` is still a good reference for how the process worked, in case you onboard a similar batch later.

**Adding/renaming a tag in the future:** three places must agree exactly — `COURSE_TAG_OPTIONS` and `COURSE_TAG_TONE` in `index.html`, the Airtable Courses → Tags multi-select option list, and the doc above.

## What changed on 2026-04-27 (heads-up before you log in)

A handful of profile-related changes shipped together — the profile/registration form and teacher cards will look a little different from what you may remember:

- **"Get to know me" tagline.** A new 140-character open-ended field on every teacher profile, shown as an italicized pull-quote above the bio. Encourage teachers to write something fun (hobbies, family, where they're from).
- **Statement of Faith affirmation.** A new checkbox on the profile that says: *"I have read and affirm LEFC's Statement of Faith and Matters of Faith and Practice and will teach in alignment with both."* The box links out to lancasterefree.com/about/what-we-believe. Date is auto-stamped the first time it's checked. The profile card meta shows "Affirmed on YYYY-MM-DD".
- **Weeks taught (replaces "Have you taught before?").** Buckets are `0`, `1-9`, `10-24`, `25+` weeks (with an "approximately" caveat in the help text). Stage is now auto-derived from this — you no longer pick the stage manually. `0` and `1-9` → Up & Comer; `10-24` → Active; `25+` → Veteran. The display collapses "Up & Comer Yr 1" / "Up & Comer Yr 2-3" to a single "Up & Comer" badge — the year flavor is preserved underneath if it was already set.
- **Past venues + relevant training are now chip lists.** Common options pre-populated (Churches, Schools, Conferences, Workshops, Retreats, Camps, etc. for venues; Seminary, Bible college, Local-church courses, etc. for training). Multi-select. There's still a free-text box for "anything else" notes.
- **"In what contexts do you intend to teach?" is gone.** The field still lives in the Airtable schema so legacy data is preserved, but the question was removed from the form.
- **Header polish.** The "LEFC Adults" badge in the header was removed (it was redundant with the LEFC ABF Resources logotype). The identity button is now a big terra-red **"Teacher & Leader Sign In"** call-to-action when nobody's signed in, so leaders and teachers can find the entry point at a glance.

**Schema-level note for you:** the old `Series Taught Count` field was renamed to `_DEPRECATED Series Count` because the Airtable Metadata API doesn't allow editing singleSelect options or deleting fields. You can hide or delete it manually in the Airtable UI when you feel like it. The new live field is `Weeks Taught`. The `Teaching Contexts` field is also no longer being written to (still readable for legacy values).



## 0. Per-person sign-in is now live — populate phone numbers and change the admin PIN

The portal now defaults to **read-only browsing** for everyone past the password gate. To **edit** a teacher's profile/availability/courses, the user has to sign in as that teacher; to **send or respond to teaching requests as a leader**, they sign in as that leader. Sign-in uses the **last 4 digits of the phone number** stored in Airtable.

**For this to work you need real phone numbers in two places:**

1. **Teachers table → Phone column** — already exists, but a few rows might still be empty. Open the Teachers table and fill any blanks. Format doesn't matter (`(717) 555-1234`, `717.555.1234`, `7175551234` all work — only the last 4 digits are checked).
2. **ABF Leaders table → Phone column** — this is **new** (just added). Open the table and add each leader's phone number.

Until a person's phone is on file they can still browse but they can't sign in. They'll see "No phone number on file for this person yet — ask an admin to add one before signing in."

**Admin override.** There's also an **Admin PIN** that unlocks edit access on every teacher and leader (so you can fill in for someone). It's stored as a SHA-256 hash in **Settings** (Key = `adminPinHash`), the same way the site password works.

- **Default PIN: `1234`** — please change this. To rotate:
  1. Pick a new PIN.
  2. On a Mac terminal: `echo -n 'newpin' | shasum -a 256` → copy the 64-character hex digest.
  3. Open the **Settings** table → row where **Key** = `adminPinHash` → paste into the **Value** cell.
  4. Takes effect on next page load.
- To **disable** admin override entirely, blank out the **Value** cell (the "Sign in as admin →" link will then say "Admin override is not configured").

**To use admin override:** click the big red **"Teacher & Leader Sign In"** button in the header → click **"Sign in as admin →"** at the bottom of the picker → enter the PIN. The badge stays red and shows "Admin Override Active". While admin is active you can pick any teacher or leader from the role pickers without needing their phone number; the badge stays red until you sign out.

**Heads up — security caveat.** Last-4-of-phone is a low-friction barrier, not a real auth system. Anyone who can read a teacher's phone number (printed church directories, public bulletins, Realm/Rock if those are visible to attendees) can sign in as them. The same shared site password ("oikos") is still the main perimeter. The Change Log audit trail (section 6 below) tells you who edited what after the fact, so a bad actor can be traced and rolled back.

## 1. Set up the two email Automations via SendGrid (~25 min)

Open the base: <https://airtable.com/appTpp1agJQqoId07>
Click **Automations** (top right), then **Create automation** twice.

> **Why SendGrid instead of Airtable's built-in Send Email?** Better deliverability, branded sender (`daly@lefc.net` instead of `automations@airtable.com`), HTML templating control. Same Airtable triggers — just a different action.

### Pre-flight: SendGrid sender + API key

Before building either automation, in your existing SendGrid account:

1. **Settings → Sender Authentication → Verify a Single Sender** → add `daly@lefc.net` (From Name: `LEFC|U ABF Scheduling`). Click the verification link SendGrid sends to that inbox.
2. **Settings → API Keys → Create API Key** → name `lefc-airtable-automations`, permission **Restricted Access** with only **Mail Send → Full Access** checked. Copy the key. You'll paste it into the script below.

### Automation A — "New request → email teacher"

**Trigger:** *When a record is created* → Table: **Requests**

**Action 1:** *Find records*
- Table: **Teachers**
- Condition: record ID is `{{Trigger record → Teacher}}`

**Action 2:** *Find records*
- Table: **ABF Leaders**
- Condition: record ID is `{{Trigger record → Requesting Leader}}`

**Action 3:** *Find records*
- Table: **ABF Classes**
- Condition: record ID is `{{Trigger record → ABF Class}}`

**Action 4:** *Run a script*

In the **Input variables** panel on the left of the script editor, add these (left-side name → right-side mapping):

| Input variable name | Value (drag from previous steps) |
|---|---|
| `teacherName` | Find Teachers → First record → Name |
| `teacherEmail` | Find Teachers → First record → Email |
| `leaderName` | Find ABF Leaders → First record → Name |
| `className` | Find ABF Classes → First record → Name |
| `service` | Find ABF Classes → First record → Service |
| `requestedSundays` | Trigger record → Requested Sundays *(formatted as comma-separated text)* |
| `leaderMessage` | Trigger record → Leader Message |

Then paste this into the script body:

```javascript
const SENDGRID_API_KEY = "REPLACE_WITH_YOUR_SENDGRID_KEY";
const FROM_EMAIL = "daly@lefc.net";
const FROM_NAME = "LEFC|U ABF Scheduling";
const PORTAL_URL = "https://www.abfresources.com/?tab=scheduling";

const { teacherName, teacherEmail, leaderName, className, service,
        requestedSundays, leaderMessage } = input.config();

const msgPlain = leaderMessage || "(no message)";
const sundaysText = (requestedSundays || "").toString().trim() || "(no Sundays specified)";

const subject = `New teaching request from ${leaderName}`;

const plain = `Hi ${teacherName},

${leaderName} just asked you to teach in ${className} (${service}) on:

${sundaysText}

Their message:
${msgPlain}

Open the portal to respond:
${PORTAL_URL}

— ABF Scheduling`;

const html = `<!DOCTYPE html><html><body style="font-family:Helvetica,Arial,sans-serif;color:#342D25;line-height:1.55;max-width:560px;margin:0 auto;padding:24px;background:#fff;">
  <div style="border-bottom:3px solid #BCA944;padding-bottom:10px;margin-bottom:18px;">
    <span style="color:#AA3B24;letter-spacing:.12em;font-size:11px;font-weight:800;text-transform:uppercase;">LEFC|U · ABF Scheduling</span>
  </div>
  <p>Hi <strong>${teacherName}</strong>,</p>
  <p><strong>${leaderName}</strong> just asked you to teach in <strong>${className}</strong> (${service}) on:</p>
  <p style="background:#f7eed7;border-left:3px solid #BCA944;padding:10px 14px;margin:14px 0;font-weight:600;">${sundaysText}</p>
  <p style="margin-top:18px;"><strong>Their message:</strong></p>
  <p style="background:#f7eed7;border-left:3px solid #524B30;padding:10px 14px;margin:6px 0 18px;">${msgPlain.replace(/\n/g, "<br>")}</p>
  <p style="margin-top:22px;">
    <a href="${PORTAL_URL}" style="display:inline-block;background:#AA3B24;color:#fff;padding:10px 22px;text-decoration:none;border-radius:4px;font-weight:700;">Open the portal to respond</a>
  </p>
  <p style="margin-top:32px;color:#6b6050;font-size:12px;">— ABF Scheduling · Lancaster Evangelical Free Church</p>
</body></html>`;

const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
  method: "POST",
  headers: {
    "Authorization": `Bearer ${SENDGRID_API_KEY}`,
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    personalizations: [{ to: [{ email: teacherEmail, name: teacherName }] }],
    from: { email: FROM_EMAIL, name: FROM_NAME },
    reply_to: { email: FROM_EMAIL, name: FROM_NAME },
    subject,
    content: [
      { type: "text/plain", value: plain },
      { type: "text/html",  value: html }
    ]
  })
});

if (res.status !== 202) {
  throw new Error(`SendGrid failed: ${res.status} ${await res.text()}`);
}
console.log(`Sent teaching-request email to ${teacherEmail}`);
```

**Test:** click **Test** with a real Request record (create a throwaway one if needed). Confirm the email lands at the teacher's inbox. Then **Turn on automation**.

### Automation B — "Teacher responded → email leader"

**Trigger:** *When a record matches conditions* → Table: **Requests**
- Condition: **Status** is any of `Accepted`, `Declined`, `Counter-Proposed`

**Action 1:** *Find records* → Table: **ABF Leaders**, condition: record ID is `{{Trigger record → Requesting Leader}}`

**Action 2:** *Find records* → Table: **Teachers**, condition: record ID is `{{Trigger record → Teacher}}`

**Action 3:** *Find records* → Table: **ABF Classes**, condition: record ID is `{{Trigger record → ABF Class}}`

**Action 4:** *Run a script*

Input variables:

| Input variable name | Value |
|---|---|
| `leaderName` | Find ABF Leaders → First record → Name |
| `leaderEmail` | Find ABF Leaders → First record → Email |
| `teacherName` | Find Teachers → First record → Name |
| `className` | Find ABF Classes → First record → Name |
| `status` | Trigger record → Status |
| `teacherResponse` | Trigger record → Teacher Response |
| `counterSundays` | Trigger record → Counter Sundays *(formatted as comma-separated text)* |

Script body:

```javascript
const SENDGRID_API_KEY = "REPLACE_WITH_YOUR_SENDGRID_KEY";
const FROM_EMAIL = "daly@lefc.net";
const FROM_NAME = "LEFC|U ABF Scheduling";
const PORTAL_URL = "https://www.abfresources.com/?tab=scheduling";

const { leaderName, leaderEmail, teacherName, className,
        status, teacherResponse, counterSundays } = input.config();

const responseText = teacherResponse || "(no note from the teacher)";
const counterText  = (counterSundays || "").toString().trim();

// Pick subject + accent color by status
const isAccepted = status === "Accepted";
const isDeclined = status === "Declined";
const accent = isAccepted ? "#524B30" : isDeclined ? "#AA3B24" : "#BCA944";

const subject = `${teacherName} ${status.toLowerCase()} your teaching request`;

const plain = `Hi ${leaderName},

${teacherName} responded "${status}" to your request to teach in ${className}.

Their note:
${responseText}
${counterText ? `\nCounter-proposed Sundays:\n${counterText}\n` : ""}
Open the portal to see the full request:
${PORTAL_URL}

— ABF Scheduling`;

const counterHtml = counterText
  ? `<p style="margin-top:18px;"><strong>Counter-proposed Sundays:</strong></p>
     <p style="background:#f7eed7;border-left:3px solid #BCA944;padding:10px 14px;margin:6px 0 18px;font-weight:600;">${counterText}</p>`
  : "";

const html = `<!DOCTYPE html><html><body style="font-family:Helvetica,Arial,sans-serif;color:#342D25;line-height:1.55;max-width:560px;margin:0 auto;padding:24px;background:#fff;">
  <div style="border-bottom:3px solid #BCA944;padding-bottom:10px;margin-bottom:18px;">
    <span style="color:#AA3B24;letter-spacing:.12em;font-size:11px;font-weight:800;text-transform:uppercase;">LEFC|U · ABF Scheduling</span>
  </div>
  <p>Hi <strong>${leaderName}</strong>,</p>
  <p><strong>${teacherName}</strong> responded <span style="color:${accent};font-weight:700;text-transform:uppercase;letter-spacing:.04em;">${status}</span> to your request to teach in <strong>${className}</strong>.</p>
  <p style="margin-top:18px;"><strong>Their note:</strong></p>
  <p style="background:#f7eed7;border-left:3px solid ${accent};padding:10px 14px;margin:6px 0 18px;">${responseText.replace(/\n/g, "<br>")}</p>
  ${counterHtml}
  <p style="margin-top:22px;">
    <a href="${PORTAL_URL}" style="display:inline-block;background:#AA3B24;color:#fff;padding:10px 22px;text-decoration:none;border-radius:4px;font-weight:700;">Open the portal</a>
  </p>
  <p style="margin-top:32px;color:#6b6050;font-size:12px;">— ABF Scheduling · Lancaster Evangelical Free Church</p>
</body></html>`;

const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
  method: "POST",
  headers: {
    "Authorization": `Bearer ${SENDGRID_API_KEY}`,
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    personalizations: [{ to: [{ email: leaderEmail, name: leaderName }] }],
    from: { email: FROM_EMAIL, name: FROM_NAME },
    reply_to: { email: FROM_EMAIL, name: FROM_NAME },
    subject,
    content: [
      { type: "text/plain", value: plain },
      { type: "text/html",  value: html }
    ]
  })
});

if (res.status !== 202) {
  throw new Error(`SendGrid failed: ${res.status} ${await res.text()}`);
}
console.log(`Sent ${status} response email to ${leaderEmail}`);
```

**Test** with an existing Request record by flipping its Status to `Accepted` (then back to Pending if you want to test again). Confirm the leader's inbox gets the email. Then **Turn on automation**.

> **API key handling:** the `SENDGRID_API_KEY` constant at the top of each script is hardcoded — anyone with collaborator access to the Airtable base can read it. If you ever add other Airtable collaborators, treat this base's "Edit" access as equivalent to handing out the SendGrid key. Rotate the key (SendGrid → API Keys → trash icon → create new) and update both scripts if you suspect exposure.

> **Free-tier limits:** Airtable free plan ≈ 100 automation runs/month, SendGrid free tier ≈ 100 emails/day. Combined volume here (a handful of requests + responses per week) sits well below either ceiling.

## 2. Update teacher email addresses

Right now every teacher's email is `<firstname>@example.com` — placeholder data. Open the **Teachers** table and replace each one with their real email so the automations can reach them.

Same for **ABF Leaders** — eight rows, all `<firstname>.<lastname>@example.com`.

## 3. (Optional) Clean up the base

You can safely delete these leftover scaffolding tables in the Airtable UI:
- `Table 1` (the default Airtable creates for new bases)
- `_probe_test` (left over from API experimentation)

## 4. (Nice-to-have) Add real photos

The **Teachers** table has a **Photo** field (multiple attachments). When you upload a teacher's photo there, the portal won't auto-display it yet — that's a small follow-up I can add when you want it.

## 5. Test the end-to-end flow once

1. Open https://www.abfresources.com, enter the password.
2. Click the identity badge in the header, sign in as a teacher (e.g., yourself or Ed Scheuerman).
3. Set some availability for a few Sundays (click cells).
4. Sign out, sign in as an ABF leader (e.g., Scott Galen for Koinonia).
5. Send yourself a teaching request.
6. Check your inbox for the automation email (assuming you've turned it on).
7. Sign back in as the teacher, accept it, and confirm the leader gets a response email.

Once that round-trip works, the tool is ready for the team.

---

# Security & Audit — How to Catch a Bad Actor

The portal has a single shared password ("oikos"), so anyone past the gate can edit teachers, courses, availability, and requests. To make that safe, three things are now in place:

1. **Audit trail** — every write goes into a **Change Log** table.
2. **Daily digest email** to you — once you set up Automation C below.
3. **Rotatable password** — the password lives in the **Settings** table as a SHA-256 hash. Change it in Airtable and the next page-load picks up the new value.

## 6. Set up the daily digest email (Automation C, ~10 min)

Open the base: <https://airtable.com/appTpp1agJQqoId07> → **Automations** → **Create automation**.

**Trigger:** *At a scheduled time*
- Frequency: **Daily**
- Time: pick whatever you check email (e.g., **7:00 AM**)
- Time zone: **America/New_York**

**Action 1:** *Find records*
- Table: **Change Log**
- Condition: **Changed At** is **within the last 1 day**
- Sort: **Changed At** descending
- Limit: 100 (more than enough for a normal day)

**Action 2:** *Send email*
- **To:** `daly@lefc.net`
- **Subject:**
  ```
  ABF Resources — daily change log ({{Find Change Log → record count}} changes)
  ```
- **Message body** (rich text):
  ```
  Here's what changed on the ABF Resources portal in the last 24 hours.

  If anything looks wrong or unauthorized, you can:
    1. Open the Change Log in Airtable and revert the offending record using
       its revision history (Free plan keeps 14 days).
    2. Rotate the site password (see "Rotate the password" below) so the
       bad actor can't get back in.

  ─────────────────────────────────────────────
  {{Find Change Log → list of records → format each as:}}
  • {{Changed At}} — {{Changed By}}
    {{Action}} on {{Table}}: {{Summary}}
    {{Details}}
  ─────────────────────────────────────────────

  Open Change Log: https://airtable.com/appTpp1agJQqoId07/{{Change Log table ID}}

  — ABF Scheduling
  ```
  *(For the "list of records" piece: in the email step, click into the body, type `+`, choose **Find Change Log → List**, then click the gear icon to customize the per-record template using `{{Changed At}}`, `{{Changed By}}`, `{{Action}}`, `{{Table}}`, `{{Summary}}`, `{{Details}}`.)*
- Add an *If/Then* wrapper around Action 2 so the email only sends when there's something to report:
  - If: `{{Find Change Log → record count}}` is greater than `0`
  - Then: send email (above)
- **Test** with a real day's data, then **Turn on automation**.

If you'd rather get a real-time ping on every change instead of a daily digest, duplicate this automation, swap the trigger to *When a record is created in Change Log*, and remove the digest formatting.

## 7. Rotate the password

Whenever you suspect the password has leaked (or just on a routine cadence), change it like this:

1. Pick a new password (e.g., `kerygma2026`).
2. Hash it. On a Mac terminal:
   ```
   echo -n 'kerygma2026' | shasum -a 256
   ```
   That prints the 64-character hex digest.
3. Open the base → **Settings** table → row where **Key** = `passwordHash`.
4. Paste the new hex digest into the **Value** cell. Save.
5. Tell whoever still needs access what the new password is.
6. Anyone with an open browser tab still has access until they reload — if you need to kick everyone out immediately, also change the Airtable Personal Access Token (let me know and I'll regenerate the token + redeploy).

The password change takes effect on the next page-load. No code changes, no GitHub push.

## 8. Roll back a bad change

Airtable's revision history is your rollback button.

**For a single record (most common):**
1. Open the Change Log row that flagged the bad edit. Note the **Table** and **Record ID**.
2. Open that table, find the record.
3. Click the record to expand it → **Activity** tab (the clock icon in the top right of the record).
4. Find the revision before the bad change → click **Revert this record to here**.
5. Free plan keeps **14 days** of per-record history. After that the snapshot is gone.

**For a bigger mess (lots of records changed at once):**
1. Open the base → **Help** menu → **Base history**.
2. Free plan keeps **7 days** of base snapshots. Pick a snapshot from before the damage and **Restore**. Heads-up: this rolls back the whole base — anything legitimate that happened since gets wiped too. Use as a last resort.

Either way, after rolling back, also rotate the password (step 7) so the same person can't redo the damage.

## 9. Where to look in Airtable

| What | Table | What's in it |
|---|---|---|
| Audit trail | **Change Log** | Every create / update / delete made through the site |
| Site password | **Settings** (Key = `passwordHash`) | SHA-256 hex of the password |
| Active automations | Automations panel | A, B (email alerts), C (daily digest) |
