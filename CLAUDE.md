# ABF Resources — Project Notes

This file is the persistent context for the **ABF Leader Resources** project. Future Claude sessions: read this first.

---

## What this project is

A static resource hub for ABF leaders and teachers at **Lancaster Evangelical Free Church (LEFC)**, hosted at **[abfresources.com](https://abfresources.com)**. Built and maintained by Tom Daly (daly@lefc.net).

ABF = Adult Bible Fellowship — Sunday-morning lay-led small groups built around Scripture, community, and care. There are **8 active ABFs across 2 services**.

The site exists to **equip and support lay leaders** so they can serve autonomously and faithfully — supported by pastoral staff, but never dependent on it. Every design decision should reflect that conviction.

---

## Brand

Adult ministry at LEFC is branded **LEFC|U**, not "LEFC Adults." The "LEFC|U" badge previously in the site header was replaced by a terra-red **"Teacher & Leader Sign In"** call-to-action when nobody's signed in. Visual identity = warm browns, deep red, gold.

For all ABF / adult-ministry materials (presentations, flyers, social, docs), use the **LEFC|U** sub-brand. The `lefc-branding` skill has the full brand spec.

---

## Audience split (standing rule)

ABF training, walkthrough, and onboarding materials are produced **separately for leaders and teachers** — not one combined piece. Their workflows differ:

- **Leaders** view the Teacher Availability grid, send teaching requests, track My Requests.
- **Teachers** manage My Availability (Sept–June Sunday grid), respond to Incoming Requests (both on the Scheduling tab), edit their courses on the Courses tab, and fill out My Profile on the Teachers tab.

A combined video forces both audiences to sit through content that isn't theirs. Default: split. The user has confirmed this preference.

---

## Site sections (top-level nav)

1. **ABF Classes** — directory of current classes by service (1st: Philippians, Faith Builders, Koinonia, Branches, Roots, Mosaic; 2nd: Agape, Synago). Room assignments (per Airtable, confirmed 2026-07-30): A3 = Philippians (1st) + Agape (2nd); A4 = Faith Builders (1st) + Synago (2nd); A5 = Koinonia; A6 = Branches; D6 = Mosaic; D7 = Roots. D5 is tagged ABF but has no class assigned. A1/A2 are multi-use, not ABF.
2. **Key Dates** — no-meeting Sundays, summer break, Easter, ABF resume dates.
3. **Resources** — Training Videos (For New Leaders / For Existing Leaders / For New Teachers), Articles, Online Studies (renamed from "Online Courses" July 2026; Joshua WBF Spring 2026, plus Tutorials). *Default subsection on load: Training Videos.*
4. **Teachers** — roster organized by stage (Veterans, Active, Up & Comers Years 2–3, Up & Comers Year 1). Also hosts **My Profile** (inline form, shown when signed in as a teacher; moved here from Scheduling July 2026).
5. **Courses** (tab id `catalog`) — top-level shared course catalog (added July 2026). Flat list with sort / teacher / weeks / topic-tag filters. Signed-in teachers see Edit/Remove on their own courses plus the add/edit form below the catalog ("Manage Your Courses"). Signed-in leaders see a **"Request this course"** button on each card that jumps to Scheduling → New Request with teacher + course pre-filled.
6. **Scheduling** (renamed from "Teacher Scheduling") — now purely send/receive: teachers get My Availability + Incoming Requests; leaders get Teacher Availability grid, New Request, My Requests. My Courses / My Profile / Available Courses moved out (see above).
7. **Feedback** — class feedback surveys with three templates (Class Standard, Topical, End-of-Series), public form (`?f=slug`), aggregate dashboard, printable PDFs. Architecture lives in `feedback/README.md`.
8. **Contact** — Tom Daly, daly@lefc.net.

---

## Architecture

- **Frontend**: static HTML at the root of this folder (`index.html`, `404.html`). Push to the GitHub repo to deploy. Repo and token details: see memory `reference_github.md`.
- **Hosting (corrected 2026-08-03)**: served by **Cloudflare Pages**, *not* GitHub Pages. GitHub Pages is disabled on the repo (the Pages API returns 404); the leftover `CNAME` file was deleted 2026-08-03. Deploys propagate a few minutes after a push — if the live site looks stale, wait rather than assuming a cache problem.
  - **Canonical host is `www.abfresources.com`.** The apex `abfresources.com` 301-redirects to www. Note `abfresources.com/index.html` 307-redirects to `/`, so always test against `https://www.abfresources.com/` — the other forms return redirects with no body and can look like stale content.
  - **~~Known issue~~ RESOLVED (verified 2026-08-05):** the apex empty-`Location` redirect bug is fixed. A Redirect Rule named **"Apex to www"** now exists in the Cloudflare dashboard (Rules → Redirect Rules): custom filter `Hostname equals abfresources.com` → Dynamic redirect `concat("https://www.abfresources.com", http.request.uri.path)`, 301, preserve query string, placed First. Verified live: apex paths, `?f=` query strings, `/12345` short codes, and plain-http all redirect correctly to www with path intact. Don't recreate or "fix" this rule — it's correct as-is.
- **Backend (scheduling + feedback)**: Airtable. Schema is documented in `SCHEDULING_TOOL_AIRTABLE_SETUP.md`.
- **API proxy (added 2026-08-03)**: the browser NEVER talks to Airtable directly — all traffic goes through the Cloudflare worker's `/api/*` layer (`worker/src/api.js`). The Airtable PAT lives only in a worker secret. The worker verifies the site password, admin PIN, and last-4-of-phone sign-in **server-side**, issues signed HMAC session tokens, enforces per-table/per-owner write permissions, strips phones/emails from anonymous responses, and rate-limits via a KV namespace. **Never reintroduce an Airtable token into any HTML page.** The old embedded PAT (`pat1ppp…`) was rotated/revoked; it's still in git history but dead. Pages covered: index.html, /bri, /preaching, /cbsetup.html, /fieldsurvey(+results), /preachingprepsurvey(+results).
- **Auth (public since 2026-08-03)**: the shared front-page password gate was **removed** — the hub is now publicly viewable. Anonymous visitors get server-sanitized data only (no phones, emails, request messages, or feedback responses; the worker strips these). The `/api/gate` endpoint + `passwordHash` in Settings still exist (the gate can be re-enabled by restoring the `unlock()`-on-load guard in index.html), but the screen is no longer shown. To edit profile / availability / courses, or to send/respond to teaching requests, the user signs in as a specific person using **the last 4 digits of the phone number** stored in Airtable — verified server-side by `POST /api/signin`, which returns a session token plus the person's own record (`me`). **Self-registration (adding a brand-new teacher/leader) is now admin-only** — the "Add yourself" link shows only under admin override, since first-time creation needs a privileged token that anonymous visitors no longer have; Tom adds new people via admin override (PIN). No separate accounts, no passwords to manage, no email confirmations.

### Teacher Scheduling Tool (restructured July 2026)

- Sept–June calendar grid; summer shaded out; no-meeting Sundays diagonally striped.
- **Teacher view** (2 tabs): **My Availability** (click each Sunday to cycle Available/Tentative/Unavailable/blank) and **Incoming Requests** (accept/decline).
- **Leader view**: **Teacher Availability grid** (rows = teachers, columns = Sundays, green/gold/red/blue booked), **New Request** form (pick teacher, course filtered to their courses, Sundays, message), **My Requests** (track pending/accepted/declined).
- **My Courses** editing → now in the top-level **Courses** tab; **My Profile** → now on the **Teachers** tab. Course browsing → the **Courses** tab catalog, which also supports course-first requests (`requestCourseFromCatalog()`).

Architecture details in memory: `project_scheduling_tool.md`.

### Class Feedback Tool

- Pre-built templates → fill survey title + duration (1, 2, 3, 4, 6, 8, 10, or 12 weeks).
- System returns a public link + a **5-digit code** (e.g. `abfresources.com/12345`) that drops cleanly into a QR code to display in class.
- Public form — no login required to fill out.
- **My Surveys** dashboard shows summary view (aggregated patterns) + individual responses.
- Question types include short text, long text, scale ratings, **multi-select**, and **plus/minus**.

Architecture details in memory: `project_feedback_tab.md`.

---

## Recent changes (August 2026)

**2026-08-05 — Self-registration re-opened behind a registration password.** Since the 2026-08-03 refactor, creating a NEW teacher/leader record required a privileged token, but the "+ Add yourself" buttons were still shown to everyone — anonymous visitors filled the form and got a misleading "check your connection" error (401 underneath). Now: clicking "Add yourself as a teacher"/"as a leader" (or the sign-in picker's register link) with no credential opens a **registration-password prompt** (`#reg-gate-modal`); the password trades for a gate token via the worker's existing `POST /api/gate`, which is what authorizes creates on the Teachers/ABF Leaders tables. The password is set as `passwordHash` (SHA-256) in the Airtable Settings table — **value intentionally not written here** (this repo is public); it's in project memory and Tom knows it. Save failures with 401/403 now show an honest "registration session expired / re-enter the password" toast (and clear the stale gate token) instead of blaming the connection. Signed-in people and admins skip the prompt entirely.

**2026-08-05 — Resources tab renamed "Video Resources"; Online Studies now first/default.** The nav tab formerly labeled "Resources" (tab id stays `courses`, pane stays `tab-courses`) is now **Video Resources**. Canonical URL is **`/videos`**; `/resources` 301s to it (alias in `_redirects`). Sub-section order is now Online Studies → Training Videos → Articles, and **Online Studies is the default view** (the other two are placeholder content as of 2026-08-05) — the `showTab('courses')` wrapper now calls `showLefcuSection('courses')`. Side effect: the course-detail "← Back" button now correctly returns to Online Studies. Home quick-access card updated to match.

**2026-08-05 — Core Beliefs course added to Online Studies.** Third course (id `corebeliefs`) alongside Tutorials and Joshua: 8 Vimeo sessions from the LEFC Resources account (vimeo.com/lefcresources), uploaded Jun–Aug 2026, teaching through the EFCA Statement of Faith articles. Session order = upload order: Intro (1200820650), The Bible (1202831300), God (1204702208), The Human Condition (1206260704), Jesus Christ (1210286814), The Work of Christ (1212729668), The Holy Spirit (1214394312), The Body of Christ (1215292942). Tags: LEFC|U / Summer 2026 / 8 Sessions; olive card gradient; no slides or Spotify links. If more sessions upload later (SoF has 10 articles), add cards to `#course-videos-corebeliefs` and bump the session count in the card + `courses` object. Tip: the public RSS feed `vimeo.com/lefcresources/videos/rss` lists new uploads without needing dashboard access.

**2026-08-05 (later) — Leaders tab renamed "ABFs".** The nav tab formerly labeled "Leaders" is now **ABFs** (internal tab id stays `leaders`, pane stays `tab-leaders` — only labels/URL changed). Canonical URL is now **`/abfs`**; `/leaders` 301s to it (kept as alias in `_redirects`). Page h2 is "ABFs"; a compact facility-map link (`.map-link-sm`, → `facility-map.pdf`) sits under the page header so people can find their room. Leader cards no longer render "(no email)" — the email line is simply omitted when a leader has none (Tom is fine with this tab being effectively view-only).

**2026-08-05 — Real URLs for every tab (History API routing).** Each top-level tab now has a shareable URL: `/` (Home), `/classes`, `/leaders`, `/key-dates` (alias `/dates` 301s to it), `/resources` (tab id `courses`), `/teachers`, `/courses` (tab id `catalog`), `/scheduling`, `/feedback`. Implementation: a routing wrapper around `window.showTab` (see the "URL Routing" section near the end of index.html's script) pushes `history.pushState` on tab clicks, handles `popstate` for back/forward, opens the right tab on deep-link load, and sets per-tab `document.title`. A new **`_redirects`** file at the repo root makes Cloudflare Pages serve index.html for those paths (200 rewrites) and 301s trailing-slash variants; everything else still falls through to 404.html, which keeps handling the `/12345` feedback short codes. The site is still one page — this is routing, not a multi-page split (considered and deliberately rejected 2026-08-05 for maintenance/risk reasons). Sub-view URLs (e.g. `/scheduling/requests`) are a possible future step. Deep links work on both the apex and `www.` — the apex redirect rule was verified fixed later the same day (see Hosting notes above).

**2026-08-03 — API proxy (security refactor).** Prompted by "can we remove the password?": the embedded Airtable PAT was readable by anyone (8 pages + public git history). All Airtable access now proxies through the worker (see Architecture). Code pushed on the **`api-proxy` branch**; deploy sequence + token rotation checklist in `SCHEDULING_TODO_TOM.md` (2026-08-03 section). Two pages existed only in the repo, not this folder — `preaching/index.html` and `cbsetup.html` — both refactored and copied back here. Removing the password gate is now a safe follow-up decision once the worker is deployed and tokens rotated.

## Recent changes (July 2026)

Shipped 2026-07-30 in one batch:

- **Tab restructure (Courses / Scheduling / Teachers)** — see the Site sections list above and the Scheduling Tool section below. New top-level Courses tab (id `catalog`); Scheduling slimmed to send/receive; My Profile now on Teachers tab; "Online Courses" → "Online Studies" under Resources. Course-first requests via `requestCourseFromCatalog()`.
- **ABF Classes cards are text-only** — leader photos and "[ Leader Photo ]" placeholders removed. Each card now opens with a colored `abf-banner` (class name in bold italic; olive/terra/steel/gold/brown rotation). The `Photo` field in the Airtable ABF Classes table and the JS seed data is no longer displayed.
- **Facility map on Home** — `facility-map.pdf` (LEFC Facility Map 2027) at site root, with a thumbnail card (`.map-card`, `photos/facility-map-thumb.jpg`) in Key Announcements linking to the PDF.
- **Facility map annotated (2026-07-30)** — A1/A2 relabeled ABF → MULTI-USE; rooms A3–A6 (pg 1) and D6/D7 (pg 2) now show ABF class assignments by service (`ABF` heading at top of the room, `1st  <Class>` / `2nd  <Class>` in the middle, red room tag at the bottom). The room labels are **baked into a raster image** inside the PDF, so edits are done as vector overlays via PyMuPDF — white-out box over the old label, then redraw. Regenerate `photos/facility-map-thumb.jpg` (900×1165, page 1 render) after any map change.

## Recent changes (April 2026)

Tom shipped a batch of profile/registration changes — see `SCHEDULING_TODO_TOM.md` for the full list. Highlights:

- **Per-person sign-in via last 4 of phone** is live. Site defaults to read-only past the password gate.
- **"Get to know me" tagline** — new 140-char field on every teacher profile.
- **Statement of Faith affirmation** — checkbox: *"I have read and affirm LEFC's Statement of Faith and Matters of Faith and Practice and will teach in alignment with both."* Auto-stamps date.
- **Weeks taught** (replaced "have you taught before?") — buckets: 0, 1–9, 10–24, 25+. Stage auto-derived: 0 / 1–9 → Up & Comer; 10–24 → Active; 25+ → Veteran.
- **Past venues** + **relevant training** are now chip lists with pre-populated common options.
- "In what contexts do you intend to teach?" question removed (legacy data preserved in Airtable).
- Header polish: LEFC|U badge removed (redundant with logotype); identity button is now "Teacher & Leader Sign In" CTA.

---

## Walkthrough videos

### Vimeo (embedded on the site)

Two Vimeo videos walk through the scheduling tool. They're embedded in two places: the Home tab "Key Announcements" section (side-by-side, leaders left / teachers right) and the Resources → Online Studies → "Tutorials" detail page. **Note:** both videos predate the July 2026 restructure (they show My Courses / My Profile / Available Courses inside the Scheduling tab) — re-record when convenient.

- ABF Leaders walkthrough: Vimeo `1188153596`
- ABF Teachers walkthrough: Vimeo `1188153632`
- Embed: `https://player.vimeo.com/video/{ID}?title=0&byline=0&portrait=0`

### NotebookLM (separate, generated April 30, 2026)

Three NotebookLM Video Overviews exist as additional walkthrough material. Source packs and notebook URLs in `walkthroughs/INDEX.md`. The leader/teacher pair are the canonical ones; the combined video was the original prototype before splitting by audience.

---

## File map

```
ABF Resources/
├── CLAUDE.md                              ← this file
├── index.html                             ← the live site
├── 404.html
├── TODO_TOMORROW.md                       ← consolidated next-actions doc — READ THIS FIRST when picking back up
├── SCHEDULING_TOOL_AIRTABLE_SETUP.md      ← Airtable schema setup guide
├── SCHEDULING_TODO_TOM.md                 ← admin to-do list (only Tom can do these)
├── FEEDBACK_TODO_TOM.md                   ← feedback report system to-do list (Tom + Claude items, post-design-spec)
├── feedback/                              ← Feedback tab build notes (May 2026)
│   ├── README.md                          ← survey-layer architecture, decisions, outstanding work
│   ├── REPORT_DESIGN.md                   ← full design spec for Phase 2 AI-synthesized reports
│   ├── AUTOMATIONS_TOM.md                 ← (superseded by worker/) SendGrid via Airtable Automations — kept for reference
│   ├── EMAIL_AUTOMATIONS_HANDOFF.md       ← (superseded by worker/) handoff doc from the Airtable Automations attempt
│   ├── templates_export.json              ← canonical Q-JSON for all 3 active templates
│   ├── seed_templates.py                  ← idempotent re-seed script
│   ├── mockup_class_standard_report.html  ← Phase 2 visual mockup (Standard, sample data)
│   └── mockup_series_baileys_rich_towards_god.html  ← Phase 2 visual mockup (Series, real data)
├── worker/                                ← Cloudflare Worker — sends transactional emails via SendGrid
│   ├── README.md                          ← deployment guide
│   ├── wrangler.toml                      ← Cloudflare config (cron schedule, env vars)
│   └── src/index.js                       ← worker code (3 email handlers, ~280 lines)
├── walkthroughs/
│   ├── INDEX.md                           ← NotebookLM video index
│   ├── walkthrough_leaders.md             ← source pack for leader video
│   ├── walkthrough_teachers.md            ← source pack for teacher video
│   └── walkthrough_combined.md            ← original combined source pack
├── ABF Class Rosters.xlsx
├── Joshua Week N - *.pdf                  ← slide files for Joshua online course
├── facility-map.pdf                       ← LEFC Facility Map 2027 (linked from Home)
├── photos/                                ← leader photos (no longer shown on class cards) + facility-map-thumb.jpg
└── *.jpg                                  ← additional leader photos at root (unused on site)
```

---

## Operating notes for Claude

- **The user's name is Tom.** Email: `daly@lefc.net`. He's the human backstop for everything ABF.
- **Push changes via Git.** The site deploys from the GitHub repo (see memory). Don't expect Netlify-style auto-deploys outside that workflow.
- **Don't auto-create new top-level docs at the root.** Use existing docs (`SCHEDULING_TODO_TOM.md`, `SCHEDULING_TOOL_AIRTABLE_SETUP.md`, this file) and the `walkthroughs/` subfolder. Add new docs to subfolders unless asked.
- **Skills to use proactively for this project**: `lefc-branding` (any visual material), `lefc-sof` (any teaching/doctrinal content), `lefc-rock` (Rock RMS context if it ever comes up).
- **For walkthrough/training content, default to the leader/teacher split** — confirm audience up front and produce two versions.
- **Reference, don't duplicate.** If something's already in `SCHEDULING_TODO_TOM.md` or `SCHEDULING_TOOL_AIRTABLE_SETUP.md`, link/refer rather than copying.
