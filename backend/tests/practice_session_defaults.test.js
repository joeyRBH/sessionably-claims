'use strict';

// Handler test — practice-wide session defaults (migration 030).
//
//   PUT  /practice   admin-only edit of default CPT / fee / POS / modifiers /
//                    duration, validated with the same parsers a session uses.
//   POST /clients    does NOT copy the practice defaults onto the client: blank
//                    stays blank (= inherit), so a later change to the practice
//                    default reaches clients created before it.
//   POST /sessions   resolves request > client > practice at creation time; an
//                    explicit "None" (place of service 'none' / modifiers ['NONE'])
//                    at client or session level overrides the practice and is
//                    never stored as a value on the session; a session with no
//                    duration takes the practice default duration.
//
// DB is an in-memory fake routed by SQL shape; an unrecognized query throws so a
// handler that starts reading something new fails here. Synthetic ids only.
//
//   node backend/tests/practice_session_defaults.test.js

const assert = require('node:assert');
const path = require('node:path');
const Module = require('node:module');

process.env.JWT_SECRET = 'test-secret-for-unit-only';

const PRACTICE = 'practice-1';
const state = {
  role: 'practice_admin',
  practice: {
    id: PRACTICE, name: 'Stone Ridge', is_active: true,
    default_cpt_code: '90837', default_place_of_service: '11', default_session_fee: '175.00',
    default_procedure_modifiers: null, default_session_duration_minutes: 50,
  },
  client: { id: '00000000-0000-4000-8000-000000000001', practice_id: PRACTICE,
    default_cpt_code: null, default_place_of_service: null, default_session_fee: '120.00',
    default_procedure_modifiers: null, diagnosis_codes: null },
  lastClientInsert: null,
  lastSessionInsert: null,
  practiceUpdate: null,
  practiceReads: 0,
};

const fakeDb = {
  query: async (sql, params) => {
    const t = sql.replace(/\s+/g, ' ').trim();
    if (/^select practice_id, role from users/i.test(t)) {
      return { rows: [{ practice_id: PRACTICE, role: state.role }], rowCount: 1 };
    }
    if (/^select practice_id from users/i.test(t)) {
      return { rows: [{ practice_id: PRACTICE }], rowCount: 1 };
    }
    if (/^select \* from practices where id = \$1 and is_active/i.test(t)) {
      return { rows: [state.practice], rowCount: 1 };
    }
    // The narrowed defaults query used by POST /sessions: only the five columns.
    if (/^select default_cpt_code, default_place_of_service, default_session_fee, default_procedure_modifiers, default_session_duration_minutes from practices where id = \$1 limit 1/i.test(t)) {
      state.practiceReads += 1;
      return { rows: [state.practice], rowCount: 1 };
    }
    if (/^update practices set/i.test(t)) {
      state.practiceUpdate = { sql: t, params };
      return { rows: [Object.assign({}, state.practice)], rowCount: 1 };
    }
    if (/^insert into clients/i.test(t)) {
      state.lastClientInsert = { sql: t, params };
      return { rows: [{ id: 'new-client', practice_id: PRACTICE }], rowCount: 1 };
    }
    if (/^select \* from clients where id = \$1 and practice_id = \$2 and is_hidden = false/i.test(t)) {
      return { rows: [state.client], rowCount: 1 };
    }
    if (/^select 1 from users where id/i.test(t)) return { rows: [{}], rowCount: 1 };
    if (/^insert into sessions/i.test(t)) {
      state.lastSessionInsert = { sql: t, params };
      return { rows: [{ id: 's1', practice_id: PRACTICE }], rowCount: 1 };
    }
    if (/^insert into audit_log/i.test(t)) return { rows: [], rowCount: 1 };
    throw new Error('unexpected query in test: ' + t);
  },
};
const dbPath = require.resolve(path.join(__dirname, '..', 'lib', 'db.js'));
require.cache[dbPath] = new Module(dbPath, module);
Object.assign(require.cache[dbPath], { filename: dbPath, loaded: true, exports: fakeDb });

const auditPath = require.resolve(path.join(__dirname, '..', 'lib', 'audit.js'));
require.cache[auditPath] = new Module(auditPath, module);
Object.assign(require.cache[auditPath], {
  filename: auditPath, loaded: true,
  exports: { audit: async () => {}, sanitizeFields: () => [] },
});

const { sign } = require(path.join(__dirname, '..', 'lib', 'jwt.js'));
const practiceH = require(path.join(__dirname, '..', 'handlers', 'practice.js'));
const clientsH = require(path.join(__dirname, '..', 'handlers', 'clients.js'));
const sessionsH = require(path.join(__dirname, '..', 'handlers', 'sessions.js'));

