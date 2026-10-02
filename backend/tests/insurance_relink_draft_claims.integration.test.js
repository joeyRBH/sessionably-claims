'use strict';

// INTEGRATION — real PostgreSQL, real SQL. Insurance added AFTER a claim was
// drafted must attach to that draft.
//
// THE BUG: a draft claim takes insurance_record_id once, at creation. A claim
// drafted before the patient's insurance was on file (session completed first,
// intake or staff entry second) kept a null link forever, so submit refused it
// ("no insurance record attached") while the client's chart showed coverage.
//
// relinkDraftClaimsToPrimaryInsurance() runs whenever coverage changes. This file
// proves, against real constraints, that it:
//   * fills a null link on a DRAFT claim;
//   * repairs a link pointing at a since-hidden record;
//   * NEVER overwrites a live, chosen policy;
//   * NEVER touches a submitted / non-draft claim, or another client's claim;
//   * does nothing (and does not throw) when the client has no coverage;
//   * is wired into POST /insurance-records.
//
//   DATABASE_URL=postgres://... node backend/tests/insurance_relink_draft_claims.integration.test.js
//
// Skips (exit 0) when no database is configured, so `npm test` runs without one.

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ADMIN_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
if (!ADMIN_URL) {
  console.log('insurance_relink_draft_claims.integration.test.js: SKIPPED (no DATABASE_URL)');
  process.exit(0);
}

