'use strict';

// Guard against the defect that made batch claim submission fail in production:
// handler code, rules, schema and UI all shipped, and the API GATEWAY ROUTE did
// not. infra/terraform/locals.tf declares every route explicitly, so a PR that
// adds an endpoint without touching that file produces an endpoint that cannot
// be reached — and nothing in the repo notices, because the handler's unit tests
// pass, the UI renders, and `npm test` is green.
//
// It failed loudly only in the browser, and even then it lied about the cause:
// API Gateway's default 404 carries no CORS header, so `fetch` rejects with a
// TypeError and the biller sees "Failed to fetch" — a network fault, apparently,
// rather than a missing route.
//
// THREE routes were missing this way before this test existed:
//   POST /claims/group           (grouping,     #115)
//   POST /claims/{id}/ungroup    (grouping,     #115)
//   POST /claims/{id}/replace    (replacement,  frequency-7 corrections)
//
// This is a source-consistency test, not a live probe: it reads the terraform
// route table and the two places that name routes, and asserts they agree. It
// needs no AWS credentials and no network.
//
//   node backend/tests/api_routes_wired.test.js

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const repo = path.join(__dirname, '..', '..');
const read = (...p) => fs.readFileSync(path.join(repo, ...p), 'utf8');

const localsTf = read('infra', 'terraform', 'locals.tf');
const apiClient = read('public', 'js', 'api-client.js');
const claimsHandler = read('backend', 'handlers', 'claims.js');

// --- the declared route table ------------------------------------------------

// { method = "POST", path = "claims/{id}/submit" }  ->  "POST /claims/{id}/submit"
const ROUTES = new Set();
const routeRe = /\{\s*method\s*=\s*"([A-Z]+)"\s*,\s*path\s*=\s*"([^"]+)"\s*\}/g;
let m;
while ((m = routeRe.exec(localsTf)) !== null) ROUTES.add(`${m[1]} /${m[2]}`);

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('the terraform route table parses', () => {
  assert.ok(ROUTES.size > 40,
    'expected the full API surface, got ' + ROUTES.size + ' routes — the parser or the file shape changed');
  assert.ok(ROUTES.has('POST /login') && ROUTES.has('GET /claims'),
    'sanity: known routes are present');
});

// --- every claim action the handler dispatches has a route --------------------

// The handler is the authority on what it answers. Each of these lines is a real
// dispatch, so each needs a gateway route pointing at it:
//   if (action === 'submit' && method === 'POST' && id) return await submitClaim(...)
test('every /claims/{id}/<action> the handler dispatches is routed', () => {
  const dispatched = [];
  const re = /action === '([a-z]+)'\s*&&\s*method === '([A-Z]+)'/g;
  let hit;
  while ((hit = re.exec(claimsHandler)) !== null) dispatched.push({ action: hit[1], method: hit[2] });

  assert.ok(dispatched.length >= 8,
    'expected the claims sub-action dispatch table, found ' + dispatched.length + ' entries');

  const missing = dispatched
    .map(({ action, method }) => `${method} /claims/{id}/${action}`)
    .filter((key) => !ROUTES.has(key));

  assert.deepStrictEqual(missing, [],
    'these claim actions are dispatched by the handler but have NO API Gateway route, '
    + 'so they 404 before reaching the Lambda: ' + missing.join(', '));
});

// --- collection actions (no {id}) ---------------------------------------------

test('every /claims/<collection-action> is routed', () => {
  const listed = /const COLLECTION_ACTIONS = \[([^\]]*)\]/.exec(claimsHandler);
  assert.ok(listed, 'claims.js still declares COLLECTION_ACTIONS');

  const actions = listed[1].split(',')
    .map((s) => s.trim().replace(/^'|'$/g, ''))
    .filter(Boolean);
  assert.ok(actions.length >= 1, 'expected at least one collection action');

  actions.forEach((action) => {
    // Collection actions are dispatched as
    //   if (collectionAction(event) === 'group' && method === 'POST')
    const guard = new RegExp(`collectionAction\\(event\\) === '${action}'\\s*&&\\s*method === '([A-Z]+)'`);
    const hit = guard.exec(claimsHandler);
    assert.ok(hit, `claims.js dispatches the '${action}' collection action`);
    const key = `${hit[1]} /claims/${action}`;
    assert.ok(ROUTES.has(key),
      key + ' is dispatched by the handler but has NO API Gateway route — '
      + 'this is exactly how POST /claims/group shipped dead');
  });
});

