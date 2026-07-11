'use strict';

// Calendar resource — a de-identified, read-only ICS feed per clinician, plus the
// authenticated endpoints that expose and rotate the feed token.
//
//   GET  /calendar/{feed_token}.ics  → text/calendar (NO auth; token is the capability)
//   GET  /calendar/settings          → the caller's feed url + token   (Bearer JWT)
//   POST /calendar/regenerate        → rotate the token, revoking the old feed (Bearer JWT)
//
// HIPAA design constraint (not a preference): ZERO PHI leaves Reddably in the feed.
// A rendered event carries ONLY:
//   * SUMMARY  "Client session — M.W."   (client INITIALS only, never the name)
//   * DTSTART/DTEND as all-day VALUE=DATE (sessions carry a date, no clock time)
//   * DESCRIPTION = a single deep link back into the app: no name, DOB, phone,
//     diagnosis, CPT, or insurance anywhere.
// The de-identification is encoded as a unit test (calendar_ics.test.js) so it
// cannot silently regress.
//
// The feed authenticates by token ALONE — calendar apps (Google/Apple/Outlook)
// cannot send a JWT. So the token is treated as a capability: >=32 bytes of
// entropy (see migration 011), a constant-time comparison on lookup, and a
// "Regenerate" action that mints a new token and instantly revokes the old feed.
//
// Dates: sessions store session_date as a plain 'YYYY-MM-DD' string (the OID 1082
// type parser in lib/db.js keeps it a string end-to-end — see PR #49). We format
// it to an ICS DATE by pure string surgery and compute the exclusive all-day end
// purely in UTC, so there is NO Date-object timezone shift.

const crypto = require('crypto');
const db = require('../lib/db');
const { requireAuth } = require('../lib/auth');
const { json, preflight } = require('../lib/response');
const { audit } = require('../lib/audit');

// Deep-link base for the app shell (matches lib/email.js / payment_link.js).
const APP_BASE_URL = (process.env.APP_BASE_URL || 'https://claims.sessionably.com').replace(/\/+$/, '');

// UID / PRODID domain — stable, opaque, non-PHI.
const CAL_DOMAIN = 'reddably.com';

// A token is 32 bytes rendered as 64 lowercase hex chars.
const FEED_TOKEN_RE = /^[0-9a-f]{64}$/i;

// Rolling feed window: recent past + near future, so the calendar stays small and
// relevant. Computed in SQL with current_date so there is no JS date math.
const WINDOW_PAST_DAYS = 30;
const WINDOW_FUTURE_DAYS = 90;

// --- request helpers ---------------------------------------------------------

function httpMethod(event) {
  if (!event) return '';
  if (event.httpMethod) return event.httpMethod;
  const ctx = event.requestContext;
  return (ctx && ctx.http && ctx.http.method) || '';
}

function requestPath(event) {
  const ctx = (event && event.requestContext) || {};
  if (ctx.http && ctx.http.path) return ctx.http.path;
  return event && event.rawPath ? event.rawPath : '';
}

function feedTokenParam(event) {
  return event && event.pathParameters ? event.pathParameters.feed_token : undefined;
}

// The public host the client actually reached us on (custom domain: api.reddably.com
// / api.claimsub.com), so the feed url we hand back points at the right origin.
function selfBaseUrl(event) {
  const headers = (event && event.headers) || {};
  const host = headers.host || headers.Host;
  const proto = headers['x-forwarded-proto'] || headers['X-Forwarded-Proto'] || 'https';
  if (host) return `${proto}://${host}`;
  return process.env.API_BASE_URL || 'https://api.reddably.com';
}

// --- token capability ---------------------------------------------------------

// Strip a trailing ".ics" (case-insensitive). Calendar apps generally require the
// URL to end in .ics; API Gateway cannot put a literal suffix after a path
// variable, so the route captures "{feed_token}" as "<token>.ics" and we peel it.
function stripIcsSuffix(raw) {
  const s = String(raw == null ? '' : raw);
  return s.replace(/\.ics$/i, '');
}

// Constant-time equality for two same-length hex token strings. Length is not a
// secret (always 64), so an early length return is fine; the byte compare below
// is what avoids a per-character timing oracle.
function timingSafeTokenEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// --- ICS rendering (pure; exported for unit tests) ----------------------------

// Client INITIALS only, e.g. Maia White -> "M.W.". First alphanumeric letter of
// first + last name, uppercased, each dotted. Never emits the full name.
function initials(firstName, lastName) {
  const letter = (s) => {
    const m = String(s == null ? '' : s).trim().match(/[A-Za-z0-9]/);
    return m ? m[0].toUpperCase() : '';
  };
  const parts = [];
  const fi = letter(firstName);
  const li = letter(lastName);
  if (fi) parts.push(fi + '.');
  if (li) parts.push(li + '.');
  return parts.join('');
}

