# The Field — Post-Gathering Follow-Up (`/fieldsurvey`)

Follow-up survey to the **July 14, 2026** gathering of The Field (Hebrews). Simplified
from `/preachingprepsurvey`. Static `index.html` posts responses straight to Airtable.

**Status: LIVE.** Table created and wired up — no setup remaining.
- Base: `appTpp1agJQqoId07`
- Table: **Field Follow-Up** → `tbl5Hhks33h8eWX3B`
- Results dashboard: `/fieldsurveyresults`

The schema below is kept for reference.

## Airtable table

Same base as the preaching-prep survey: **`appTpp1agJQqoId07`**.
Table **"Field Follow-Up"** (`tbl5Hhks33h8eWX3B`) with these fields. Field names
must match exactly — the form writes to them by name.

| Field name | Type | Notes |
|---|---|---|
| `Submitter Name` | Single line text | required on form |
| `Submitter Email` | Email | required on form |
| `Series` | Single line text | auto-filled "Hebrews" |
| `Event Date` | Single line text | auto-filled "July 14, 2026" |
| **Section 1 — the gathering** | | |
| `Q1 Time Well Spent` | Number (integer) | 1–5 |
| `Q2 Personally Edifying` | Number (integer) | 1–5 |
| `Q3 Single Takeaway` | Long text | |
| `Q4 Use One-Word Exercise` | Number (integer) | 1–5 usefulness |
| `Q4 Use Text 1 Discussion` | Number (integer) | 1–5 usefulness |
| `Q4 Use Text 2 Discussion` | Number (integer) | 1–5 usefulness |
| `Q4 Use Q6 Sentence` | Number (integer) | 1–5 usefulness |
| `Q4 Use Large Group` | Number (integer) | 1–5 usefulness |
| `Q4 Use Breakout Rhythm` | Number (integer) | 1–5 usefulness |
| `Q4 Use Mix Of People` | Number (integer) | 1–5 usefulness |
| `Q4 Comment` | Long text | |
| `Advance Notice Adequate` | Single select | options auto-create via typecast |
| `Gathering Feedback` | Long text | |
| `Engagement Ideas` | Long text | creative ideas for congregation engagement |
| **Section 2 — the homework** | | |
| `HW Time To Complete` | Single select | options auto-create via typecast |
| `HW Usefulness` | Number (integer) | 1–5 |
| `HW Clarity Q1 Context` | Number (integer) | 1–5 |
| `HW Clarity Q2 Structure` | Number (integer) | 1–5 |
| `HW Clarity Q3 Author Intent` | Number (integer) | 1–5 |
| `HW Clarity Q4 Christ Gospel` | Number (integer) | 1–5 |
| `HW Clarity Q5 Truths Troubles` | Number (integer) | 1–5 |
| `HW Clarity Q6 Main Point` | Number (integer) | 1–5 |
| `HW Clarity Q7 Applications` | Number (integer) | 1–5 |
| `HW Feedback` | Long text | |

Notes:
- Q4 changed from a "pick up to 3" multi-select to a **1–5 usefulness rating per part**
  (7 number fields above). A leftover `Q4 Most Valuable Parts` multi-select field may still
  exist in the table from the first build — it's unused and can be deleted in the Airtable UI
  (the API can't delete fields).
- The form sends `typecast: true`, so `Single select` option values
  are created automatically on first submit — you can leave those fields with no options.
- Empty fields are stripped before submit, so blank answers won't create empty rows/options.
- Number fields: set precision to **1** (integer). Values are always 1–5.

## Field ↔ worksheet map (Section 2, Q3)

The clarity matrix mirrors the **Field Worksheet v6.24.26**:

| Airtable field | Worksheet question |
|---|---|
| `HW Clarity Q1 Context` | Key context (5–7 pieces of scripture / extra-Biblical context) |
| `HW Clarity Q2 Structure` | What the structure reveals about the main point *(optional)* |
| `HW Clarity Q3 Author Intent` | What the original author hoped to convey |
| `HW Clarity Q4 Christ Gospel` | How the passage connects to Christ / the gospel |
| `HW Clarity Q5 Truths Troubles` | Timeless truths and/or temporary troubles |
| `HW Clarity Q6 Main Point` | The main point you might make from the passage |
| `HW Clarity Q7 Applications` | Two or three practical applications for today |

## What's on the form

**Section 1 — The Gathering:** Name*, Email*, Q1 time well spent (1–5), Q2 personally
edifying (1–5), Q3 single takeaway (text), Q4 usefulness of each part of the evening
(1–5 per part, from the July 14 agenda) + comment, advance-notice question, open feedback,
and creative ideas for congregation engagement.

**Section 2 — The Homework:** time to complete, usefulness (1–5), per-question clarity
matrix (7 questions, 1–5 each), open feedback.

Only Name and Email are required — everything else is optional.
