# ABF Email Worker — Deployment Guide

> **Also the site's API layer since 2026-08-03.** `src/api.js` serves `/api/*`:
> it is the ONLY thing that talks to Airtable on behalf of the browser (the PAT
> is a worker secret, never client-side). It verifies the site password, admin
> PIN, and last-4-of-phone sign-in server-side, issues signed HMAC session
> tokens (`SESSION_SECRET`), enforces per-table/per-owner write rules, strips
> phones/emails from anonymous responses, and rate-limits via the `RATE` KV
> namespace (create with `npx wrangler kv namespace create RATE`, paste the id
> into `wrangler.toml`). Extra secrets: `SESSION_SECRET`, `ROCK_ACCESS_HASH`
> (sha256 of the /bri board password). Deploy + rotation checklist:
> `SCHEDULING_TODO_TOM.md`, 2026-08-03 section.

A Cloudflare Worker that polls Airtable every 5 minutes and sends transactional emails via **Brevo** (migrated from SendGrid 2026-07-30 after SendGrid sunset its free plan and the account hit "Maximum credits exceeded") for these event types:

- **A.** New teaching request → email teacher
- **B.** Teacher responded (Accepted / Declined / Counter-Proposed) → email leader
- **D.** New feedback response → email teacher
- **E.** Pending-request reminder → email teacher once when a request has sat unanswered for more than 5 full days (5 × 24h), sent during the 7am hour America/New_York (added 2026-07-30)

Every outgoing email is BCC'd to `daly@lefc.net` (the `BCC_EMAIL` var in `wrangler.toml`) for admin visibility.

Replaces the Airtable Automations approach (which required a paid Team plan to enable Run-script).

---

## Total cost at expected volume: $0/month

- Cloudflare Workers free tier (100k req/day): we use ~300/day max
- Brevo free tier (300 emails/day): we use ~50/year
- Airtable API: included in Free plan

---

## One-time setup (~15 min)

### 1. Add four fields to Airtable

Open the base at <https://airtable.com/appTpp1agJQqoId07>.

**Requests table** — add three fields:

| Field name | Type |
|---|---|
| `Created Email Sent At` | Date with time |
| `Last Status Emailed` | Single line text |
| `Last Status Email Sent At` | Date with time |
| `Reminder Sent At` | Date with time *(added via API 2026-07-30 for flow E — already exists)* |

**Feedback Responses table** — add one field:

| Field name | Type |
|---|---|
| `Email Sent At` | Date with time |

These are the worker's "have we already sent this email?" markers. The worker queries records where these are blank, sends emails, then sets them.

### 2. Create an Airtable Personal Access Token

<https://airtable.com/create/tokens> → **Create new token**

- **Name:** `LEFC ABF Email Worker`
- **Scopes:** `data.records:read` and `data.records:write`
- **Access:** add the `ABF Scheduling` base only (not all bases)
- **Click Create**, copy the token.

### 3. Install Wrangler CLI

```bash
npm install -g wrangler
wrangler login
```

This opens a browser window; sign in to your Cloudflare account.

### 4. Deploy the worker

From the project root:

```bash
cd worker
wrangler deploy
```

First deploy will give you a URL like `https://abf-email-worker.YOUR-SUBDOMAIN.workers.dev`. Note it.

### 5. Set the two secrets

```bash
wrangler secret put AIRTABLE_TOKEN
# paste the Airtable PAT from step 2

wrangler secret put BREVO_API_KEY
# paste the Brevo transactional API key (Brevo → Settings → API Keys)
```

The sender in `FROM_EMAIL` (wrangler.toml) must be verified in Brevo — either as a single sender (daly@lefc.net) or via domain authentication for abfresources.com.

Optional third secret if you want to use the manual `/run` endpoint:

```bash
wrangler secret put MANUAL_TRIGGER_AUTH
# pick any random string — used as the x-trigger-auth header
```

### 6. Test in DRY_RUN mode first

The worker's `wrangler.toml` ships with `DRY_RUN = "false"`. To test safely, change it to `"true"`, redeploy, and verify the worker runs without sending real emails.

```bash
# Edit wrangler.toml: DRY_RUN = "true"
wrangler deploy
```

Watch logs in real time:

```bash
wrangler tail
```

The cron fires every 5 min. You should see lines like:

```
ABF email worker run complete {"newRequests":0,"statusChanges":0,"newFeedback":0,"errors":[]}
```

