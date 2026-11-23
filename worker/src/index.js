/**
 * ABF Email Worker
 *
 * Cloudflare Worker that polls Airtable on a cron and sends transactional
 * emails via Brevo (migrated from SendGrid 2026-07-30) for these event types:
 *
 *   A. New teaching request   →  email teacher, plus a separate short FYI
 *      email to each of the class's other leaders (2026-11-23)
 *   B. Teacher responded      →  email leader
 *      ...unless the LEADER was the one who acted (accepting or declining a
 *      counter-proposal, or withdrawing a Pending request), in which case it
 *      emails the teacher instead.
 *   D. New feedback response  →  email teacher
 *   E. Unanswered-request reminder → nudge whoever the request is waiting on,
 *      every 5 days (5 × 24h) until it's answered, during the 7am hour
 *      America/New_York. Pending nudges the teacher; Counter-Proposed nudges
 *      the leader. Stops once all the Sundays in question have passed.
 *   G. Feedback survey closed → AI synthesis report (Claude) emailed to the
 *      teacher, about once an hour (2026-11-23). See processClosedFeedbackReports.
 *
 * Schema additions required (added once via Airtable UI):
 *
 *   Requests table:
 *     - "Created Email Sent At"        (Date with time)
 *     - "Last Status Emailed"          (Single line text)
 *     - "Last Status Email Sent At"    (Date with time)
 *     - "Reminder Sent At"             (Date with time)
 *
 *   Feedback Responses table:
 *     - "Email Sent At"                (Date with time)
 *
 * Env vars (set via wrangler secret or Cloudflare dashboard):
 *   AIRTABLE_TOKEN     — Airtable PAT, scoped to this base, data:read+write
 *   BREVO_API_KEY      — Brevo (formerly Sendinblue) transactional API key
 *   AIRTABLE_BASE_ID   — Airtable base ID (also in wrangler.toml)
 *   FROM_EMAIL         — sender address (verified in Brevo)
 *   FROM_NAME          — sender display name
 *   PORTAL_URL         — base URL of abfresources.com
 *   DRY_RUN            — "true" to log instead of send (for testing)
 *   ANTHROPIC_API_KEY  — Claude API key for flow G (secret; G skips if unset)
 */

const STATUSES_TO_EMAIL = ['Accepted', 'Declined', 'Counter-Proposed', 'Withdrawn'];

// Feedback Forms that are free-text question boxes rather than template
// surveys. Their `Answers` field is {week, question} instead of a big blob of
// ratings, so Flow D can put the actual question in the notification and link
// to that form's own results page. Any form NOT listed here keeps the generic
// "someone submitted a response" email — dumping a template survey's Answers
// JSON into an email would be unreadable.
const QUESTION_BOX_FORMS = {
  // Core Beliefs panel question box — /corebeliefs-questions (built 2026-08-17)
  recVl45LLCj8z3eun: { resultsPath: '/corebeliefs-questions/results/' },
};

import { handleApi } from './api.js';

export default {
  async scheduled(event, env, ctx) {
    const cfg = buildConfig(env);
    const results = { newRequests: 0, statusChanges: 0, newFeedback: 0, reminders: 0, upcoming: 0, errors: [] };

    try {
      results.newRequests = await processNewRequests(cfg);
    } catch (e) { results.errors.push(`newRequests: ${e.message}`); }

    try {
      results.statusChanges = await processStatusChanges(cfg);
    } catch (e) { results.errors.push(`statusChanges: ${e.message}`); }

    try {
      results.newFeedback = await processNewFeedbackResponses(cfg);
    } catch (e) { results.errors.push(`newFeedback: ${e.message}`); }

    try {
      // Only during the 7am hour America/New_York; the "Reminder Sent At"
      // stamp means only the first cron tick that hour actually sends.
      results.reminders = await processPendingReminders(cfg, false);
    } catch (e) { results.errors.push(`reminders: ${e.message}`); }

    try {
      // Same 7am gate: the one-month heads-up for classes already booked.
      results.upcoming = await processUpcomingClassReminders(cfg, false);
    } catch (e) { results.errors.push(`upcoming: ${e.message}`); }

    try {
      // Flow G: once an hour, the first tick of each UTC hour (minute < 5).
      // Manual sends go through POST /run/report instead; POST /run never
      // generates or sends reports.
      const tick = new Date(event.scheduledTime || Date.now());
      if (tick.getUTCMinutes() < 5) {
        results.reports = await processClosedFeedbackReports(cfg);
      }
    } catch (e) { results.errors.push(`reports: ${e.message}`); }

    console.log('ABF email worker run complete', JSON.stringify(results));
  },

  // For manual testing: GET / triggers the same logic as the cron
  async fetch(request, env, ctx) {
    const path = new URL(request.url).pathname;

    // API proxy layer (browser ↔ Airtable). Handles its own CORS.
    if (path === '/api' || path.startsWith('/api/')) {
      return handleApi(request, env);
    }

    // CORS preflight (the /bri page calls /rock-notify cross-origin)
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // Rock Ideas & Feedback board → immediate notification on new ticket / comment.
    // Recipients are fixed server-side (ROCK_NOTIFY_EMAILS) so this endpoint can
    // only ever email those addresses, never arbitrary ones.
    if (path === '/rock-notify') {
      if (request.method !== 'POST') {
        return jsonResponse({ error: 'POST only' }, 405);
      }
      const cfg = buildConfig(env);
      try {
        const body = await request.json();
        const result = await sendRockNotification(cfg, body);
        return jsonResponse(result, 200);
      } catch (e) {
        console.error('rock-notify error:', e.message);
        return jsonResponse({ error: e.message }, 400);
      }
    }

    // Flow G manual trigger: one survey's report, by slug. dry=1 returns the
    // HTML without emailing or writing anything to Airtable.
    if (path === '/run/report') {
      if (request.headers.get('x-trigger-auth') !== env.MANUAL_TRIGGER_AUTH || !env.MANUAL_TRIGGER_AUTH) {
        return new Response('forbidden', { status: 403 });
      }
      if (request.method !== 'POST') return jsonResponse({ error: 'POST only' }, 405);
      const cfg = buildConfig(env);
      const params = new URL(request.url).searchParams;
      try {
        const out = await runManualReport(cfg, {
          slug: params.get('slug') || '',
          dry: cfg.dryRun || params.get('dry') === '1',
          resend: params.get('resend') === '1',
        });
        return jsonResponse(out, out.error ? (out.status || 400) : 200);
      } catch (e) {
        console.error('run/report error:', e.message);
        return jsonResponse({ error: e.message }, 500);
      }
    }

    if (path !== '/run') {
      return new Response('ABF email worker. POST /run with auth to trigger.', { status: 200 });
    }
    const auth = request.headers.get('x-trigger-auth');
    if (auth !== env.MANUAL_TRIGGER_AUTH) return new Response('forbidden', { status: 403 });
    // POST /run?dry=1 forces dry-run for this call only, so a new flow can be
    // checked against live Airtable data without mailing anyone. (2026-08-10)
    const cfg = { ...buildConfig(env), dryRun: buildConfig(env).dryRun || new URL(request.url).searchParams.get('dry') === '1' };
    const upcomingPreview = [];
    const results = {
      dryRun: cfg.dryRun,
      newRequests: await processNewRequests(cfg),
      statusChanges: await processStatusChanges(cfg),
      newFeedback: await processNewFeedbackResponses(cfg),
      // Manual runs bypass the 7am gate so reminders are testable on demand.
      reminders: await processPendingReminders(cfg, true),
      upcoming: await processUpcomingClassReminders(cfg, true, upcomingPreview),
      upcomingPreview,
    };
    return new Response(JSON.stringify(results, null, 2), {
      headers: { 'content-type': 'application/json' },
    });
  },
};

// ─── CORS / JSON helpers ──────────────────────────────────────────────────────

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json', ...corsHeaders() },
  });
}

// ─── Config ──────────────────────────────────────────────────────────────────

function buildConfig(env) {
  return {
    airtableToken: env.AIRTABLE_TOKEN,
    airtableBase: env.AIRTABLE_BASE_ID,
    brevoKey: env.BREVO_API_KEY,
    fromEmail: env.FROM_EMAIL,
    fromName: env.FROM_NAME,
    bccEmail: env.BCC_EMAIL || '',  // BCC every outgoing email here (admin visibility). Empty = no BCC.
    portalUrl: env.PORTAL_URL || 'https://www.abfresources.com',
    dryRun: env.DRY_RUN === 'true',
    // Flow G (feedback reports). Never logged.
    anthropicKey: env.ANTHROPIC_API_KEY || '',
    // KV (the namespace the /api layer rate-limits with) doubles as the store
    // for flow F's "already reminded" markers — see processUpcomingClassReminders.
    kv: env.RATE,
    // Rock Ideas & Feedback board (/bri): fixed recipient list, comma-separated.
    rockNotifyEmails: (env.ROCK_NOTIFY_EMAILS || 'daly@lefc.net, brianna.roberts@lefc.net')
      .split(',').map(s => s.trim()).filter(Boolean),
  };
}

// ─── Rock Ideas & Feedback: immediate notification ────────────────────────────
//
// Called by the /bri page right after a new ticket or comment is saved.
// Payload shape:
//   { type: 'ticket', title, submitter, priority, description }
//   { type: 'comment', title, author, isAdmin, body }
async function sendRockNotification(cfg, payload) {
  const type = (payload && payload.type) || '';
  if (type !== 'ticket' && type !== 'comment') {
    throw new Error('unknown notification type');
  }

  // ROCK_NOTIFY_EMAILS is both the "whole team" list and the allowlist: the
  // endpoint can only ever email addresses in this roster, never arbitrary ones.
  const roster = cfg.rockNotifyEmails;
  const lc = s => (s || '').trim().toLowerCase();

  let recipients;
  if (type === 'ticket') {
    // New ticket → whole team, minus the person who submitted it.
    const submitter = lc(payload.submitterEmail);
    recipients = roster.filter(r => lc(r) !== submitter);
  } else {
    // New comment → only that ticket's people (submitter + upvoters),
    // minus the comment's author. Derived server-side from Airtable.
    const subs = await rockSubscribers(cfg, payload.ticketId);
    const author = lc(payload.authorEmail);
    recipients = roster.filter(r => subs.has(lc(r)) && lc(r) !== author);
  }

  if (!recipients.length) return { sent: false, reason: 'no recipients after routing' };

  const email = type === 'ticket'
    ? buildRockTicketEmail(payload, cfg.portalUrl)
    : buildRockCommentEmail(payload, cfg.portalUrl);

  if (cfg.dryRun) {
    console.log('DRY_RUN ROCK:', JSON.stringify({ type, to: recipients, subject: email.subject }));
    return { sent: false, dryRun: true, to: recipients, subject: email.subject };
  }

  // One send, all recipients on the To line so they can see each other.
  await sendgridSendMulti(cfg, { to: recipients, ...email });
  return { sent: true, to: recipients, subject: email.subject };
}

// Who is "subscribed" to a Rock ticket = its submitter + everyone who upvoted it.
// Returns a Set of lowercased emails, derived from Airtable (Rock Tickets + Votes).
async function rockSubscribers(cfg, ticketId) {
  const emails = new Set();
  if (!ticketId) return emails;
  try {
    const ticket = await airtableGet(cfg, 'Rock Tickets', ticketId);
    const se = ticket && ticket.fields && ticket.fields['Submitter Email'];
    if (se) emails.add(se.trim().toLowerCase());
  } catch (e) { console.error('rockSubscribers ticket lookup:', e.message); }
  try {
    const votes = await airtableQuery(cfg, 'Rock Ticket Votes', `{Ticket ID}='${ticketId}'`);
    for (const v of votes) {
      const ve = v.fields && v.fields['Voter Email'];
      if (ve) emails.add(ve.trim().toLowerCase());
    }
  } catch (e) { console.error('rockSubscribers votes lookup:', e.message); }
  return emails;
}

// ─── Process: A — New requests ──────────────────────────────────────────────

async function processNewRequests(cfg) {
  // A request withdrawn before this flow ever picked it up is never
  // announced: the teacher would get "you've been asked" and "never mind"
  // back to back. Flow B also stays quiet for those (2026-11-02).
  const formula = `AND({Created Email Sent At}=BLANK(), {Teacher}!='', {Requesting Leader}!='', {Status}!='Withdrawn')`;
  const requests = await airtableQuery(cfg, 'Requests', formula);

  let sent = 0;
  for (const req of requests) {
    try {
      const teacherId = (req.fields['Teacher'] || [])[0];
      const leaderId  = (req.fields['Requesting Leader'] || [])[0];
      const classId   = (req.fields['ABF Class'] || [])[0];
      if (!teacherId) continue;

      const [teacher, leader, cls] = await Promise.all([
        airtableGet(cfg, 'Teachers', teacherId),
        leaderId ? airtableGet(cfg, 'ABF Leaders', leaderId) : null,
        classId ? airtableGet(cfg, 'ABF Classes', classId) : null,
      ]);

      const teacherEmail = teacher?.fields?.Email;
      const teacherName  = teacher?.fields?.Name || 'Teacher';
      const leaderName   = leader?.fields?.Name || 'A leader';
      const className    = cls?.fields?.Name || 'an ABF';
      const service      = cls?.fields?.Service || '';
      const room         = cls?.fields?.Room || '';
      const sundayIds    = req.fields['Requested Sundays'] || [];
      const sundayDates  = await fetchLinkedFieldValues(cfg, 'Sundays', sundayIds, 'Date');
      const courseTitle  = (await fetchLinkedFieldValues(cfg, 'Courses', req.fields['Course'] || [], 'Title'))[0] || '';
      // Blank message = no message block at all (it used to print "(no message)").
      const message      = String(req.fields['Leader Message'] || '').trim();
      const leaderEmail  = leader?.fields?.Email || '';

      if (!teacherEmail) continue;

      // Other leaders of this ABF get their OWN short FYI email (2026-11-23).
      // They used to be BCC'd on the teacher's email, whose "Hi LEFC
      // Mobilization ... just asked you to teach" read to a co-leader like a
      // request addressed to them. Deduped by address, minus the teacher and
      // the requesting leader (duplicate leader records can share an address).
      const coLeaders = (await getClassLeaders(cfg, classId, leaderId))
        .filter(p => !sameEmail(p.email, teacherEmail) && !sameEmail(p.email, leaderEmail));

      const portalUrl = cfg.portalUrl + '/?tab=scheduling';
      const details = { teacherName, leaderName, className, service, room, courseTitle, sundayDates, message, portalUrl, leaderEmail };
      const email = buildNewRequestEmail(details);

      if (cfg.dryRun) {
        console.log('DRY_RUN A:', JSON.stringify({ to: teacherEmail, subject: email.subject, replyTo: email.replyTo?.email || null, fyi: coLeaders.map(p => p.email) }));
      } else {
        // Admin BCC is still added inside sendgridSend.
        await sendgridSend(cfg, { to: teacherEmail, toName: teacherName, ...email });
        // The teacher email is the one that matters. If an FYI fails, log it
        // and still stamp the request below, so the next cron tick does not
        // send the teacher a second copy.
        for (const p of coLeaders) {
          try {
            const fyi = buildCoLeaderFyiEmail({ ...details, recipientName: p.name });
            await sendgridSend(cfg, { to: p.email, toName: p.name, ...fyi });
          } catch (e) {
            console.error(`A FYI error on record ${req.id} for leader ${p.id}:`, e.message);
          }
        }
      }

      await airtableUpdate(cfg, 'Requests', req.id, {
        'Created Email Sent At': new Date().toISOString(),
      });
      sent++;
    } catch (e) {
      console.error(`A error on record ${req.id}:`, e.message);
    }
  }
  return sent;
}

