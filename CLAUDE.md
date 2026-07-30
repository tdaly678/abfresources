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

1. **ABF Classes** — directory of current classes by service (1st: Philippians, Faith Builders, Koinonia, Branches, Roots; 2nd: Agape, Mosaic, Synago).
2. **Key Dates** — no-meeting Sundays, summer break, Easter, ABF resume dates.
3. **Resources** — Training Videos (For New Leaders / For Existing Leaders / For New Teachers), Articles, Online Studies (renamed from "Online Courses" July 2026; Joshua WBF Spring 2026, plus Tutorials). *Default subsection on load: Training Videos.*
4. **Teachers** — roster organized by stage (Veterans, Active, Up & Comers Years 2–3, Up & Comers Year 1). Also hosts **My Profile** (inline form, shown when signed in as a teacher; moved here from Scheduling July 2026).
5. **Courses** (tab id `catalog`) — top-level shared course catalog (added July 2026). Flat list with sort / teacher / weeks / topic-tag filters. Signed-in teachers see Edit/Remove on their own courses plus the add/edit form below the catalog ("Manage Your Courses"). Signed-in leaders see a **"Request this course"** button on each card that jumps to Scheduling → New Request with teacher + course pre-filled.
6. **Scheduling** (renamed from "Teacher Scheduling") — now purely send/receive: teachers get My Availability + Incoming Requests; leaders get Teacher Availability grid, New Request, My Requests. My Courses / My Profile / Available Courses moved out (see above).
7. **Feedback** — class feedback surveys with three templates (Class Standard, Topical, End-of-Series), public form (`?f=slug`), aggregate dashboard, printable PDFs. Architecture lives in `feedback/README.md`.
8. **Contact** — Tom Daly, daly@lefc.net.

---

## Architecture

- **Frontend**: static HTML at the root of this folder (`index.html`, `404.html`). Hosted via the GitHub-pages-style setup; push to the GitHub repo to deploy. Repo and token details: see memory `reference_github.md`.
- **Backend (scheduling + feedback)**: Airtable. Schema is documented in `SCHEDULING_TOOL_AIRTABLE_SETUP.md`.
- **Auth**: Password gate on the front page (one shared leader/teacher password Tom shares directly). Past the gate, the site **defaults to read-only**. To edit profile / availability / courses, or to send/respond to teaching requests, the user signs in as a specific person using **the last 4 digits of the phone number** stored in Airtable (Teachers table or ABF Leaders table). No separate accounts, no passwords to manage, no email confirmations.

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

## Recent changes (July 2026)

Shipped 2026-07-30 in one batch:

- **Tab restructure (Courses / Scheduling / Teachers)** — see the Site sections list above and the Scheduling Tool section below. New top-level Courses tab (id `catalog`); Scheduling slimmed to send/receive; My Profile now on Teachers tab; "Online Courses" → "Online Studies" under Resources. Course-first requests via `requestCourseFromCatalog()`.
- **ABF Classes cards are text-only** — leader photos and "[ Leader Photo ]" placeholders removed. Each card now opens with a colored `abf-banner` (class name in bold italic; olive/terra/steel/gold/brown rotation). The `Photo` field in the Airtable ABF Classes table and the JS seed data is no longer displayed.
- **Facility map on Home** — `facility-map.pdf` (LEFC Facility Map 2027) at site root, with a thumbnail card (`.map-card`, `photos/facility-map-thumb.jpg`) in Key Announcements linking to the PDF.

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
