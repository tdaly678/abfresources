/* ════════════════════════════════════════════════════════════════════
   ABF Resources — API proxy layer  (added 2026-08-03)

   All browser → Airtable traffic now flows through this worker. The
   Airtable PAT lives ONLY in the AIRTABLE_TOKEN secret; it is never
   sent to the browser. This layer enforces:

     • CORS origin allowlist (ALLOWED_ORIGINS var)
     • Signed session tokens (HMAC-SHA256, SESSION_SECRET secret)
     • Server-side password gate + admin PIN + phone-last-4 sign-in
       (hashes/phones never leave the server)
     • Per-table / per-owner write authorization
     • Response sanitization (phones & emails stripped for anonymous
       callers; request messages only for participants; feedback
       responses only for the owning teacher)
     • KV-backed rate limiting (RATE binding; fails open if absent)

   Endpoints (all JSON):
     POST /api/gate            {password}            → {ok, gateToken}
     POST /api/admin           {pin}                 → {ok, token}
     POST /api/signin          {role, id, pin}       → {ok, token, me}
                               (valid admin Bearer token bypasses pin)
     GET  /api/bootstrap       (optional Bearer)     → sanitized tables
     POST /api/proxy           {method, table, recordId, body, query}
                               (Bearer session/gate token; ACL below)
     POST /api/rock/gate       {password}            → {ok, token}
     GET  /api/rock/bootstrap  (rock Bearer)         → tickets/votes/comments
     POST /api/survey/submit   {survey, fields}      → public, rate-limited
     POST /api/survey/results  {survey, password}    → records
   ════════════════════════════════════════════════════════════════════ */

const TBL = {
  abfClasses:        'tblorq8AWWByXzgTu',
  teachers:          'tbloa5MWyhbLxIoC9',
  abfLeaders:        'tbl3dKd7NqiS3KRqU',
  courses:           'tblgq15R3SGaJ7V0p',
  sundays:           'tblN0ZSrYH4k9tlqM',
  availability:      'tblVMW4uGgwPoSPo4',
  requests:          'tblr0brmHkKaep6ez',
  changeLog:         'tblzU7ANhqp9HTvHB',
  settings:          'tblU0XGRCrWQJBPH6',
  feedbackTemplates: 'tblFuma2qufToaLV2',
  feedbackForms:     'tbl2gDQMd4zLBYC5v',
  feedbackResponses: 'tblv1DxkrUiqEZsYH',
  fieldSurvey:       'tbl5Hhks33h8eWX3B',
  preachingPrep:     'tblqkdRxqC72RAsjy',
  rockTickets:       'Rock Tickets',
  rockVotes:         'Rock Ticket Votes',
  rockComments:      'Rock Ticket Comments',
  // Public-by-URL pages (/preaching, /cbsetup.html). These had no auth
  // before the proxy either — parity is public read + rate-limited,
  // field-allowlisted writes. The win is that the PAT is gone.
  preachSundays:     'Preaching Sundays',
  preachAvail:       'Preaching Availability',
  preachConfig:      'Preaching Config',
  cbSignups:         'tblIY53Mbkhh8dbwg',
};

// Tables anyone may LIST through the proxy (public-parity pages).
const PUBLIC_READ = ['preachSundays', 'preachAvail', 'preachConfig', 'cbSignups'];

// Reverse lookup: table id/name → friendly key
const TBL_KEY = Object.fromEntries(Object.entries(TBL).map(([k, v]) => [v, k]));

const SURVEYS = { field: TBL.fieldSurvey, preachingprep: TBL.preachingPrep };

// Sessions last 60 days; gate tokens 30 days.
const SESSION_TTL_MS = 60 * 24 * 3600 * 1000;
const GATE_TTL_MS    = 30 * 24 * 3600 * 1000;

/* ─── entry point (called from index.js for /api/*) ─────────────────── */