// --- every STATIC path the browser calls is routed -----------------------------

test('every fixed path in api-client.js has a route', () => {
  // Only fully-literal paths can be checked this way: `'/clients/' + id` is a
  // fragment, not a path. Those are covered by the dispatch checks above.
  // Calls that pass VERCEL_BASE go to a Vercel function in /api, not the Lambda
  // API, so they have no terraform route by design.
  const re = /request\('([A-Z]+)',\s*'(\/[^']*)'/g;
  const missing = [];
  let hit;
  while ((hit = re.exec(apiClient)) !== null) {
    const [, method, p] = hit;
    if (p.endsWith('/')) continue;          // a prefix awaiting an id
    if (p.startsWith('/api/')) continue;    // Vercel function, not the Lambda API
    // Look at the rest of this call for a VERCEL_BASE 4th argument.
    const call = apiClient.slice(hit.index, apiClient.indexOf(')', hit.index) + 1);
    if (/VERCEL_BASE/.test(apiClient.slice(hit.index, hit.index + call.length + 80))) continue;
    if (!ROUTES.has(`${method} ${p}`)) missing.push(`${method} ${p}`);
  }
  assert.deepStrictEqual(missing, [],
    'the browser calls these paths but terraform declares no route for them: ' + missing.join(', '));
});

// --- the three that were actually missing --------------------------------------

test('the routes that shipped dead are now declared', () => {
  [
    'POST /claims/group',
    'POST /claims/{id}/ungroup',
    'POST /claims/{id}/replace',
  ].forEach((key) => {
    assert.ok(ROUTES.has(key), key + ' must be declared in infra/terraform/locals.tf');
  });
});

// --- route keys stay unique ----------------------------------------------------

test('no two routes collide on the flattened terraform key', () => {
  // locals.tf flattens (function, route) into a map key by stripping / { }.
  // Two routes colliding there would silently drop one from the for_each.
  const keys = new Map();
  const fnRe = /^\s{4}([a-z_]+) = \{$/gm;
  let fn;
  const bounds = [];
  while ((fn = fnRe.exec(localsTf)) !== null) bounds.push({ name: fn[1], at: fn.index });
  bounds.forEach(({ name, at }, i) => {
    const chunk = localsTf.slice(at, i + 1 < bounds.length ? bounds[i + 1].at : localsTf.length);
    const r = /\{\s*method\s*=\s*"([A-Z]+)"\s*,\s*path\s*=\s*"([^"]+)"\s*\}/g;
    let x;
    while ((x = r.exec(chunk)) !== null) {
      const key = `${name}-${x[1]}-${x[2].replace(/\//g, '-').replace(/[{}]/g, '')}`;
      assert.ok(!keys.has(key), 'duplicate terraform route key: ' + key);
      keys.set(key, true);
    }
  });
  assert.ok(keys.size === ROUTES.size,
    'every declared route produces a distinct key (' + keys.size + ' keys / ' + ROUTES.size + ' routes)');
});

// --- runner ---------------------------------------------------------------------

let failed = 0;
for (const t of tests) {
  try {
    t.fn();
    console.log('  ok  ' + t.name);
  } catch (err) {
    failed++;
    console.error('FAIL  ' + t.name + '\n      ' + (err && err.message));
  }
}
console.log('\n' + (tests.length - failed) + '/' + tests.length + ' passed');
process.exit(failed ? 1 : 0);