// ─── Process: B — Status changes ────────────────────────────────────────────

async function processStatusChanges(cfg) {
  // Match: Status is one of the email-worthy values AND we haven't emailed this exact status yet
  const statusList = STATUSES_TO_EMAIL.map(s => `{Status}='${s}'`).join(', ');
  const formula = `AND(OR(${statusList}), OR({Last Status Emailed}=BLANK(), {Last Status Emailed}!={Status}))`;
  const requests = await airtableQuery(cfg, 'Requests', formula);

  let sent = 0;
  for (const req of requests) {
    try {
      const status    = req.fields['Status'];
      const teacherId = (req.fields['Teacher'] || [])[0];
      const leaderId  = (req.fields['Requesting Leader'] || [])[0];
      const classId   = (req.fields['ABF Class'] || [])[0];
      if (!leaderId || !teacherId || !STATUSES_TO_EMAIL.includes(status)) continue;

      const [teacher, leader, cls] = await Promise.all([
        airtableGet(cfg, 'Teachers', teacherId),
        airtableGet(cfg, 'ABF Leaders', leaderId),
        classId ? airtableGet(cfg, 'ABF Classes', classId) : null,
      ]);

      const leaderEmail   = leader?.fields?.Email;
      const leaderName    = leader?.fields?.Name || 'Leader';
      const teacherName   = teacher?.fields?.Name || 'Teacher';
      const teacherEmail  = teacher?.fields?.Email;
      const className     = cls?.fields?.Name || 'the class';
      const service       = cls?.fields?.Service || '';
      const room          = cls?.fields?.Room || '';
      const courseTitle   = (await fetchLinkedFieldValues(cfg, 'Courses', req.fields['Course'] || [], 'Title'))[0] || '';
      // Reply-To the teacher only when they actually wrote a note (2026-11-23).
      const teacherNote   = String(req.fields['Teacher Response'] || '').trim();
      const teacherResp   = teacherNote || '(no note from the teacher)';
      const counterIds    = req.fields['Counter Sundays'] || [];
      const counterDates  = await fetchLinkedFieldValues(cfg, 'Sundays', counterIds, 'Date');
      const requestedDates = await fetchLinkedFieldValues(cfg, 'Sundays', req.fields['Requested Sundays'] || [], 'Date');

      // Who actually just acted? Normally the teacher answers a pending
      // request and we tell the leader. But if the previously emailed status
      // was Counter-Proposed and it is now Accepted/Declined, it was the
      // LEADER closing the loop on the teacher's counter-proposal — so the
      // news has to travel the other way, to the teacher. (2026-08-06)
      const prevStatus  = req.fields['Last Status Emailed'] || '';
      const leaderActed = prevStatus === 'Counter-Proposed' &&
                          (status === 'Accepted' || status === 'Declined');

      let email, toEmail, toName, classLeaderBccs;
      if (status === 'Withdrawn') {
        // The leader withdrew a Pending request (2026-11-02). Tell the
        // teacher, not the leader who clicked. If the teacher was never told
        // about the request in the first place (withdrawn inside the 5 minute
        // cron window), say nothing and just mark it handled.
        if (!req.fields['Created Email Sent At'] || !teacherEmail) {
          await airtableUpdate(cfg, 'Requests', req.id, {
            'Last Status Emailed': status,
            'Last Status Email Sent At': new Date().toISOString(),
          });
          continue;
        }
        toEmail = teacherEmail;
        toName  = teacherName;
        // Other leaders of the class saw the original request (Flow A BCC),
        // so they hear about the withdrawal too.
        classLeaderBccs = await getClassLeaderEmails(cfg, classId, leaderId);
        email = buildWithdrawnEmail({
          teacherName, leaderName, className, service, room, courseTitle,
          requestedDates,
          note: extractWithdrawNote(req.fields['Leader Message']),
          portalUrl: cfg.portalUrl + '/?tab=scheduling',
          leaderEmail,
        });
      } else if (leaderActed) {
        if (!teacherEmail) continue;
        toEmail = teacherEmail;
        toName  = teacherName;
        // Keep the whole leader team in the loop, including the one who acted.
        classLeaderBccs = await getClassLeaderEmails(cfg, classId, null);
        email = buildCounterResolvedEmail({
          teacherName, leaderName, className, service, room, courseTitle, status,
          // On accept the front end copies the counter dates into Requested
          // Sundays, so "Requested Sundays" IS what was agreed to.
          agreedDates: requestedDates,
          leaderReply: extractLeaderReply(req.fields['Leader Message']),
          portalUrl: cfg.portalUrl + '/?tab=scheduling',
          leaderEmail,
        });
      } else {
        if (!leaderEmail) continue;
        toEmail = leaderEmail;
        toName  = leaderName;
        // BCC all OTHER leaders of this ABF so the team stays in sync on responses
        classLeaderBccs = await getClassLeaderEmails(cfg, classId, leaderId);
        email = buildStatusChangeEmail({
          leaderName, teacherName, className, service, room, courseTitle, status,
          teacherResp, requestedDates, counterDates,
          portalUrl: cfg.portalUrl + '/?tab=scheduling',
          replyTo: teacherNote ? personReplyTo(teacherEmail, teacherName) : null,
        });
      }

      if (cfg.dryRun) {
        console.log('DRY_RUN B:', JSON.stringify({ to: toEmail, status, leaderActed, subject: email.subject, replyTo: email.replyTo?.email || null, bccs: classLeaderBccs }));
      } else {
        await sendgridSend(cfg, { to: toEmail, toName, ...email, extraBccs: classLeaderBccs });
      }

      await airtableUpdate(cfg, 'Requests', req.id, {
        'Last Status Emailed': status,
        'Last Status Email Sent At': new Date().toISOString(),
      });
      sent++;
    } catch (e) {
      console.error(`B error on record ${req.id}:`, e.message);
    }
  }
  return sent;
}

/* Leaders have no note field of their own on a Request (`FIELDS.requestByLeader`
   in api.js doesn't allow one), so index.html appends their reply to
   `Leader Message` behind this marker. Pull it back out so the teacher's
   "they accepted / declined" email can quote it. Keep in sync with
   LEADER_REPLY_MARK in index.html. */
function extractLeaderReply(leaderMessage) {
  const m = /\n\n\[Leader reply\]\s*([\s\S]*)$/.exec(String(leaderMessage || ''));
  return m ? m[1].trim() : '';
}

/* The optional note a leader adds when withdrawing (2026-11-02). Keep in
   sync with WITHDRAW_NOTE_MARK in index.html. */
function extractWithdrawNote(leaderMessage) {
  const m = /\n\n\[Withdrawn\]\s*([\s\S]*)$/.exec(String(leaderMessage || ''));
  return m ? m[1].trim() : '';
}

// ─── Process: D — New feedback responses ────────────────────────────────────

async function processNewFeedbackResponses(cfg) {
  const formula = `AND({Email Sent At}=BLANK(), {Form}!='')`;
  const responses = await airtableQuery(cfg, 'Feedback Responses', formula);

  let sent = 0;
  for (const resp of responses) {
    try {
      const formId = (resp.fields['Form'] || [])[0];
      if (!formId) continue;

      const form = await airtableGet(cfg, 'Feedback Forms', formId);
      const teacherId = (form?.fields?.Teacher || [])[0];
      if (!teacherId) continue;
      const teacher = await airtableGet(cfg, 'Teachers', teacherId);

      const teacherEmail   = teacher?.fields?.Email;
      const teacherName    = teacher?.fields?.Name || 'Teacher';
      const formTitle      = form?.fields?.Title || 'your feedback survey';
      const submitterName  = resp.fields['Submitter Name'] || 'Someone';
      const submittedAt    = resp.fields['Submitted At'] || new Date().toISOString();

      if (!teacherEmail) continue;
      // Skip our own test record so we don't spam the real teacher during setup
      if ((submitterName || '').toLowerCase().startsWith('test - automation')) {
        await airtableUpdate(cfg, 'Feedback Responses', resp.id, {
          'Email Sent At': new Date().toISOString(),
        });
        continue;
      }

      // Question-box forms get the question itself in the email; everything
      // else keeps the generic notification.
      const qbox = QUESTION_BOX_FORMS[formId];
      let answers = null;
      if (qbox) {
        try { answers = JSON.parse(resp.fields['Answers'] || '{}'); } catch { answers = null; }
      }
      const hasQuestion = answers && typeof answers.question === 'string' && answers.question.trim();

      const email = hasQuestion
        ? buildQuestionBoxEmail({
            teacherName, formTitle,
            submitterName: resp.fields['Submitter Name'] || '',
            submitterEmail: resp.fields['Submitter Email'] || '',
            week: answers.week || '',
            question: answers.question.trim(),
            submittedAt,
            resultsUrl: cfg.portalUrl + qbox.resultsPath,
          })
        : buildFeedbackResponseEmail({
            teacherName, formTitle, submitterName, submittedAt,
            portalUrl: cfg.portalUrl + '/?tab=feedback',
          });

      if (cfg.dryRun) {
        console.log('DRY_RUN D:', JSON.stringify({ to: teacherEmail, subject: email.subject }));
      } else {
        await sendgridSend(cfg, { to: teacherEmail, toName: teacherName, ...email });
      }

      await airtableUpdate(cfg, 'Feedback Responses', resp.id, {
        'Email Sent At': new Date().toISOString(),
      });
      sent++;
    } catch (e) {
      console.error(`D error on record ${resp.id}:`, e.message);
    }
  }
  return sent;
}

// ─── Process: E — Unanswered-request reminders ──────────────────────────────
//
// A request that nobody has answered gets a nudge every 5 days (not just
// once, changed 2026-08-06), sent during the 7am hour America/New_York.
// "Reminder Sent At" is now a *rolling* stamp: it records the last nudge,
// and the next one goes out 5 days after it.
//
// Both directions are covered, because either side can be the one holding
// things up:
//   • Pending          → waiting on the TEACHER  → nudge the teacher
//   • Counter-Proposed → waiting on the LEADER   → nudge the leader
//
// The clock restarts at each phase: for a counter-proposal it runs from
// "Responded At" (when the teacher countered), not from the original
// request date, so the leader gets a fair 5 days before the first nudge.
//
// Nudging stops, and the request is CLOSED OUT, as soon as either the
// earliest requested Sunday has passed or REMINDER_MAX nudges have gone
// unanswered. Both sides get one final email saying so. (2026-09-24)
//
// force=true (manual /run) bypasses the 7am gate for testing; the rolling
// stamp still prevents more than one nudge per day per request.

const REMINDER_EVERY_HOURS = 5 * 24;
const REMINDER_SEND_HOUR = 7; // 7am America/New_York

// A request nobody answers no longer nags forever (added 2026-09-24). After
// REMINDER_MAX nudges the worker closes it out and tells both sides, so the
// leader knows to ask someone else instead of waiting on silence.
//
// The count is DERIVED from elapsed time rather than stored in a column: nudge
// N lands at phaseStart + N * 5 days, so "4 nudges sent" is the same statement
// as "this phase has been waiting 20 days". That keeps the Airtable schema
// untouched. Missed cron ticks only ever make the real count LOWER than the
// derived one, so the error is always toward closing a beat late, never early.
const REMINDER_MAX = 4;

// Status written when a request is auto closed. 'Declined' is reused on
// purpose: the API proxy only sends typecast:true on POST, so a PATCH carrying
// a select option that doesn't exist in Airtable fails outright. If you add an
// "Expired" option to the Requests.Status field by hand, change this one
// constant to 'Expired' and nothing else has to move.
const CLOSE_STATUS = 'Declined';

// Marks the worker's own note so an auto close reads differently from a real
// decline, both in Airtable and in the portal's My Requests list.
const AUTO_CLOSE_MARK = '[Auto closed]';

function nyHour(date) {
  return parseInt(new Intl.DateTimeFormat('en-US', {
    hour: 'numeric', hour12: false, timeZone: 'America/New_York',
  }).format(date), 10) % 24;
}