export async function handleApi(request, env) {
  const url = new URL(request.url);
  const origin = request.headers.get('Origin') || '';
  const cors = corsFor(origin, env);

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }
  // Browser requests must come from an allowed origin. Non-browser
  // requests (no Origin header) are allowed — CORS is not the security
  // boundary here, the token/ACL checks below are.
  if (origin && !isAllowedOrigin(origin, env)) {
    return json({ error: 'origin not allowed' }, 403, cors);
  }

  try {
    const route = url.pathname.replace(/\/+$/, '');
    if (route === '/api/gate' && request.method === 'POST')            return await apiGate(request, env, cors);
    if (route === '/api/admin' && request.method === 'POST')           return await apiAdmin(request, env, cors);
    if (route === '/api/signin' && request.method === 'POST')          return await apiSignin(request, env, cors);
    if (route === '/api/bootstrap' && request.method === 'GET')        return await apiBootstrap(request, env, cors);
    if (route === '/api/proxy' && request.method === 'POST')           return await apiProxy(request, env, cors);
    if (route === '/api/rock/gate' && request.method === 'POST')       return await apiRockGate(request, env, cors);
    if (route === '/api/rock/bootstrap' && request.method === 'GET')   return await apiRockBootstrap(request, env, cors);
    if (route === '/api/survey/submit' && request.method === 'POST')   return await apiSurveySubmit(request, env, cors);
    if (route === '/api/survey/results' && request.method === 'POST')  return await apiSurveyResults(request, env, cors);
    return json({ error: 'not found' }, 404, cors);
  } catch (e) {
    console.error('[api]', url.pathname, e.stack || e.message);
    const status = e.status || 500;
    return json({ error: e.expose ? e.message : 'internal error' }, status, cors);
  }
}

/* ─── CORS ──────────────────────────────────────────────────────────── */

function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS ||
    'https://www.abfresources.com,https://abfresources.com')
    .split(',').map(s => s.trim()).filter(Boolean);
}
function isAllowedOrigin(origin, env) {
  const list = allowedOrigins(env);
  if (list.includes(origin)) return true;
  // localhost convenience for testing (http://localhost:*, http://127.0.0.1:*)
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}
function corsFor(origin, env) {
  const h = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
  if (origin && isAllowedOrigin(origin, env)) h['Access-Control-Allow-Origin'] = origin;
  return h;
}

function json(obj, status = 200, headers = {}) {
  return new Response(JSON.stringify(obj), {
    status, headers: { 'content-type': 'application/json', ...headers },
  });
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  e.expose = true;
  return e;
}

/* ─── crypto: hashing + signed tokens ───────────────────────────────── */

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  const raw = atob(str.replace(/-/g, '+').replace(/_/g, '/') + pad);
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}

async function hmacKey(env) {
  if (!env.SESSION_SECRET) throw httpError(500, 'SESSION_SECRET not configured');
  return crypto.subtle.importKey('raw', new TextEncoder().encode(env.SESSION_SECRET),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

async function signToken(env, payload) {
  const key = await hmacKey(env);
  const body = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)));
  return 'v1.' + body + '.' + b64url(sig);
}

async function verifyToken(env, token) {
  if (!token || !token.startsWith('v1.')) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const key = await hmacKey(env);
    const ok = await crypto.subtle.verify('HMAC', key, b64urlDecode(parts[2]),
      new TextEncoder().encode(parts[1]));
    if (!ok) return null;
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[1])));
    if (!payload.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch { return null; }
}

async function sessionFrom(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m ? verifyToken(env, m[1]) : null;
}

/* ─── rate limiting (KV; fails open if binding missing) ─────────────── */

function clientIp(request) {
  return request.headers.get('CF-Connecting-IP') || 'unknown';
}

// Returns true if UNDER the limit. Only call after a FAILED attempt for
// auth endpoints (so shared church-WiFi users doing it right never trip it).
async function rateCheck(env, key, limit, windowSec) {
  if (!env.RATE) return true; // KV not bound yet — fail open, log once
  try {
    const n = parseInt((await env.RATE.get(key)) || '0', 10);
    return n < limit;
  } catch { return true; }
}
async function rateBump(env, key, windowSec) {
  if (!env.RATE) return;
  try {
    const n = parseInt((await env.RATE.get(key)) || '0', 10) + 1;
    await env.RATE.put(key, String(n), { expirationTtl: windowSec });
  } catch { /* non-fatal */ }
}

