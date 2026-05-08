# Tomorrow's To-Do — Picking Up From Today

> Snapshot from end-of-day 2026-05-06. Read this first when you sit down tomorrow. Everything you need to do — and the deeper docs to consult — is below.

---

## Today's progress in one paragraph

We tried to wire email notifications via Airtable Automations + SendGrid, hit two real blockers (empty trigger tables and discovering Run-script is a paid Team plan feature), pivoted to a **Cloudflare Worker that polls Airtable on a 5-min cron** and sends via SendGrid. The Worker code is fully written and ready to deploy. Total expected cost: **$0/month indefinitely**. Email coverage: new teaching request → email teacher (A), teacher accepts/declines/counter-proposes → email leader (B), new feedback response → email teacher (D).

Also today: Bailey's "Rich Towards God" feedback report mockup went live at `abfresources.com/30334report` as a one-off public link. AI-feedback-report design spec was completed (`feedback/REPORT_DESIGN.md`). Several iterations on the report grid (radial spokes, interpretive key, AI tone rules).

---

## Priority 1 — Deploy the email Worker (~5 min — Airtable side already done)

**As of 2026-05-07 evening, I already did the Airtable + PAT prep work autonomously.** All 4 schema fields are added, the PAT is created with all scopes, the Worker code is ready. **Final step is the Wrangler deploy from your terminal.**

See `feedback/EMAIL_AUTOMATIONS_HANDOFF.md` for the full handoff including the PAT value to paste. Quick version:

```bash
npm install -g wrangler
wrangler login                                    # opens browser, OAuth
cd "/Users/daly/Documents/Claude/Projects/ABF Resources/worker"
wrangler deploy                                   # deploys the Worker
wrangler secret put AIRTABLE_TOKEN                # paste PAT (in handoff doc)
wrangler secret put SENDGRID_API_KEY              # paste scoped SG key (in handoff doc)
# Edit wrangler.toml: DRY_RUN = "true", redeploy, wrangler tail to watch logs
# Once dry-run shows expected logs, flip DRY_RUN = "false", redeploy → live
```

**Why CLI instead of dashboard:** Cloudflare dashboard was hung on the loading splash when I tried earlier — terminal is faster anyway.

---

## Priority 2 — Cleanup of dead-end work (~5 min, after Worker is verified)

Three artifacts left over from the failed Airtable Automations attempt:

- **Delete two skeleton Airtable Automations** in the base: `A — New request → email teacher` (OFF, partial config) and `D — Feedback response → email teacher` (OFF, partial config). Both replaced by the Worker. Keep `C — Daily change log digest` — that's unrelated and still useful.
- **Delete the synthetic Feedback Response** with Submitter Name `TEST - automation setup` (linked to the Bailey form). Optional — the Worker auto-skips it via a name-prefix guard, so leaving it doesn't break anything.
- **Delete the older "ABF Resources" full-access SendGrid key** (the one shared in chat earlier). The new `lefc-airtable-automations` scoped key (Mail Send only) is what the Worker uses; the old full-access key is residual risk.

---

## Priority 3 — Open AI feedback report work (no urgency)

Carry-over from yesterday's `FEEDBACK_TODO_TOM.md`. None of these block anything; all are forward progress on the Phase 2 AI-synthesized reports system.

- **Build the Topical mockup** — last format we haven't pinned down. Pattern: same as Standard mockup, minus the plus_minus components section.
- **Round-trip-test the AI prompt** in `feedback/REPORT_DESIGN.md` Appendix A against the Bailey's data. Does Sonnet 4.6 actually produce consistent, grounded HTML? Iterate until yes.
- **Build the second Cloudflare Worker** — this one for AI report generation, separate from the email Worker. Same Cloudflare account, can reuse the deploy pattern from `worker/`. Spec is in `feedback/REPORT_DESIGN.md` "On-demand generation architecture."
- **Implement the match algorithm** for the interpretive key (Balanced / Heady Egg / Pep Talk / Lecture Mode) — heuristic in `REPORT_DESIGN.md`.
- **Add the "Generate preliminary report" button** to My Surveys cards in `index.html`. Modal opens, calls the AI Worker, renders HTML.
- **Add the "also mentioned" footer** to theme card sections (themes 4+ that didn't make the top-3 cut surfaced as a one-line list).

---

## Open design questions still unresolved

From the original `FEEDBACK_TODO_TOM.md` Section 3 — defer until the AI report Worker is closer to building:

- Cohort-comparison overlay on the radial (Tom-only toggle, off by default)
- Annual review (longitudinal) view — September–June ABF year vs. calendar year?
- Anonymous vs. attributed quotes in the report
- Public report URL gating (passworded vs. open)
- Sonnet 4.6 vs. Opus 4.6 model choice
- Preliminary-report rate limiting

---

## Files to read tomorrow (in order)

1. **`TODO_TOMORROW.md`** — this file (start here)
2. **`worker/README.md`** — Worker deployment walkthrough — read before starting Priority 1
3. **`feedback/EMAIL_AUTOMATIONS_HANDOFF.md`** — has the SendGrid scoped API key value if you need to dig it out for `wrangler secret put`
4. **`FEEDBACK_TODO_TOM.md`** — open AI report items (Priority 3 detail)
5. **`feedback/REPORT_DESIGN.md`** — full design spec for AI reports (consult when building the second Worker)

---

## Status snapshot at end-of-day

| Item | Status |
|---|---|
| Email Worker code | ✓ written, not deployed |
| Email Worker deployment | ☐ pending (Priority 1) |
| SendGrid scoped key | ✓ created (Mail Send only) |
| SendGrid sender (`daly@lefc.net`) | ✓ verified |
| Bailey's report URL (`/30334report`) | ✓ live |
| Skeleton Airtable Automations (A, D) | ⚠ partial OFF, delete tomorrow |
| Synthetic test Feedback Response | ⚠ in Airtable, optional cleanup |
| Old "ABF Resources" full-access SendGrid key | ⚠ delete after Worker verified |
| AI report design spec | ✓ done (`feedback/REPORT_DESIGN.md`) |
| Class Standard mockup | ✓ done |
| Series mockup (real Bailey data) | ✓ done |
| Topical mockup | ☐ not started (Priority 3) |
| AI report Worker | ☐ not started (Priority 3) |
| `Generate preliminary report` button | ☐ not started (Priority 3) |
