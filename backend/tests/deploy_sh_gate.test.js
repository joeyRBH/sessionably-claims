'use strict';

// Test — infra/terraform/deploy.sh guards: the plan gate (plan_gate.jq) and the
// preflight failure paths (expired credentials, held state lock, missing DB
// password). No AWS, no terraform: `aws` and `terraform` are stubs on PATH, and
// nothing here reaches npm ci or an apply (every case exits in preflight).
//
//   node backend/tests/deploy_sh_gate.test.js

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const TF_DIR = path.join(__dirname, '..', '..', 'infra', 'terraform');
const GATE = path.join(TF_DIR, 'plan_gate.jq');

if (spawnSync('jq', ['--version']).status !== 0) {
    console.error('jq is required to run this test (deploy.sh requires it too)');
    process.exit(1);
}

let failures = 0;
function check(name, fn) {
    try { fn(); console.log(`  ok    ${name}`); }
    catch (err) { failures += 1; console.error(`  FAIL  ${name}\n        ${err.message}`); }
}

function gate(resourceChanges, allowInfra = false) {
    const r = spawnSync('jq', ['-f', GATE, '--argjson', 'allow_infra', String(allowInfra)],
        { input: JSON.stringify({ resource_changes: resourceChanges }), encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
}
const rc = (address, type, actions) => ({ address, type, change: { actions } });

// ---- plan gate ------------------------------------------------------------
check('routine backend deploy (lambda in-place updates) passes', () => {
    const g = gate([rc('aws_lambda_function.auth["clients"]', 'aws_lambda_function', ['update']),
        rc('aws_lambda_function.migrate', 'aws_lambda_function', ['update']),
        rc('aws_vpc.main', 'aws_vpc', ['no-op'])]);
    assert.equal(g.ok, true);
    assert.deepEqual(g.counts, { update: 2 });
});
check('a lambda replacement is refused', () => {
    const g = gate([rc('aws_lambda_function.migrate', 'aws_lambda_function', ['delete', 'create'])]);
    assert.equal(g.ok, false);
    assert.match(g.violations[0], /REPLACE/);
});
check('a plain delete is refused', () => {
    assert.equal(gate([rc('aws_lambda_function.x', 'aws_lambda_function', ['delete'])]).ok, false);
});
check('RDS replace is refused even with ALLOW_INFRA_CHANGE', () => {
    const g = gate([rc('aws_db_instance.main', 'aws_db_instance', ['delete', 'create'])], true);
    assert.equal(g.ok, false, 'the override must never permit a destructive action');
});
check('infrastructure update is refused without the override, allowed with it', () => {
    const c = [rc('aws_security_group.rds', 'aws_security_group', ['update'])];
    assert.equal(gate(c).ok, false);
    assert.equal(gate(c, true).ok, true);
});
check('ssm parameter and iam changes are treated as infrastructure', () => {
    assert.equal(gate([rc('aws_ssm_parameter.secure["X"]', 'aws_ssm_parameter', ['update'])]).ok, false);
    assert.equal(gate([rc('aws_iam_role_policy.p', 'aws_iam_role_policy', ['create'])]).ok, false);
});
check('an empty plan passes', () => assert.equal(gate([]).ok, true));
check('gate output never echoes attribute values', () => {
    const r = spawnSync('jq', ['-f', GATE, '--argjson', 'allow_infra', 'false'], { encoding: 'utf8',
        input: JSON.stringify({ resource_changes: [{ address: 'aws_lambda_function.a', type: 'aws_lambda_function',
            change: { actions: ['update'], after: { environment: { DATABASE_URL: 'postgres://SECRET' } } } }] }) });
    assert.ok(!r.stdout.includes('SECRET'));
});

// ---- deploy.sh preflight --------------------------------------------------
function runDeploy({ sts = 'ok', lock = 'none', password = 'set', args = [] } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploysh-'));
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    const stub = (name, body) => { fs.writeFileSync(path.join(bin, name), `#!/usr/bin/env bash\n${body}\n`); fs.chmodSync(path.join(bin, name), 0o755); };
    stub('terraform', 'exit 0');
    stub('npm', 'exit 0'); // never run a real npm ci from a test
    stub('aws', `
case "$*" in
  *"sts get-caller-identity"*) ${sts === 'ok' ? 'echo \'{"Account":"111122223333"}\'' : 'exit 255'} ;;
  *"s3api get-object"*) ${lock === 'held'
        ? 'out="${@: -1}"; echo \'{"ID":"abc-123","Who":"someone@host","Operation":"OperationTypeApply","Created":"2026-09-01T00:00:00Z"}\' > "$out"; exit 0'
        : 'echo "An error occurred (NoSuchKey) when calling the GetObject operation: The specified key does not exist." >&2; exit 254'} ;;
  *"ssm get-parameter"*) ${password === 'set' ? 'echo hunter2' : 'echo None'} ;;
  *) exit 0 ;;
esac`);
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
    delete env.TF_VAR_db_master_password;
    const r = spawnSync('bash', [path.join(TF_DIR, 'deploy.sh'), ...args], { env, encoding: 'utf8', timeout: 20000 });
    fs.rmSync(dir, { recursive: true, force: true });
    return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

check('expired AWS credentials stop the script before anything else', () => {
    const r = runDeploy({ sts: 'bad' });
    assert.notEqual(r.code, 0);
    assert.match(r.out, /aws sso login/);
});
check('a held state lock stops the script, names the ID, and never unlocks', () => {
    const r = runDeploy({ lock: 'held' });
    assert.notEqual(r.code, 0);
    assert.match(r.out, /LOCKED/);
    assert.match(r.out, /terraform force-unlock abc-123/);
});
check('a missing DB master password stops the script', () => {
    const r = runDeploy({ password: 'none' });
    assert.notEqual(r.code, 0);
    assert.match(r.out, /DB master password not available/);
});
check('the DB password is never printed', () => {
    const r = runDeploy({ password: 'set' });
    assert.ok(!r.out.includes('hunter2'), 'password leaked to output');
    assert.match(r.out, /account=111122223333/);
});
check('-auto-approve is refused', () => {
    const r = runDeploy({ args: ['-auto-approve'] });
    assert.notEqual(r.code, 0);
    assert.match(r.out, /-auto-approve is not accepted/);
});

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log('\nall deploy.sh gate checks passed');