/* ─── Airtable (server-side, secret token) ──────────────────────────── */

async function at(env, method, table, { recordId, body, query } = {}) {
  let path = '/' + encodeURIComponent(table);
  if (recordId) path += '/' + recordId;
  const qs = query ? '?' + query : '';
  const res = await fetch('https://api.airtable.com/v0/' + env.AIRTABLE_BASE_ID + path + qs, {
    method,
    headers: {
      'Authorization': 'Bearer ' + env.AIRTABLE_TOKEN,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const txt = await res.text();
    console.error('[airtable]', method, table, res.status, txt);
    throw httpError(res.status === 404 ? 404 : 502, 'Airtable ' + res.status);
  }
  return res.status === 204 ? null : res.json();
}

async function atListAll(env, table, extraQuery) {
  const out = [];
  let offset = null;
  do {
    const q = 'pageSize=100' + (offset ? '&offset=' + encodeURIComponent(offset) : '') +
      (extraQuery ? '&' + extraQuery : '');
    const page = await at(env, 'GET', table, { query: q });
    out.push(...(page.records || []));
    offset = page.offset || null;
  } while (offset);
  return out;
}

let _settingsCache = null; // { at: ms, map: {Key: Value} } — 60s TTL per isolate
async function getSetting(env, key) {
  if (!_settingsCache || Date.now() - _settingsCache.at > 60000) {
    const recs = await atListAll(env, TBL.settings);
    const map = {};
    for (const r of recs) {
      const f = r.fields || {};
      if (f.Key) map[f.Key] = String(f.Value || '').trim();
    }
    _settingsCache = { at: Date.now(), map };
  }
  return _settingsCache.map[key] || '';
}

/* ─── auth endpoints ────────────────────────────────────────────────── */

async function apiGate(request, env, cors) {
  const ip = clientIp(request);
  const rlKey = 'rl:gate:' + ip;
  if (!(await rateCheck(env, rlKey, 20, 900))) {
    return json({ error: 'Too many attempts. Try again in a few minutes.' }, 429, cors);
  }
  const { password } = await request.json();
  const expected = (await getSetting(env, 'passwordHash')).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expected)) {
    return json({ error: 'gate not configured' }, 500, cors);
  }
  const got = await sha256Hex(String(password || ''));
  if (got !== expected) {
    await rateBump(env, rlKey, 900);
    return json({ ok: false }, 401, cors);
  }
  const gateToken = await signToken(env, { gate: true, iat: Date.now(), exp: Date.now() + GATE_TTL_MS });
  return json({ ok: true, gateToken }, 200, cors);
}

async function apiAdmin(request, env, cors) {
  const ip = clientIp(request);
  const rlKey = 'rl:admin:' + ip;
  if (!(await rateCheck(env, rlKey, 5, 900))) {
    return json({ error: 'Too many attempts. Try again in a few minutes.' }, 429, cors);
  }
  const { pin } = await request.json();
  const expected = (await getSetting(env, 'adminPinHash')).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expected)) {
    return json({ error: 'admin override disabled' }, 403, cors);
  }
  const got = await sha256Hex(String(pin || ''));
  if (got !== expected) {
    await rateBump(env, rlKey, 900);
    return json({ ok: false }, 401, cors);
  }
  const token = await signToken(env, { adm: true, iat: Date.now(), exp: Date.now() + SESSION_TTL_MS });
  return json({ ok: true, token }, 200, cors);
}