const { Client } = require('pg');
const SCRATCH = `rdb_relink_${Date.now()}_${process.pid}`;
const scratchUrl = (base, name) => { const u = new URL(base); u.pathname = `/${name}`; return u.toString(); };

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}`); console.log(`       ${err && err.message}`); }
}

(async () => {
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH}`);
  await admin.query(`CREATE DATABASE ${SCRATCH}`);
  await admin.end();

  const url = scratchUrl(ADMIN_URL, SCRATCH);
  process.env.DATABASE_URL = url;
  process.env.PGSSLMODE = 'disable';
  process.env.DB_SSL = 'disable';
  process.env.JWT_SECRET = 'integration-test-not-production';

  const db = require(path.join(__dirname, '..', 'lib', 'db.js'));
  const { relinkDraftClaimsToPrimaryInsurance } = require(path.join(__dirname, '..', 'lib', 'claims.js'));
  const { sign } = require(path.join(__dirname, '..', 'lib', 'jwt.js'));
  const insuranceHandler = require(path.join(__dirname, '..', 'handlers', 'insurance_records.js'));

  const raw = new Client({ connectionString: url });
  await raw.connect();
  let exitCode = 0;

  try {
    await raw.query(fs.readFileSync(path.join(__dirname, '..', '..', 'db', 'schema.sql'), 'utf8'));

    // Fictional fixtures only — never real PHI.
    const practice = (await raw.query(
      `insert into practices (name, slug) values ('Cedar Hollow Counseling','cedar-hollow') returning id`)).rows[0].id;
    const clinician = (await raw.query(
      `insert into users (practice_id, email, first_name, last_name, role)
       values ($1,'clin@example.test','Casey','Lane','clinician') returning id`, [practice])).rows[0].id;
    const mkClient = async (first) => (await raw.query(
      `insert into clients (practice_id, first_name, last_name) values ($1,$2,'Fixture') returning id`,
      [practice, first])).rows[0].id;
    const mkSession = async (clientId) => (await raw.query(
      `insert into sessions (practice_id, client_id, clinician_id, session_date, fee)
       values ($1,$2,$3,'2026-09-01',150) returning id`, [practice, clientId, clinician])).rows[0].id;
    const mkClaim = async (clientId, { status = 'draft', ins = null, hidden = false } = {}) => {
      const sid = await mkSession(clientId);
      return (await raw.query(
        `insert into claims (practice_id, session_id, client_id, clinician_id, insurance_record_id,
                             status, billed_amount, is_hidden)
         values ($1,$2,$3,$4,$5,$6,150,$7) returning id`,
        [practice, sid, clientId, clinician, ins, status, hidden])).rows[0].id;
    };
    const mkIns = async (clientId, carrier, { primary = true, hidden = false } = {}) => (await raw.query(
      `insert into insurance_records (practice_id, client_id, carrier_name, is_primary, is_hidden)
       values ($1,$2,$3,$4,$5) returning id`, [practice, clientId, carrier, primary, hidden])).rows[0].id;
    const linkOf = async (claimId) =>
      (await raw.query(`select insurance_record_id from claims where id = $1`, [claimId])).rows[0].insurance_record_id;

    console.log('\nrelinkDraftClaimsToPrimaryInsurance');

    await test('fills a null link on a draft claim once coverage exists (the reported bug)', async () => {
      const c = await mkClient('Fill');
      const claim = await mkClaim(c);
      assert.strictEqual(await linkOf(claim), null, 'precondition: drafted before insurance existed');
      const ins = await mkIns(c, 'Carrier A');
      const ids = await relinkDraftClaimsToPrimaryInsurance(db, practice, c);
      assert.deepStrictEqual(ids, [claim]);
      assert.strictEqual(await linkOf(claim), ins);
    });

    await test('repairs a link that points at a since-hidden record', async () => {
      const c = await mkClient('Hidden');
      const old = await mkIns(c, 'Old Carrier');
      const claim = await mkClaim(c, { ins: old });
      await raw.query(`update insurance_records set is_hidden = true where id = $1`, [old]);
      const fresh = await mkIns(c, 'New Carrier');
      await relinkDraftClaimsToPrimaryInsurance(db, practice, c);
      assert.strictEqual(await linkOf(claim), fresh);
    });

    await test('never overwrites a live, chosen policy', async () => {
      const c = await mkClient('Chosen');
      const chosen = await mkIns(c, 'Chosen Carrier', { primary: false });
      const claim = await mkClaim(c, { ins: chosen });
      await mkIns(c, 'Primary Carrier', { primary: true });
      const ids = await relinkDraftClaimsToPrimaryInsurance(db, practice, c);
      assert.deepStrictEqual(ids, []);
      assert.strictEqual(await linkOf(claim), chosen);
    });

    await test('never touches a non-draft claim', async () => {
      const c = await mkClient('Filed');
      const claim = await mkClaim(c, { status: 'submitted' });
      await mkIns(c, 'Carrier');
      const ids = await relinkDraftClaimsToPrimaryInsurance(db, practice, c);
      assert.deepStrictEqual(ids, []);
      assert.strictEqual(await linkOf(claim), null);
    });

    await test('never touches a hidden draft, or another client\'s draft', async () => {
      const c = await mkClient('Scope');
      const other = await mkClient('Other');
      const hiddenClaim = await mkClaim(c, { hidden: true });
      const otherClaim = await mkClaim(other);
      await mkIns(c, 'Carrier');
      await relinkDraftClaimsToPrimaryInsurance(db, practice, c);
      assert.strictEqual(await linkOf(hiddenClaim), null);
      assert.strictEqual(await linkOf(otherClaim), null);
    });

    await test('no coverage on file: no-op, no throw', async () => {
      const c = await mkClient('None');
      const claim = await mkClaim(c);
      assert.deepStrictEqual(await relinkDraftClaimsToPrimaryInsurance(db, practice, c), []);
      assert.strictEqual(await linkOf(claim), null);
    });

    await test('is idempotent', async () => {
      const c = await mkClient('Twice');
      await mkClaim(c);
      await mkIns(c, 'Carrier');
      assert.strictEqual((await relinkDraftClaimsToPrimaryInsurance(db, practice, c)).length, 1);
      assert.strictEqual((await relinkDraftClaimsToPrimaryInsurance(db, practice, c)).length, 0);
    });

    console.log('\nwired into POST /insurance-records');

    await test('staff adding insurance to the chart attaches it to the client\'s stranded draft', async () => {
      const c = await mkClient('Wired');
      const claim = await mkClaim(c);
      const user = (await raw.query(
        `insert into users (practice_id, email, first_name, last_name, role)
         values ($1,'admin@example.test','Ada','Admin','practice_admin') returning id`, [practice])).rows[0].id;
      const token = sign({ id: user, practice_id: practice, role: 'practice_admin' });
      const res = await insuranceHandler.handler({
        httpMethod: 'POST',
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ client_id: c, carrier_name: 'Wired Carrier', member_id: 'ZZ0001' }),
      });
      assert.strictEqual(res.statusCode, 201, res.body);
      const created = JSON.parse(res.body).insurance_record.id;
      assert.strictEqual(await linkOf(claim), created);
      const audited = await raw.query(
        `select count(*)::int n from audit_log where action = 'claim.insurance_relink' and resource_id = $1`, [claim]);
      assert.strictEqual(audited.rows[0].n, 1, 'each relinked claim is audited');
    });
  } catch (err) {
    console.log('  FATAL', err && err.stack);
    exitCode = 1;
  } finally {
    await raw.end();
    try { await db.getPool().end(); } catch (_) {}
    const a2 = new Client({ connectionString: ADMIN_URL });
    await a2.connect();
    await a2.query(`DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`);
    await a2.end();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(exitCode || (failed ? 1 : 0));
})();
