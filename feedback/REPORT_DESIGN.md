# Teacher Feedback Report System — Design Spec

> **Version 1** · May 5, 2026 · LEFC|U / ABF Resources
> Companion to `templates_export.json`, `README.md`, and the `mockup_*.html` files in this folder.
> This doc is the blueprint for going from mockup → live AI-generated reports surfaced to teachers and emailed when surveys close. Every implementation decision belongs here.

> **Update 2026-11-23: email-on-close is built.** It lives in the existing email worker (`abf-email-worker`, flow G in `worker/src/index.js`), not in a separate Pages Function or second worker, and not in an Airtable Automation. Model `claude-sonnet-5-5`; sender `noreply@abfresources.com` via Brevo, to the form's teachers plus the class's ABF leaders (deduped, added 2026-11-24), BCC admin. The cron checks hourly for closed surveys; surveys that closed before 2026-11-23 5 PM ET never auto-send. The email is a simplified, email-safe version of this design: a worker-computed score table plus an AI narrative (at a glance, what landed, what stuck, how to grow, anonymous quotes). No radial chart or SVG in email. Respondents are anonymous in the report, which overrides the "specific names" example under Rule 6. Operational details: `worker/README.md`. Still not built: the mid-survey "Generate preliminary report" button, the public `/r/<id>` URL, and the Report Generations log table (token usage goes to worker logs instead).

---

## What this is

The Feedback tab on abfresources.com lets teachers create surveys from three templates (Class Standard, Topical, Series), share via QR or short link, and review responses. This document specifies the **report layer that sits on top of those responses** — a per-survey, AI-generated report that integrates quantitative scores, qualitative comment themes, and a coaching synthesis into one consistent grid.

Three deliverables flow from this spec:

- **One mockup per template** — `mockup_class_standard_report.html`, `mockup_topical_report.html` (TBD), `mockup_series_*.html`. Each populated with realistic or real data, used as the visual standard.
- **One Cloudflare Pages Function** that, given a form ID, pulls responses from Airtable, calls Claude, and returns HTML.
- **Two trigger paths** — on-demand button mid-survey, automatic on close + email to teacher.

---

## Design philosophy

**Honest by construction.** Every claim in the report is traceable to actual data in this survey. No invented comparisons ("one of the strongest scores across ABFs"), no fabricated benchmarks ("rare in series feedback"), no theory-laden generalizations ("the harder half of stewardship teaching"). If you can't point to the source, don't write it. This rule is the single biggest driver of the AI prompt template — see Rule 1 below.

**Quant + qual integrated, not separated.** Numbers and student comments answer to each other on the page. Each qualitative theme card carries a small "quant chip" linking it to the numeric dimension it explains, supports, or matches. The radial shape is interpreted in light of the comment themes. The at-a-glance pills cite specific scores *and* specific quotes.

**Coaching, not summary.** The report is a development tool. Same grid every time so teachers learn to read it. Direct candid language about what to change next time, not just what happened.