async function processPendingReminders(cfg, force) {
  const now = new Date();
  if (!force && nyHour(now) !== REMINDER_SEND_HOUR) return 0;

  // Anything still awaiting a reply from either side, whose original
  // "new request" email actually went out. No "Reminder Sent At is blank"
  // filter any more — the stamp is now a rolling clock, not a one-shot flag.
  const formula = `AND(OR({Status}='Pending', {Status}='Counter-Proposed'), {Created Email Sent At}!=BLANK(), {Teacher}!='')`;
  const requests = await airtableQuery(cfg, 'Requests', formula);

  let sent = 0;
  for (const req of requests) {
    try {
      const status = req.fields['Status'];
      // Age from Created At (client-populated), falling back to the record's
      // own createdTime, then to when we emailed the original notification.
      const createdIso = req.fields['Created At'] || req.createdTime || req.fields['Created Email Sent At'];

      // The waiting clock restarts when the ball changes court: a
      // counter-proposal starts the leader's clock at "Responded At".
      const phaseStart = new Date(
        status === 'Counter-Proposed'
          ? (req.fields['Responded At'] || createdIso)
          : createdIso);

      // Roll forward from the last nudge, but ignore a stamp left over from
      // an earlier phase so the new recipient still gets a full 5 days.
      const stamp = req.fields['Reminder Sent At'] ? new Date(req.fields['Reminder Sent At']) : null;
      const baseline = (stamp && stamp > phaseStart) ? stamp : phaseStart;
      const dueForNudge = (now - baseline) / 36e5 > REMINDER_EVERY_HOURS;

      // Deliberately NOT bailing out here when a nudge isn't due. The auto
      // close checks further down have to run every morning — gating them on
      // the 5-day cadence would mean a request only gets closed on the days it
      // would otherwise have been nagged. (changed 2026-09-24)
      const teacherId = (req.fields['Teacher'] || [])[0];
      const leaderId  = (req.fields['Requesting Leader'] || [])[0];
      const classId   = (req.fields['ABF Class'] || [])[0];
      if (!teacherId) continue;

      const [teacher, leader, cls] = await Promise.all([
        airtableGet(cfg, 'Teachers', teacherId),
        leaderId ? airtableGet(cfg, 'ABF Leaders', leaderId) : null,
        classId ? airtableGet(cfg, 'ABF Classes', classId) : null,
      ]);

      const teacherEmail = teacher?.fields?.Email;
      const teacherName  = teacher?.fields?.Name || 'Teacher';
      const leaderEmail  = leader?.fields?.Email;
      const leaderName   = leader?.fields?.Name || 'An ABF leader';
      const className    = cls?.fields?.Name || 'an ABF';
      const service      = cls?.fields?.Service || '';
      const room         = cls?.fields?.Room || '';
      const courseTitle  = (await fetchLinkedFieldValues(cfg, 'Courses', req.fields['Course'] || [], 'Title'))[0] || '';

      // Nudge about the dates actually on the table: the teacher's
      // counter-proposal if there is one, otherwise the original ask.
      const counterIds     = req.fields['Counter Sundays'] || [];
      const requestedDates = await fetchLinkedFieldValues(cfg, 'Sundays', req.fields['Requested Sundays'] || [], 'Date');
      const counterDates   = await fetchLinkedFieldValues(cfg, 'Sundays', counterIds, 'Date');
      const sundayDates    = (status === 'Counter-Proposed' && counterDates.length)
        ? counterDates : requestedDates;

      const daysWaiting = Math.floor((now - phaseStart) / 36e5 / 24);

      // ── Close this out instead of nagging it? Two separate ways in. ──
      //
      // 1. The dates ran out. This used to be .every(), which meant a
      //    three-Sunday ask kept nudging until the LAST date passed. That is
      //    exactly how REQ-MS7P8SCE nagged Joshua Bailey ~11 times about
      //    Sept 13 / 20 / 27 when Sept 13 was already weeks gone. Once the
      //    EARLIEST requested Sunday is past, the request can no longer be
      //    honoured as written, so it's over. (fixed 2026-09-24)
      const today = nyToday();
      const days = sortedDays(sundayDates);
      const firstIso = days.length ? isoOf(days[0]) : null;
      const datesPassed = !!firstIso && firstIso < today;

      // 2. Nobody answered. See REMINDER_MAX for why elapsed days stands in
      //    for a nudge counter.
      const nudgesSent = Math.floor(daysWaiting / (REMINDER_EVERY_HOURS / 24));
      const unanswered = nudgesSent >= REMINDER_MAX;

      if (datesPassed || unanswered) {
        await closeStaleRequest(cfg, req, {
          reason: datesPassed ? 'dates' : 'unanswered',
          teacherName, teacherEmail, leaderName, leaderEmail,
          className, service, room, courseTitle,
          sundayDates, daysWaiting,
        });
        sent++;
        continue;
      }

      if (!dueForNudge) continue;

      let email, toEmail, toName;
      if (status === 'Counter-Proposed') {
        if (!leaderEmail) continue;
        toEmail = leaderEmail; toName = leaderName;
        email = buildLeaderReminderEmail({
          leaderName, teacherName, className, service, room, courseTitle,
          requestedDates, counterDates, daysWaiting,
          portalUrl: cfg.portalUrl + '/?tab=scheduling',
        });
      } else {
        if (!teacherEmail) continue;
        toEmail = teacherEmail; toName = teacherName;
        email = buildReminderEmail({
          teacherName, leaderName, className, service, room, courseTitle,
          sundayDates, daysPending: daysWaiting,
          portalUrl: cfg.portalUrl + '/?tab=scheduling',
        });
      }

      if (cfg.dryRun) {
        console.log('DRY_RUN E:', JSON.stringify({ to: toEmail, status, subject: email.subject, daysWaiting }));
      } else {
        await sendgridSend(cfg, { to: toEmail, toName, ...email });
      }

      await airtableUpdate(cfg, 'Requests', req.id, {
        'Reminder Sent At': new Date().toISOString(),
      });
      sent++;
    } catch (e) {
      console.error(`E error on record ${req.id}:`, e.message);
    }
  }
  return sent;
}

/* Close out a request nobody is going to answer (added 2026-09-24).

   Writes a terminal status, APPENDS a note behind AUTO_CLOSE_MARK rather than
   overwriting whatever the teacher may already have typed, and mails teacher
   and leader together so the leader knows to go ask someone else.

   'Last Status Emailed' is set to the same value as 'Status' on purpose. Flow
   B fires whenever those two disagree, so without this the leader would ALSO
   receive a generic "<teacher> Declined your teaching request" a few minutes
   later — which would read as though the teacher had actually said no. */
async function closeStaleRequest(cfg, req, p) {
  const { reason, teacherName, teacherEmail, leaderName, leaderEmail } = p;
  const nowIso = new Date().toISOString();
  const label = req.fields['Request ID'] || req.id;

  const note = reason === 'dates'
    ? `${AUTO_CLOSE_MARK} ${nyToday()} — the requested Sundays passed without a response.`
    : `${AUTO_CLOSE_MARK} ${nyToday()} — no response after ${REMINDER_MAX} reminders over ${p.daysWaiting} days.`;

  const prior = (req.fields['Teacher Response'] || '').trim();
  const teacherResponse = prior ? `${prior}\n\n${note}` : note;

  const email = buildRequestClosedEmail({
    ...p, portalUrl: cfg.portalUrl + '/?tab=scheduling',
  });

  const recipients = [teacherEmail, leaderEmail].filter(Boolean);

  if (cfg.dryRun) {
    console.log('DRY_RUN E-close:', JSON.stringify({
      request: label, reason, daysWaiting: p.daysWaiting,
      to: recipients, subject: email.subject,
    }));
    return;
  }

  // Status first, mail second. If SendGrid throws, the request is still closed
  // and tomorrow's tick won't re-nag: a missed notice beats an endless loop.
  await airtableUpdate(cfg, 'Requests', req.id, {
    'Status': CLOSE_STATUS,
    'Teacher Response': teacherResponse,
    'Responded At': nowIso,
    'Last Status Emailed': CLOSE_STATUS,
    'Last Status Email Sent At': nowIso,
    'Reminder Sent At': nowIso,
  });

  if (!recipients.length) {
    console.error(`E close: ${label} has no email on either side; closed silently`);
    return;
  }

  await sendgridSendMulti(cfg, {
    to: recipients,
    extraBccs: cfg.bccEmail ? [cfg.bccEmail] : [],
    ...email,
  });
}

// ─── Process: F — "You're teaching in a month" heads-up ─────────────────────
//
// Once a request is Accepted the whole thread goes quiet, and the class can be
// months away. This sends ONE heads-up to the teacher AND the requesting leader
// together, about a month before the first Sunday they agreed to, so nobody
// arrives at a Sunday nobody prepared for. (added 2026-08-10)
//
// Rules:
//   • Keyed to the EARLIEST Requested Sunday — a four-week series gets one
//     email ahead of week one, not one per Sunday.
//   • Fires at ≤30 days out, so a request accepted six months early still
//     waits until the month mark.
//   • Requests accepted inside that window get a grace period: no heads-up
//     until the acceptance is 7 days old (they obviously already know), and
//     the wording switches from "one month out" to "N days out".
//   • Nothing goes out if the first Sunday is already past.
//   • Teacher + requesting leader share the To line on purpose — if something
//     needs sorting out, they can just hit reply and talk to each other.
//
// Idempotency: a "we already sent this" marker in **KV**, not an Airtable
// field. Every other flow stamps a datetime column, but creating one needs
// schema permission the worker's Airtable PAT doesn't have (verified
// 2026-08-10: the Metadata API returns 403 for this token), and this shouldn't
// wait on a manual field-add. The KV namespace already bound for rate limiting
// serves fine. The marker is written BEFORE the send: a marker that silently
// fails to stick would mean re-sending this every single morning, so if KV is
// unavailable the record errors out and mails nobody.
//
// To force a re-send, delete the `f-sent:<recordId>` key (Cloudflare dashboard
// → Workers → KV → the namespace bound as RATE).

const UPCOMING_REMINDER_DAYS = 30;   // how far out the heads-up fires
const ACCEPT_GRACE_HOURS = 7 * 24;   // don't nudge someone who just accepted
const SENT_KEY_PREFIX = 'f-sent:';
const SENT_KEY_TTL = 400 * 24 * 3600; // long past the 30-day window; keeps KV tidy

// 'YYYY-MM-DD' for today in America/New_York. Using UTC here would roll the
// date over during the evening and mis-count "days until" by one.
function nyToday() {
  return new Intl.DateTimeFormat('en-CA', {
    year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'America/New_York',
  }).format(new Date());
}

// Whole days from ISO day `fromIso` to ISO day `toIso` (negative = in the past).
function daysBetweenIsoDays(fromIso, toIso) {
  const a = parseIsoDay(fromIso), b = parseIsoDay(toIso);
  if (!a || !b) return null;
  return Math.round((Date.UTC(b.y, b.mo - 1, b.d) - Date.UTC(a.y, a.mo - 1, a.d)) / 864e5);
}

async function processUpcomingClassReminders(cfg, force, collect) {
  const now = new Date();
  if (!force && nyHour(now) !== REMINDER_SEND_HOUR) return 0;

  const formula = `AND({Status}='Accepted', {Teacher}!='', {Requesting Leader}!='')`;
  const requests = await airtableQuery(cfg, 'Requests', formula);

  const today = nyToday();
  let sent = 0;

  for (const req of requests) {
    try {
      const sundayIds = req.fields['Requested Sundays'] || [];
      if (!sundayIds.length) continue;

      if (!cfg.kv) throw new Error('no KV binding — cannot track which reminders were sent');
      const sentKey = SENT_KEY_PREFIX + req.id;
      const already = await cfg.kv.get(sentKey);
      if (already && !cfg.dryRun) continue;

      // Requested Sundays is the agreed set even after a counter-proposal —
      // accepting one copies the counter dates in here (see the front end).
      const sundayDates = await fetchLinkedFieldValues(cfg, 'Sundays', sundayIds, 'Date');
      const days = sortedDays(sundayDates);
      if (!days.length) continue;

      const firstIso = isoOf(days[0]);
      const daysUntil = daysBetweenIsoDays(today, firstIso);
      if (daysUntil === null) continue;
      if (daysUntil < 0) continue;                       // first Sunday already past
      if (daysUntil > UPCOMING_REMINDER_DAYS) continue;  // not yet at the month mark

      // Accepted inside the window? Give it a week before piling on. No stamp
      // is written, so this record gets re-checked each morning and the email
      // still goes out once the acceptance has aged (assuming time remains).
      const acceptedIso = req.fields['Responded At'] || req.fields['Created At'] || req.createdTime;
      if (acceptedIso) {
        const acceptedAgeHours = (now - new Date(acceptedIso)) / 36e5;
        if (acceptedAgeHours < ACCEPT_GRACE_HOURS) continue;
      }

      const teacherId = (req.fields['Teacher'] || [])[0];
      const leaderId  = (req.fields['Requesting Leader'] || [])[0];
      const classId   = (req.fields['ABF Class'] || [])[0];
      if (!teacherId || !leaderId) continue;

      const [teacher, leader, cls] = await Promise.all([
        airtableGet(cfg, 'Teachers', teacherId),
        airtableGet(cfg, 'ABF Leaders', leaderId),
        classId ? airtableGet(cfg, 'ABF Classes', classId) : null,
      ]);

      const teacherEmail = teacher?.fields?.Email;
      const leaderEmail  = leader?.fields?.Email;
      if (!teacherEmail || !leaderEmail) continue;

      const email = buildUpcomingClassEmail({
        teacherName: teacher?.fields?.Name || 'the teacher',
        leaderName:  leader?.fields?.Name || 'the ABF leader',
        className:   cls?.fields?.Name || 'an ABF',
        service:     cls?.fields?.Service || '',
        room:        cls?.fields?.Room || '',
        courseTitle: (await fetchLinkedFieldValues(cfg, 'Courses', req.fields['Course'] || [], 'Title'))[0] || '',
        sundayDates,
        daysUntil,
        portalUrl: cfg.portalUrl + '/?tab=scheduling',
      });

      // Everyone else who leads this ABF, plus the admin BCC.
      const bccs = await getClassLeaderEmails(cfg, classId, leaderId);
      if (cfg.bccEmail) bccs.push(cfg.bccEmail);

      if (cfg.dryRun) {
        // Dry runs report records that already went out too, flagged — that's
        // the only readable answer to "who has been reminded?", since the
        // marker lives in KV rather than a column Tom can see in Airtable.
        const preview = {
          request: req.fields['Request ID'] || req.id,
          to: [teacherEmail, leaderEmail], bccs, daysUntil, firstIso,
          subject: email.subject,
          alreadySent: already || false,
        };
        console.log('DRY_RUN F:', JSON.stringify(preview));
        if (collect) collect.push(preview);
      } else {
        // Marker first: see the note above on why this order matters.
        await cfg.kv.put(sentKey, new Date().toISOString(), { expirationTtl: SENT_KEY_TTL });
        await sendgridSendMulti(cfg, {
          to: [teacherEmail, leaderEmail],
          extraBccs: bccs,
          ...email,
        });
      }
      sent++;
    } catch (e) {
      console.error(`F error on record ${req.id}:`, e.message);
    }
  }
  return sent;
}