// RFC 5545 §3.3.11 text escaping: backslash, semicolon, comma, and newlines.
function escapeText(value) {
  return String(value == null ? '' : value)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

// 'YYYY-MM-DD' -> 'YYYYMMDD' by pure string surgery (no Date, no shift).
function toIcsDate(ymd) {
  return String(ymd == null ? '' : ymd).slice(0, 10).replace(/-/g, '');
}

// Exclusive all-day end date: the day AFTER session_date, formatted 'YYYYMMDD'.
// Computed and read entirely in UTC so the process timezone can never shift it.
function nextIcsDate(ymd) {
  const parts = String(ymd == null ? '' : ymd).slice(0, 10).split('-');
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  const d = Number(parts[2]);
  const dt = new Date(Date.UTC(y, m - 1, d + 1));
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}${mm}${dd}`;
}

// RFC 5545 §3.1 content-line folding: no line may exceed 75 OCTETS; longer lines
// are split with a CRLF followed by a single leading space (which counts toward
// the 75 on continuation lines). Split on UTF-8 byte boundaries so a multibyte
// char (e.g. the em dash) is never cut in half.
function foldLine(line) {
  const MAX = 75;
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= MAX) return line;
  const out = [];
  let idx = 0;
  let first = true;
  while (idx < bytes.length) {
    const limit = first ? MAX : MAX - 1; // continuation lines carry a leading space
    let take = Math.min(limit, bytes.length - idx);
    // Back off so we don't split in the middle of a UTF-8 multibyte sequence.
    while (take > 0 && idx + take < bytes.length && (bytes[idx + take] & 0xc0) === 0x80) {
      take -= 1;
    }
    const piece = bytes.slice(idx, idx + take).toString('utf8');
    out.push(first ? piece : ' ' + piece);
    idx += take;
    first = false;
  }
  return out.join('\r\n');
}

// Render one VEVENT for a session. `s` is a plain shape (no DB):
//   { session_id, session_date ('YYYY-MM-DD'), first_name, last_name, client_id,
//     dtstamp ('YYYYMMDDTHHMMSSZ') }
// De-identified: SUMMARY carries initials only; DESCRIPTION is a deep link only.
function renderEvent(s) {
  const summary = `Client session — ${initials(s.first_name, s.last_name)}`;
  const link = `${APP_BASE_URL}/app/app.html#clients/${encodeURIComponent(s.client_id)}`;
  const lines = [
    'BEGIN:VEVENT',
    `UID:session-${s.session_id}@${CAL_DOMAIN}`,
    `DTSTAMP:${s.dtstamp}`,
    `DTSTART;VALUE=DATE:${toIcsDate(s.session_date)}`,
    `DTEND;VALUE=DATE:${nextIcsDate(s.session_date)}`,
    `SUMMARY:${escapeText(summary)}`,
    `DESCRIPTION:${escapeText(link)}`,
    'STATUS:CONFIRMED',
    'TRANSP:TRANSPARENT',
    'END:VEVENT',
  ];
  return lines.map(foldLine).join('\r\n');
}

// Render a full VCALENDAR wrapping the events. Pure — deterministic given inputs.
function renderCalendar(sessions) {
  const head = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:-//Sessionably Claims//Calendar Feed//EN`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:Sessionably Claims Sessions',
  ];
  const body = (Array.isArray(sessions) ? sessions : []).map(renderEvent);
  const tail = ['END:VCALENDAR'];
  // Trailing CRLF per RFC 5545 (a final blank line after END:VCALENDAR).
  return head.map(foldLine).concat(body, tail).join('\r\n') + '\r\n';
}

// --- responses ----------------------------------------------------------------

function icsResponse(body) {
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': 'inline; filename="reddably.ics"',
      'Cache-Control': 'private, max-age=300, no-transform',
    },
    body,
  };
}

// A bad/unknown token reveals nothing: 404, plain text, no body data.
function notFound() {
  return {
    statusCode: 404,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    body: 'Not found',
  };
}

// --- public feed --------------------------------------------------------------