const token = () => `Bearer ${sign({ id: 'user-1', practice_id: PRACTICE, role: state.role })}`;
const call = (h, method, body, pathParameters) => h.handler({
  httpMethod: method, headers: { authorization: token() }, pathParameters: pathParameters || null,
  body: body == null ? null : JSON.stringify(body),
});

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('admin can save session defaults; only the named columns are written', async () => {
  const res = await call(practiceH, 'PUT', {
    default_cpt_code: '90834', default_place_of_service: '10', default_session_fee: 150,
    default_procedure_modifiers: ['95'], default_session_duration_minutes: 45,
  });
  assert.strictEqual(res.statusCode, 200, res.body);
  const { sql, params } = state.practiceUpdate;
  for (const c of ['default_cpt_code', 'default_place_of_service', 'default_session_fee',
    'default_procedure_modifiers', 'default_session_duration_minutes']) {
    assert.ok(sql.includes(c + ' ='), 'writes ' + c);
  }
  assert.ok(!sql.includes('name ='), 'does not touch identity columns');
  assert.ok(params.includes(45) && params.includes('90834'));
  const shaped = JSON.parse(res.body).practice;
  assert.ok('default_session_duration_minutes' in shaped, 'the practice API returns the defaults');
});

test('billing_staff may edit identity but NOT session defaults', async () => {
  state.role = 'billing_staff';
  state.practiceUpdate = null;
  const denied = await call(practiceH, 'PUT', { default_cpt_code: '90837' });
  assert.strictEqual(denied.statusCode, 403);
  assert.strictEqual(state.practiceUpdate, null, 'nothing was written');
  const ok = await call(practiceH, 'PUT', { name: 'Stone Ridge Counseling' });
  assert.strictEqual(ok.statusCode, 200, 'identity edit is unchanged');
  state.role = 'practice_admin';
});

test('a clinician cannot edit the practice at all', async () => {
  state.role = 'clinician';
  const res = await call(practiceH, 'PUT', { default_cpt_code: '90837' });
  assert.strictEqual(res.statusCode, 403);
  state.role = 'practice_admin';
});

test('invalid defaults are a 400 and nothing is written', async () => {
  for (const bad of [
    { default_place_of_service: 'office' },
    { default_session_fee: -1 },
    { default_procedure_modifiers: ['toolong'] },
    { default_session_duration_minutes: 0 },
    { default_session_duration_minutes: 'abc' },
  ]) {
    state.practiceUpdate = null;
    const res = await call(practiceH, 'PUT', bad);
    assert.strictEqual(res.statusCode, 400, JSON.stringify(bad) + ' → ' + res.body);
    assert.strictEqual(state.practiceUpdate, null);
  }
});

test('blank values clear a default (stored as null)', async () => {
  const res = await call(practiceH, 'PUT', { default_cpt_code: '', default_session_fee: '' });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(state.practiceUpdate.params.filter((p) => p === null).length, 2);
});

const SESSION = () => ({
  client_id: state.client.id, clinician_id: '00000000-0000-4000-8000-000000000002',
  session_date: '2026-10-01',
});

test('POST /clients does NOT copy the practice defaults: they stay blank (= inherit)', async () => {
  const res = await call(clientsH, 'POST', { first_name: 'Alex', last_name: 'Doe' });
  assert.strictEqual(res.statusCode, 201, res.body);
  const p = state.lastClientInsert.params;
  assert.ok(!p.includes('90837') && !p.includes('11') && !p.includes('175.00'),
    'nothing from the practice is written to the client row');
  assert.strictEqual(state.practiceReads, 0, 'and creating a client does not even read the practice');
});

test('POST /clients stores only what the request supplied', async () => {
  const res = await call(clientsH, 'POST', {
    first_name: 'Alex', last_name: 'Doe', default_cpt_code: '90834', default_session_fee: 99,
  });
  assert.strictEqual(res.statusCode, 201, res.body);
  const p = state.lastClientInsert.params;
  assert.ok(p.includes('90834') && p.includes(99));
});

test('a client created BEFORE a practice change gets the NEW practice fee on its next session', async () => {
  state.practice.default_session_fee = '175.00';
  state.client = Object.assign({}, state.client, { default_session_fee: null, default_cpt_code: null });
  const created = await call(clientsH, 'POST', { first_name: 'Later', last_name: 'Change' });
  assert.strictEqual(created.statusCode, 201);
  let res = await call(sessionsH, 'POST', SESSION());
  assert.strictEqual(res.statusCode, 201, res.body);
  assert.strictEqual(state.lastSessionInsert.params[9], '175.00', 'resolved from the practice today');
  state.practice.default_session_fee = '200.00';        // the practice raises its rate
  res = await call(sessionsH, 'POST', SESSION());
  assert.strictEqual(state.lastSessionInsert.params[9], '200.00',
    'the same client picks up the new rate — nothing was frozen onto their row');
  state.client.default_session_fee = '120.00';           // restore for the later cases
});