**One grid, three templates.** The Standard, Topical, and Series reports share the visual language. They differ only in which sections appear (per the template's question set), not in how shared sections look.

---

## The five dimensions

The radial chart has five spokes, surfaced consistently across all three templates.

| Dimension | Standard | Topical | Series |
|---|---|---|---|
| **Scripture Fidelity** | Q `text_anchor` (1–5) | Q `grounded_scripture` (1–5) | Q `text_anchor` (1–5) |
| **Main Idea Clarity** | Q `main_idea` (1–5) | Q `principles_clear` (1–5) | Q `main_idea` (1–5) |
| **Application** | Q `application` (1–5) | Q `application` (1–5) | Q `application` (1–5) |
| **Classroom Interaction** | Q `interaction` (1–5) | Q `interaction` (1–5) | Q `interaction` (1–5) |
| **Accessibility** | Q `pitched` (1–5) | Q `pitched` (1–5) | **Blend**: avg of Q `pitched` (1–5) and Q `understanding_deepened` (1–10, scaled to 1–5 by /2) |

For the Series template, **Accessibility is a blended score** — in-class clarity (Q5 `pitched`) averaged with growth-over-the-arc (Q2 `understanding_deepened`, scaled). It represents "did students cognitively access the teaching, AND did their understanding actually deepen across the series." This was a deliberate choice to fold the multi-week growth signal into the radial rather than show it as a separate gauge — keeps the radial as the single profile view.

The center gauge inside the radial is **Overall Score** — the mean of Q `overall` (Spiritual Nourishment), shown numerically inside a 22px circle.

---

## Spoke layout (the compass)

Spokes arranged clockwise from 12 o'clock. **Top half = content + clarity. Bottom half = engagement + life-bridge.** This ordering is meaningful: shape distortions diagnose teaching patterns at a glance.

| Position | Dimension | Half |
|---|---|---|
| 12 (top) | Scripture Fidelity | Top — anchoring |
| 2 (top-right) | Main Idea Clarity | Top — structure |
| 5 (bottom-right) | Application | Bottom — life-bridge |
| 7 (bottom-left) | Classroom Interaction | Bottom — engagement |
| 10 (top-left) | Accessibility | Top — learner-bridge |

The reading list to the right of the radial walks around the chart in the same clockwise order. No clock-position numbers in the labels — the order alone does the work.

---

## The interpretive key (4 shapes)

Every report shows four reference shapes alongside the user's actual radial. The closest match is highlighted with a "YOUR SHAPE" badge.

| Shape | Pattern | Diagnostic copy |
|---|---|---|
| **Balanced** | Roughly regular pentagon, all spokes ≥ ~4 | "Roughly regular pentagon at high scores. Content and engagement both serving each other." |
| **The Heady Egg** | Top spokes high (Scripture, Main Idea), bottom spokes low (Application, Interaction) | "Top-heavy. Strong text handling, weak life-bridge. Risks staying in your head." |
| **The Pep Talk** | Bottom spokes high, top spokes low | "Bottom-heavy. Engaging and applicable but drifting from the text." |
| **Lecture Mode** | Most spokes high but Interaction pinched | "Pinched at Interaction. Clear and accessible, but the format doesn't make space for the room to speak." |

### Match algorithm (heuristic)

A simple rule-based heuristic for v1, replaceable later:

```
top_avg    = avg(Scripture, Main Idea, Accessibility)
bottom_avg = avg(Application, Interaction)

if Interaction is more than 0.6 below avg(other 4 spokes):
    → Lecture Mode
elif top_avg − bottom_avg > 0.7:
    → Heady Egg
elif bottom_avg − top_avg > 0.7:
    → Pep Talk
else:
    → Balanced
```

Tied or near-tied profiles default to Balanced when all spokes ≥ 4.0. The match is shown in the report; the user's actual radial is ALSO drawn as the primary visual — the key shapes are reference, not a substitute.

---

## Report sections by template

| Section | Standard | Topical | Series |
|---|---|---|---|
| Header (teacher · class · date · N) | ✓ | ✓ | ✓ |
| At-a-glance band (Overall + Top strength + Top growth area) | ✓ | ✓ | ✓ |
| Five Dimensions radial + readings | ✓ | ✓ | ✓ |
| Interpretive Key (4 shapes, match highlighted) | ✓ | ✓ | ✓ |
| Pace Dial (single-choice 5-bucket) | ✓ | ✓ | ✗ (subsumed by component dials) |
| Component Calibration (plus_minus dials) | 5 components | ✗ (template has no plus_minus) | 8 components |
| What Stuck (takeaway themes, AI-clustered, alignment %, max 3 cards) | ✓ | ✓ (single-takeaway data) | ✓ |
| Goals Achieved synthesis | ✗ | ✗ | ✓ |
| Highlights synthesis | ✗ | ✗ | ✓ |
| How To Grow (improvement themes, AI-clustered, max 3 cards) | ✓ | ✓ | ✓ |
| What Landed (encouragement themes, AI-clustered, max 3 cards) | ✓ | ✓ | ✓ |
| Footer (raw responses + CSV export links) | ✓ | ✓ | ✓ |

**Removed from the original spec:** Coaching Synthesis section (was a single 2-paragraph AI synthesis at the end of the report). Quantitative + qualitative insights are now integrated throughout the sections above; a separate synthesis read as redundant.

**3-card max rule:** What Stuck / How To Grow / What Landed display *up to* 3 theme cards each. If more than 3 themes emerge from clustering, show top 3 by mention count. Anything below the cut should appear as a one-line "also mentioned: X, Y, Z" footer below the cards (TBD — not yet in mockup).

---

## Visual design standards

### Brand: LEFC|U

LEFC|U is the adult-ministry sub-brand. Every report carries LEFC|U branding in the header (`LEFC|U · ABF Teacher Report`) and footer (`Lancaster Evangelical Free Church · LEFC|U · ABF Resources`).

### Color tokens

Identical to `index.html`'s `:root` block. Reports re-declare these so they render correctly when displayed standalone (e.g., emailed inline).

| Token | Hex | Use |
|---|---|---|
| `--dark-brown` | `#342D25` | Headlines, body text, header background |
| `--gold` | `#BCA944` | Accent rule under header, target ring at score 4 on radial |
| `--olive` | `#524B30` | Score polygon stroke/fill, "more" segments, positive-signal chips |
| `--terra` | `#AA3B24` | Warning signals, "less" segments, growth-area chips, AI-tag dot |
| `--cream` | `#f7eed7` | Soft backgrounds, "about right" segments, narrative blocks |
| `--cream-border` | `#ddcca5` | Section dividers, card borders |
| `--steel-blue` | `#3F5765` | Quant chips on theme cards, AI synthesis blocks (Goals/Highlights) |

### Typography

- Body: Montserrat, 16px base
- Section headers (`<h2>`): 1.05rem, 800-weight, letter-spacing .02em, uppercase, with terra `<span>·</span>` separator
- Score values: 800-weight with `font-feature-settings: 'tnum'` (tabular numerals so digits align)

### Quant chip vocabulary

Small chips on theme cards that link a qualitative theme to a numeric dimension. Use one of these labels:

| Chip | Meaning | Color treatment |
|---|---|---|
| **MATCHES** | The theme directly matches the dimension's main concept (e.g., dominant takeaway matches Main Idea Clarity) | olive |
| **SUPPORTS** | The theme reinforces/explains a positive dimension score | olive |
| **EXPLAINS** | The theme accounts for *why* a dimension scored low (improvement themes that explain a low Interaction score) | terra (warn variant) |
| **ADJACENT** | Theme is related to a dimension but isn't the primary signal | steel-blue |
| **PERIPHERAL** | Side theme, low convergence (rare; prefer omitting the card) | steel-blue |
| **UNIQUE** | Theme is a distinct strength/format point not measured by the radial dimensions (e.g., teaching-team dynamic) | olive |

### Section visual hierarchy

Two AI synthesis sections (Goals Achieved, Highlights — Series only) use a steel-blue left border and steel-blue accent dot to distinguish them from theme cards (which use olive/terra/gold borders per section type). This prevents the eye from blurring multiple "AI sections" together.

---

## AI prompt rules

These are the rules the prompt template embeds explicitly. Non-negotiable.

### Rule 1 — No fabricated context

Never invent comparative or generalizing context that isn't grounded in observed-here data. Specifically prohibited phrasings:

- "One of the strongest X across all reports"
- "Rare in [domain]" / "unusual signal in [genre]"
- "Most respondents in this kind of survey"
- "The harder half of [topic]" / "the easy part of [topic]"
- "X is what good teachers do"
- "Adult classes often lack..."

Always allowed:

- Observations about the actual scores: "Application scored 4.93, the highest dimension on the chart"
- Observations about the actual respondents: "13 of 14 respondents gave a 5"
- Observations about distinctness *within this survey*: "None of the other 13 respondents wrote about anticipation between sessions"
- Direct quotes from respondents
- Summaries of clustered themes from the comments
- Diagnostic readings of the shape (per the interpretive key)

### Rule 2 — Tone

70% candid coaching · 30% analytical. Direct. Names patterns. Ends with concrete next-time suggestions where applicable. Pastoral but not soft.

**Never expose the tone ratio in the rendered text.** No "Tone: 70/30" or any analogous metadata in the visible HTML.

### Rule 3 — Brevity

| Element | Max |
|---|---|
| Top strength + Top growth area pills | 2 sentences each |
| Goals Achieved synthesis | 2 paragraphs + bullet quote list |
| Highlights synthesis | 2 paragraphs + bullet quote list |
| Theme cards | 3 per section |
| Theme card quotes | 1 quote per card (representative; combine with `·` if pulling 2 closely-related quotes) |

### Rule 4 — AI-generated provenance

Every AI section includes a small "AI-generated" indicator (terra dot + uppercase tag) so the user can always tell which sections are AI synthesis and which are direct numeric or quoted output.

### Rule 5 — Doctrinal alignment

Reports are written in alignment with LEFC's Statement of Faith and the EFCA SOF. AI synthesis avoids language that could be doctrinally ambiguous or contrary. (See `lefc-sof` skill if generating teaching-related content.)

### Rule 6 — Specific over general

Specific names + specific quotes beats abstract summaries.

> "Three improvement comments converge on the handouts — Bates wants bigger print, Dan F doesn't want printed slideshows, Heather wants fill-in sheets"

beats

> "Several respondents wanted handout improvements"

### Rule 7 — Soft language on diagnostics

When naming a teaching pattern, frame it as the *teaching pattern*, not the teacher's character. The Lecture Mode shape says "the format doesn't make space for the room to speak" — not "the room never speaks." Diagnostics describe *what the teaching did*, not *who the teacher is*.

---

## On-demand generation architecture

### Trigger paths

**1. Auto-generate on survey close (primary path).**

- Airtable Automation fires when a Form's `closesAt` passes (or when its `status` flips to Closed)
- Calls a Cloudflare Pages Function with the form ID
- Function pulls metadata + responses, calls Claude, gets HTML
- Function writes HTML to Airtable's Forms table (new field: `aiReportHtml`) and to a permanent public URL `abfresources.com/r/<reportId>`
- Function emails the teacher (looked up via Form's `teacherId`) with the report inline + the URL link

**2. On-demand mid-survey button (secondary path).**

- Teacher clicks "Generate preliminary report" on their My Surveys card
- Frontend POSTs to the same Function with `mode=preliminary`
- Function pulls current responses, calls Claude
- Function returns HTML inline (does NOT persist; preliminary only)
- Frontend renders HTML in a modal
- Banner on the preliminary report: *"Preliminary report — based on N responses received so far. Final report will be generated when the survey closes on [date]."*

### Architecture

```
[Survey closes / Button click]
       │
       ▼
[Cloudflare Pages Function: /api/generate-report]
       │
       ├── Pull form metadata + template + responses from Airtable
       │   (uses Airtable PAT in Function env var)
       │
       ├── Compose Claude API request
       │   - System prompt: design rules from this doc (Rules 1–7)
       │   - User prompt: structured JSON of metadata + responses
       │   - Output: complete HTML matching the mockup template
       │
       ├── Receive HTML; validate basic structure
       │   - <svg> for radial present
       │   - All five dimension scores populated
       │   - Required sections present per template
       │   - File size < 200KB; no <script> tags
       │
       ├── On auto-close: write to Airtable + send email
       │   On preliminary: return inline to caller
       │
       └── Log to a "Report Generations" Airtable table
           (form, mode, timestamp, status, model, token usage)
```

### Input data shape (frontend → Function → Claude)

```json
{
  "template": {
    "name": "Series Feedback (End-of-Series)",
    "questions": [/* full template Q-JSON */]
  },
  "form": {
    "title": "Rich Towards God",
    "teacher": "The Baileys",
    "class": "Mosaic" /* or whichever ABF */,
    "dateRange": "2026-04-12 to 2026-05-03",
    "n_total": 14,
    "n_responded": 14
  },
  "responses": [
    {
      "respondentName": "Ben Spead",
      "answers": {
        "q_main_idea": 4,
        "q_text_anchor": 4,
        "q_pitched": 4,
        "q_application": 5,
        "q_components": { "Bible exposition": "=", "Group discussion": "=", /* ... */ },
        "q_takeaway_1": "Focus on God's Priorities for Treasure",
        /* ... */
      }
    }
    /* ... */
  ]
}
```

### Output (Claude → Function → caller / email)

A complete HTML document matching the mockup template structure. The Function validates the response then forwards or persists.

### Claude API call details

- **Model**: `claude-sonnet-5-5` (as built 2026-11-23; the 4.6 names in the original draft are retired)
- **Max output tokens**: 8000, `output_config.effort: "medium"`
- **Temperature**: not sent. Sonnet 5.5 rejects sampling params, thinking budgets and prefill
- **System prompt**: embeds Rules 1–7 from this document (see Appendix A)
- **User prompt**: the JSON above

### Email delivery

- Triggered only on auto-close path
- **Sender**: `daly@lefc.net` or a no-reply LEFC|U address (TBD)
- **Recipient**: teacher email from Airtable Teachers table. *(Built version, 2026-11-24: every Teacher linked on the form plus every active ABF Leader of the form's class, deduped by email, all on To, admin BCC. See `worker/README.md`.)*
- **Subject**: `[LEFC|U] Your feedback report for [Form Title]`
- **Body**: HTML report inline + link to the public URL for browser viewing
- **Service**: Cloudflare Email Routing or SendGrid (TBD — pick whichever is cheapest with reasonable deliverability)

### Cost estimate

- Average response set: ~14 responses × ~16 questions = ~224 datapoints + comments
- Average input tokens: ~3000
- Average output tokens: ~3500 (full HTML)
- Per-report cost (Sonnet 4.6): ~$0.03
- Throughput estimate: 8 ABFs × ~6 surveys/year ≈ 48 reports/year ≈ **~$1.50/year total**. Negligible.

### Implementation phases

| Phase | Deliverable | Status |
|---|---|---|
| **1** | Cloudflare Function with prompt template; "Generate preliminary report" button on My Surveys; renders in modal; no persistence | not started (a dry-run preview exists as the admin-only `POST /run/report?dry=1`) |
| **2** | Generate on close; persist HTML to Forms table; public URL `abfresources.com/r/<reportId>` | done 2026-11-23 in `abf-email-worker` (hourly cron, HTML saved to `aiReportHtml`), except the public `/r/<id>` URL, which is not built |
| **3** | Email delivery; teacher receives report when survey closes | done 2026-11-23: Brevo from `noreply@abfresources.com`, BCC admin |
| **4** | Reports archive table; per-teacher trend view (annual review) | not started |

Phase 1 is the MVP. Phases 2–3 are the auto-close-and-email flow Tom wants. Phase 4 unlocks the longitudinal teacher-development view.

---

## Open questions / future work

- **Per-teacher trend view** (annual rollup of all reports for one teacher into a year-end review). Requires a "year" definition — September–June ABF year, not calendar.
- **Cohort comparison** overlay on the radial. Only viable once we have ~20+ reports across teachers. Should be a Tom-only toggle by default; teachers don't need to see how they compare to peers.
- **Topical mockup** — not yet built. Format follows Standard minus the plus_minus components section. ETA: next session.
- **Match-algorithm refinement** — start with the heuristic in this doc, evaluate against actual reports, refine later if shapes mis-match.
- **"Also mentioned" footer** for the 3-card max rule (themes that didn't make the cut surfaced as a one-line list).
- **AI prompt template** in Appendix A is a draft — needs round-trip testing against actual data before going live.

---

## Appendix A — Draft system prompt for Claude API

```
You are generating a teacher feedback report for Lancaster Evangelical Free Church
(LEFC) ABF teachers. The report follows a specific design specification documented
in feedback/REPORT_DESIGN.md.

CRITICAL RULES:

1. NO FABRICATED CONTEXT. Every claim must be traceable to the data provided.
   Do NOT write:
     - "one of the strongest X across all reports" — no comparison data exists
     - "rare in [domain]" or "unusual in [genre]" — no reference distribution
     - "most respondents in this kind of survey" — only this survey
     - "the harder half of [topic]" — generalization about teaching theory
     - "X is what good teachers do" — presumes a teaching theory
   DO write:
     - Observations about the actual scores ("Application scored 4.93")
     - Observations about the actual respondents ("13 of 14 gave a 5")
     - Observations about distinctness within THIS survey ("none of the other
       respondents wrote about anticipation between sessions")
     - Direct quotes from respondents
     - Summaries of clustered themes from the comments

2. TONE: 70% candid coaching, 30% analytical. Direct. Names patterns. Ends with
   concrete next-time suggestions where applicable. Pastoral but not soft.
   NEVER expose the tone ratio in the rendered text.

3. OUTPUT FORMAT: A complete HTML document matching the mockup template
   structure. No <script> tags. No new CSS classes. Only the inline <style>
   block from the template.

4. THEME CARDS: max 3 per section. Each card has a quant chip
   (MATCHES / SUPPORTS / EXPLAINS / ADJACENT / PERIPHERAL / UNIQUE).

5. AI PROVENANCE: AI synthesis sections (Goals Achieved, Highlights, Top Strength,
   Top Growth Area pills) include a terra-dot AI-generated indicator.

6. BREVITY:
   - Top strength/growth pills: max 2 sentences
   - Goals Achieved / Highlights: max 2 paragraphs + bullet quote list
   - Theme card quotes: max 1 representative quote per card

7. DOCTRINAL ALIGNMENT: write in alignment with LEFC SOF and EFCA SOF.
   Avoid theologically ambiguous language.

8. SOFT DIAGNOSTICS: Frame teaching patterns as the *teaching pattern*, not
   the teacher's character. Lecture Mode = "the format doesn't make space for
   the room to speak," NOT "the room never speaks."

INPUT: A JSON object with the survey template, form metadata, and all responses.

OUTPUT: A complete HTML document. Validate that all required sections appear
(per the template type) before returning.
```

---

## Status snapshot (as of 2026-05-05)

| Item | Status | File |
|---|---|---|
| Class Standard mockup with sample data | ✓ done | `mockup_class_standard_report.html` |
| Series mockup with real Bailey's "Rich Towards God" data | ✓ done | `mockup_series_baileys_rich_towards_god.html` |
| Topical mockup | not started | — |
| Report generation on close (in `abf-email-worker`, flow G) | built 2026-11-23, not yet deployed | `worker/src/index.js` |
| Airtable schema additions (`aiReportHtml` + `Report *` columns on Forms) | auto-created by the worker on first run if the PAT allows | `worker/README.md` |
| Reports log table | not started (usage goes to worker logs) | — |
| Email delivery wiring | built 2026-11-23 (Brevo) | `worker/src/index.js` |
| Production AI prompt | in code as `REPORT_SYSTEM_PROMPT`; needs a round trip against real data (`/run/report?dry=1`) | `worker/src/index.js` |