async function apiSignin(request, env, cors) {
  const ip = clientIp(request);
  const { role, id, pin } = await request.json();
  if (!['teacher', 'leader'].includes(role) || !/^rec[A-Za-z0-9]{14,17}$/.test(String(id || ''))) {
    throw httpError(400, 'bad role or id');
  }
  const session = await sessionFrom(request, env);
  const isAdmin = !!(session && session.adm);

  const rlIp = 'rl:signin:' + ip;
  const rlId = 'rl:signin-id:' + id;
  if (!isAdmin) {
    if (!(await rateCheck(env, rlIp, 10, 900)) || !(await rateCheck(env, rlId, 5, 900))) {
      return json({ error: 'Too many attempts. Try again in a few minutes.' }, 429, cors);
    }
  }

  const table = role === 'teacher' ? TBL.teachers : TBL.abfLeaders;
  const rec = await at(env, 'GET', table, { recordId: id });
  const f = rec.fields || {};

  if (!isAdmin) {
    const digits = String(f.Phone || '').replace(/\D/g, '');
    const last4 = digits.length >= 4 ? digits.slice(-4) : '';
    if (!last4 || String(pin || '') !== last4) {
      await rateBump(env, rlIp, 900);
      await rateBump(env, rlId, 900);
      return json({
        ok: false,
        error: last4 ? 'PIN does not match.' : 'No phone number on file — contact Tom.',
      }, 401, cors);
    }
  }

  const token = await signToken(env, {
    role, id, adm: isAdmin, iat: Date.now(), exp: Date.now() + SESSION_TTL_MS,
  });
  // `me` is the only place a phone number ever goes back to a browser —
  // it's the signed-in person's own record.
  return json({ ok: true, token, me: { id: rec.id, fields: f } }, 200, cors);
}

/* ─── bootstrap (sanitized reads) ───────────────────────────────────── */

const TEACHER_PUBLIC_FIELDS = [
  'Name', 'Status', 'Home Class', 'Initials', 'Avatar Color', 'Bio', 'Tagline',
  'Active', 'Year Started Attending', 'LEFC Member', 'Teaching Contexts',
  'Has Taught Before', 'Weeks Taught', 'Affirms SoF & MFP', 'SoF Affirmed Date',
  'Past Venues', 'Other Venue Notes', 'Training',
];
const LEADER_PUBLIC_FIELDS = ['Name', 'ABF Class', 'Active'];

function pickFields(rec, allowed, extra = []) {
  const out = {};
  const f = rec.fields || {};
  for (const k of [...allowed, ...extra]) if (k in f) out[k] = f[k];
  return { id: rec.id, fields: out, createdTime: rec.createdTime };
}

async function apiBootstrap(request, env, cors) {
  const s = await sessionFrom(request, env); // null | gate | session | admin
  const signedIn = !!(s && (s.role || s.adm));
  const isAdmin = !!(s && s.adm);

  const [classes, teachers, leaders, courses, sundays, avail, reqs, fbTpls, fbForms, fbResps] =
    await Promise.all([
      atListAll(env, TBL.abfClasses),
      atListAll(env, TBL.teachers),
      atListAll(env, TBL.abfLeaders),
      atListAll(env, TBL.courses),
      atListAll(env, TBL.sundays),
      atListAll(env, TBL.availability),
      atListAll(env, TBL.requests),
      atListAll(env, TBL.feedbackTemplates),
      atListAll(env, TBL.feedbackForms),
      atListAll(env, TBL.feedbackResponses),
    ]);

  const contactExtra = signedIn ? ['Email'] : []; // phones NEVER go out here
  const outTeachers = teachers.map(r => pickFields(r, TEACHER_PUBLIC_FIELDS, contactExtra));
  const outLeaders  = leaders.map(r => pickFields(r, LEADER_PUBLIC_FIELDS, contactExtra));

  const outReqs = reqs.map(r => {
    const f = { ...(r.fields || {}) };
    const isParticipant = isAdmin || (s && s.role === 'teacher' && (f.Teacher || []).includes(s.id))
      || (s && s.role === 'leader' && (f['Requesting Leader'] || []).includes(s.id));
    if (!isParticipant) {
      delete f['Leader Message'];
      delete f['Teacher Response'];
    }
    return { id: r.id, fields: f, createdTime: r.createdTime };
  });

  let outResps = [];
  if (isAdmin) {
    outResps = fbResps;
  } else if (s && s.role === 'teacher') {
    const myFormIds = new Set(fbForms
      .filter(r => ((r.fields || {}).Teacher || []).includes(s.id)).map(r => r.id));
    outResps = fbResps.filter(r => (((r.fields || {}).Form) || []).some(fid => myFormIds.has(fid)));
  }

  return json({
    abfClasses: classes, teachers: outTeachers, abfLeaders: outLeaders,
    courses, sundays, availability: avail, requests: outReqs,
    feedbackTemplates: fbTpls, feedbackForms: fbForms, feedbackResponses: outResps,
  }, 200, cors);
}

