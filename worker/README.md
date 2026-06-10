# ABF Email Worker — Deployment Guide

A Cloudflare Worker that polls Airtable every 5 minutes and sends transactional emails via SendGrid for three event types:

- **A.** New teaching request → email teacher
- **B.** Teacher responded (Accepted / Declined / Counter-Proposed) → email leader
- **D.** New feedback response → email teacher

Replaces the Airtable Automations approach (which required a paid Team plan to enable Run-script).

---

## Total cost at expected volume: $0/month

- Cloudflare Workers free tier (100k req/day): we use ~300/day max
- SendGrid free tier (100 emails/day): we use ~50/year
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

wrangler secret put SENDGRID_API_KEY
# paste the SendGrid scoped key (lefc-airtable-automations from earlier)
```

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
- **Triggers:** a **new ticket** or a **new comment**. (Votes and resolve/reopen do not email.)
- **Recipients:** fixed server-side via the `ROCK_NOTIFY_EMAILS` var in `wrangler.toml`
  (default `daly@lefc.net, brianna.roberts@lefc.net`). The client never specifies
  recipients, so the endpoint can only ever mail those addresses.
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

All three handlers are independent and idempotent — failures in one don't block the others, and re-running the worker won't duplicate emails (the "sent at" markers prevent it).

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