// ─── Process: G — End-of-survey AI report ───────────────────────────────────
//
// When a feedback survey closes, Claude writes a pastoral synthesis of the
// responses and it is emailed to the survey's teacher (BCC admin). Design
// rules live in feedback/REPORT_DESIGN.md. (added 2026-11-23)
//
// Auto path (cron, first tick of each UTC hour) only picks up forms that:
//   • have a Closes At that has passed (full timestamp compare)
//   • closed strictly AFTER REPORT_AUTO_SEND_CUTOFF. Forms that closed
//     before this feature shipped never auto-send (no surprise backfill);
//     Tom can still send one on purpose through POST /run/report.
//   • are not question-box forms, have ≥1 real response, have no
//     Report Sent At, and are under REPORT_MAX_ATTEMPTS.
//
// Lock and retries: before calling Claude, the job stamps Report Started At
// and bumps Report Attempt Count. A form whose lock is under
// REPORT_LOCK_MINUTES old is skipped; an older lock is treated as stale (the
// run died) and retried. Any failure records Report Last Error and leaves
// Report Sent At blank, so the next hourly run tries again, up to
// REPORT_MAX_ATTEMPTS attempts. Report Sent At is written only after Brevo
// accepts the email.
//
// The same state is mirrored into KV (`report:<formId>`), so if a column
// can't be created (the PAT has lacked schema scope before; see flow F) the
// job still can't double-send. If neither KV nor a confirmed Report Sent At
// column is available, the job refuses to send at all.

const REPORT_AUTO_SEND_CUTOFF = '2026-11-23T22:00:00.000Z'; // 5:00 PM ET, Nov 23 2026
const REPORT_MODEL = 'claude-sonnet-5-5';
const ANTHROPIC_VERSION = '2026-10-21';
const REPORT_MAX_TOKENS = 8000;
const REPORT_LOCK_MINUTES = 15;
const REPORT_MAX_ATTEMPTS = 5;
const REPORT_MAX_PER_RUN = 2;          // bounds one cron tick's wall time
const REPORT_KV_PREFIX = 'report:';
const REPORT_KV_TTL = 400 * 24 * 3600;
const FEEDBACK_FORMS_TABLE_ID = 'tbl2gDQMd4zLBYC5v';     // same ids as api.js
const FEEDBACK_TEMPLATES_TABLE_ID = 'tblFuma2qufToaLV2';

const RF = {
  sentAt: 'Report Sent At',
  startedAt: 'Report Started At',
  attempts: 'Report Attempt Count',
  lastError: 'Report Last Error',
  html: 'aiReportHtml',
};

const REPORT_FIELD_SPECS = [
  { name: RF.sentAt, type: 'dateTime', options: { dateFormat: { name: 'iso' }, timeFormat: { name: '24hour' }, timeZone: 'America/New_York' } },
  { name: RF.startedAt, type: 'dateTime', options: { dateFormat: { name: 'iso' }, timeFormat: { name: '24hour' }, timeZone: 'America/New_York' } },
  { name: RF.attempts, type: 'number', options: { precision: 0 } },
  { name: RF.lastError, type: 'multilineText' },
  { name: RF.html, type: 'multilineText' },
];

// Per-isolate cache of which report columns exist. A Set of field names, or
// null when the Metadata API couldn't be read (then writes are best effort).
let _reportFieldsCache;
let _reportFieldsCheckedAt = 0;
const REPORT_FIELDS_RECHECK_MS = 6 * 3600 * 1000;

async function ensureReportFields(cfg) {
  if (_reportFieldsCache !== undefined && Date.now() - _reportFieldsCheckedAt < REPORT_FIELDS_RECHECK_MS) {
    return _reportFieldsCache;
  }
  _reportFieldsCheckedAt = Date.now();
  try {
    const res = await fetch(`https://api.airtable.com/v0/meta/bases/${cfg.airtableBase}/tables`, {
      headers: { Authorization: `Bearer ${cfg.airtableToken}` },
    });
    if (!res.ok) throw new Error(`meta read ${res.status}`);
    const json = await res.json();
    const table = (json.tables || []).find(t => t.id === FEEDBACK_FORMS_TABLE_ID || t.name === 'Feedback Forms');
    if (!table) throw new Error('Feedback Forms table not found in meta');
    const have = new Set((table.fields || []).map(f => f.name));
    for (const spec of REPORT_FIELD_SPECS) {
      if (have.has(spec.name)) continue;
      const cr = await fetch(`https://api.airtable.com/v0/meta/bases/${cfg.airtableBase}/tables/${table.id}/fields`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfg.airtableToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(spec),
      });
      if (cr.ok) {
        have.add(spec.name);
        console.log(`G: created Feedback Forms field "${spec.name}"`);
      } else {
        console.error(`G: could not create field "${spec.name}": ${cr.status} ${(await cr.text()).slice(0, 300)}`);
      }
    }
    _reportFieldsCache = have;
  } catch (e) {
    console.error(`G: Airtable Metadata API unavailable (${e.message}); report state falls back to KV. Add the Report columns by hand: ${REPORT_FIELD_SPECS.map(s => s.name).join(', ')}`);
    _reportFieldsCache = null;
  }
  return _reportFieldsCache;
}

// Combined report state: Airtable columns first, KV mirror filling gaps.
async function getReportState(cfg, form) {
  const f = form.fields || {};
  let kvState = {};
  if (cfg.kv) {
    try { kvState = JSON.parse(await cfg.kv.get(REPORT_KV_PREFIX + form.id) || '{}') || {}; } catch { kvState = {}; }
  }
  return {
    sentAt: f[RF.sentAt] || kvState.sentAt || '',
    startedAt: [f[RF.startedAt], kvState.startedAt].filter(Boolean).sort().pop() || '',
    attempts: Math.max(Number(f[RF.attempts]) || 0, Number(kvState.attempts) || 0),
    lastError: f[RF.lastError] || kvState.lastError || '',
  };
}

// Write state to KV and to whichever Airtable columns exist. `patch` uses the
// short keys from RF. Throws only if NEITHER store took the write.
async function writeReportState(cfg, form, prev, patch, fields) {
  const next = { ...prev, ...patch };
  let ok = false;
  if (cfg.kv) {
    try {
      await cfg.kv.put(REPORT_KV_PREFIX + form.id, JSON.stringify(next), { expirationTtl: REPORT_KV_TTL });
      ok = true;
    } catch (e) { console.error(`G: KV write failed for ${form.id}: ${e.message}`); }
  }
  const at = {};
  for (const [k, v] of Object.entries(patch)) {
    const col = RF[k];
    if (!col) continue;
    if (fields && !fields.has(col)) continue;
    at[col] = v;
  }
  if (Object.keys(at).length) {
    try {
      await airtableUpdate(cfg, 'Feedback Forms', form.id, at);
      ok = true;
    } catch (e) {
      console.error(`G: Airtable state write failed for ${form.id}: ${String(e.message).slice(0, 300)}`);
    }
  }
  if (!ok) throw new Error('could not record report state in KV or Airtable');
  return next;
}

function isRealResponse(r) {
  return !String(r.fields?.['Submitter Name'] || '').toLowerCase().startsWith('test - automation');
}

// Question boxes are listed in QUESTION_BOX_FORMS; as a backstop, a form with
// no template whose answers are all {question} is treated as one too.
function isQuestionBoxForm(form, responses) {
  if (QUESTION_BOX_FORMS[form.id]) return true;
  if ((form.fields?.Template || []).length) return false;
  return responses.length > 0 && responses.every(r => {
    try { return typeof JSON.parse(r.fields?.Answers || '{}').question === 'string'; } catch { return false; }
  });
}

async function responsesByForm(cfg) {
  const all = await airtableQueryAll(cfg, 'Feedback Responses', `{Form}!=''`);
  const map = new Map();
  for (const r of all) {
    if (!isRealResponse(r)) continue;
    const fid = (r.fields?.Form || [])[0];
    if (!fid) continue;
    if (!map.has(fid)) map.set(fid, []);
    map.get(fid).push(r);
  }
  return map;
}

async function processClosedFeedbackReports(cfg) {
  if (!cfg.anthropicKey) {
    console.error('G: ANTHROPIC_API_KEY is not set; skipping feedback reports');
    return 0;
  }
  const now = Date.now();
  const cutoff = Date.parse(REPORT_AUTO_SEND_CUTOFF);

  // Only Closes At in the formula: referencing a report column that doesn't
  // exist yet would make Airtable reject the whole query.
  const forms = (await airtableQueryAll(cfg, 'Feedback Forms', `{Closes At}!=''`))
    .filter(f => {
      const closes = Date.parse(f.fields?.['Closes At'] || '');
      return Number.isFinite(closes) && closes > cutoff && closes <= now && !QUESTION_BOX_FORMS[f.id];
    });
  if (!forms.length) return 0;

  const fields = await ensureReportFields(cfg);
  if (!cfg.kv && !(fields && fields.has(RF.sentAt))) {
    console.error('G: no KV binding and no Report Sent At column; refusing to send reports (cannot guarantee one send per survey)');
    return 0;
  }

  const byForm = await responsesByForm(cfg);
  let sent = 0, tried = 0;
  for (const form of forms) {
    if (tried >= REPORT_MAX_PER_RUN) break;
    const label = form.fields?.Slug || form.id;
    try {
      const responses = byForm.get(form.id) || [];
      if (!responses.length || isQuestionBoxForm(form, responses)) continue;
      const state = await getReportState(cfg, form);
      if (state.sentAt) continue;
      if (state.attempts >= REPORT_MAX_ATTEMPTS) continue;
      if (state.startedAt && now - Date.parse(state.startedAt) < REPORT_LOCK_MINUTES * 60e3) continue;

      // DRY_RUN=true on the worker: report what would run, but don't spend
      // Claude tokens every hour on a preview nobody reads.
      if (cfg.dryRun) {
        console.log('DRY_RUN G:', JSON.stringify({ form: label, responses: responses.length, attempts: state.attempts }));
        continue;
      }

      tried++;
      const out = await generateFeedbackReport(cfg, form, { responses, state, fields, dry: false });
      if (out.sent) sent++;
      if (out.error) console.error(`G error on form ${label}: ${out.error}`);
    } catch (e) {
      console.error(`G error on form ${label}:`, e.message);
    }
  }
  return sent;
}

/* POST /run/report?slug=NNNNN[&dry=1][&resend=1]. Bypasses the cutoff, the
   hourly gate and the attempt cap. A real send still requires the survey to
   have closed, refuses question boxes, and refuses a survey whose report was
   already sent unless resend=1. */
async function runManualReport(cfg, { slug, dry, resend }) {
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(slug)) return { error: 'slug required (letters, digits, - or _)', status: 400 };
  if (!cfg.anthropicKey) return { error: 'ANTHROPIC_API_KEY is not set on the worker', status: 500 };

  const forms = await airtableQuery(cfg, 'Feedback Forms', `{Slug}='${slug}'`);
  const form = forms[0];
  if (!form) return { error: `no Feedback Form with slug ${slug}`, status: 404 };

  const responses = (await responsesByForm(cfg)).get(form.id) || [];
  if (isQuestionBoxForm(form, responses)) return { error: 'question-box forms do not get AI reports', status: 400 };
  if (!responses.length) return { error: 'no real responses on this form', status: 400 };

  const fields = dry ? _reportFieldsCache ?? null : await ensureReportFields(cfg);
  const state = await getReportState(cfg, form);

  if (!dry) {
    const closes = Date.parse(form.fields?.['Closes At'] || '');
    if (!Number.isFinite(closes) || closes > Date.now()) {
      return { error: 'survey has not closed yet; use dry=1 for a preview', status: 409 };
    }
    if (state.sentAt && !resend) {
      return { error: `report already sent at ${state.sentAt}; add resend=1 to send again`, status: 409 };
    }
    if (state.startedAt && Date.now() - Date.parse(state.startedAt) < REPORT_LOCK_MINUTES * 60e3) {
      return { error: `a report run started at ${state.startedAt} may still be in progress; try again in ${REPORT_LOCK_MINUTES} minutes`, status: 409 };
    }
    if (!cfg.kv && !(fields && fields.has(RF.sentAt))) {
      return { error: 'no KV binding and no Report Sent At column; refusing to send', status: 500 };
    }
  }

  return await generateFeedbackReport(cfg, form, { responses, state, fields, dry });
}

/* Build, generate and (unless dry) send one report. Returns
   { slug, formTitle, to, subject, dryRun, wouldSend, sent, usage, html, error }.
   A dry run writes nothing anywhere. */
async function generateFeedbackReport(cfg, form, { responses, state, fields, dry }) {
  const f = form.fields || {};
  const slug = f.Slug || '';
  const formTitle = f.Title || 'your feedback survey';
  const subject = `[LEFC|U] Your feedback report for ${formTitle}`;

  let st = state;
  if (!dry) {
    st = await writeReportState(cfg, form, st, {
      startedAt: new Date().toISOString(),
      attempts: (st.attempts || 0) + 1,
    }, fields);
  }

  let to = '', toName = '';
  try {
    const teacherId = (f.Teacher || [])[0];
    const templateId = (f.Template || [])[0];
    const classId = (f['ABF Class'] || [])[0];
    const [teacher, template, cls] = await Promise.all([
      teacherId ? airtableGet(cfg, 'Teachers', teacherId) : null,
      templateId ? airtableGet(cfg, FEEDBACK_TEMPLATES_TABLE_ID, templateId) : null,
      classId ? airtableGet(cfg, 'ABF Classes', classId) : null,
    ]);
    to = String(teacher?.fields?.Email || '').trim();
    toName = teacher?.fields?.Name || '';
    if (!to && !dry) throw new Error('survey teacher has no email on record');

    let questions = [];
    try { questions = JSON.parse(template?.fields?.Questions || '[]'); } catch { questions = []; }

    const data = buildReportData({
      form, formTitle, teacherName: toName, className: cls?.fields?.Name || '',
      templateName: template?.fields?.Name || '', questions, responses,
    });

    const ai = await callClaudeForReport(cfg, data);
    console.log('G usage:', JSON.stringify({ form: slug || form.id, model: REPORT_MODEL, input_tokens: ai.usage.input_tokens, output_tokens: ai.usage.output_tokens, dry }));

    const email = buildFeedbackReportEmail({
      subject, teacherName: toName, formTitle, data, aiHtml: ai.html,
      portalUrl: cfg.portalUrl + '/?tab=feedback',
    });

    const base = {
      slug, formId: form.id, formTitle, to, toName, bcc: cfg.bccEmail || null, subject,
      responses: data.n, model: REPORT_MODEL, usage: ai.usage,
    };

    if (dry) {
      return { ...base, dryRun: true, wouldSend: !!to, sent: false, html: email.html, plain: email.plain };
    }

    await sendgridSend(cfg, { to, toName, subject, plain: email.plain, html: email.html });

    // Sent. From here on, a failed stamp must NOT be reported as a failed
    // attempt, or the next run would send it again.
    const sentAt = new Date().toISOString();
    try {
      await writeReportState(cfg, form, st, { sentAt, lastError: '' }, fields);
    } catch (e) {
      console.error(`G: report for ${slug} SENT but the Sent At stamp failed: ${e.message}`);
    }
    if (!fields || fields.has(RF.html)) {
      try {
        // Airtable long text caps at 100k characters.
        await airtableUpdate(cfg, 'Feedback Forms', form.id, { [RF.html]: email.html.slice(0, 99000) });
      } catch (e) { console.error(`G: aiReportHtml write failed for ${slug}: ${String(e.message).slice(0, 200)}`); }
    }
    return { ...base, dryRun: false, wouldSend: true, sent: true, sentAt };
  } catch (e) {
    const msg = String(e.message || e).slice(0, 1000);
    if (!dry) {
      try {
        await writeReportState(cfg, form, st, { lastError: `${new Date().toISOString()} ${msg}` }, fields);
      } catch (e2) { console.error(`G: could not record error for ${slug}: ${e2.message}`); }
    }
    return { slug, formId: form.id, formTitle, to, subject, dryRun: !!dry, sent: false, error: msg, status: 502 };
  }
}

