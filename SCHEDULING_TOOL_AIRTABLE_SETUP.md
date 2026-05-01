# ABF Scheduling Tool — Airtable Setup Guide

This guide walks you through creating the Airtable base that powers the teacher scheduling tool. Once it's built, the portal at abfresources.com will read and write data here. You only have to do this setup once.

Estimated time: **45–60 minutes.**

---

## Step 1 — Create the base

1. Sign in at airtable.com (free plan is fine).
2. From your workspace, click **Add a base → Start from scratch**.
3. Name the base **ABF Scheduling**.
4. Delete the auto-created "Table 1" — we'll build seven tables manually so the schema is correct.

---

## Step 2 — Build the seven tables

Build them in the order below. Some tables link to others (e.g., a Course belongs to a Teacher), so order matters. Each table has a primary field (the first column, can't be deleted) and several other fields. For each field I list the **type** Airtable should use.

> **Tip:** If you accidentally name a field wrong, click the small `▾` arrow on the column header and choose Customize field type or Rename field. Don't delete and re-add — that breaks links.

### Table 1: `ABF Classes`

The classes that meet on Sunday mornings. Pre-existing data will be copied here.

| Field name        | Type                | Notes                                              |
|-------------------|---------------------|----------------------------------------------------|
| Name              | Single line text    | Primary field. e.g. "Mosaic", "Philippians"        |
| Service           | Single select       | Options: `1st Service`, `2nd Service`              |
| Leaders           | Long text           | Comma-separated leader names (matches current site)|
| Photo             | Attachment          | One leader photo per class (optional)              |
| Room              | Single line text    | "Room TBD" is fine for now                         |
| Active            | Checkbox            | Default: checked                                   |

### Table 2: `Teachers`

Everyone who can be requested to teach.

| Field name        | Type                | Notes                                              |
|-------------------|---------------------|----------------------------------------------------|
| Name              | Single line text    | Primary field. Full name.                          |
| Email             | Email               | Required for the alerts to work.                   |
| Phone             | Phone number        | Optional.                                          |
| Status            | Single select       | Options: `Veteran`, `Active`, `Up & Comer Yr 1`, `Up & Comer Yr 2-3` |
| Home Class        | Link to another record | Linked to **ABF Classes**. Single record.       |
| Initials          | Single line text    | Two letters, used for the avatar (e.g. "ES")       |
| Avatar Color      | Single select       | Options: `olive`, `terra`, `steel-blue`            |
| Bio               | Long text           | Optional. Shown on teacher profile.                |
| Photo             | Attachment          | Optional. Replaces the avatar initials when set.   |
| Active            | Checkbox            | Default: checked. Uncheck to hide from the portal. |

### Table 3: `ABF Leaders`

The volunteers leading each ABF class who can send teaching requests.

| Field name        | Type                | Notes                                              |
|-------------------|---------------------|----------------------------------------------------|
| Name              | Single line text    | Primary field.                                     |
| Email             | Email               | Required so they get response notifications.       |
| ABF Class         | Link to another record | Linked to **ABF Classes**. Single record.       |
| Active            | Checkbox            | Default: checked.                                  |

### Table 4: `Courses`

The courses a teacher is willing to teach (e.g., "Genesis — 8 weeks min, 12 weeks max").

| Field name        | Type                | Notes                                              |
|-------------------|---------------------|----------------------------------------------------|
| Title             | Single line text    | Primary field. e.g. "Genesis", "Sermon on the Mount" |
| Teacher           | Link to another record | Linked to **Teachers**. Single record.          |
| Description       | Long text           | What the course covers.                            |
| Min Weeks         | Number (integer)    | Smallest number of Sundays the course can run.     |
| Max Weeks         | Number (integer)    | Largest. Same as Min if it's a fixed length.       |
| Tags              | Multiple select     | Topic tags for the leader-side catalog filter. Options must match the list in the site code (`COURSE_TAG_OPTIONS`): Old Testament, New Testament, Theology & Doctrine, Apologetics, Discipleship, Spiritual Formation, Marriage & Family, Church Life, Mission & Evangelism, Cultural Engagement. Teachers pick 2–3 per course. |
| Available         | Checkbox            | Default: checked. Uncheck to retire a course.      |

### Table 5: `Sundays`

Every Sunday in the academic year, with a flag for whether classes meet that day. The portal will pre-populate this — but the table needs to exist now.

| Field name        | Type                | Notes                                              |
|-------------------|---------------------|----------------------------------------------------|
| Date              | Date                | Primary field. ISO format (yyyy-mm-dd) — **turn off "Use the same time zone for all collaborators"** so it's a pure date. |
| In Session        | Checkbox            | Checked = ABFs meet that day. Unchecked = no class (Christmas, Easter, Family Worship). |
| Notes             | Single line text    | "Christmas — no class", "Easter Sunday", etc.      |
| Term              | Single select       | Options: `Fall 2026`, `Winter 2027`, `Spring 2027` |

### Table 6: `Availability`

One row per teacher × Sunday — the teacher's availability status for that day.

| Field name        | Type                | Notes                                              |
|-------------------|---------------------|----------------------------------------------------|
| Key               | Formula             | Primary field. Formula: `Teacher & " — " & DATETIME_FORMAT(Sunday, 'YYYY-MM-DD')` (we'll set this once the link fields exist) |
| Teacher           | Link to another record | Linked to **Teachers**.                         |
| Sunday            | Link to another record | Linked to **Sundays**.                          |
| Status            | Single select       | Options: `Available`, `Unavailable`, `Tentative`   |
| Notes             | Single line text    | Optional, e.g. "Out of town"                       |
| Updated           | Last modified time  | Auto.                                              |

> **Note on the Key formula:** create the link fields first (Teacher, Sunday). Then go back to the Key field, pick "Customize field type → Formula", and paste this exact formula: `{Teacher} & " — " & DATETIME_FORMAT({Sunday}, 'YYYY-MM-DD')`. Airtable's primary field can't be a Link, so we use a formula that combines the two links into a readable identifier.

### Table 7: `Requests`

An ABF leader requesting a teacher for one or more Sundays.

| Field name        | Type                | Notes                                              |
|-------------------|---------------------|----------------------------------------------------|
| Request ID        | Autonumber          | Primary field. Just a counter.                     |
| Requesting Leader | Link to another record | Linked to **ABF Leaders**.                      |
| ABF Class         | Link to another record | Linked to **ABF Classes**. (Denormalized — useful in the email.) |
| Service           | Lookup              | Lookup the **Service** from the linked ABF Class.  |
| Teacher           | Link to another record | Linked to **Teachers**.                         |
| Course            | Link to another record | Linked to **Courses**. Optional.                |
| Requested Sundays | Link to another record | Linked to **Sundays**. **Allow linking to multiple records.** |
| Status            | Single select       | Options: `Pending`, `Accepted`, `Declined`, `Counter-Proposed` — default `Pending`. |
| Leader Message    | Long text           | The message from the leader.                       |
| Teacher Response  | Long text           | Filled in when the teacher replies.                |
| Counter Sundays   | Link to another record | Linked to **Sundays**. Multiple. Used when status = Counter-Proposed. |
| Created           | Created time        | Auto.                                              |
| Responded At      | Date                | Filled in when the teacher responds.               |

---

## Step 3 — Seed the data

Once all seven tables and their fields exist, populate them in this order. (Order matters because of links.)

### 3a — `ABF Classes` (8 rows)

| Name           | Service     | Leaders                                                              | Room    | Active |
|----------------|-------------|----------------------------------------------------------------------|---------|--------|
| Philippians    | 1st Service | Jim Dillner, Jean Dillner                                            | Room TBD| ✓      |
| Faith Builders | 1st Service | Dawn Clinton, Jeff Clinton, Debbie Spangler, Ileana Brown, Brooke Fullen | Room TBD| ✓  |
| Koinonia       | 1st Service | Scott Galen, Nick Desiato                                            | Room TBD| ✓      |
| Branches       | 1st Service | Dan Longo, Molly Longo, Jason Leed, Ben Spead                        | Room TBD| ✓      |
| Roots          | 1st Service | Atlee Eshleman, Adrienne Eshleman, Dave Cox, Chris Cox               | Room TBD| ✓      |
| Agape          | 2nd Service | Coleen Gehman, Mary Ann Powers, Thelma Lord, MB Support              | Room TBD| ✓      |
| Mosaic         | 2nd Service | Kurt Zimmerman, Josh Bailey, Lauren Timmins                          | Room TBD| ✓      |
| Synago         | 2nd Service | Colton Keller, Hannah Keller, Paige Huber, Kevin Zook, Julie Zook, Abi Mitchell | Room TBD| ✓ |

### 3b — `Teachers` (14 rows)

I've put illustrative emails as placeholders. **Update them with real emails before email alerts are turned on** — otherwise the automations will fail or send to bogus addresses.

| Name             | Email (replace) | Status            | Home Class | Initials | Avatar Color | Active |
|------------------|------------------|-------------------|------------|----------|--------------|--------|
| Ed Scheuerman    | (you fill)       | Veteran           | Mosaic     | ES       | olive        | ✓      |
| Dave Cox         | (you fill)       | Veteran           | Roots      | DC       | olive        | ✓      |
| Corey Mitchell   | (you fill)       | Veteran           | Koinonia   | CM       | olive        | ✓      |
| Josh Bailey      | (you fill)       | Active            | Mosaic     | JB       | terra        | ✓      |
| Steve Weaver     | (you fill)       | Active            | Mosaic     | SW       | terra        | ✓      |
| Kurt Zimmerman   | (you fill)       | Active            | Mosaic     | KZ       | terra        | ✓      |
| Zach Wilkerson   | (you fill)       | Up & Comer Yr 2-3 | Mosaic     | ZW       | steel-blue   | ✓      |
| Alex Dennis      | (you fill)       | Up & Comer Yr 2-3 | Mosaic     | AD       | steel-blue   | ✓      |
| Jesse Buckwalter | (you fill)       | Up & Comer Yr 2-3 | Mosaic     | JB       | steel-blue   | ✓      |
| Adam Timmins     | (you fill)       | Up & Comer Yr 1   | Mosaic     | AT       | steel-blue   | ✓      |
| Brett Nolt       | (you fill)       | Up & Comer Yr 1   | Mosaic     | BN       | steel-blue   | ✓      |
| JJ Huber         | (you fill)       | Up & Comer Yr 1   | Mosaic     | JH       | steel-blue   | ✓      |

(That's 12 — the original site lists 14 across the three sections; the last two were not visible in the cards I read. Add any missing teachers as you go.)

### 3c — `Courses` — sample seed

To demonstrate the format, add one example course per veteran teacher. You'll be able to add real courses through the portal once it's built — but it's helpful to seed one or two so we can test.

| Title              | Teacher         | Description                                | Min Weeks | Max Weeks | Available |
|--------------------|-----------------|--------------------------------------------|-----------|-----------|-----------|
| Genesis            | Ed Scheuerman   | Walk through Genesis 1–50.                 | 8         | 12        | ✓         |
| Sermon on the Mount| Dave Cox        | Matthew 5–7 verse-by-verse.                | 6         | 8         | ✓         |
| Daniel             | Corey Mitchell  | Apocalyptic literature in its context.     | 6         | 10        | ✓         |

### 3d — `ABF Leaders`

Add one leader per ABF Class (the primary point of contact who'll send requests). You can add more later. Use real emails — these are the inboxes that receive teacher responses.

### 3e — Skip `Sundays`, `Availability`, `Requests`

Leave these three tables empty. The portal will populate `Sundays` automatically once configured (every Sunday Sept 6, 2026 → June 27, 2027, with the no-class days marked from the Key Dates tab). The other two get filled in as people use the tool.

---

## Step 4 — Generate a Personal Access Token

The portal needs a token to talk to your base. You'll generate one and paste it into me when ready.

1. Go to **airtable.com/create/tokens** (or click your avatar → Developer hub → Personal access tokens).
2. Click **Create new token**.
3. Name: `ABF Scheduling Portal`.
4. **Scopes** — check these four:
   - `data.records:read`
   - `data.records:write`
   - `schema.bases:read`
   - `data.recordComments:read` (optional, fine to skip)
5. **Access** — click "Add a base" and select **ABF Scheduling**. (Crucial: don't grant access to all bases — scope it tight.)
6. Click **Create token**, copy the token that starts with `pat...`. You won't be able to see it again.
7. Also grab the **Base ID** — open the base, look at the URL, it's the part that starts with `app...` (e.g. `appXXXXXXXXXXXXXX`).

**Send me both** (paste them into the chat). I'll wire them into the portal.

---

## Step 5 — Email automations (we'll do this together later)

Once the request flow works, we'll add two Airtable Automations:

1. **When a record is created in `Requests`** → email the linked Teacher.
2. **When `Status` changes from `Pending` in `Requests`** → email the Requesting Leader.

This is configured in the Airtable UI (no code) — I'll walk you through it in Phase 5.

---

## Common gotchas

- **Linked record fields:** when you create a link field, Airtable also creates a reciprocal field on the other table (e.g. linking Teachers → ABF Classes adds a "Teachers" field on ABF Classes). That's expected. You can rename or hide it.
- **Single-select options:** the spelling has to match exactly what the portal sends. Use the exact options I listed (case sensitive).
- **Date timezones:** Sunday dates should be timezone-naive — uncheck "Use the same time zone for all collaborators" on the Date field, otherwise Sundays can shift by a day.
- **Don't rename the tables** after the portal's wired up — the portal references them by name. If you rename later, tell me so I can update the code.

---

## When you're done

Send me:
1. Your Personal Access Token (the `pat...` string)
2. Your Base ID (the `app...` string)
3. A note confirming all 7 tables exist

I'll wire the portal up to your base and we'll move into Phase 2.
