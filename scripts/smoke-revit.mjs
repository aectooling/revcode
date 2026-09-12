// Runs ONLY against a disposable project created by REVCODE_SMOKE_DIR.
// Usage: node scripts/smoke-revit.mjs <discovery.json> <smoke-project.txt> [report.json]
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const [discoveryPath, markerPath, outputPath] = process.argv.slice(2);
if (!discoveryPath || !markerPath) throw new Error('Pass discovery.json and the test-only smoke-project.txt marker.');
const discovery = JSON.parse(await readFile(discoveryPath, 'utf8'));
const projectPath = (await readFile(markerPath, 'utf8')).trim();
const projectName = basename(projectPath, '.rvt');
assert.match(projectName, /^Revcode-Smoke-[a-f0-9]{32}$/);
const headers = { Authorization: `Bearer ${discovery.browserToken}`, 'Content-Type': 'application/json' };
async function api(path, data) {
  const response = await fetch(`${discovery.url}/api/${path}`, { method: data ? 'POST' : 'GET', headers, ...(data ? { body: JSON.stringify(data) } : {}) });
  const result = await response.json();
  if (!response.ok) throw new Error(`${path}: ${JSON.stringify(result)}`);
  return result;
}
const state = await api('state');
assert.equal(state.connected, true, 'Revit must be connected.');
assert.equal(state.context.document.title, projectName, 'Refusing to edit a document other than the explicitly created smoke project.');
const documentToken = state.context.document.token;
const results = [];
async function execute(label, code, mode = 'query') {
  const before = await api('state');
  assert.equal(before.context.document.token, documentToken, 'Active document changed; stop the test.');
  const { operationId } = await api('execute', { requestId: randomUUID(), code, mode, transactionName: `Smoke: ${label}` });
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const current = await api('state');
    const operation = current.operations.find(op => op.operationId === operationId);
    if (operation && ['succeeded', 'failed', 'cancelled', 'unknown'].includes(operation.status)) {
      results.push({ label, ...operation });
      console.log(`${label}: ${operation.status} (${operation.transactionStatus ?? 'no transaction'})`);
      return operation;
    }
    await delay(250);
  }
  throw new Error(`${label} did not complete; do not replay automatically.`);
}

try {
  const levels = 'new FilteredElementCollector(ctx.Doc).OfClass(typeof(Level)).Cast<Level>()';
  const initial = await execute('initial query', `return ${levels}.Select(x => new { id = x.UniqueId, name = x.Name }).ToArray();`);
  assert.equal(initial.status, 'succeeded', JSON.stringify(initial));
  const bad = await execute('compiler diagnostics', 'var x = 1;\nreturn missingIdentifier;');
  assert.equal(bad.status, 'failed');
  assert.ok(bad.diagnostics.some(d => d.line === 2 && d.message.includes('missingIdentifier')));
  const unique = randomUUID().slice(0, 8);
  const createdName = `Revcode verified ${unique}`;
  const create = await execute('create level', `var level = Level.Create(ctx.Doc, UnitUtils.ConvertToInternalUnits(4500, UnitTypeId.Millimeters)); level.Name = "${createdName}"; return new { id = level.UniqueId, name = level.Name };`, 'modify');
  assert.equal(create.status, 'succeeded', JSON.stringify(create));
  assert.equal(create.transactionStatus, 'Committed');
  const verify = await execute('verify creation', `return ${levels}.Count(x => x.Name == "${createdName}");`);
  assert.equal(verify.result, 1);
  const rollbackName = `Revcode rollback ${unique}`;
  const rollback = await execute('rollback on exception', `var level = Level.Create(ctx.Doc, 20); level.Name = "${rollbackName}"; throw new InvalidOperationException("Intentional smoke rollback");`, 'modify');
  assert.equal(rollback.status, 'failed');
  assert.equal(rollback.transactionStatus, 'RolledBack');
  const absent = await execute('verify rollback', `return ${levels}.Count(x => x.Name == "${rollbackName}");`);
  assert.equal(absent.result, 0);
  const invalidName = `Revcode invalid return ${unique}`;
  const invalid = await execute('serialization rollback', `var level = Level.Create(ctx.Doc, 30); level.Name = "${invalidName}"; return level;`, 'modify');
  assert.equal(invalid.status, 'failed');
  assert.equal(invalid.transactionStatus, 'RolledBack');
  const absentInvalid = await execute('verify serialization rollback', `return ${levels}.Count(x => x.Name == "${invalidName}");`);
  assert.equal(absentInvalid.result, 0);
  console.log('Real Revit C# query, compile errors, edit, and both rollback checks passed.');
} finally {
  if (outputPath) await writeFile(resolve(outputPath), JSON.stringify({ at: new Date().toISOString(), context: state.context, projectPath, results }, null, 2));
}
