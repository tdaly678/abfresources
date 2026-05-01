# Retroactive Course Tagging — Workflow

Use this when you (Tom) need to backfill the new `Tags` field on the Courses table for courses that existed before tags shipped (May 2026). Should take ~30 min for the full catalog.

The whole point is that **Claude does the classification, you do the review.** Don't try to tag 30+ courses by hand.

---

## The 10 tags

The site code is the source of truth (search `COURSE_TAG_OPTIONS` in `index.html`). Current set:

1. Old Testament
2. New Testament
3. Theology & Doctrine
4. Apologetics
5. Discipleship
6. Spiritual Formation
7. Marriage & Family
8. Church Life
9. Mission & Evangelism
10. Cultural Engagement

Every course gets **2–3 tags**. No more, no fewer.

---

## Step 1 — Export current courses from Airtable

In Airtable → Courses table → click the view dropdown (top-left) → **Download CSV**. Or, faster, just open the table, select all rows, and copy them.

Either way, you want a list with: **Title · Teacher · Description · Min/Max Weeks**. Paste into a new chat with Claude.

---

## Step 2 — Ask Claude to propose tags

Paste this prompt with your course list:

> Using the LEFC ABF tag list (Old Testament, New Testament, Theology & Doctrine, Apologetics, Discipleship, Spiritual Formation, Marriage & Family, Church Life, Mission & Evangelism, Cultural Engagement), assign 2–3 tags to each of the courses below. Return a markdown table with columns: Title, Tags, Reasoning (one short sentence). Tags must come from the list exactly — no improvising.
>
> [paste course list here]

Claude will return something like:

| Title | Tags | Reasoning |
|---|---|---|
| Genesis (full survey) | Old Testament, Theology & Doctrine | Verse-by-verse OT book; covers creation, fall, covenant theology. |
| Joy in All Circumstances (Philippians) | New Testament, Spiritual Formation | NT book study focused on Christian endurance and contentment. |
| Marriage as Covenant | Marriage & Family, Discipleship, Theology & Doctrine | Topical study of biblical marriage with applied discipleship focus. |

---

## Step 3 — Review

Read every row. Common things to watch for:

- **OT/NT mismatch on topical studies.** A topical study on prayer that draws from both testaments shouldn't get either OT or NT — pick Spiritual Formation + Discipleship instead.
- **Marriage & Family vs Discipleship.** A course on parenting belongs in Marriage & Family. A course on what it means to follow Christ that uses parenting as one example belongs in Discipleship. When in doubt, ask the teacher.
- **Apologetics vs Theology & Doctrine.** Apologetics = defending the faith to outsiders. Theology & Doctrine = teaching what we believe to insiders. *Why We Believe* is apologetics; *The Trinity* is doctrine.
- **Cultural Engagement.** Reserve for courses that explicitly engage with non-Christian thought, current cultural debates, or worldview formation. Don't sprinkle it in just because a course mentions "the world we live in."

Edit the table directly to fix anything that's off.

---

## Step 4 — Paste back into Airtable

Two options:

**Option A — manual (best for ≤30 courses).** Open Airtable → Courses → click each row → set the Tags field from the dropdown. Use the table you reviewed as your reference.

**Option B — CSV import (best for larger sets).** Export Airtable's CSV again, paste in your final tag column (semicolon-separated values inside the cell, e.g. `Old Testament; Theology & Doctrine`), then re-import via Airtable's CSV import feature. Match on the Title column.

---

## Step 5 — Spot-check on the live site

Open <https://abfresources.com> → Teacher Scheduling → Available Courses. Confirm:

- Tags show as colored pills on each course card.
- Clicking a tag chip in the filter bar narrows the catalog correctly.
- Sort by Weeks (shortest first) puts 2–4 week courses at the top.
- Resetting clears all filters back to default.

If anything looks off, the most likely culprit is a typo in an Airtable tag option that doesn't match the site's `COURSE_TAG_OPTIONS` exactly. Open the Tags field's option list and compare letter-by-letter.

---

## Going forward

Once existing courses are backfilled, teachers will pick tags themselves when adding/editing courses on the My Courses form. The validation on the form requires 2–3 tags before it will save, so you shouldn't accumulate untagged courses again.

If you ever want to add or rename a tag:

1. Update `COURSE_TAG_OPTIONS` (and `COURSE_TAG_TONE` for the color hint) in `index.html`.
2. Update the matching option in the Airtable Courses → Tags multi-select.
3. Update the list at the top of this doc.

All three places must agree exactly.