async function servePublicFeed(rawToken, event) {
  const token = stripIcsSuffix(rawToken);
  if (!FEED_TOKEN_RE.test(token)) return notFound();

  // Indexed unique probe by token, then an explicit constant-time compare against
  // the stored value as a belt-and-suspenders guard on the capability check.
  const userRes = await db.query(
    `select id, practice_id, calendar_feed_token
       from users
      where calendar_feed_token = $1 and is_active = true
      limit 1`,
    [token]
  );
  const user = userRes.rows[0];
  if (!user || !timingSafeTokenEqual(token, user.calendar_feed_token)) {
    return notFound();
  }

  // Rolling window computed in SQL (current_date) — no JS date math, no shift.
  // Practice-scoped AND clinician-scoped; hidden sessions/clients excluded.
  const sessRes = await db.query(
    `select s.id                                                            as session_id,
            s.session_date,
            c.id                                                            as client_id,
            c.first_name,
            c.last_name,
            to_char(coalesce(s.updated_at, s.created_at) at time zone 'UTC',
                    'YYYYMMDD"T"HH24MISS"Z"')                               as dtstamp
       from sessions s
       join clients c on c.id = s.client_id
      where s.clinician_id = $1
        and s.practice_id = $2
        and s.is_hidden = false
        and c.is_hidden = false
        and s.session_date >= (current_date - ($3 || ' days')::interval)
        and s.session_date <= (current_date + ($4 || ' days')::interval)
      order by s.session_date asc, s.id asc`,
    [user.id, user.practice_id, WINDOW_PAST_DAYS, WINDOW_FUTURE_DAYS]
  );

  return icsResponse(renderCalendar(sessRes.rows));
}

// --- authenticated feed management --------------------------------------------

// Load (provisioning if missing) the caller's feed token. The migration backfills
// and defaults the column, so this is normally a plain read; the coalesce covers a
// user created before the migration or in a rare race.
async function getFeedSettings(userId, event) {
  const res = await db.query(
    `update users
        set calendar_feed_token = coalesce(calendar_feed_token, encode(gen_random_bytes(32), 'hex'))
      where id = $1 and is_active = true
      returning calendar_feed_token`,
    [userId]
  );
  const row = res.rows[0];
  if (!row) return json(401, { error: 'Unauthorized' }, event);
  const token = row.calendar_feed_token;
  const feedUrl = `${selfBaseUrl(event)}/calendar/${token}.ics`;
  return json(200, { calendar_feed: { feed_token: token, feed_url: feedUrl } }, event);
}

// Rotate the token: mint a new one, which instantly revokes the old feed (the old
// token no longer matches any row -> 404). Audited (no PHI, no token value).
async function regenerateFeed(caller, event) {
  const res = await db.query(
    `update users
        set calendar_feed_token = encode(gen_random_bytes(32), 'hex')
      where id = $1 and is_active = true
      returning calendar_feed_token`,
    [caller.id]
  );
  const row = res.rows[0];
  if (!row) return json(401, { error: 'Unauthorized' }, event);

  await audit(event, { userId: caller.id, practiceId: caller.practice_id }, {
    action: 'calendar_feed.regenerate',
    resourceType: 'calendar_feed',
    resourceId: caller.id,
  });

  const token = row.calendar_feed_token;
  const feedUrl = `${selfBaseUrl(event)}/calendar/${token}.ics`;
  return json(200, { calendar_feed: { feed_token: token, feed_url: feedUrl } }, event);
}

async function loadCaller(userId) {
  const res = await db.query(
    `select id, practice_id, is_active from users where id = $1 limit 1`,
    [userId]
  );
  return res.rows[0] || null;
}

// --- entrypoint ---------------------------------------------------------------

// Pure helpers exported for unit tests (Lambda only calls .handler).
exports.initials = initials;
exports.escapeText = escapeText;
exports.toIcsDate = toIcsDate;
exports.nextIcsDate = nextIcsDate;
exports.foldLine = foldLine;
exports.renderEvent = renderEvent;
exports.renderCalendar = renderCalendar;
exports.stripIcsSuffix = stripIcsSuffix;
exports.timingSafeTokenEqual = timingSafeTokenEqual;

exports.handler = async (event) => {
  const method = httpMethod(event);
  if (method === 'OPTIONS') {
    return preflight(event);
  }

  try {
    // Public, token-authed ICS feed: no JWT (calendar apps can't send one).
    const rawToken = feedTokenParam(event);
    if (method === 'GET' && rawToken != null) {
      return await servePublicFeed(rawToken, event);
    }

    // Everything else is a staff management route and requires a Bearer JWT.
    let auth;
    try {
      auth = requireAuth(event);
    } catch (err) {
      return json(err.statusCode || 401, { error: 'Unauthorized' }, event);
    }

    const path = requestPath(event);
    if (method === 'GET' && /\/calendar\/settings$/.test(path)) {
      return await getFeedSettings(auth.user.sub, event);
    }
    if (method === 'POST' && /\/calendar\/regenerate$/.test(path)) {
      const caller = await loadCaller(auth.user.sub);
      if (!caller || caller.is_active === false) {
        return json(401, { error: 'Unauthorized' }, event);
      }
      return await regenerateFeed(caller, event);
    }

    return json(405, { error: 'Method not allowed' }, event);
  } catch (err) {
    console.error('calendar error:', err && err.message);
    return json(500, { error: 'Internal server error' }, event);
  }
};
