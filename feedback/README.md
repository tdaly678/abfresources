# Feedback Tab — Build Notes (May 2026)

Reference doc for the Feedback feature on abfresources.com. Captures what was built, why, and what's left. Future Claude sessions: read this before touching the Feedback tab — it explains decisions that aren't obvious from the code.

---

## What this is

The Feedback tab is a self-service survey system for ABF teachers and leaders, branded under **LEFC|U** (the new adult-ministry brand). Teachers create surveys from templates, share via short link or QR, respondents fill on phones, and teachers see aggregated results. Backed by Airtable.

Live at: `abfresources.com` (Feedback tab) and `abfresources.com/<5-digit code>` (public survey URLs).

---

## Three active templates

| Template | Length | Use case | Airtable ID |
|---|---|---|---|
| **Class Feedback (Standard)** | 10 Qs · ~2 min | Default for a single class or short series. Walk-through-a-passage style. | `rechhUfDL9s313g5V` |
| **Topical Class Feedback** | 11 Qs · ~2 min | Topical classes built on biblical principles rather than expositing a passage. Asks whether the principles came through clearly *and* whether they were grounded in Scripture vs. opinion. | `recUd0Oz8VjwZqOj8` |
| **Series Feedback (End-of-Series)** | 17 Qs · ~5 min | Multi-week wrap-up. Includes attendance, growth-in-understanding rating (1–10), component dials, three takeaway slots, goal-achievement reflection, qualitative highlights. | `recsgDN8lDevXp557` |

The legacy **"ABF Teaching Feedback"** template (8 generic Qs, predates this work) is **archived** (Active=false) but recoverable via the Airtable UI.

All three end with the same optional open box, `q_anything_else` (long_text, not required): "Anything else you'd like your teacher to know?" Added 2026-11-24 after `q_overall`. Forms read questions from the live template, so open forms pick it up too; older responses simply lack the key. Write-ins like this reach the end-of-survey AI report with no worker change, since `buildReportData` passes every non-empty answer through to the model.

Canonical question structures live in `templates_export.json` in this folder. To restore Airtable to that state any time: `python3 feedback/seed_templates.py` (idempotent). Run `--dry-run` first: it prints live vs export question ids and writes nothing. With no `AIRTABLE_TOKEN` in the environment it prompts for the admin PIN and PATCHes each template by `airtable_id` through the worker's `/api/proxy`, so no Airtable token is needed on the Mac.

---

## Question types supported by the public form

The renderer is `pfRenderQuestion` in `index.html`. To add a new template that uses an existing type, no code change is needed — just write the JSON. Adding a *new type* requires extending the renderer, the answer-collection logic, the responses dashboard renderer, *and* the print-PDF renderer.

| Type | What it is | Stored as |
|---|---|---|
| `rating` | N-point Likert with `min`, `max`, `minLabel`, `maxLabel`. Rendered as a row of numbered buttons with anchors above showing "1 = X" / "N = Y" in gold chips. Both 1–5 and 1–10 are in use. | string of the number |
| `single_choice` (or `choice`) | Radio buttons with `options[]`. | string of the chosen option |
| `multi_select` | Pill-shaped checkboxes with `options[]`. | array of chosen options |
| `plus_minus` | Three-button less / about right / more for each item in `components[]`. The signature feature for component-calibration feedback. | object `{component: '-' \| '=' \| '+'}` |
| `text` (default) | Short answer. | string |
| `long_text` (or `textarea`) | Multi-line answer. | string |
| `date` | HTML date input. | ISO date string |

---

## Public form invariants