/* ─── generic authorized write proxy ────────────────────────────────── */

// Field allowlists for non-admin writes
const FIELDS = {
  teacherCreate: [...TEACHER_PUBLIC_FIELDS, 'Email', 'Phone'],
  leaderCreate:  [...LEADER_PUBLIC_FIELDS, 'Email', 'Phone'],
  requestByLeader: ['Request ID', 'Status', 'Requesting Leader', 'ABF Class', 'Service',
    'Teacher', 'Course', 'Requested Sundays', 'Leader Message', 'Created At', 'Responded At'],
  requestByTeacher: ['Status', 'Teacher Response', 'Counter Sundays', 'Responded At'],
  changeLog: ['Summary', 'Table', 'Action', 'Record ID', 'Record Name', 'Changed By', 'Changed At', 'Details'],
  preachAvail: ['Key', 'DateISO', 'PreacherId', 'Preacher', 'Status', 'UpdatedAt'],
  preachSundays: ['Assigned Preacher'],
  cbSignups: ['Name', 'Date', 'Topic', 'Role', 'Submitted At'],
};

function assertFields(body, allowed) {
  // Supports both single-record ({fields}) and bulk ({records:[{id?,fields}]})
  const sets = (body && Array.isArray(body.records))
    ? body.records.map(r => (r && r.fields) || {})
    : [(body && body.fields) || {}];
  for (const f of sets) {
    for (const k of Object.keys(f)) {
      if (!allowed.includes(k)) throw httpError(403, 'field not allowed: ' + k);
    }
  }
}
function linksTo(body, field, id) {
  const v = ((body && body.fields) || {})[field];
  return Array.isArray(v) && v.length === 1 && v[0] === id;
}
async function ownsRecord(env, table, recordId, linkField, id) {
  const rec = await at(env, 'GET', table, { recordId });
  return (((rec.fields || {})[linkField]) || []).includes(id);
}

