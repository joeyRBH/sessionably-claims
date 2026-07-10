'use strict';

// POST /register — two modes: new_practice | invitation.
// API Gateway proxy integration handler.

const db = require('../lib/db');
const { hash } = require('../lib/password');
const { sign } = require('../lib/jwt');
const { json, preflight } = require('../lib/response');
const { audit } = require('../lib/audit');
const {
  normalizeEmail,
  baseSlug,
  randomSlugSuffix,
  publicUser,
  parseBody,
} = require('../lib/util');

const MAX_SLUG_ATTEMPTS = 5;

const PG_UNIQUE_VIOLATION = '23505';

// Pure invitation-acceptance guard (exported for unit tests). Enforces, in order:
// single-use (status must be 'pending' — an accepted/revoked/expired row is dead),
// expiry (expires_at must exist and be in the future), and that the account being
// created belongs to the invited email (the token alone must not let someone claim
// an arbitrary address). Returns { ok: true } or { ok: false, code, clientMessage? }.
function validateInvitationForAccept(invite, providedEmail, nowMs) {
  if (!invite) return { ok: false, code: 'invalid' };
  if (invite.status !== 'pending') return { ok: false, code: 'invalid' };
  if (!invite.expires_at) return { ok: false, code: 'invalid' };
  const exp = new Date(invite.expires_at).getTime();
  if (Number.isNaN(exp) || exp <= nowMs) return { ok: false, code: 'expired' };
  if (normalizeEmail(invite.email) !== normalizeEmail(providedEmail)) {
    return {
      ok: false,
      code: 'email_mismatch',
      clientMessage: 'This invitation was sent to a different email address.',
    };
  }
  return { ok: true };
}

function missing(fields, body) {
  return fields.filter((f) => !body[f] || String(body[f]).trim() === '');
}

async function registerNewPractice(body, event) {
  const required = ['practice_name', 'email', 'password', 'first_name', 'last_name'];
  const absent = missing(required, body);
  if (absent.length) {
    return json(400, { error: `Missing required fields: ${absent.join(', ')}` }, event);
  }

  const email = normalizeEmail(body.email);
  const passwordHash = await hash(body.password);
  const base = baseSlug(body.practice_name);

  let user;
  try {
    user = await db.withTransaction(async (client) => {
      // Insert the practice, regenerating the slug with a fresh random suffix if
      // it collides (NOT NULL UNIQUE). A SAVEPOINT keeps a failed attempt from
      // poisoning the surrounding transaction. First attempt uses the bare base.
      let practiceId;
      let slug = base;
      for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt += 1) {
        await client.query('savepoint slug_attempt');
        try {
          const practiceRes = await client.query(
            `insert into practices (name, slug, default_fee_payer, platform_fee_percent)
             values ($1, $2, 'client', 5.00)
             returning id`,
            [String(body.practice_name).trim(), slug]
          );
          practiceId = practiceRes.rows[0].id;
          await client.query('release savepoint slug_attempt');
          break;
        } catch (err) {
          if (err && err.code === PG_UNIQUE_VIOLATION) {
            await client.query('rollback to savepoint slug_attempt');
            slug = `${base}-${randomSlugSuffix()}`;
            continue;
          }
          throw err;
        }
      }
      if (!practiceId) {
        const e = new Error('slug_attempts_exhausted'); // surfaces as a clean 500
        e.statusCode = 500;
        throw e;
      }

      const userRes = await client.query(
        `insert into users (practice_id, role, first_name, last_name, email, password_hash)
         values ($1, 'practice_admin', $2, $3, $4, $5)
         returning *`,
        [practiceId, String(body.first_name).trim(), String(body.last_name).trim(), email, passwordHash]
      );
      return userRes.rows[0];
    });
  } catch (err) {
    if (err && err.code === PG_UNIQUE_VIOLATION) {
      // Could be email or slug; return a generic message (no user-enumeration).
      return json(409, { error: 'Could not create account.' }, event);
    }
    throw err;
  }

  const token = sign(user);
  return json(201, { token, user: publicUser(user) }, event);
}

async function registerFromInvitation(body, event) {
  const required = ['invite_token', 'email', 'password', 'first_name', 'last_name'];
  const absent = missing(required, body);
  if (absent.length) {
    return json(400, { error: `Missing required fields: ${absent.join(', ')}` }, event);
  }

  const email = normalizeEmail(body.email);
  const passwordHash = await hash(body.password);

  let user;
  let acceptedInviteId = null;
  try {
    user = await db.withTransaction(async (client) => {
      // Lock the invitation row to serialize concurrent accepts (the first accept
      // flips status to 'accepted'; a second blocks here, then reads the updated
      // row and is rejected by the single-use guard below).
      const inviteRes = await client.query(
        `select id, practice_id, role, email, status, expires_at
           from invitations
          where token = $1
          for update`,
        [body.invite_token]
      );
      const invite = inviteRes.rows[0];

      // Single-use + expiry + invited-email match, all enforced server-side.
      const check = validateInvitationForAccept(invite, email, Date.now());
      if (!check.ok) {
        const e = new Error(check.code);
        e.statusCode = 400;
        if (check.clientMessage) e.clientMessage = check.clientMessage;
        throw e;
      }

      const userRes = await client.query(
        `insert into users (practice_id, role, first_name, last_name, email, password_hash)
         values ($1, $2, $3, $4, $5, $6)
         returning *`,
        [
          invite.practice_id,
          invite.role,
          String(body.first_name).trim(),
          String(body.last_name).trim(),
          email,
          passwordHash,
        ]
      );
      const newUser = userRes.rows[0];

      await client.query(
        `update invitations
            set status = 'accepted', accepted_at = now(), accepted_user_id = $1
          where id = $2`,
        [newUser.id, invite.id]
      );
      acceptedInviteId = invite.id;
      return newUser;
    });
  } catch (err) {
    if (err && err.statusCode === 400) {
      return json(
        400,
        { error: err.clientMessage || 'This invitation is invalid, expired, or already used.' },
        event
      );
    }
    if (err && err.code === PG_UNIQUE_VIOLATION) {
      return json(409, { error: 'Could not create account.' }, event);
    }
    throw err;
  }

  // Audit the acceptance (HIPAA audit log; no PHI). Actor is the just-created user.
  await audit(event, { userId: user.id, practiceId: user.practice_id }, {
    action: 'invitation.accept',
    resourceType: 'invitation',
    resourceId: acceptedInviteId,
    metadata: { role: user.role },
  });

  const token = sign(user);
  return json(201, { token, user: publicUser(user) }, event);
}

// Exported for unit testing the acceptance guard (Lambda only calls .handler).
exports.validateInvitationForAccept = validateInvitationForAccept;

exports.handler = async (event) => {
  if (event && event.httpMethod === 'OPTIONS') {
    return preflight(event);
  }
  try {
    const body = parseBody(event);
    const mode = body.mode;

    if (mode === 'new_practice') {
      return await registerNewPractice(body, event);
    }
    if (mode === 'invitation') {
      return await registerFromInvitation(body, event);
    }
    // TODO(magic-link): client (patient) self-registration via magic link will land
    // here as a separate mode once the /send-email endpoint exists.
    return json(400, { error: "Invalid mode. Expected 'new_practice' or 'invitation'." }, event);
  } catch (err) {
    console.error('register error:', err && err.message); // never log body/password
    return json(500, { error: 'Internal server error' }, event);
  }
};
