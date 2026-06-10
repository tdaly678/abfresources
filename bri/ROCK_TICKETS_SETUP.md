# Rock Ideas & Feedback — Setup Guide

A standalone, password-protected idea/feedback board for our **Rock** system, living at
**abfresources.com/bri**. It's intentionally separate from the ABF content — it just rides
on the same domain and the same Airtable account.

People past the password can **submit ideas** (name, title, description, priority),
**vote** items up, and **comment**. **Bri** signs in with a second admin password to
**mark items resolved** and **reply as the admin** (badged).

---

## Passwords

| Who | Password | What it unlocks |
|-----|----------|-----------------|
| Everyone | `oikos` | View, submit, vote, comment (same as the main ABF site) |
| Bri (admin) | `irock` | Mark items **Resolved** / Reopen, and post **Admin** comments |

> To rotate either password, edit `bri/index.html`, find the line with the matching hash near
> the top of the `<script>` (`ACCESS_HASH` / `ADMIN_HASH`), and replace it with a new SHA-256
> hash. Generate one in a terminal: `printf '%s' 'YourNewPassword' | sha256sum`

---

## Step 1 — Create three tables in Airtable

These go in the **same base** the ABF site already uses (`ABF Scheduling`,
id `appTpp1agJQqoId07`). The page reuses the token already in the site, so there's
**no token to generate**. The data stays logically separate in its own tables.

Open the base → **Add a table** (the `+` next to the table tabs) → **Start from scratch**.
Name and field spelling must match **exactly** (the page references them by name).

### Table 1 — `Rock Tickets`

| Field name   | Type             | Notes |
|--------------|------------------|-------|
| `Title`      | Single line text | Primary field. |
| `Description`| Long text        | |
| `Submitter`  | Single line text | The submitter's typed name. |
| `Priority`   | Single select    | Options exactly: `Low`, `Medium`, `High`. |
| `Status`     | Single select    | Options exactly: `Open`, `Resolved`. |
| `Resolved By`| Single line text | Auto-filled with the admin name when resolved. |
| `Resolved At`| Date             | Auto-filled when resolved. (Date only is fine.) |

### Table 2 — `Rock Ticket Votes`

| Field name   | Type             | Notes |
|--------------|------------------|-------|
| `Voter Key`  | Single line text | Primary field. Auto-filled as `<ticketId>:<voterId>` — prevents double votes. |
| `Ticket ID`  | Single line text | The Rock Tickets record id this vote belongs to. |
| `Voter`      | Single line text | Anonymous per-browser id. |

### Table 3 — `Rock Ticket Comments`

| Field name   | Type             | Notes |
|--------------|------------------|-------|
| `Ref`        | Single line text | Primary field. Auto-filled `author · timestamp`. |
| `Ticket ID`  | Single line text | The Rock Tickets record id this comment belongs to. |
| `Author`     | Single line text | Commenter's name (or the admin name). |
| `Body`       | Long text        | The comment text. |
| `Is Admin`   | Checkbox         | Checked when Bri posts as admin → shows the **Admin** badge. |

> You can delete the auto-created "Notes"/"Assignee"/"Status" starter fields Airtable adds —
> just keep the fields listed above. Don't rename tables or fields after go-live; the page
> looks them up by name.

There are no linked-record fields and no formulas to set up — votes and comments reference
their ticket by a plain `Ticket ID` text value, so setup is quick.

---

## Step 2 — Deploy

The page is already in this repo at `bri/index.html`. Push to GitHub like any other site
change (see the repo/push notes in the project) and GitHub Pages will serve it at:

```
https://www.abfresources.com/bri
```

(GitHub Pages serves `bri/index.html` for the `/bri/` path; `/bri` redirects to `/bri/`
automatically.)

---

## Step 3 — Smoke test

1. Visit `/bri`, enter `oikos`.
2. Submit a test idea → it should appear in the list.
3. Click the ▲ vote arrow → count goes to 1; click again → back to 0.
4. Open comments, post one as yourself.
5. Click **Admin sign in**, enter the admin password → an "★ Admin: Bri" chip appears.
6. Post an **Admin** comment (shows the red Admin badge), then **Mark resolved** → the
   item moves to the **Resolved** filter. **Reopen** brings it back.
7. Delete the test records from Airtable when done.

---

## Email notifications

New tickets and new comments fire an **immediate email** to `daly@lefc.net` and
`brianna.roberts@lefc.net`. (Votes and resolve/reopen do **not** email.)

This runs through the existing Cloudflare email worker (`worker/`), which must be
**deployed** for emails to send — see `worker/README.md`. Two things to know:

1. The board works fine **without** the worker; it just won't send emails until it's
   deployed and the page is pointed at it.
2. After deploying, set `NOTIFY_URL` near the top of `bri/index.html` to the worker's
   `/rock-notify` URL and push. Until then it's `''` (no-op). To change who gets the
   emails, edit `ROCK_NOTIFY_EMAILS` in `worker/wrangler.toml`.

---

## Notes & limitations

- **Vote dedup is per browser** (a random id stored in the browser). Someone clearing their
  browser data or using another device could vote again. Fine for an internal idea board;
  tell me if you want true one-person-one-vote and we'll add name-based sign-in.
- **Only the admin password gates resolve/admin-comments.** Anyone who learns that password
  gets those powers — so keep it to Bri.
- **The Airtable token is visible in the page source**, same as the rest of the site. It's
  scoped to this one base. Don't treat anything here as confidential.
- This board is **not linked** from the ABF site nav — it's reachable only by going to `/bri`
  directly.