async function apiProxy(request, env, cors) {
  const s = await sessionFrom(request, env);
  const { method, table, recordId, body, query } = await request.json();

  if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(method)) throw httpError(400, 'bad method');
  const key = TBL_KEY[table] || (TBL[table] ? table : null);
  if (!key) throw httpError(403, 'unknown table');
  const tableId = TBL[key];
  if (recordId && !/^rec[A-Za-z0-9]{14,17}$/.test(recordId)) throw httpError(400, 'bad recordId');

  const isAdmin = !!(s && s.adm);
  const isTeacher = !!(s && s.role === 'teacher');
  const isLeader = !!(s && s.role === 'leader');
  const hasGate = !!(s && (s.gate || s.role || s.adm));
  const isRock = !!(s && s.rock);
  const ip = clientIp(request);

  // General write throttle for authenticated callers (per identity)
  const throttleKey = 'rl:proxy:' + (s ? (s.id || (s.adm ? 'admin' : s.rock ? 'rock:' + ip : 'gate:' + ip)) : 'anon:' + ip);
  if (!(await rateCheck(env, throttleKey, 240, 600))) {
    return json({ error: 'Slow down a little — too many requests.' }, 429, cors);
  }
  await rateBump(env, throttleKey, 600);

  let allowed = false;

  // Public-parity tables: anyone can list; writes are field-allowlisted
  // and rate-limited below.
  if (method === 'GET' && PUBLIC_READ.includes(key)) allowed = true;

  if (!allowed && isAdmin && !['settings'].includes(key)) allowed = true;
  else if (!allowed) switch (key) {
    case 'teachers':
      if (method === 'POST' && hasGate) { assertFields(body, FIELDS.teacherCreate); allowed = true; }
      if (method === 'PATCH' && isTeacher && recordId === s.id) { assertFields(body, FIELDS.teacherCreate); allowed = true; }
      break;
    case 'abfLeaders':
      if (method === 'POST' && hasGate) { assertFields(body, FIELDS.leaderCreate); allowed = true; }
      if (method === 'PATCH' && isLeader && recordId === s.id) { assertFields(body, FIELDS.leaderCreate); allowed = true; }
      break;
    case 'courses':
    case 'availability':
    case 'feedbackForms':
      if (method === 'POST' && isTeacher && linksTo(body, 'Teacher', s.id)) allowed = true;
      if ((method === 'PATCH' || method === 'DELETE') && isTeacher &&
          await ownsRecord(env, tableId, recordId, 'Teacher', s.id)) {
        // owner may not reassign the record to someone else
        if (method === 'PATCH' && body && body.fields && 'Teacher' in body.fields &&
            !linksTo(body, 'Teacher', s.id)) break;
        allowed = true;
      }
      break;
    case 'requests':
      if (method === 'POST' && isLeader && linksTo(body, 'Requesting Leader', s.id)) {
        assertFields(body, FIELDS.requestByLeader); allowed = true;
      }
      if (method === 'PATCH' && isTeacher &&
          await ownsRecord(env, tableId, recordId, 'Teacher', s.id)) {
        assertFields(body, FIELDS.requestByTeacher); allowed = true;
      }
      if ((method === 'PATCH' || method === 'DELETE') && isLeader &&
          await ownsRecord(env, tableId, recordId, 'Requesting Leader', s.id)) {
        if (method === 'PATCH') assertFields(body, FIELDS.requestByLeader);
        allowed = true;
      }
      break;
    case 'changeLog':
      if (method === 'POST' && hasGate) { assertFields(body, FIELDS.changeLog); allowed = true; }
      break;
    case 'feedbackResponses':
      if (method === 'POST') {
        // Public survey submission — rate-limited per IP.
        const k = 'rl:fbresp:' + ip;
        if (!(await rateCheck(env, k, 15, 3600))) {
          return json({ error: 'Too many submissions from this connection — try later.' }, 429, cors);
        }
        await rateBump(env, k, 3600);
        allowed = true;
      }
      break;
    case 'rockTickets':
    case 'rockVotes':
    case 'rockComments':
      if (isRock && ['POST', 'PATCH', 'DELETE'].includes(method)) allowed = true;
      break;
    case 'preachAvail': {
      // /preaching has no auth by design (name-picker page) — writes are
      // open but field-limited and rate-limited per IP.
      if (['POST', 'PATCH', 'DELETE'].includes(method)) {
        if (method !== 'DELETE') assertFields(body, FIELDS.preachAvail);
        const k = 'rl:preach:' + ip;
        if (!(await rateCheck(env, k, 120, 3600))) {
          return json({ error: 'Too many changes from this connection — try later.' }, 429, cors);
        }
        await rateBump(env, k, 3600);
        allowed = true;
      }
      break;
    }
    case 'preachSundays':
      // Only the assignment column is writable (admin "Plan" feature).
      if (method === 'PATCH') { assertFields(body, FIELDS.preachSundays); allowed = true; }
      break;
    case 'cbSignups':
      if (method === 'POST') {
        assertFields(body, FIELDS.cbSignups);
        const k = 'rl:cbsignup:' + ip;
        if (!(await rateCheck(env, k, 20, 3600))) {
          return json({ error: 'Too many submissions from this connection — try later.' }, 429, cors);
        }
        await rateBump(env, k, 3600);
        allowed = true;
      }
      break;
    default:
      break; // settings, feedbackTemplates, surveys, everything else: deny
  }

  if (!allowed) throw httpError(s ? 403 : 401, s ? 'not allowed' : 'sign in required');

  const result = await at(env, method, tableId, { recordId, body, query });

  // Never let a proxy response leak someone's phone number.
  if (result && result.fields && 'Phone' in result.fields &&
      !(s && (s.adm || s.id === result.id))) {
    delete result.fields.Phone;
  }
  return json(result === null ? { ok: true } : result, 200, cors);
}

