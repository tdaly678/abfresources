/**
 * ABF Email Worker
 *
 * Cloudflare Worker that polls Airtable on a cron and sends transactional
 * emails via Brevo (migrated from SendGrid 2026-07-30) for these event types:
 *
 *   A. New teaching request   →  email teacher
 *   B. Teacher responded      →  email leader
 *      ...unless the LEADER was the one who acted (accepting or declining a
 *      counter-proposal), in which case it emails the teacher instead.
 *   D. New feedback response  →  email teacher
 *   E. Unanswered-request reminder → nudge whoever the request is waiting on,
 *      every 5 days (5 × 24h) until it's answered, during the 7am hour
 *      America/New_York. Pending nudges the teacher; Counter-Proposed nudges
 *      the leader. Stops once all the Sundays in question have passed.
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
 */

const STATUSES_TO_EMAIL = ['Accepted', 'Declined', 'Counter-Proposed'];

import { handleApi } from './api.js';

export default {
  async scheduled(event, env, ctx) {
    const cfg = buildConfig(env);
    const results = { newRequests: 0, statusChanges: 0, newFeedback: 0, reminders: 0, errors: [] };

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

    if (path !== '/run') {
      return new Response('ABF email worker. POST /run with auth to trigger.', { status: 200 });
    }
    const cfg = buildConfig(env);
    const auth = request.headers.get('x-trigger-auth');
    if (auth !== env.MANUAL_TRIGGER_AUTH) return new Response('forbidden', { status: 403 });
    const results = {
      newRequests: await processNewRequests(cfg),
      statusChanges: await processStatusChanges(cfg),
      newFeedback: await processNewFeedbackResponses(cfg),
      // Manual runs bypass the 7am gate so reminders are testable on demand.
      reminders: await processPendingReminders(cfg, true),
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
  const formula = `AND({Created Email Sent At}=BLANK(), {Teacher}!='', {Requesting Leader}!='')`;
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
      const message      = req.fields['Leader Message'] || '(no message)';

      if (!teacherEmail) continue;

      // BCC all OTHER leaders of this ABF (the requesting leader sent this, no need to re-notify)
      const classLeaderBccs = await getClassLeaderEmails(cfg, classId, leaderId);

      const email = buildNewRequestEmail({
        teacherName, leaderName, className, service, room, courseTitle, sundayDates, message,
        portalUrl: cfg.portalUrl + '/?tab=scheduling',
      });

      if (cfg.dryRun) {
        console.log('DRY_RUN A:', JSON.stringify({ to: teacherEmail, subject: email.subject, bccs: classLeaderBccs }));
      } else {
        await sendgridSend(cfg, { to: teacherEmail, toName: teacherName, ...email, extraBccs: classLeaderBccs });
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
      const teacherResp   = req.fields['Teacher Response'] || '(no note from the teacher)';
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
      if (leaderActed) {
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
        });
      }

      if (cfg.dryRun) {
        console.log('DRY_RUN B:', JSON.stringify({ to: toEmail, status, leaderActed, subject: email.subject, bccs: classLeaderBccs }));
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

      const email = buildFeedbackResponseEmail({
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
// Nudging stops once every requested Sunday is in the past — a request for
// dates that have already come and gone is moot, and shouldn't nag forever.
//
// force=true (manual /run) bypasses the 7am gate for testing; the rolling
// stamp still prevents more than one nudge per day per request.

const REMINDER_EVERY_HOURS = 5 * 24;
const REMINDER_SEND_HOUR = 7; // 7am America/New_York

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
      if (!((now - baseline) / 36e5 > REMINDER_EVERY_HOURS)) continue;

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

      // Stop nagging once every date in question has passed.
      const today = new Date().toISOString().slice(0, 10);
      if (sundayDates.length && sundayDates.every(d => String(d).slice(0, 10) < today)) continue;

      const daysWaiting = Math.floor((now - phaseStart) / 36e5 / 24);

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

// ─── Airtable client ────────────────────────────────────────────────────────

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

async function sendgridSend(cfg, { to, toName, subject, plain, html, extraBccs = [] }) {
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
    replyTo: { email: cfg.fromEmail, name: cfg.fromName },
    to: [{ email: to, name: toName || to }],
    subject,
    textContent: plain,
    htmlContent: html,
  };
  if (allBccs.length) payload.bcc = allBccs.map(email => ({ email }));
  await brevoRequest(cfg, payload);
}

// Send one email to several recipients (all on the To line). Used by the Rock board.
async function sendgridSendMulti(cfg, { to, subject, plain, html }) {
  const recipients = (Array.isArray(to) ? to : [to]).filter(Boolean).map(email => ({ email }));
  await brevoRequest(cfg, {
    sender: { email: cfg.fromEmail, name: cfg.fromName },
    replyTo: { email: cfg.fromEmail, name: cfg.fromName },
    to: recipients,
    subject,
    textContent: plain,
    htmlContent: html,
  });
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
  const where = [service, room ? `Room ${room}` : ''].filter(Boolean).join(' · ');
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

function buildNewRequestEmail({ teacherName, leaderName, className, service, room, courseTitle, sundayDates, message, portalUrl }) {
  const compactShort = fmtSundaysCompact(sundayDates, true);
  const subject = `${leaderName} asked you to teach ${className}${compactShort ? ` — ${compactShort}` : ''}`;
  const rows = [
    ...requestRows({ className, service, room, courseTitle }),
    sundayRow('Sundays', sundayDates),
  ];
  const plain = `Hi ${teacherName},

${leaderName} just asked you to teach in ${className}.

${detailsPlain(rows)}

Their message:
${message}

Open the portal to accept, decline, or suggest different Sundays:
${portalUrl}

— ABF Scheduling`;
  const html = brandShell(`
  <p>Hi <strong>${escapeHtml(teacherName)}</strong>,</p>
  <p><strong>${escapeHtml(leaderName)}</strong> just asked you to teach in <strong>${escapeHtml(className)}</strong>.</p>
  ${detailsHtml(rows)}
  <p style="margin-top:18px;"><strong>Their message:</strong></p>
  <p style="background:#faf7ef;border-left:3px solid #524B30;padding:10px 14px;margin:6px 0 18px;">${escapeHtml(message).replace(/\n/g, '<br>')}</p>
  <p style="font-size:13px;color:#6b6050;">You can accept, decline, or suggest different Sundays from the portal.</p>
  <p style="margin-top:22px;">${ctaButton('Open the portal to respond', portalUrl)}</p>`);
  return { subject, plain, html };
}

function buildStatusChangeEmail({ leaderName, teacherName, className, service, room, courseTitle, status, teacherResp, requestedDates, counterDates, portalUrl }) {
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

  const plain = `Hi ${leaderName},

${lead}

${detailsPlain(rows)}

Their note:
${teacherResp}

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
  ${countered ? `<p style="font-size:13px;color:#6b6050;">Nothing is booked yet — the request is waiting on you to accept or decline these dates.</p>` : ''}
  <p style="margin-top:22px;">${ctaButton(countered ? 'Accept or decline these Sundays' : 'Open the portal', portalUrl)}</p>`);
  return { subject, plain, html };
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
function buildCounterResolvedEmail({ teacherName, leaderName, className, service, room, courseTitle, status, agreedDates, leaderReply, portalUrl }) {
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

  const replyPlain = leaderReply ? `\n${leaderName}'s note:\n${leaderReply}\n` : '';
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
       <p style="background:#faf7ef;border-left:3px solid ${accent};padding:10px 14px;margin:6px 0 18px;">${escapeHtml(leaderReply).replace(/\n/g, '<br>')}</p>`
    : '';
  const html = brandShell(`
  <p>Hi <strong>${escapeHtml(teacherName)}</strong>,</p>
  <p><strong>${escapeHtml(leaderName)}</strong> <span style="color:${accent};font-weight:700;text-transform:uppercase;letter-spacing:.04em;">${accepted ? 'accepted' : 'declined'}</span> the Sundays you suggested for <strong>${escapeHtml(className)}</strong>.${accepted ? " You're on the schedule." : ' This request is now closed — nothing has been added to your schedule.'}</p>
  ${detailsHtml(rows, accent)}
  ${replyHtml}
  <p style="margin-top:22px;">${ctaButton('Open the portal', portalUrl)}</p>`);
  return { subject, plain, html };
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