/* Everything the model sees. Respondent names and emails are deliberately
   left out: respondents are "Respondent 1..N" in submission order. Numeric
   summaries are computed here, not by the model, so the score table in the
   email is exact. */
function buildReportData({ form, formTitle, teacherName, className, templateName, questions, responses }) {
  const f = form.fields || {};
  const sorted = responses.slice().sort((a, b) =>
    String(a.fields?.['Submitted At'] || a.createdTime || '').localeCompare(String(b.fields?.['Submitted At'] || b.createdTime || '')));
  const answers = sorted.map(r => {
    try { return JSON.parse(r.fields?.Answers || '{}') || {}; } catch { return {}; }
  });

  const qList = Array.isArray(questions) && questions.length
    ? questions
    : [...new Set(answers.flatMap(a => Object.keys(a)))].map(id => ({ id, label: id, type: 'unknown' }));

  const ratings = [], choices = [], dials = [];
  for (const q of qList) {
    if (q.type === 'rating') {
      const vals = answers.map(a => Number(a[q.id])).filter(v => Number.isFinite(v) && v > 0);
      if (!vals.length) continue;
      const dist = {};
      for (const v of vals) dist[v] = (dist[v] || 0) + 1;
      ratings.push({
        id: q.id, label: q.label || q.id, min: q.min ?? 1, max: q.max ?? 5,
        n: vals.length, avg: Math.round(vals.reduce((s, v) => s + v, 0) / vals.length * 100) / 100,
        distribution: dist,
      });
    } else if (q.type === 'single_choice' || q.type === 'choice' || q.type === 'multi_select') {
      const counts = {};
      for (const a of answers) {
        const v = a[q.id];
        for (const x of (Array.isArray(v) ? v : [v])) if (x) counts[x] = (counts[x] || 0) + 1;
      }
      if (Object.keys(counts).length) choices.push({ id: q.id, label: q.label || q.id, options: q.options || null, counts });
    } else if (q.type === 'plus_minus') {
      const comps = {};
      for (const a of answers) {
        const v = a[q.id];
        if (!v || typeof v !== 'object') continue;
        for (const [c, x] of Object.entries(v)) {
          comps[c] = comps[c] || {};
          comps[c][x] = (comps[c][x] || 0) + 1;
        }
      }
      if (Object.keys(comps).length) dials.push({ id: q.id, label: q.label || q.id, scale: 'values are less / about right / more as submitted', components: comps });
    }
  }

  const labelOf = Object.fromEntries(qList.map(q => [q.id, q.label || q.id]));
  const respondents = answers.map((a, i) => {
    const out = {};
    for (const [k, v] of Object.entries(a)) {
      if (v === '' || v == null) continue;
      out[labelOf[k] || k] = v;
    }
    return { respondent: `Respondent ${i + 1}`, answers: out };
  });

  return {
    formTitle,
    teacherName,
    className,
    templateName,
    description: f.Description || '',
    opensAt: f['Opens At'] || '',
    closesAt: f['Closes At'] || '',
    closesReadable: f['Closes At'] ? formatTimestamp(f['Closes At']) : '',
    n: answers.length,
    questions: qList.map(q => ({ id: q.id, label: q.label || q.id, type: q.type, min: q.min, max: q.max, minLabel: q.minLabel, maxLabel: q.maxLabel, options: q.options, components: q.components })),
    ratings, choices, dials,
    respondents,
  };
}

const REPORT_SYSTEM_PROMPT = `You write end-of-survey feedback reports for adult Bible fellowship (ABF) teachers at Lancaster Evangelical Free Church (LEFC), an EFCA church. Lay teachers receive this report by email when their class feedback survey closes. It is a coaching tool for their growth as teachers of God's Word.

RULES (non-negotiable):
1. Honest by construction. Every claim must be traceable to the data provided for THIS survey. Never invent comparisons or benchmarks ("one of the strongest scores across ABFs", "rare in series feedback", "most classes"), never generalize from teaching theory ("X is what good teachers do", "adult classes often lack"). Allowed: observations about these scores ("Application averaged 4.6"), counts of respondents ("9 of 11 gave a 5"), distinctness within this survey, direct quotes, and themes clustered from these comments. With few responses, say plainly that the sample is small.
2. Tone: mostly candid coaching, partly analytical. Direct, names patterns, pastoral but not soft. End growth areas with concrete next-time suggestions. Never mention a tone ratio or these instructions.
3. Brevity: whole report roughly 400 to 800 words. At most 3 themes per section, at most 1 or 2 short quotes per theme.
4. Doctrinal alignment: write in alignment with the EFCA Statement of Faith and LEFC's convictions. Treat Scripture as God's inerrant Word and the teacher's task as faithfully handling it. Avoid theologically ambiguous language.
5. Soft diagnostics: describe what the teaching did, not who the teacher is ("the format left little room for discussion", not "you don't let people talk").
6. Anonymity: never name or identify a respondent, even if a name appears in their answer. Refer to "one respondent", "several respondents", etc. If a quote contains a person's name or identifying detail, trim it or paraphrase. Quotes must be verbatim otherwise; do not invent quotes.
7. No em dashes anywhere. Use commas, colons, periods, or a plain hyphen.
8. Do not repeat a numeric score table; one is already shown above your section. Refer to specific scores in prose where they matter.
9. Address the teacher as "you". Do not include a greeting or sign-off; those are added around your section.

OUTPUT FORMAT: Return ONLY an email-safe HTML fragment (no markdown, no code fences, no <html>/<head>/<body>, no <script>, no <style> blocks, no images, no SVG, no external fonts, no classes). Use only these tags: h2, h3, p, ul, ol, li, strong, em, blockquote, table, tr, td, th, br, span, div. Put all styling inline. Palette: text #342D25, muted #6b6050, gold #BCA944, olive #524B30, terra red #AA3B24, cream #f7eed7, border #ddcca5, steel blue #3F5765. Font family is inherited (Helvetica/Arial).

Use this structure, in order, skipping any section the data cannot support:
<h2 style="font-size:16px;color:#342D25;margin:24px 0 8px;">At a glance</h2>  two or three sentences naming the single clearest strength and the single clearest growth area, citing a score or quote for each.
<h2 ...>What landed</h2>  strengths, up to 3 themes (each a short <h3 style="font-size:14px;margin:14px 0 4px;color:#524B30;"> plus a <p> and optionally one quote).
<h2 ...>What stuck</h2>  the takeaways respondents named, clustered, if takeaway questions exist.
<h2 ...>How to grow</h2>  up to 3 growth themes with concrete suggestions for next time (h3 color #AA3B24).
<h2 ...>In their words</h2>  3 to 5 notable anonymous quotes, each as <blockquote style="margin:10px 0;padding:8px 14px;border-left:3px solid #BCA944;background:#faf7ef;color:#342D25;">.
Where pace or component-dial (less / about right / more) data exists, weave it into the relevant section briefly.`;

async function callClaudeForReport(cfg, data) {
  const user = `Here is the survey data as JSON. Write the report section.\n\n${JSON.stringify(data)}`;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': cfg.anthropicKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: REPORT_MODEL,
      max_tokens: REPORT_MAX_TOKENS,
      output_config: { effort: 'medium' },
      system: REPORT_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: user }],
    }),
    signal: AbortSignal.timeout(240000),
  });
  if (!res.ok) {
    // Error bodies don't echo the key; still cap what gets stored.
    throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 400)}`);
  }
  const json = await res.json();
  if (json.stop_reason !== 'end_turn' && json.stop_reason !== 'stop_sequence') {
    throw new Error(`Anthropic stop_reason ${json.stop_reason}; not sending a partial report`);
  }
  const text = (json.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  const html = sanitizeReportHtml(text);
  if (html.replace(/<[^>]+>/g, '').trim().length < 200) throw new Error('Anthropic returned an empty or too-short report');
  return {
    html,
    usage: { input_tokens: json.usage?.input_tokens ?? null, output_tokens: json.usage?.output_tokens ?? null },
  };
}

// Belt and braces on the model's HTML: strip fences, a stray document
// wrapper, anything active, and em dashes.
function sanitizeReportHtml(s) {
  let h = String(s || '').trim();
  h = h.replace(/^```(?:html)?\s*/i, '').replace(/\s*```$/, '');
  const body = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(h);
  if (body) h = body[1];
  h = h.replace(/<!DOCTYPE[^>]*>/gi, '')
    .replace(/<(script|style|iframe|object|embed|svg|form|head|title)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<\/?(html|body|meta|link|img|input|button|base)\b[^>]*>/gi, '')
    .replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src)\s*=\s*("|')\s*javascript:[^"']*\2/gi, '')
    .replace(/\s*(—|&mdash;|&#8212;|&#x2014;)\s*/gi, ', ');
  return h.trim();
}

function reportScoreTableHtml(ratings) {
  if (!ratings.length) return '';
  const rows = ratings.map(r => `
    <tr>
      <td style="padding:7px 10px;border-top:1px solid #ddcca5;font-size:13px;vertical-align:top;">${escapeHtml(r.label)}</td>
      <td style="padding:7px 10px;border-top:1px solid #ddcca5;font-size:15px;font-weight:800;text-align:right;white-space:nowrap;vertical-align:top;">${r.avg.toFixed(2)}<span style="font-size:11px;font-weight:400;color:#6b6050;"> / ${escapeHtml(String(r.max))}</span></td>
      <td style="padding:7px 10px;border-top:1px solid #ddcca5;font-size:12px;color:#6b6050;text-align:right;white-space:nowrap;vertical-align:top;">n=${r.n}</td>
    </tr>`).join('');
  return `<h2 style="font-size:16px;color:#342D25;margin:24px 0 8px;">Scores</h2>
  <table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;background:#f7eed7;border-left:3px solid #524B30;">
    <tr>
      <th style="padding:7px 10px;font-size:11px;text-transform:uppercase;letter-spacing:.07em;color:#6b6050;text-align:left;">Question</th>
      <th style="padding:7px 10px;font-size:11px;text-transform:uppercase;letter-spacing:.07em;color:#6b6050;text-align:right;">Average</th>
      <th style="padding:7px 10px;"></th>
    </tr>${rows}
  </table>`;
}

function reportScoreTablePlain(ratings) {
  if (!ratings.length) return '';
  return '\nScores\n' + ratings.map(r => `  ${r.label}: ${r.avg.toFixed(2)} / ${r.max} (n=${r.n})`).join('\n') + '\n';
}

// Rough HTML to text for the plain-text part of the email.
function htmlToPlain(h) {
  return String(h || '')
    .replace(/<\/(p|h2|h3|li|tr|blockquote|div)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '  - ')
    .replace(/<h2[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&rsquo;/g, "'").replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function buildFeedbackReportEmail({ subject, teacherName, formTitle, data, aiHtml, portalUrl }) {
  const greet = ministryDisplay(teacherName)?.greeting || teacherName || 'there';
  const rows = [
    { label: 'Survey', value: formTitle },
    data.className ? { label: 'ABF', value: data.className } : null,
    data.closesReadable ? { label: 'Closed', value: data.closesReadable } : null,
    { label: 'Responses', value: String(data.n) },
  ].filter(Boolean);
  const lead = `Your survey "${formTitle}" has closed. Here is a summary of the ${data.n} ${data.n === 1 ? 'response' : 'responses'} it received. Respondents are kept anonymous.`;

  const plain = `Hi ${greet},

${lead}

${detailsPlain(rows)}
${reportScoreTablePlain(data.ratings)}
${htmlToPlain(aiHtml)}

(The written summary above is AI-generated from your survey responses.)

See every individual response in the portal:
${portalUrl}

ABF Feedback`;

  const html = brandShell(`
  <p>Hi <strong>${escapeHtml(greet)}</strong>,</p>
  <p>${escapeHtml(lead)}</p>
  ${detailsHtml(rows, '#524B30')}
  ${reportScoreTableHtml(data.ratings)}
  <p style="margin:26px 0 0;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;color:#AA3B24;"><span style="font-size:14px;">&#9679;</span> AI-generated summary</p>
  ${aiHtml}
  <p style="margin-top:22px;font-size:13px;color:#6b6050;">This summary was written by AI from your survey responses. Scores and counts above are computed directly from the data.</p>
  <p style="margin-top:18px;">${ctaButton('See every response in the portal', portalUrl)}</p>`);

  return { subject, plain, html };
}

// ─── Airtable client ────────────────────────────────────────────────────────

// Like airtableQuery, but follows `offset` past the first 100 records.
async function airtableQueryAll(cfg, tableName, formula) {
  const out = [];
  let offset = '';
  for (let page = 0; page < 50; page++) {
    const url = `https://api.airtable.com/v0/${cfg.airtableBase}/${encodeURIComponent(tableName)}?filterByFormula=${encodeURIComponent(formula)}&pageSize=100${offset ? `&offset=${encodeURIComponent(offset)}` : ''}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${cfg.airtableToken}` } });
    if (!res.ok) throw new Error(`Airtable query ${tableName} failed: ${res.status} ${await res.text()}`);
    const json = await res.json();
    out.push(...(json.records || []));
    if (!json.offset) break;
    offset = json.offset;
  }
  return out;
}

async function airtableQuery(cfg, tableName, formula) {
  const url = `https://api.airtable.com/v0/${cfg.airtableBase}/${encodeURIComponent(tableName)}?filterByFormula=${encodeURIComponent(formula)}&pageSize=100`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${cfg.airtableToken}` },
  });
  if (!res.ok) throw new Error(`Airtable query ${tableName} failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  return json.records || [];
}

