# Claimsub backend

Node.js AWS Lambda handlers (API Gateway proxy integration) behind
`https://api.claimsub.com`. This folder currently covers **core authentication**:
email + password registration and login for clinicians and admins, issuing JWTs.

## Layout

```
backend/
  package.json            deps: pg, bcryptjs, jsonwebtoken
  .env.example            required env vars (no real values)
  lib/
    db.js                 module-scope pg Pool; query() + withTransaction(); parameterized only
    password.js           hash() / compare() via bcryptjs (cost 12)
    jwt.js                sign(user) / verify(token); claims: sub, practice_id, role
    response.js           json(status, body, event) + preflight() with CORS
    auth.js               requireAuth(event) -> { user } or throws AuthError (401)
    util.js               normalizeEmail, slugifyPracticeName, publicUser, parseBody
  handlers/
    register.js           POST /register
    login.js              POST /login
    me.js                 GET  /me
```

## Routes → handlers

| Method | Path        | Handler                       | Auth        |
| ------ | ----------- | ----------------------------- | ----------- |
| POST   | `/register` | `handlers/register.handler`   | public      |
| POST   | `/login`    | `handlers/login.handler`      | public      |
| GET    | `/me`       | `handlers/me.handler`         | Bearer JWT  |

Each handler is an API Gateway proxy integration and answers its own `OPTIONS`
preflight, so wire `ANY` (or `POST,OPTIONS` / `GET,OPTIONS`) for each route to the
matching handler.

### `POST /register`

Two modes, switched by `mode` in the JSON body:

- `mode: "new_practice"` — `{ practice_name, email, password, first_name, last_name }`.
  In one transaction: insert a `practices` row (`default_fee_payer='client'`,
  `platform_fee_percent=5.00`, generated unique `slug`), then a `users` row with
  `role='practice_admin'`.
- `mode: "invitation"` — `{ invite_token, email, password, first_name, last_name }`.
  Looks up a `pending`, non-expired invitation (row-locked), creates the `users` row
  with the invitation's `role` + `practice_id`, then marks the invitation `accepted`.
  Invalid/expired/used tokens → `400`.

On success returns `201 { token, user }` (never `password_hash`). Duplicate email →
generic `409` (no user-enumeration).

### `POST /login`

`{ email, password }`. Finds the active user by normalized email and `bcrypt.compare`s.
Any failure (no user / inactive / bad password) → the same `401 Invalid email or
password`. Success updates `last_login_at` and returns `200 { token, user }`.

### `GET /me`

`Authorization: Bearer <jwt>`. Re-loads the user from the DB (so a deactivated user
can't keep acting on a live token) and returns `200 { user, practice: { id, name, role } }`.
Missing/invalid/expired token → `401`.

## Environment variables

| Var              | Required | Default | Notes                                                        |
| ---------------- | -------- | ------- | ------------------------------------------------------------ |
| `DATABASE_URL`   | yes      | —       | `postgres://USER:PASS@HOST:5432/DB`. RDS, inside the VPC.    |
| `JWT_SECRET`     | yes      | —       | HS256 signing secret. Long random value (`openssl rand -hex 32`). |
| `JWT_EXPIRES_IN` | no       | `12h`   | Token lifetime (zeit/ms string).                             |
| `DB_SSL`         | no       | (TLS)   | Set to `disable` only for local plaintext Postgres.          |
| `DB_POOL_MAX`    | no       | `2`     | Max pooled connections per warm container.                   |

Secrets come from the environment only — never committed. See `.env.example`.

## Local setup

```bash
cd backend
npm install
cp .env.example .env   # then fill in real values locally (do not commit)
```

There is no build step. Handlers are plain CommonJS modules; deploy the folder (with
`node_modules`) as your Lambda artifact, or bundle per-handler with your packaging tool.

## Security notes

- Parameterized queries only — no string-concatenated SQL.
- Generic auth errors on both register and login (no user-enumeration).
- bcryptjs cost factor 12.
- CORS allows `https://app.claimsub.com` and `https://claimsub.com`; methods
  `GET, POST, OPTIONS`; headers `Content-Type, Authorization`. Preflight handled.
- Never logs passwords, tokens, or PHI.
- Request rate-limiting is expected at the API Gateway / WAF layer (not implemented here).

## Not in this task (clear TODO hooks left in code)

- **Google OAuth** — needs Google client credentials. The `users.google_oauth_sub`
  column exists; a `mode`/handler will slot in later.
- **Client magic-link auth** — needs the `/send-email` endpoint. A `TODO(magic-link)`
  hook marks where a client self-registration mode lands in `register.js`.