/* ─── Rock board (/bri) ─────────────────────────────────────────────── */

async function apiRockGate(request, env, cors) {
  const ip = clientIp(request);
  const rlKey = 'rl:rockgate:' + ip;
  if (!(await rateCheck(env, rlKey, 10, 900))) {
    return json({ error: 'Too many attempts. Try again in a few minutes.' }, 429, cors);
  }
  const { password } = await request.json();
  const expected = String(env.ROCK_ACCESS_HASH || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expected)) {
    return json({ error: 'rock gate not configured' }, 500, cors);
  }
  if (await sha256Hex(String(password || '')) !== expected) {
    await rateBump(env, rlKey, 900);
    return json({ ok: false }, 401, cors);
  }
  const token = await signToken(env, { rock: true, iat: Date.now(), exp: Date.now() + SESSION_TTL_MS });
  return json({ ok: true, token }, 200, cors);
}

async function apiRockBootstrap(request, env, cors) {
  const s = await sessionFrom(request, env);
  if (!s || !(s.rock || s.adm)) throw httpError(401, 'rock sign in required');
  const [tickets, votes, comments] = await Promise.all([
    atListAll(env, TBL.rockTickets),
    atListAll(env, TBL.rockVotes),
    atListAll(env, TBL.rockComments),
  ]);
  return json({ tickets, votes, comments }, 200, cors);
}

/* ─── one-off surveys (field / preachingprep) ───────────────────────── */

async function apiSurveySubmit(request, env, cors) {
  const ip = clientIp(request);
  const k = 'rl:survey:' + ip;
  if (!(await rateCheck(env, k, 15, 3600))) {
    return json({ error: 'Too many submissions from this connection — try later.' }, 429, cors);
  }
  const { survey, fields } = await request.json();
  const tableId = SURVEYS[survey];
  if (!tableId) throw httpError(400, 'unknown survey');
  if (!fields || typeof fields !== 'object') throw httpError(400, 'missing fields');
  await rateBump(env, k, 3600);
  // typecast lets Airtable create select options on the fly (the survey
  // pages relied on this when posting directly).
  const result = await at(env, 'POST', tableId, { body: { fields, typecast: true } });
  return json({ ok: true, id: result.id }, 200, cors);
}

async function apiSurveyResults(request, env, cors) {
  const ip = clientIp(request);
  const rlKey = 'rl:svresults:' + ip;
  if (!(await rateCheck(env, rlKey, 20, 900))) {
    return json({ error: 'Too many attempts. Try again in a few minutes.' }, 429, cors);
  }
  const { survey, password } = await request.json();
  const tableId = SURVEYS[survey];
  if (!tableId) throw httpError(400, 'unknown survey');
  // Same site password as the main gate (results pages historically
  // checked Settings.passwordHash). A valid gate/session token works too.
  const s = await sessionFrom(request, env);
  let ok = !!(s && (s.gate || s.role || s.adm));
  if (!ok) {
    const expected = (await getSetting(env, 'passwordHash')).toLowerCase();
    ok = /^[0-9a-f]{64}$/.test(expected) &&
      (await sha256Hex(String(password || ''))) === expected;
  }
  if (!ok) {
    await rateBump(env, rlKey, 900);
    return json({ ok: false }, 401, cors);
  }
  const records = await atListAll(env, tableId);
  return json({ ok: true, records }, 200, cors);
}