async function airtableGet(cfg, tableName, recordId) {
  const url = `https://api.airtable.com/v0/${cfg.airtableBase}/${encodeURIComponent(tableName)}/${recordId}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${cfg.airtableToken}` },
  });
  if (!res.ok) {
    console.error(`Airtable get ${tableName}/${recordId} failed: ${res.status}`);
    return null;
  }
  return await res.json();
}

// Fetch multiple linked records and return a single field's value from each (in order).
// Used to turn linked-record IDs (e.g. for Sundays) into human-readable field values.
async function fetchLinkedFieldValues(cfg, tableName, recordIds, fieldName) {
  if (!recordIds || recordIds.length === 0) return [];
  const records = await Promise.all(recordIds.map(id => airtableGet(cfg, tableName, id)));
  return records
    .map(r => r?.fields?.[fieldName])
    .filter(v => v !== undefined && v !== null && v !== '');
}

// Return email addresses of all active ABF Leaders linked to the given class,
// optionally excluding one leader (e.g. the primary "to" recipient on a status email).
async function getClassLeaderEmails(cfg, classId, excludeLeaderId) {
  if (!classId) return [];
  const all = await airtableQuery(cfg, 'ABF Leaders', `{Active}=TRUE()`);
  return all
    .filter(r => {
      const linked = r.fields?.['ABF Class'] || [];
      return Array.isArray(linked) && linked.includes(classId) && r.id !== excludeLeaderId;
    })
    .map(r => r.fields?.Email)
    .filter(Boolean);
}

// Same set of leaders as getClassLeaderEmails, but as {id, name, email} and
// deduped by email address (case-insensitive), so two leader records that
// share an address produce one recipient. Used by Flow A's co-leader FYI.
async function getClassLeaders(cfg, classId, excludeLeaderId) {
  if (!classId) return [];
  const all = await airtableQuery(cfg, 'ABF Leaders', `{Active}=TRUE()`);
  const seen = new Set();
  const out = [];
  for (const r of all) {
    const linked = r.fields?.['ABF Class'] || [];
    if (!Array.isArray(linked) || !linked.includes(classId) || r.id === excludeLeaderId) continue;
    const email = String(r.fields?.Email || '').trim();
    const key = email.toLowerCase();
    if (!email || seen.has(key)) continue;
    seen.add(key);
    out.push({ id: r.id, name: r.fields?.Name || 'there', email });
  }
  return out;
}