To force a run immediately:

```bash
curl -X POST -H "x-trigger-auth: $YOUR_MANUAL_TRIGGER_AUTH" \
  https://abf-email-worker.YOUR-SUBDOMAIN.workers.dev/run
```

When test data is present, expect `DRY_RUN A:`, `DRY_RUN B:`, or `DRY_RUN D:` log lines showing the recipient + subject without actually sending.

### 7. Flip to live

Change `DRY_RUN` back to `"false"` in `wrangler.toml` and redeploy:

```bash
wrangler deploy
```

The next cron tick will send real emails for any pending records.

---

## Rock Ideas & Feedback notifications (`/bri`)

This same worker also powers immediate email alerts for the **Rock Ideas & Feedback**
board at abfresources.com/bri (separate from ABF — it just shares this worker + SendGrid
sender). Unlike the three cron flows above, this one is **push, not poll**: the `/bri`
page calls the worker the instant something happens, so the email is immediate.

- **Endpoint:** `POST /rock-notify` (CORS-enabled, no auth — see note below)
- **Triggers & routing:**
  - **New ticket** → the **whole team** (everyone in `ROCK_NOTIFY_EMAILS`), minus the submitter.
  - **New comment** → only **that ticket's people**: its submitter + everyone who upvoted it,
    minus the comment's author. The subscriber list is derived server-side from Airtable
    (the ticket's `Submitter Email` + the `Voter Email`s on its votes).
  - Votes and resolve/reopen do **not** email.
- **Recipients / allowlist:** the `ROCK_NOTIFY_EMAILS` var in `wrangler.toml` is both the
  "whole team" list and the allowlist — the endpoint can only ever mail addresses in it,
  never arbitrary ones. **Must match the `ROSTER` in `bri/index.html`.**
- **DRY_RUN** applies here too — logs `DRY_RUN ROCK:` instead of sending.

**Connect the page to the worker (one step after deploy):** the page ships with
`NOTIFY_URL = ''`, so it works but sends nothing. After `wrangler deploy` gives you the
worker URL, open `bri/index.html`, set:

```js
const NOTIFY_URL = 'https://abf-email-worker.YOUR-SUBDOMAIN.workers.dev/rock-notify';
```

then push. To test: `curl -X POST -H 'Content-Type: application/json' \
  -d '{"type":"ticket","title":"Test","submitter":"Tom","priority":"High","description":"hi"}' \
  https://abf-email-worker.YOUR-SUBDOMAIN.workers.dev/rock-notify`

> **Security note:** the endpoint has no auth so the static page can call it. Because
> recipients are hard-fixed server-side, the only possible abuse is someone spamming
> those two inboxes — same risk posture as the base-scoped Airtable token already in the
> page. If that ever becomes a problem, add a shared-secret header check.

---

## End-of-survey AI feedback report (flow G, added 2026-11-23)

When a feedback survey closes, the worker asks Claude for a pastoral synthesis of the responses and emails it to the survey's teachers and the class's ABF leaders (BCC `BCC_EMAIL`), from `noreply@abfresources.com` via Brevo. Code: `processClosedFeedbackReports`, `runManualReport`, `generateFeedbackReport`, `resolveReportRecipients`, `reportGreeting`, `buildReportData`, `callClaudeForReport`, `buildFeedbackReportEmail` in `src/index.js`. Design rules: `feedback/REPORT_DESIGN.md`.

- **Recipients (2026-11-24):** every Teacher linked on the Feedback Form (all of them, not just the first), then every active ABF Leader of the form's ABF Class (`getClassLeaders`). Deduped by email, case-insensitive, first occurrence wins, so a leader who is also the form teacher appears once. People with no email are left off and listed in the dry run as `skippedNoEmail`. One email, everyone on To so they can see each other (`sendgridSendMulti`), with `BCC_EMAIL` passed explicitly as a BCC (dropped if the admin is already on To). A real send with zero addressable recipients fails like any other error. A co-teacher gets the report by being linked as a second Teacher on the form or by being an active leader of the class. The `Teachers` back-link on ABF Classes is **not** used: it comes from `Teachers.Home Class`, so it lists teachers who attend that class, not the survey's teachers.
- **Greeting:** "Hi Josh and Dan," / "Hi Josh, Dan, and Kurt,". Each recipient is named by their `MINISTRY_DISPLAY` greeting if they have one, otherwise by first name; duplicates collapse. The lead line reads "The survey ... has closed" since leaders get it too.

- **Secret:** `ANTHROPIC_API_KEY` (`npx wrangler secret put ANTHROPIC_API_KEY -c wrangler.toml`). If it is missing, flow G logs an error and skips; the other flows are unaffected.
- **Model:** `claude-sonnet-5-5`, `anthropic-version: 2026-10-21`, `max_tokens` 8000, `output_config.effort: "medium"`. No temperature or thinking params (Sonnet 5.5 rejects them). Token usage is logged as `G usage: {...}`.
- **Schedule:** runs on the first cron tick of each UTC hour (minute < 5), at most 2 surveys per tick. `POST /run` never generates or sends reports.
- **Auto-send rules:** `Closes At` has passed (full timestamp) AND is strictly after `REPORT_AUTO_SEND_CUTOFF = 2026-11-23T22:00:00.000Z` (5 PM ET, Nov 23 2026), not a question-box form, at least 1 real response (submitter names starting `test - automation` don't count), `Report Sent At` blank, attempts under the cap. Surveys that closed before the cutoff (11403, 30334, 25125, 64270) and surveys with no `Closes At` never auto-send.
- **Anonymity:** respondent names and emails never go to the model; respondents are "Respondent 1..N". The score table is computed in the worker, not by the model. The model writes the narrative only, as an email-safe HTML fragment; the worker strips scripts, styles, SVG, images, event handlers and em dashes before sending.
- **Airtable columns** (Feedback Forms): `Report Sent At` (date+time), `Report Started At` (date+time, the lock), `Report Attempt Count` (number), `Report Last Error` (long text), `aiReportHtml` (long text). The job creates missing ones through the Metadata API on first need (cached per isolate for 6 h). If the token lacks `schema.bases:write` it logs which columns to add by hand and keeps working off KV.
- **Lock and retries:** before calling Claude the job stamps `Report Started At` and bumps `Report Attempt Count`. A lock under 15 minutes old is skipped; an older one is treated as stale and retried. A failure writes `Report Last Error`, leaves `Report Sent At` blank, and the next hourly run retries, up to 5 attempts total. `Report Sent At` and `aiReportHtml` are written only after Brevo accepts the email. All state is mirrored to KV key `report:<formRecordId>` (RATE namespace) so a missing column can't cause a double send; with neither KV nor a `Report Sent At` column the job refuses to send. To retry a capped form, lower `Report Attempt Count` in Airtable and delete the KV key, or use the manual trigger.
- **DRY_RUN=true** makes the cron log `DRY_RUN G:` candidates without calling Claude.

**Manual trigger** (same `MANUAL_TRIGGER_AUTH` as `/run`):

```bash
# Preview: calls Claude, returns JSON (shape below). Sends nothing and writes
# no record data (no lock, no Sent At, no aiReportHtml, no KV). It does a fresh
# schema check and may CREATE missing report columns if the PAT allows it.
curl -s -X POST -H "x-trigger-auth: <MANUAL_TRIGGER_AUTH>" \
  "https://abf-email-worker.tdaly678.workers.dev/run/report?slug=11403&dry=1"

# Real send: survey must have closed. Ignores the cutoff and the attempt cap.
# Refuses if already sent unless &resend=1, and refuses question-box forms.
curl -s -X POST -H "x-trigger-auth: <MANUAL_TRIGGER_AUTH>" \
  "https://abf-email-worker.tdaly678.workers.dev/run/report?slug=11403"
```

Dry-run response shape:

```json
{
  "slug": "11403", "formId": "rec...", "formTitle": "...",
  "recipients": [{ "name": "...", "email": "...", "role": "teacher" }, { "name": "...", "email": "...", "role": "leader" }],
  "to": ["...", "..."],
  "skippedNoEmail": [{ "name": "...", "role": "teacher" }],
  "bcc": "<BCC_EMAIL>",
  "subject": "[LEFC|U] Your feedback report for ...",
  "responses": 12, "model": "claude-sonnet-5-5", "usage": { "input_tokens": 0, "output_tokens": 0 },
  "dryRun": true, "wouldSend": true, "sent": false,
  "html": "...", "plain": "...",
  "reportFields": { "present": ["Report Sent At", "..."], "missing": [], "created": [], "error": "" }
}
```

`wouldSend` is true when at least one recipient has an email. `reportFields` covers the five tracking columns; if the Metadata API can't be read, all five are listed as missing and `error` says presence is unknown (state then lives in KV). Real sends return the same `reportFields` (from the cached check).

To list just the recipients: `... | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["recipients"], d["bcc"], d["reportFields"])'`. To read just the HTML: `... | python3 -c 'import json,sys; print(json.load(sys.stdin)["html"])' > report.html`.

---

## Cleanup of synthetic test data

I created one synthetic Feedback Response during the Airtable Automation attempt (Submitter Name: "TEST - automation setup", linked to the Bailey form). The worker code skips email sending for any submitter name starting with `TEST - automation` so the real teacher (Joshua Bailey) won't get a stray email — but the row itself can be deleted from the Feedback Responses table whenever you want.

Also recommend deleting the older "ABF Resources" full-access SendGrid API key once the worker has been verified working.

---

## How it works (reference)

The worker exports two handlers:

- `scheduled()` — fires on the cron defined in `wrangler.toml` (every 5 min)
- `fetch()` — manual trigger via `POST /run` with an auth header

Both run the same three processors:

- `processNewRequests()` — finds Requests where `Created Email Sent At` is empty, looks up the linked Teacher / Leader / Class via the Airtable API, builds a branded LEFC|U HTML email, sends via SendGrid, sets `Created Email Sent At = now()`.
- `processStatusChanges()` — finds Requests where Status is `Accepted` / `Declined` / `Counter-Proposed` AND `Last Status Emailed != Status`. Sends to the leader. Sets `Last Status Emailed = current Status`. This handles the case where a request bounces between statuses (e.g., declined then re-accepted) by re-emailing each transition.
- `processNewFeedbackResponses()` — finds Feedback Responses where `Email Sent At` is empty, walks the Form link to find the Teacher, sends to the teacher.
- `processPendingReminders()` — finds Requests still `Pending` with `Reminder Sent At` empty whose age (from `Created At`, falling back to record createdTime) exceeds 5 × 24 hours, and emails the teacher a nudge. On the cron it only fires during the **7am hour America/New_York** (the `Reminder Sent At` stamp means only the first tick that hour sends anything); manual `POST /run` bypasses the hour gate so you can test on demand. One reminder per request — if you later want repeat nudges every N days, change the stamp check to compare against `now - N days` instead of blank.

- `processClosedFeedbackReports()` — flow G, cron only, hourly. See the section above.

All the handlers are independent and idempotent — failures in one don't block the others, and re-running the worker won't duplicate emails (the "sent at" markers prevent it).

---

## Maintenance

- **Logs:** `wrangler tail` for real-time. Cloudflare Dashboard → Workers → abf-email-worker → Logs for historical (last 24h on free plan).
- **Modifying email copy:** edit the `buildXxxEmail()` functions in `src/index.js`, then `wrangler deploy`.
- **Changing cron frequency:** edit the `crons` array in `wrangler.toml`. `*/5 * * * *` is every 5 min; `*/1 * * * *` would be every 1 min.
- **Pausing without uninstalling:** flip `DRY_RUN = "true"` and redeploy. Worker still runs, but nothing sends.
- **Rotating API keys:** `wrangler secret put SENDGRID_API_KEY` (overwrites). Same for `AIRTABLE_TOKEN`.

---

## File map

```
worker/
├── README.md          ← this file
├── wrangler.toml      ← Cloudflare Worker config (cron, env vars)
└── src/
    └── index.js       ← worker code (~280 lines, single file)
```

---

## Troubleshooting

**"Airtable query failed: 401"** — token invalid or doesn't have access to this base. Check the PAT's scopes and base list.

**"Airtable query failed: 422"** — formula references a field that doesn't exist. Likely the `Email Sent At` / `Created Email Sent At` / `Last Status Emailed` fields aren't added yet. Add them per Step 1 above.

**"SendGrid failed: 401"** — SendGrid key invalid. Run `wrangler secret put SENDGRID_API_KEY` again with a fresh key.

**"SendGrid failed: 403"** — sender not verified. The from-address must match a verified Single Sender in SendGrid (currently `daly@lefc.net`).

**Worker runs but no emails go out** — check `DRY_RUN` value in the dashboard. If `"true"`, the worker is logging instead of sending.

**Same email keeps re-sending** — the "Email Sent At" marker isn't being set. Most likely cause: token doesn't have `data.records:write` scope. Re-create with both read + write.
