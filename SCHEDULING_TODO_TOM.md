# Scheduling Tool — Things For You To Do

The site is live and pulling from Airtable. Below are the things only you can do (Airtable API doesn't support these), in priority order.

## 1. Set up the two email Automations (15 min)

Open the base: <https://airtable.com/appTpp1agJQqoId07>
Click **Automations** (top right), then **Create automation** twice.

### Automation A — "New request → email teacher"

**Trigger:** *When a record is created* → Table: **Requests**

**Action 1:** *Find records*
- Table: **Teachers**
- Condition: where the record ID is `{{Trigger record → Teacher}}`
- Use this so you can read the teacher's email in the email step.

**Action 2:** *Send email*
- **To:** the **Email** field from the "Find records" step (Action 1 output → first record → Email)
- **Subject:**
  ```
  New teaching request from {{Trigger record → Requesting Leader → Name}}
  ```
- **Message body** (use rich-text mode — paste this in):
  ```
  Hi {{Find Teachers → first record → Name}},

  {{Trigger record → Requesting Leader → Name}} just asked you to teach in
  {{Trigger record → ABF Class → Name}} ({{Trigger record → Service}}) on:

  {{Trigger record → Requested Sundays}}

  Their message:
  {{Trigger record → Leader Message}}

  Open the portal to respond:
  https://www.abfresources.com/?tab=scheduling

  — ABF Scheduling
  ```
- **Test step**: click **Test** with a real Request record (you can create a throwaway one). Confirm the email lands. Then **Turn on automation**.

### Automation B — "Teacher responded → email leader"

**Trigger:** *When a record matches conditions* → Table: **Requests**
- Condition: **Status** is any of `Accepted`, `Declined`, `Counter-Proposed`
- (This fires every time a request transitions out of Pending.)

**Action 1:** *Find records*
- Table: **ABF Leaders**
- Condition: record ID is `{{Trigger record → Requesting Leader}}`

**Action 2:** *Send email*
- **To:** Email field from the "Find records" step
- **Subject:**
  ```
  {{Trigger record → Teacher → Name}} {{Trigger record → Status}} your request
  ```
- **Message body:**
  ```
  Hi {{Find ABF Leaders → first record → Name}},

  {{Trigger record → Teacher → Name}} responded "{{Trigger record → Status}}" to your
  request to teach in {{Trigger record → ABF Class → Name}}.

  Their note:
  {{Trigger record → Teacher Response}}

  Counter-proposed Sundays (if any):
  {{Trigger record → Counter Sundays}}

  Open the portal to see the full request:
  https://www.abfresources.com/?tab=scheduling

  — ABF Scheduling
  ```
- Test, then **Turn on automation**.

> **Heads up:** the free Airtable plan gives you ~100 automation runs/month. The volume here (a handful of requests/responses per week) will fit comfortably.

## 2. Update teacher email addresses

Right now every teacher's email is `<firstname>@example.com` — placeholder data. Open the **Teachers** table and replace each one with their real email so the automations can reach them.

Same for **ABF Leaders** — eight rows, all `<firstname>.<lastname>@example.com`.

## 3. (Optional) Clean up the base

You can safely delete these leftover scaffolding tables in the Airtable UI:
- `Table 1` (the default Airtable creates for new bases)
- `_probe_test` (left over from API experimentation)

## 4. (Nice-to-have) Add real photos

The **Teachers** table has a **Photo** field (multiple attachments). When you upload a teacher's photo there, the portal won't auto-display it yet — that's a small follow-up I can add when you want it.

## 5. Test the end-to-end flow once

1. Open https://www.abfresources.com, enter the password.
2. Click the identity badge in the header, sign in as a teacher (e.g., yourself or Ed Scheuerman).
3. Set some availability for a few Sundays (click cells).
4. Sign out, sign in as an ABF leader (e.g., Scott Galen for Koinonia).
5. Send yourself a teaching request.
6. Check your inbox for the automation email (assuming you've turned it on).
7. Sign back in as the teacher, accept it, and confirm the leader gets a response email.

Once that round-trip works, the tool is ready for the team.