function sameEmail(a, b) {
  return !!a && !!b && String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

async function airtableUpdate(cfg, tableName, recordId, fields) {
  const url = `https://api.airtable.com/v0/${cfg.airtableBase}/${encodeURIComponent(tableName)}/${recordId}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${cfg.airtableToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ fields }),
  });
  if (!res.ok) throw new Error(`Airtable update failed: ${res.status} ${await res.text()}`);
  return await res.json();
}

// ─── Brevo client ───────────────────────────────────────────────────────────
//
// Migrated from SendGrid 2026-07-30 (SendGrid sunset its free plan — the
// account hit "Maximum credits exceeded" and notifications silently died).
// Brevo free tier: 300 emails/day. API docs: https://developers.brevo.com

async function brevoRequest(cfg, payload) {
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key': cfg.brevoKey,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (res.status !== 201 && res.status !== 202) {
    throw new Error(`Brevo send failed: ${res.status} ${await res.text()}`);
  }
}

// `replyTo` (2026-11-23): the {email, name} of the person whose note or
// message the email quotes, from personReplyTo(). When present the recipient
// can hit Reply and reach that person; From stays the noreply sender. When
// absent, Reply-To stays the sender address, exactly as before.
async function sendgridSend(cfg, { to, toName, subject, plain, html, extraBccs = [], replyTo = null }) {
  // (Name kept from the SendGrid era so call sites didn't change.)
  const toLower = (to || '').toLowerCase();
  const allBccs = [];
  // Per-call BCCs (e.g., other leaders of the ABF class for full-team visibility).
  for (const e of extraBccs) {
    const lower = (e || '').toLowerCase();
    if (lower && lower !== toLower && !allBccs.some(b => b.toLowerCase() === lower)) {
      allBccs.push(e);
    }
  }
  // Admin BCC for ongoing visibility — skip if recipient or already in extraBccs.
  if (cfg.bccEmail) {
    const adminLower = cfg.bccEmail.toLowerCase();
    if (adminLower !== toLower && !allBccs.some(b => b.toLowerCase() === adminLower)) {
      allBccs.push(cfg.bccEmail);
    }
  }
  const payload = {
    sender: { email: cfg.fromEmail, name: cfg.fromName },
    replyTo: replyTo?.email
      ? { email: replyTo.email, name: replyTo.name || replyTo.email }
      : { email: cfg.fromEmail, name: cfg.fromName },
    to: [{ email: to, name: toName || to }],
    subject,
    textContent: plain,
    htmlContent: html,
  };
  if (allBccs.length) payload.bcc = allBccs.map(email => ({ email }));
  await brevoRequest(cfg, payload);
}

// Send one email to several recipients (all on the To line, so they can see
// each other). Used by the Rock board and by the one-month teaching heads-up.
// `extraBccs` is opt-in — callers that don't pass it get no BCC at all, which
// is how the Rock board has always behaved.
async function sendgridSendMulti(cfg, { to, subject, plain, html, extraBccs = [] }) {
  const recipients = (Array.isArray(to) ? to : [to]).filter(Boolean).map(email => ({ email }));
  const onTo = recipients.map(r => r.email.toLowerCase());
  const bccs = [];
  for (const e of extraBccs) {
    const lower = (e || '').toLowerCase();
    if (lower && !onTo.includes(lower) && !bccs.some(b => b.toLowerCase() === lower)) bccs.push(e);
  }
  const payload = {
    sender: { email: cfg.fromEmail, name: cfg.fromName },
    replyTo: { email: cfg.fromEmail, name: cfg.fromName },
    to: recipients,
    subject,
    textContent: plain,
    htmlContent: html,
  };
  if (bccs.length) payload.bcc = bccs.map(email => ({ email }));
  await brevoRequest(cfg, payload);
}

// ─── Email templates ────────────────────────────────────────────────────────

/* ─── Detail formatting (2026-08-06) ──────────────────────────────────────────
   These emails used to say "2027-02-07, 2027-02-14, 2027-02-21" and leave the
   reader to work out that those are the Sundays in February. Worse, none of
   them ever named the *course* — so a teacher asked about two different classes
   got mail that could have been about either. Everything below exists to put
   the whole ask in the message body: class, service, room, course, and dates a
   human can read without opening a calendar. */

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

// Parse without `new Date()`: 'YYYY-MM-DD' through the Date constructor is
// UTC midnight, which renders as the *previous* day once a US timezone gets
// hold of it. Pulling the parts out of the string sidesteps that entirely.
function parseIsoDay(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  return m ? { y: +m[1], mo: +m[2], d: +m[3] } : null;
}

function sortedDays(dates) {
  return (dates || []).map(parseIsoDay).filter(Boolean)
    .sort((a, b) => a.y - b.y || a.mo - b.mo || a.d - b.d);
}

function isoOf(p) {
  return `${p.y}-${String(p.mo).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

// "Sunday, February 7, 2027"
function fmtSundayLong(iso) {
  const p = parseIsoDay(iso);
  return p ? `Sunday, ${MONTH_NAMES[p.mo - 1]} ${p.d}, ${p.y}` : String(iso || '');
}

function joinAnd(parts) {
  if (parts.length <= 1) return parts[0] || '';
  if (parts.length === 2) return `${parts[0]} & ${parts[1]}`;
  return `${parts.slice(0, -1).join(', ')} & ${parts[parts.length - 1]}`;
}

/* Collapse a run of dates into the way someone would say it out loud:
   "February 7, 14, 21 & 28, 2027" rather than four near-identical strings.
   `short` uses abbreviated months, for subject lines. */
function fmtSundaysCompact(dates, short) {
  const days = sortedDays(dates);
  if (!days.length) return '';
  const groups = [];
  for (const p of days) {
    const last = groups[groups.length - 1];
    if (last && last.y === p.y && last.mo === p.mo) last.days.push(p.d);
    else groups.push({ y: p.y, mo: p.mo, days: [p.d] });
  }
  const multiYear = new Set(groups.map(g => g.y)).size > 1;
  const name = g => (short ? MONTH_NAMES[g.mo - 1].slice(0, 3) : MONTH_NAMES[g.mo - 1]);
  const parts = groups.map(g =>
    `${name(g)} ${joinAnd(g.days.map(String))}${multiYear ? `, ${g.y}` : ''}`);
  return parts.join('; ') + (multiYear ? '' : `, ${groups[0].y}`);
}

/* A labelled facts block. Rows are {label, value} for plain text; `html`
   overrides `value` on the HTML side when the value needs markup. */
function detailsHtml(rows, accent) {
  const bar = accent || '#BCA944';
  const cells = rows.filter(r => r && (r.html || r.value)).map(r => `
    <tr>
      <td style="padding:7px 14px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#6b6050;white-space:nowrap;vertical-align:top;">${escapeHtml(r.label)}</td>
      <td style="padding:7px 14px 7px 0;vertical-align:top;">${r.html || escapeHtml(r.value)}</td>
    </tr>`).join('');
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:16px 0;background:#f7eed7;border-left:3px solid ${bar};width:100%;">${cells}</table>`;
}

function detailsPlain(rows) {
  return rows.filter(r => r && r.value).map(r => `${r.label}: ${r.value}`).join('\n');
}

/* One Sundays row, ready to drop into detailsHtml/detailsPlain. Each date on
   its own line — someone checking a calendar reads down a column far more
   easily than across a comma-separated run. */
function sundayRow(label, dates, opts) {
  const days = sortedDays(dates);
  const o = opts || {};
  if (!days.length) {
    return { label, value: '(no Sundays specified)', html: '<em style="color:#6b6050;">(no Sundays specified)</em>' };
  }
  const long = days.map(p => fmtSundayLong(isoOf(p)));
  const strike = o.struck ? 'text-decoration:line-through;color:#8a8070;font-weight:400;' : 'font-weight:600;';
  return {
    label: `${label} (${days.length})`,
    value: `\n    ${long.join('\n    ')}`,
    html: `<span style="${strike}">${long.map(escapeHtml).join('<br>')}</span>`,
  };
}

/* Class / service / room / course — the "what is this actually about" rows
   shared by every scheduling email. */
function requestRows({ className, service, room, courseTitle }) {
  // The Room field in Airtable already reads "Room A3", so prefixing it
  // unconditionally produced "Room Room A3" in every scheduling email between
  // 2026-08-06 and 2026-08-10. Only add the word when it isn't already there.
  const roomLabel = room ? (/^room\b/i.test(String(room).trim()) ? String(room).trim() : `Room ${room}`) : '';
  const where = [service, roomLabel].filter(Boolean).join(' · ');
  return [
    {
      label: 'ABF',
      value: className + (where ? ` (${where})` : ''),
      html: `<strong>${escapeHtml(className)}</strong>${where ? `<br><span style="font-size:13px;color:#6b6050;">${escapeHtml(where)}</span>` : ''}`,
    },
    courseTitle ? { label: 'Course', value: courseTitle } : null,
  ].filter(Boolean);
}

function brandShell(innerHtml) {
  // Use a styled separator span for the LEFC|U pipe so it doesn't visually collapse into a capital I
  // in tightly-letter-spaced fonts (Apple Mail, Outlook, etc.).
  const lefcU = `LEFC<span style="color:#BCA944;font-weight:400;padding:0 1px;">|</span>U`;
  return `<!DOCTYPE html><html><body style="font-family:Helvetica,Arial,sans-serif;color:#342D25;line-height:1.55;max-width:560px;margin:0 auto;padding:24px;background:#fff;">
  <div style="border-bottom:3px solid #BCA944;padding-bottom:10px;margin-bottom:18px;">
    <span style="color:#AA3B24;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;">${lefcU} · ABF</span>
  </div>
  ${innerHtml}
  <p style="margin-top:32px;color:#6b6050;font-size:12px;">Lancaster Evangelical Free Church · ${lefcU} · ABF Resources</p>
</body></html>`;
}

function ctaButton(label, href) {
  return `<a href="${href}" style="display:inline-block;background:#AA3B24;color:#fff;padding:10px 22px;text-decoration:none;border-radius:4px;font-weight:700;">${escapeHtml(label)}</a>`;
}

/* Ministry accounts (2026-11-23). These are Teacher records that stand for a
   ministry, not a person, so "Hi LEFC Mobilization," reads oddly. Keyed by the
   Teacher record's Name, which is how MINISTRY_ACCOUNTS in index.html matches
   them too. If an account is added or renamed there, add or rename it here.
     greeting: used after "Hi"
     subject:  how the co-leader FYI subject line names the recipient
     who:      how the co-leader FYI body names the recipient; keeps the
               account name in brackets so it stays clear which record the
               request went to */
const MINISTRY_DISPLAY = {
  'lefc mobilization': {
    greeting: 'Global Partner Visits team',
    subject: 'the Global Partner Visits team',
    who: 'the Global Partner Visits team (LEFC Mobilization)',
  },
  'lefc elders': {
    greeting: 'Elders',
    subject: 'the Elders',
    who: 'the Elders (LEFC Elders)',
  },
};

function ministryDisplay(teacherName) {
  return MINISTRY_DISPLAY[String(teacherName || '').trim().toLowerCase()] || null;
}

// Subject date text: "Dec 6, 2026", "Dec 6 & 13, 2026", "Dec 13; Jan 3, 2027".
function requestSubjectDates(sundayDates) {
  return fmtSundaysCompact(sundayDates, true);
}

/* Reply-To for emails that quote a person's own note or message (2026-11-23,
   from Ben Spead's portal feedback). Returns null when there is no usable
   address, and the caller then omits both the header and the reply line. */
function personReplyTo(email, name) {
  const e = String(email || '').trim();
  if (!e || !/^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/.test(e)) return null;
  return { email: e, name: String(name || '').trim() || e };
}

// "Reply to this email to respond to X directly." Ministry accounts read as
// "the Global Partner Visits team" rather than "LEFC Mobilization".
function replyLine(replyTo) {
  if (!replyTo) return { plain: '', html: '' };
  const who = ministryDisplay(replyTo.name)?.subject || replyTo.name;
  return {
    plain: `\nReply to this email to respond to ${who} directly.\n`,
    html: `<p style="font-size:13px;color:#6b6050;margin:0 0 14px;">Reply to this email to respond to <strong>${escapeHtml(who)}</strong> directly.</p>`,
  };
}

function messageBlock(leaderName, message) {
  if (!message) return { plain: '', html: '' };
  return {
    plain: `\nMessage from ${leaderName}:\n${message}\n`,
    html: `<p style="margin-top:18px;"><strong>Message from ${escapeHtml(leaderName)}:</strong></p>
  <p style="background:#faf7ef;border-left:3px solid #524B30;padding:10px 14px;margin:6px 0 18px;">${escapeHtml(message).replace(/\n/g, '<br>')}</p>`,
  };
}

function buildNewRequestEmail({ teacherName, leaderName, className, service, room, courseTitle, sundayDates, message, portalUrl, leaderEmail }) {
  const dates = requestSubjectDates(sundayDates);
  const subject = `Teaching request: ${className}${dates ? `, ${dates}` : ''} (from ${leaderName})`;
  const greet = ministryDisplay(teacherName)?.greeting || teacherName;
  const rows = [
    ...requestRows({ className, service, room, courseTitle }),
    sundayRow('Sundays', sundayDates),
  ];
  const msg = messageBlock(leaderName, message);
  // Reply-To only when there is a message to reply to.
  const replyTo = message ? personReplyTo(leaderEmail, leaderName) : null;
  const rl = replyLine(replyTo);
  const plain = `Hi ${greet},

${leaderName} just asked you to teach in ${className}.

${detailsPlain(rows)}
${msg.plain}${rl.plain}
Open the portal to accept, decline, or suggest different Sundays:
${portalUrl}

ABF Scheduling`;
  const html = brandShell(`
  <p>Hi <strong>${escapeHtml(greet)}</strong>,</p>
  <p><strong>${escapeHtml(leaderName)}</strong> just asked you to teach in <strong>${escapeHtml(className)}</strong>.</p>
  ${detailsHtml(rows)}
  ${msg.html}
  ${rl.html}
  <p style="font-size:13px;color:#6b6050;">You can accept, decline, or suggest different Sundays from the portal.</p>
  <p style="margin-top:22px;">${ctaButton('Open the portal to respond', portalUrl)}</p>`);
  return { subject, plain, html, replyTo };
}

/* The co-leader copy of a new request (2026-11-23). Same facts as the
   teacher's email, but it opens by saying it's an FYI, who the request went
   to, and why this person got it. No call to action. */
function buildCoLeaderFyiEmail({ recipientName, teacherName, leaderName, className, service, room, courseTitle, sundayDates, message, portalUrl, leaderEmail }) {
  const dates = requestSubjectDates(sundayDates);
  const who = ministryDisplay(teacherName)?.who || teacherName;
  const whoShort = ministryDisplay(teacherName)?.subject || teacherName;
  const subject = `FYI: ${leaderName} sent a ${className} teaching request to ${whoShort}${dates ? `, ${dates}` : ''}`;
  const days = sortedDays(sundayDates);
  const onDates = days.length === 1 ? ` on ${fmtSundayLong(isoOf(days[0]))}`
    : days.length > 1 ? ` on ${days.length} Sundays (${fmtSundaysCompact(sundayDates, false)})` : '';
  const what = courseTitle ? `"${courseTitle}" ` : '';
  const lead = `FYI: ${leaderName} asked ${who} to teach ${what}in ${className}${onDates}.`;
  const why = `You're getting this because you lead ${className}. No action needed. The request went to ${who}, not to you, and ${leaderName} will hear back when they respond.`;
  const rows = [
    { label: 'Sent to', value: who },
    { label: 'Sent by', value: leaderName },
    ...requestRows({ className, service, room, courseTitle }),
    sundayRow('Sundays', sundayDates),
  ];
  const msg = messageBlock(leaderName, message);
  // Same rule as the teacher's copy: Reply-To the requesting leader only when
  // the FYI quotes their message. With no message there is nothing to answer.
  const replyTo = message ? personReplyTo(leaderEmail, leaderName) : null;
  const rl = replyLine(replyTo);
  const plain = `Hi ${recipientName},

${lead}

${why}

${detailsPlain(rows)}
${msg.plain}${rl.plain}
Scheduling on ABF Resources:
${portalUrl}

ABF Scheduling`;
  const html = brandShell(`
  <p style="background:#eef2f4;border-left:3px solid #3F5765;padding:10px 14px;margin:0 0 16px;font-size:14px;"><strong>FYI only. No action needed.</strong> You're getting this because you lead ${escapeHtml(className)}.</p>
  <p>Hi <strong>${escapeHtml(recipientName)}</strong>,</p>
  <p>${escapeHtml(lead)}</p>
  <p style="font-size:14px;color:#6b6050;">The request went to ${escapeHtml(who)}, not to you, and ${escapeHtml(leaderName)} will hear back when they respond.</p>
  ${detailsHtml(rows, '#3F5765')}
  ${msg.html}
  ${rl.html}
  <p style="font-size:13px;color:#6b6050;margin-top:22px;">Scheduling on ABF Resources: <a href="${portalUrl}" style="color:#AA3B24;">${escapeHtml(portalUrl.replace(/^https?:\/\//, ''))}</a></p>`);
  return { subject, plain, html, replyTo };
}

function buildStatusChangeEmail({ leaderName, teacherName, className, service, room, courseTitle, status, teacherResp, requestedDates, counterDates, portalUrl, replyTo = null }) {
  const countered = status === 'Counter-Proposed' && (counterDates || []).length > 0;
  const accent = status === 'Accepted' ? '#524B30' : status === 'Declined' ? '#AA3B24' : '#3F5765';

  // A counter-proposal is the one case where "X counter-proposed your request"
  // tells the reader nothing actionable. Say what they suggested instead.
  const subject = countered
    ? `${teacherName} suggested different Sundays for ${className} — ${fmtSundaysCompact(counterDates, true)}`
    : `${teacherName} ${status.toLowerCase()} your teaching request — ${className}`;

  // On a counter-proposal the whole point is the contrast between what you
  // asked for and what they're offering, so show both, old one struck through.
  const rows = [
    ...requestRows({ className, service, room, courseTitle }),
    countered
      ? sundayRow('You asked for', requestedDates, { struck: true })
      : sundayRow('Sundays', requestedDates),
    countered ? sundayRow('They suggest', counterDates) : null,
  ].filter(Boolean);

  const lead = countered
    ? `${teacherName} can't do the Sundays you asked for in ${className}, and suggested a different set instead.`
    : `${teacherName} responded "${status}" to your request to teach in ${className}.`;

  const rl = replyLine(replyTo);
  const plain = `Hi ${leaderName},

${lead}

${detailsPlain(rows)}

Their note:
${teacherResp}
${rl.plain}
${countered
  ? `Accept or decline these Sundays in the portal:`
  : `Open the portal to see the full request:`}
${portalUrl}

— ABF Scheduling`;

  const html = brandShell(`
  <p>Hi <strong>${escapeHtml(leaderName)}</strong>,</p>
  ${countered
    ? `<p><strong>${escapeHtml(teacherName)}</strong> <span style="color:${accent};font-weight:700;text-transform:uppercase;letter-spacing:.04em;">suggested different Sundays</span> for <strong>${escapeHtml(className)}</strong>.</p>`
    : `<p><strong>${escapeHtml(teacherName)}</strong> responded <span style="color:${accent};font-weight:700;text-transform:uppercase;letter-spacing:.04em;">${escapeHtml(status)}</span> to your request to teach in <strong>${escapeHtml(className)}</strong>.</p>`}
  ${detailsHtml(rows, accent)}
  <p style="margin-top:18px;"><strong>Their note:</strong></p>
  <p style="background:#faf7ef;border-left:3px solid ${accent};padding:10px 14px;margin:6px 0 18px;">${escapeHtml(teacherResp).replace(/\n/g, '<br>')}</p>
  ${rl.html}
  ${countered ? `<p style="font-size:13px;color:#6b6050;">Nothing is booked yet — the request is waiting on you to accept or decline these dates.</p>` : ''}
  <p style="margin-top:22px;">${ctaButton(countered ? 'Accept or decline these Sundays' : 'Open the portal', portalUrl)}</p>`);
  return { subject, plain, html, replyTo };
}

/* Nudge for the other direction: the teacher countered with different
   Sundays and the leader hasn't answered yet. (added 2026-08-06) */
function buildLeaderReminderEmail({ leaderName, teacherName, className, service, room, courseTitle, requestedDates, counterDates, daysWaiting, portalUrl }) {
  const subject = `Reminder: ${teacherName} suggested different Sundays for ${className} — ${fmtSundaysCompact(counterDates, true)}`;
  const rows = [
    ...requestRows({ className, service, room, courseTitle }),
    (requestedDates || []).length ? sundayRow('You asked for', requestedDates, { struck: true }) : null,
    sundayRow('They suggest', counterDates),
  ].filter(Boolean);
  const plain = `Hi ${leaderName},

Just a friendly nudge — ${teacherName} suggested different Sundays for ${className} ${daysWaiting} days ago, and the request is still waiting on you.

${detailsPlain(rows)}

Nothing is booked until you accept. Open the portal to accept or decline these dates:
${portalUrl}

— ABF Scheduling`;
  const html = brandShell(`
  <p>Hi <strong>${escapeHtml(leaderName)}</strong>,</p>
  <p>Just a friendly nudge &mdash; <strong>${escapeHtml(teacherName)}</strong> suggested different Sundays for <strong>${escapeHtml(className)}</strong> <strong>${daysWaiting} days</strong> ago, and the request is still waiting on you.</p>
  ${detailsHtml(rows, '#3F5765')}
  <p>Nothing is booked until you accept. A quick yes or no lets ${escapeHtml(String(teacherName).split(' ')[0])} know where things stand.</p>
  <p style="margin-top:22px;">${ctaButton('Accept or decline these Sundays', portalUrl)}</p>`);
  return { subject, plain, html };
}

/* The leader answered the teacher's counter-proposal, so this one goes TO
   the teacher. Without it, the only email on a counter-proposal resolution
   went back to the leader who had just clicked the button, and the teacher
   was never told the outcome. (added 2026-08-06) */
function buildCounterResolvedEmail({ teacherName, leaderName, className, service, room, courseTitle, status, agreedDates, leaderReply, portalUrl, leaderEmail }) {
  const accepted = status === 'Accepted';
  const accent = accepted ? '#524B30' : '#AA3B24';
  const compactShort = fmtSundaysCompact(agreedDates, true);
  const subject = accepted
    ? `Confirmed: you're teaching ${className}${compactShort ? ` — ${compactShort}` : ''}`
    : `${leaderName} declined the Sundays you suggested for ${className}`;

  const rows = [
    ...requestRows({ className, service, room, courseTitle }),
    accepted ? sundayRow("You're scheduled for", agreedDates) : null,
  ].filter(Boolean);

  const replyTo = leaderReply ? personReplyTo(leaderEmail, leaderName) : null;
  const rl = replyLine(replyTo);
  const replyPlain = leaderReply ? `\n${leaderName}'s note:\n${leaderReply}\n${rl.plain}` : '';
  const plain = `Hi ${teacherName},

${accepted
  ? `${leaderName} accepted the Sundays you suggested for ${className}. You're on the schedule.`
  : `${leaderName} declined the Sundays you suggested for ${className}, so this request is now closed. Nothing has been added to your schedule.`}

${detailsPlain(rows)}
${replyPlain}
Open the portal to see the full request:
${portalUrl}

— ABF Scheduling`;

  const replyHtml = leaderReply
    ? `<p style="margin-top:18px;"><strong>${escapeHtml(leaderName)}'s note:</strong></p>
       <p style="background:#faf7ef;border-left:3px solid ${accent};padding:10px 14px;margin:6px 0 18px;">${escapeHtml(leaderReply).replace(/\n/g, '<br>')}</p>
       ${rl.html}`
    : '';
  const html = brandShell(`
  <p>Hi <strong>${escapeHtml(teacherName)}</strong>,</p>
  <p><strong>${escapeHtml(leaderName)}</strong> <span style="color:${accent};font-weight:700;text-transform:uppercase;letter-spacing:.04em;">${accepted ? 'accepted' : 'declined'}</span> the Sundays you suggested for <strong>${escapeHtml(className)}</strong>.${accepted ? " You're on the schedule." : ' This request is now closed — nothing has been added to your schedule.'}</p>
  ${detailsHtml(rows, accent)}
  ${replyHtml}
  <p style="margin-top:22px;">${ctaButton('Open the portal', portalUrl)}</p>`);
  return { subject, plain, html, replyTo };
}

/* The leader withdrew a request the teacher hadn't answered yet. Goes to
   the teacher. (added 2026-11-02) */
function buildWithdrawnEmail({ teacherName, leaderName, className, service, room, courseTitle, requestedDates, note, portalUrl, leaderEmail }) {
  const accent = '#6b6050';
  const subject = `${leaderName} withdrew their teaching request for ${className}`;
  const rows = [
    ...requestRows({ className, service, room, courseTitle }),
    sundayRow('Sundays', requestedDates, { struck: true }),
  ];
  const replyTo = note ? personReplyTo(leaderEmail, leaderName) : null;
  const rl = replyLine(replyTo);
  const notePlain = note ? `\n${leaderName}'s note:\n${note}\n${rl.plain}` : '';
  const plain = `Hi ${teacherName},

${leaderName} withdrew their request for you to teach in ${className}. There's nothing you need to do, and nothing was added to your schedule.

${detailsPlain(rows)}
${notePlain}
Thank you for being willing to serve. Open the portal any time:
${portalUrl}

ABF Scheduling`;
  const noteHtml = note
    ? `<p style="margin-top:18px;"><strong>${escapeHtml(leaderName)}'s note:</strong></p>
       <p style="background:#faf7ef;border-left:3px solid ${accent};padding:10px 14px;margin:6px 0 18px;">${escapeHtml(note).replace(/\n/g, '<br>')}</p>
       ${rl.html}`
    : '';
  const html = brandShell(`
  <p>Hi <strong>${escapeHtml(teacherName)}</strong>,</p>
  <p><strong>${escapeHtml(leaderName)}</strong> <span style="color:${accent};font-weight:700;text-transform:uppercase;letter-spacing:.04em;">withdrew</span> their request for you to teach in <strong>${escapeHtml(className)}</strong>. There's nothing you need to do, and nothing was added to your schedule.</p>
  ${detailsHtml(rows, accent)}
  ${noteHtml}
  <p style="font-size:13px;color:#6b6050;">Thank you for being willing to serve.</p>
  <p style="margin-top:22px;">${ctaButton('Open the portal', portalUrl)}</p>`);
  return { subject, plain, html, replyTo };
}

function buildFeedbackResponseEmail({ teacherName, formTitle, submitterName, submittedAt, portalUrl }) {
  const submittedReadable = formatTimestamp(submittedAt);
  const subject = `New feedback on "${formTitle}" from ${submitterName}`;
  const plain = `Hi ${teacherName},

${submitterName} just submitted a response to your "${formTitle}" survey on ${submittedReadable}.

Open the portal to see this response alongside the aggregate summary:
${portalUrl}

— ABF Feedback`;
  const html = brandShell(`
  <p>Hi <strong>${escapeHtml(teacherName)}</strong>,</p>
  <p><strong>${escapeHtml(submitterName)}</strong> just submitted a response to your <strong>"${escapeHtml(formTitle)}"</strong> survey.</p>
  <p style="background:#f7eed7;border-left:3px solid #524B30;padding:10px 14px;margin:14px 0;font-size:13px;color:#524B30;">Submitted ${escapeHtml(submittedReadable)}</p>
  <p style="margin-top:22px;">${ctaButton('See response in the portal', portalUrl)}</p>
  <p style="margin-top:14px;font-size:13px;color:#6b6050;">Tip: the portal's <strong>Summary</strong> view aggregates patterns across all responses; <strong>Individual</strong> shows each one.</p>`);
  return { subject, plain, html };
}

/* Question-box notification (Flow D, for forms in QUESTION_BOX_FORMS).
   Puts the submitted question in the body so Tom can read it from his phone
   without opening anything, and links to that form's results page rather than
   the Feedback tab. Anonymous submissions are expected — a blank name is
   rendered as "Anonymous", not treated as missing data. */
function buildQuestionBoxEmail({ teacherName, formTitle, submitterName, submitterEmail,
                                 week, question, submittedAt, resultsUrl }) {
  const who = submitterName.trim() || 'Anonymous';
  const isAnon = !submitterName.trim();
  const submittedReadable = formatTimestamp(submittedAt);
  const weekLabel = week || 'No week given';

  // Keep the subject readable in a phone notification: first line of the
  // question, trimmed to something that won't get truncated mid-word.
  let preview = question.replace(/\s+/g, ' ').trim();
  if (preview.length > 80) preview = preview.slice(0, 77).replace(/\s+\S*$/, '') + '…';
  const subject = `New question (${weekLabel}): ${preview}`;

  const plain = `Hi ${teacherName},

A new question came in on "${formTitle}".

Week: ${weekLabel}
From: ${who}${submitterEmail ? ' <' + submitterEmail + '>' : (isAnon ? ' (no name given)' : '')}
Submitted: ${submittedReadable}

${question}

See every question in one list:
${resultsUrl}

— ABF Feedback`;

  const html = brandShell(`
  <p>Hi <strong>${escapeHtml(teacherName)}</strong>,</p>
  <p>A new question came in on <strong>"${escapeHtml(formTitle)}"</strong>.</p>
  <p style="margin:14px 0 6px;">
    <span style="display:inline-block;background:#342D25;color:#BCA944;font-size:11px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;padding:3px 10px;border-radius:99px;">${escapeHtml(weekLabel)}</span>
  </p>
  <div style="background:#fff;border:1px solid #ddcca5;border-left:4px solid #AA3B24;border-radius:6px;padding:16px 18px;margin:12px 0 16px;font-size:15px;line-height:1.6;white-space:pre-wrap;">${escapeHtml(question)}</div>
  <p style="font-size:13px;color:#6b6050;margin:0 0 4px;">
    From: <strong>${escapeHtml(who)}</strong>${isAnon ? ' <em>(submitted anonymously)</em>' : ''}${submitterEmail ? ' &middot; <a href="mailto:' + escapeHtml(submitterEmail) + '" style="color:#AA3B24;">' + escapeHtml(submitterEmail) + '</a>' : ''}
  </p>
  <p style="font-size:13px;color:#6b6050;margin:0;">Submitted ${escapeHtml(submittedReadable)}</p>
  <p style="margin-top:22px;">${ctaButton('See all questions', resultsUrl)}</p>
  <p style="margin-top:14px;font-size:13px;color:#6b6050;">The results page needs your admin PIN. It groups questions by week and has copy/print for panel prep.</p>`);

  return { subject, plain, html };
}

function buildReminderEmail({ teacherName, leaderName, className, service, room, courseTitle, sundayDates, daysPending, portalUrl }) {
  const compactShort = fmtSundaysCompact(sundayDates, true);
  const subject = `Reminder: ${leaderName} is waiting on you — ${className}${compactShort ? `, ${compactShort}` : ''}`;
  const rows = [
    ...requestRows({ className, service, room, courseTitle }),
    sundayRow('Requested Sundays', sundayDates),
  ];
  const plain = `Hi ${teacherName},

Just a friendly nudge — ${leaderName}'s request for you to teach in ${className} has been waiting ${daysPending} days for a response.

${detailsPlain(rows)}

Even if the answer is "not this time," a quick decline helps ${leaderName} plan and ask someone else. You can also suggest different Sundays if these don't work.

Open the portal to respond:
${portalUrl}

— ABF Scheduling`;
  const html = brandShell(`
  <p>Hi <strong>${escapeHtml(teacherName)}</strong>,</p>
  <p>Just a friendly nudge &mdash; <strong>${escapeHtml(leaderName)}</strong>'s request for you to teach in <strong>${escapeHtml(className)}</strong> has been waiting <strong>${daysPending} days</strong> for a response.</p>
  ${detailsHtml(rows)}
  <p>Even if the answer is &ldquo;not this time,&rdquo; a quick decline helps ${escapeHtml(leaderName)} plan and ask someone else &mdash; and you can suggest different Sundays if these don't work.</p>
  <p style="margin-top:22px;">${ctaButton('Open the portal to respond', portalUrl)}</p>`);
  return { subject, plain, html };
}

/* The auto-close notice (flow E). Teacher and leader both on the To line, same
   as the one-month heads-up: the useful next step belongs to the leader, but
   the teacher should know the ask is off their plate and the nudges have
   stopped. Names both rather than assuming a single "you". (added 2026-09-24) */
function buildRequestClosedEmail({ reason, teacherName, leaderName, className, service, room, courseTitle, sundayDates, daysWaiting, portalUrl }) {
  const compactShort = fmtSundaysCompact(sundayDates, true);
  const subject = `Closed: ${leaderName}'s teaching request for ${className}${compactShort ? `, ${compactShort}` : ''}`;
  const rows = [
    ...requestRows({ className, service, room, courseTitle }),
    sundayRow('Requested Sundays', sundayDates),
  ];
  const why = reason === 'dates'
    ? `The Sundays in this request have started to pass without an answer, so it has been closed out.`
    : `This request went ${daysWaiting} days without an answer, so after ${REMINDER_MAX} reminders it has been closed out automatically.`;

  const plain = `${why}

${detailsPlain(rows)}

Nothing is scheduled and no reply is needed. ${teacherName} won't get any more reminders about it.

${leaderName} — if this class still needs a teacher, the quickest path is a fresh request in the portal: either back to ${teacherName} on dates that work better, or to someone else with open Sundays.

${portalUrl}

— ABF Scheduling`;
  const html = brandShell(`
  <p>${escapeHtml(why)}</p>
  ${detailsHtml(rows)}
  <p>Nothing is scheduled and no reply is needed. <strong>${escapeHtml(teacherName)}</strong> won't get any more reminders about it.</p>
  <p><strong>${escapeHtml(leaderName)}</strong> &mdash; if this class still needs a teacher, the quickest path is a fresh request in the portal: either back to ${escapeHtml(teacherName)} on dates that work better, or to someone else with open Sundays.</p>
  <p style="margin-top:22px;">${ctaButton('Open the portal', portalUrl)}</p>`);
  return { subject, plain, html };
}

/* The one-month heads-up (flow F). One email, teacher and leader both on the
   To line, so a reply goes to the person who can actually do something about
   it. Written to read naturally to either of them — it names both rather than
   assuming a single "you". (added 2026-08-10) */

// "One month out" / "3 weeks out" / "9 days out" — however far out it actually is.
function horizonLabel(days) {
  if (days >= 25) return 'One month out';
  if (days >= 8) return `${Math.round(days / 7)} weeks out`;
  if (days <= 0) return 'This Sunday';
  if (days === 1) return 'Tomorrow';
  return `${days} days out`;
}

function buildUpcomingClassEmail({ teacherName, leaderName, className, service, room, courseTitle, sundayDates, daysUntil, portalUrl }) {
  const all = sortedDays(sundayDates);
  const first = all[0], last = all[all.length - 1];
  const firstLong = first ? fmtSundayLong(isoOf(first)) : '';
  const lastLong = last ? fmtSundayLong(isoOf(last)) : '';
  const compactShort = fmtSundaysCompact(sundayDates, true);
  const horizon = horizonLabel(daysUntil);
  const teacherFirst = String(teacherName).split(' ')[0];
  const leaderFirst  = String(leaderName).split(' ')[0];
  const many = sortedDays(sundayDates).length > 1;

  const subject = `${horizon}: ${teacherName} is teaching ${className}${compactShort ? ` — ${compactShort}` : ''}`;

  const rows = [
    ...requestRows({ className, service, room, courseTitle }),
    { label: 'Teacher', value: teacherName },
    sundayRow(many ? 'Sundays' : 'Sunday', sundayDates),
  ];

  // "starting on X and ending on Y" for a series; a single Sunday just says
  // "on X" — "starting and ending" on one date reads like a typo.
  const span = many
    ? `starting on ${firstLong} and ending on ${lastLong}`
    : `on ${firstLong}`;

  const plain = `Hi ${teacherFirst} and ${leaderFirst},

A friendly reminder that ${teacherName} is scheduled to teach in ${className}, ${span}.

${detailsPlain(rows)}

Reply to this email and you'll reach each other. The full request is in the portal:
${portalUrl}

— ABF Scheduling`;

  const html = brandShell(`
  <p>Hi <strong>${escapeHtml(teacherFirst)}</strong> and <strong>${escapeHtml(leaderFirst)}</strong>,</p>
  <p>A friendly reminder that <strong>${escapeHtml(teacherName)}</strong> is scheduled to teach in <strong>${escapeHtml(className)}</strong>, ${escapeHtml(span)}.</p>
  ${detailsHtml(rows, '#524B30')}
  <p style="font-size:13px;color:#6b6050;">You're both on this email, so a reply reaches each other.</p>
  <p style="margin-top:22px;">${ctaButton('Open the portal', portalUrl)}</p>`);

  return { subject, plain, html };
}

// ─── Rock Ideas & Feedback templates ─────────────────────────────────────────
//
// This board (/bri) is its own thing, separate from ABF — so it uses a plain
// "LEFC · ROCK" header rather than the LEFC|U ABF shell.

function rockBrandShell(innerHtml) {
  return `<!DOCTYPE html><html><body style="font-family:Helvetica,Arial,sans-serif;color:#342D25;line-height:1.55;max-width:560px;margin:0 auto;padding:24px;background:#fff;">
  <div style="border-bottom:3px solid #BCA944;padding-bottom:10px;margin-bottom:18px;">
    <span style="color:#AA3B24;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;">LEFC · ROCK</span>
  </div>
  ${innerHtml}
  <p style="margin-top:32px;color:#6b6050;font-size:12px;">Lancaster Evangelical Free Church · Rock Ideas &amp; Feedback</p>
</body></html>`;
}

function priorityPill(priority) {
  const p = priority || 'Medium';
  const color = p === 'High' ? '#AA3B24' : p === 'Low' ? '#524B30' : '#8a6310';
  return `<span style="display:inline-block;background:#f7eed7;border:1px solid ${color};color:${color};font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.04em;padding:2px 8px;border-radius:5px;">${escapeHtml(p)}</span>`;
}

function buildRockTicketEmail(p, portalUrl) {
  const url = portalUrl + '/bri';
  const title = p.title || '(untitled)';
  const submitter = p.submitter || 'Someone';
  const priority = p.priority || 'Medium';
  const desc = p.description || '';
  const subject = `New Rock idea: ${title}`;
  const plain = `${submitter} submitted a new idea/feedback for Rock.

Title: ${title}
Priority: ${priority}
${desc ? `\n${desc}\n` : ''}
View and respond on the board:
${url}

— Rock Ideas & Feedback`;
  const html = rockBrandShell(`
  <p><strong>${escapeHtml(submitter)}</strong> submitted a new idea/feedback for Rock.</p>
  <p style="font-size:17px;font-weight:800;margin:16px 0 6px;">${escapeHtml(title)}</p>
  <p style="margin:0 0 14px;">${priorityPill(priority)}</p>
  ${desc ? `<p style="background:#f7eed7;border-left:3px solid #524B30;padding:10px 14px;margin:6px 0 18px;">${escapeHtml(desc).replace(/\n/g, '<br>')}</p>` : ''}
  <p style="margin-top:22px;">${ctaButton('Open the board', url)}</p>`);
  return { subject, plain, html };
}

function buildRockCommentEmail(p, portalUrl) {
  const url = portalUrl + '/bri';
  const title = p.title || 'a ticket';
  const author = p.author || 'Someone';
  const isAdmin = !!p.isAdmin;
  const body = p.body || '';
  const who = author + (isAdmin ? ' (Admin)' : '');
  const subject = `New comment on "${title}"`;
  const plain = `${who} commented on "${title}".

${body}

View the full thread on the board:
${url}

— Rock Ideas & Feedback`;
  const html = rockBrandShell(`
  <p><strong>${escapeHtml(author)}</strong>${isAdmin ? ' <span style="background:#AA3B24;color:#fff;font-size:10px;font-weight:800;padding:1px 6px;border-radius:4px;text-transform:uppercase;">Admin</span>' : ''} commented on <strong>"${escapeHtml(title)}"</strong>.</p>
  <p style="background:#f7eed7;border-left:3px solid #524B30;padding:10px 14px;margin:14px 0 18px;">${escapeHtml(body).replace(/\n/g, '<br>')}</p>
  <p style="margin-top:22px;">${ctaButton('Open the board', url)}</p>`);
  return { subject, plain, html };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function formatTimestamp(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit',
      timeZone: 'America/New_York',
    });
  } catch { return iso; }
}
