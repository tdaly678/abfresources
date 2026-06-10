# Rock Ideas & Feedback — Setup Guide

A standalone, password-protected idea/feedback board for our **Rock** system, living at
**abfresources.com/bri**. It's intentionally separate from the ABF content — it just rides
on the same domain and the same Airtable account.

Everyone signs in with one shared password, then **picks their name** from the roster (so
the system knows who they are and their email). Signed-in people can **submit ideas**,
**upvote**, and **comment**. **Brianna's** identity carries admin powers — she can **mark
items resolved/reopen** and her comments show an **Admin** badge.

---

## Access & identity

- **One shared password for everyone: `oikos`.**
- After the password, each person selects their name from a dropdown. That name + email is
  remembered in their browser (they can "Switch user" anytime from the header).
- **Admin = whoever signs in as Brianna Roberts.** No separate admin password. (Because the
  password is shared, this isn't strict security — anyone *could* pick her name. Fine for a
  trusted internal team; tell me if you ever want it locked down.)

To rotate the access password, edit `bri/index.html`, replace the `ACCESS_HASH` line near the
top of the `<script>`, and push. Generate a hash with: `printf '%s' 'YourNewPassword' | sha256sum`

### Roster

The people with access live in the `ROSTER` array at the top of `bri/index.html`'s script,
and **must match** `ROCK_NOTIFY_EMAILS` in `worker/wrangler.toml`. Current list:

Brianna Roberts (admin), Emma Smith, Ethan Zook, Gary Poorman, Jeff Travis, Jenny Hoover,
Linsey Smoker, Sandy Morris, Tom Daly.

To add/remove someone: edit both places, then push the page and redeploy the worker.

---

## Airtable tables (already created)

The three tables live in the **same base** the ABF site uses (`ABF Scheduling`,
id `appTpp1agJQqoId07`) and were created for you via the API. The page reuses the token
already in the site, so there's **no token to generate**. Field reference:

**`Rock Tickets`** — `Title` (primary), `Description`, `Submitter`, `Submitter Email`,
`Priority` (`Low`/`Medium`/`High`), `Status` (`Open`/`Resolved`), `Resolved By`, `Resolved At`.

**`Rock Ticket Votes`** — `Voter Key` (primary, `<ticketId>:<email>` — prevents double votes),
`Ticket ID`, `Voter` (name), `Voter Email`.

**`Rock Ticket Comments`** — `Ref` (primary), `Ticket ID`, `Author`, `Author Email`, `Body`,
`Is Admin` (checkbox → shows the Admin badge).

Votes and comments reference their ticket by a plain `Ticket ID` text value (no linked-record
fields). Don't rename tables or fields — the page and worker look them up by name.

---

## Voting

One vote **per person** (keyed by email), so it holds across devices and browsers — not the
old per-browser method.

---

## Email notifications

Routed through the existing Cloudflare email worker (`worker/`). Rules:

| Event | Who gets emailed |
|-------|------------------|
| **New ticket** | The **whole team** (everyone in the roster), minus the submitter. |
| **New comment** | Only **that ticket's people** — its submitter + everyone who upvoted it — minus the comment's author. |
| Upvote | No email. |
| Resolved / reopened | No email. |

"That ticket's people" is derived server-side from Airtable (the ticket's `Submitter Email`
plus the `Voter Email`s on its votes). The worker can only ever email addresses in
`ROCK_NOTIFY_EMAILS` (the roster doubles as an allowlist), so it can't be used to mail
arbitrary addresses.

**After any change to the worker or the roster, redeploy it:**

```
cd "/Users/daly/Documents/Claude/Projects/ABF Resources/worker"
npx wrangler deploy
```

The page's `NOTIFY_URL` already points at the deployed worker
(`https://abf-email-worker.tdaly678.workers.dev/rock-notify`).

---

## Notes & limitations

- **Identity isn't authenticated** — the shared password plus a name dropdown. Good enough for
  a trusted internal team; not a security boundary.
- **The Airtable token is visible in the page source**, same as the rest of the site. It's
  scoped to this one base. Don't treat anything here as confidential.
- This board is **not linked** from the ABF site nav — it's reachable only by going to `/bri`
  directly.