// sessions insert params: [practice, client, clinician, date, duration, cpt, dx, pos, mods, fee, ...]
test('POST /sessions: client > practice per field, practice duration fills a missing one', async () => {
  state.practice.default_session_fee = '175.00';
  state.client = Object.assign({}, state.client, { default_session_fee: '120.00' });
  const res = await call(sessionsH, 'POST', SESSION());
  assert.strictEqual(res.statusCode, 201, res.body);
  const p = state.lastSessionInsert.params;
  assert.strictEqual(p[4], 50, 'practice default duration');
  assert.strictEqual(p[5], '90837', 'client has no CPT → practice');
  assert.strictEqual(p[7], '11', 'client has no POS → practice');
  assert.strictEqual(p[9], '120.00', 'client fee beats the practice fee');
});

test('POST /sessions: a supplied duration beats the practice default', async () => {
  await call(sessionsH, 'POST', Object.assign(SESSION(), { duration_minutes: 30 }));
  assert.strictEqual(state.lastSessionInsert.params[4], 30);
});

test('practice modifier 95 + session "None" = no modifier (and no sentinel is stored)', async () => {
  state.practice.default_procedure_modifiers = ['95'];
  let res = await call(sessionsH, 'POST', SESSION());
  assert.deepStrictEqual(state.lastSessionInsert.params[8], ['95'], 'blank still inherits the practice modifier');
  res = await call(sessionsH, 'POST', Object.assign(SESSION(), { procedure_modifiers: ['NONE'] }));
  assert.strictEqual(res.statusCode, 201, res.body);
  assert.strictEqual(state.lastSessionInsert.params[8], null, 'explicit None → no modifier');
  state.practice.default_procedure_modifiers = null;
});

test('client "None" overrides the practice modifier and place of service', async () => {
  state.practice.default_procedure_modifiers = ['95'];
  state.client = Object.assign({}, state.client, { default_procedure_modifiers: [], default_place_of_service: 'none' });
  const res = await call(sessionsH, 'POST', SESSION());
  assert.strictEqual(res.statusCode, 201, res.body);
  const p = state.lastSessionInsert.params;
  assert.strictEqual(p[8], null, 'client None beats practice 95');
  assert.strictEqual(p[7], null, "client POS None beats practice 11 — and 'none' never reaches the session row");
  assert.ok(!JSON.stringify(p).includes('"none"'), 'no sentinel anywhere in the insert');
  // A session-level value still beats the client None.
  await call(sessionsH, 'POST', Object.assign(SESSION(), { procedure_modifiers: ['GT'], place_of_service: '12' }));
  assert.deepStrictEqual(state.lastSessionInsert.params[8], ['GT']);
  assert.strictEqual(state.lastSessionInsert.params[7], '12');
  state.practice.default_procedure_modifiers = null;
  state.client = Object.assign({}, state.client, { default_procedure_modifiers: null, default_place_of_service: null });
});

test('session place of service "none" overrides the client and practice defaults', async () => {
  state.client = Object.assign({}, state.client, { default_place_of_service: '10' });
  const res = await call(sessionsH, 'POST', Object.assign(SESSION(), { place_of_service: 'none' }));
  assert.strictEqual(res.statusCode, 201, res.body);
  assert.strictEqual(state.lastSessionInsert.params[7], null);
  state.client = Object.assign({}, state.client, { default_place_of_service: null });
});

test('POST /clients stores "None" as the sentinel / empty array, and a blank [] still clears', async () => {
  let res = await call(clientsH, 'POST', { first_name: 'No', last_name: 'Defaults',
    default_place_of_service: 'none', default_procedure_modifiers: ['NONE'] });
  assert.strictEqual(res.statusCode, 201, res.body);
  let p = state.lastClientInsert.params;
  assert.ok(p.includes('none'), 'client POS None stored as the sentinel');
  assert.ok(p.some((v) => Array.isArray(v) && v.length === 0), 'client modifiers None stored as an empty array');
  res = await call(clientsH, 'POST', { first_name: 'Blank', last_name: 'Mods', default_procedure_modifiers: [] });
  p = state.lastClientInsert.params;
  assert.ok(!p.some((v) => Array.isArray(v)), '[] on the wire is still "blank", not None');
});

test('the practice defaults read is the narrowed column list, not select *', async () => {
  state.practiceReads = 0;
  await call(sessionsH, 'POST', SESSION());
  assert.strictEqual(state.practiceReads, 1);
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log('  ok  ' + t.name); }
    catch (err) { failed++; console.error('FAIL  ' + t.name + '\n      ' + (err && err.stack || err)); }
  }
  console.log('\n' + (tests.length - failed) + '/' + tests.length + ' passed');
  process.exit(failed ? 1 : 0);
})();
