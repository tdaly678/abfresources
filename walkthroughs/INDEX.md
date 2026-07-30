# Walkthroughs — Index

Source packs and notebook URLs for the abfresources.com walkthrough videos.

> **⚠ Outdated as of 2026-07-30.** All videos and source packs below predate the July 2026 tab restructure: course browsing/editing moved to a new top-level **Courses** tab, My Profile moved to the **Teachers** tab, and the Scheduling tab (renamed from "Teacher Scheduling") is now just My Availability + Incoming Requests (teachers) and grid + New Request + My Requests (leaders). "Online Courses" under Resources is now "Online Studies." Update the source packs and re-record before pointing new people at these.

There are **two parallel sets** of walkthrough videos:

1. **Vimeo** — the canonical site-embedded videos. IDs: leaders `1188153596`, teachers `1188153632`. These are embedded on the Home tab (Key Announcements) and Resources → Online Studies → Tutorials.
2. **NotebookLM** — generated April 30, 2026 as an alternative / supplementary set. Each one is grounded in a source pack (the `.md` files in this folder).

The site embed pattern for Vimeo: `https://player.vimeo.com/video/{ID}?title=0&byline=0&portrait=0`.

---

## NotebookLM Video Overviews (April 30, 2026)

All three were generated with **Explainer format + Whiteboard visual style** + a custom focus prompt. Whiteboard was chosen as the cleanest, most professional style for this audience (Kawaii / Anime would be wrong for ABF leaders/teachers).

### 1. Leaders walkthrough — sign-in + scheduling focus

- Source pack: [walkthrough_leaders.md](walkthrough_leaders.md)
- NotebookLM notebook: <https://notebooklm.google.com/notebook/fc7a943b-fd13-4fc4-9891-30e3fc8a5fe7>
- Title (notebook + title card): **Scheduling Tutorial — ABF Leaders**
- Focus: ~70% on signing in + the leader views (Teacher Availability grid, sending a New Request, the My Requests tab). ~30% mentions the other features in passing.

### 2. Teachers walkthrough — sign-in + scheduling focus

- Source pack: [walkthrough_teachers.md](walkthrough_teachers.md)
- NotebookLM notebook: <https://notebooklm.google.com/notebook/6ae12476-ff16-49e7-9511-452e59765158>
- Title (notebook + title card): **Scheduling Tutorial — ABF Teachers**
- Focus: ~70% on signing in + the four teacher tabs (My Availability, Incoming Requests, My Courses, My Profile incl. doctrinal alignment). ~30% on Resources, Online Courses, and Feedback in passing.

### 3. Combined walkthrough — original prototype

- Source pack: [walkthrough_combined.md](walkthrough_combined.md)
- NotebookLM notebook: <https://notebooklm.google.com/notebook/493d0894-c413-47b1-bb91-359f59f75a38>
- Title in NotebookLM: "Equipping the Saints: ABF Leader Resources Walkthrough Guide"
- Focus: full site tour weighted toward the Scheduling Tool and Feedback Tool. Built before the leader/teacher split rule landed — kept here for reference.

---

## Process notes (for next time)

- NotebookLM doesn't have an MCP/API. The flow is: write a markdown source pack → drive Chrome via the Claude-in-Chrome extension → paste source via "Copied text" → click Video Overview → fill the "What should the AI hosts focus on?" textbox with a tight focus prompt → pick visual style → Generate. Generation runs ~10–15 min.
- File upload through the Chrome extension is blocked ("Not allowed"). Use **Copied text** instead — inject the source via JavaScript directly into the dialog textarea.
- The custom focus prompt is doing a lot of the work. Lead with audience, tone, and percent split between the focus area and the quick-lap-of-everything-else.
- If a video misses, **edit the source pack** in this folder and re-run rather than starting from scratch — the source is the cheapest thing to iterate on.