- Built-in respondent **Name** AND **Email** are both required. (Tom's call — overrides the research recommendation toward anonymity.)
- Email is shape-validated client-side.
- Auto-share QR banner appears at the top of every survey (`?f=slug` page) — teachers can pull up the survey on a laptop and screenshot/right-click the QR for slides/texts.
- Rating questions show "1 = X" / "N = Y" anchors *above* the buttons with the scale number rendered as a gold chip pinned to its end, so meaning is clear before clicking.

---

## Browse Templates feature

Subnav button **Browse Templates** (visible to *everyone*, signed in or not). Lists every active template with name, description, question count, estimated time, and a chip summary of question types. **Preview button** opens a fullscreen rendered preview using the same `#public-feedback` overlay real respondents see — same styling, name/email/Submit disabled. Esc or "Close preview" returns to the portal. **Download printable PDF button** opens a print-formatted single-page LEFC|U-branded PDF.

---

## Responses dashboard

`openFbResponsesModal` has two views:

- **Summary** (default): per-question aggregates. Rating means + distribution bars, choice counts, multi-select chip ranking with %, plus_minus rendered as stacked bars (terra=less, cream=same, olive=more), text answers as bullet lists.
- **Individual responses**: per-respondent cards.

Toolbar: Summary toggle · Individual toggle · **Export CSV** · **Copy report bundle**. The bundle copies a structured JSON of form metadata, template, and all responses to clipboard for paste-into-Claude AI synthesis (the MVP for the Phase 2 AI report ambition).

---

## Printable PDFs

Every template card and every open/my-survey card has a "Download printable PDF" button. Opens a new tab with print-formatted HTML and auto-fires `window.print()` → "Save as PDF" is one click in modern browsers.

- Single-page layout, US Letter, 0.4" margins
- LEFC|U branded: terra-cotta accent (#AA3B24), gold rule, dark-brown headlines
- Auto-2-column for templates with > 11 questions (Series template fits cleanly)
- Paper-fillable rendering per question type (circles for ratings, boxes for choices, lined fields for text, plus/minus matrix table)
- Survey-specific PDFs include the form's unique 5-digit code + QR pointing to the digital fill-out URL — groundwork for the future scan-and-link workflow
- Template-only PDFs leave the code area blank for the teacher to write in
- **Large print (2 pages)** — a second button next to each "Download printable PDF" (template cards, open/my-survey cards, and the template preview banner). Added Oct 2026 after Agape feedback that the compact sheet was hard to read. `openFbPrintView({ …, largePrint: true })` appends `fbLargePrintCss()` overrides: ~12.5pt body / 12pt labels, line-height ~1.45, 0.6" margins, bigger rating circles and checkboxes, taller write-in lines, never two-column. Class Standard (10 Q) and Topical (11 Q) land on 2 pages; Series (17 Q) runs to 3. Re-measured 2026-11-24 after adding `q_anything_else` (headless Chromium, Letter): the compact sheet is still 1 page for all three. The compact one-page sheet stays the default.

---

## Brand: LEFC|U

Adult ministry at LEFC is now branded **LEFC|U** (LEFC University), not "LEFC Adults." This applies to anything we build for ABF or adult ministry going forward. Format: literal characters `LEFC|U` (no spaces around the pipe). Terra-cotta `#AA3B24` is the current accent until told otherwise.

---

## What was deliberately cut from the templates

Pulpit-evaluation rubrics (Chapell, Robinson, WTS, TEDS) include 25–40 items. We deliberately excluded:

- **Voice / gestures / posture / pulpit presence** — pulpit-centric, not classroom-relevant
- **Christ-centeredness / gospel connection** as a student-facing question — students often can't evaluate it well, and asking risks turning the form into a doctrinal audit. Better surfaced via elder/peer review.
- **Demographics** — adds friction, harms anonymity
- **Use of original languages, biblical theology, cross-references** — too technical for student feedback; teacher self-reflection territory
- **Prayer / opening / announcements / logistics** — not the teacher's content; surveying these confuses the instrument

These should be gathered through other channels (peer review, teacher self-reflection, annual program-level survey), not bolted onto the per-class form.

---

## Outstanding work (deferred from this session)

1. **Airtable Automations** for the lifecycle:
   - (a) **email teacher when a new response lands** — full setup spec in `AUTOMATIONS_TOM.md` in this folder. Uses SendGrid via Airtable's Run-script action; same pattern as the scheduling automations in `SCHEDULING_TODO_TOM.md`.
   - (b) auto-flag forms past `closesAt` as Closed in the UI — not yet specced; daily-scheduled "Update Record" automation when ready.
2. **Stated Goals field on Feedback Forms** (Airtable schema change) — would let respondents directly rate goal achievement instead of a freeform question. Worthwhile if/when the Series template gets used regularly.
3. **Phase 2: AI-synthesized reports** — full design spec is now in **`REPORT_DESIGN.md`** in this folder, with companion mockups (`mockup_class_standard_report.html`, `mockup_series_baileys_rich_towards_god.html`). Spec covers: five-dimension radial + interpretive key (Balanced / Heady Egg / Pep Talk / Lecture Mode), per-template section layout, AI prompt rules (no fabricated context, 70/30 candid-coaching tone), Cloudflare Pages Function + Airtable Automation architecture for on-demand button + auto-close + email. Implementation roadmap is in 4 phases (Phase 1 = on-demand button MVP). Read `REPORT_DESIGN.md` before building.
4. **Scan-and-match for paper responses** — every survey-specific printable PDF includes the unique 5-digit code + QR. Manual transcription works today (volunteer types responses into `abfresources.com/<code>`). Future: vision-based intake (Claude vision or OCR service) reads scanned PDFs and populates digital responses. Same infra decision as #3.

---

## File map

```
feedback/
├── README.md                                        — this file
├── REPORT_DESIGN.md                                 — full design spec for Phase 2 AI-synthesized reports
├── templates_export.json                            — canonical question JSON for all 3 active templates
├── seed_templates.py                                — idempotent re-seed script (reads templates_export.json)
├── mockup_class_standard_report.html                — Phase 2 visual mockup (Standard template, sample data)
└── mockup_series_baileys_rich_towards_god.html      — Phase 2 visual mockup (Series template, real Baileys data)
```

The actual implementation (renderer, dashboard, print view, etc.) lives in the single-file `index.html` at the project root.

---

## Key commits (this build, May 2026)

- `c67185c` — Feedback tab: new question types, aggregate dashboard, QR code, name+email required
- `63ecf52` — Stronger field affordances (defined `--cream` tokens, sturdy borders, focus rings)
- `3301bfb` — Rating questions: explicit `1 = X` / `N = Y` anchors with gold chips
- `270af64` — Auto-render QR + share banner at top of every survey
- `851493a` — Browse Templates with full survey previews
- `bb73d5d` — Defined `--cream` CSS tokens; preview banner full-width opaque
- `1d26508` — `Download printable PDF` for templates + open surveys
- `03201fc` — Rebrand: LEFC Adults → LEFC|U
- `34aa9b3` — Resources tab rename + subnav reorder + header subtitle update
- `703b01d` — Header: "LEFC ABF Resources" → "LEFC|U ABF Resources"
