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
async function execute(label, input, cancelRunning = false) {
  let cancellationSent = false;
  const before = await api('state');
  assert.equal(before.context.document.token, documentToken, 'Active document changed; stop the test.');
  const { operationId } = await api('execute', { requestId: randomUUID(), documentToken, ...input, transactionName: `Smoke: ${label}` });
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const current = await api('state');
    const operation = current.operations.find(op => op.operationId === operationId);
    if (cancelRunning && !cancellationSent && operation?.status === 'running') {
      await api('cancel', {}); cancellationSent = true;
    }
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
  const prefix = `Revcode batch ${randomUUID().slice(0, 8)}`;
  const steps = [
    { name: "Create", code: `var level = Level.Create(ctx.Doc, 25); level.Name = "${prefix}"; return new { id = level.UniqueId };` },
    { name: "Rename", code: `var level = ctx.Doc.GetElement(ctx.StepResults[0].GetProperty("id").GetString()); level.Name = "${prefix} renamed"; return level.UniqueId;` },
  ];
  const query = async () => (await execute('Inspect batch elements', { mode: 'query', code: `return new FilteredElementCollector(ctx.Doc).OfClass(typeof(Level)).Cast<Level>().Count(x => x.Name.StartsWith("${prefix}"));` })).result;
  const batch = (label, changes = {}) => execute(label, { mode: 'batch', steps, ...changes });
  const compile = await batch('Later compilation failure', { steps: [steps[0], { name: 'Bad source', code: 'return missingIdentifier;' }] });
  assert.equal(compile.status, 'failed');
  assert.equal(compile.transactionStatus, 'NotStarted');
  assert.equal(compile.diagnostics.find(d => d.severity === 'error').stepIndex, 1);
  assert.equal(await query(), 0);
  for (const [label, changes] of [
    ['Later exception', { steps: [steps[0], { name: 'Throw', code: 'throw new InvalidOperationException("Expected batch failure");' }] }],
    ['Invalid result', { steps: [steps[0], { name: 'Invalid', code: 'return ctx.Doc;' }] }],
    ['Verification false', { verify: { code: 'return false;' } }],
    ['Verification nonboolean', { verify: { code: 'return "true";' } }],
    ['Cooperative cancellation exception', { steps: [steps[0], { name: 'Cancel', code: 'throw new OperationCanceledException();' }] }],
  ]) {
    const result = await batch(label, changes);
    assert.ok(['failed', 'cancelled'].includes(result.status), JSON.stringify(result));
    assert.equal(result.transactionStatus, 'RolledBack');
    assert.equal(result.result.steps[0].status, 'rolledBack');
    assert.equal(await query(), 0);
  }
  const cancelled = await execute('Cancel running batch through transport', { mode: 'batch', steps: [steps[0], { name: 'Wait cooperatively', code: 'var timer = System.Diagnostics.Stopwatch.StartNew(); while (timer.Elapsed.TotalSeconds < 20) { ctx.CheckCancellation(); } return true;' }] }, true);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.transactionStatus, 'RolledBack');
  assert.equal(await query(), 0);
  const success = await batch('Successful verified batch', { verify: { code: `return ctx.Doc.GetElement(ctx.StepResults[0].GetProperty("id").GetString()).Name == "${prefix} renamed";` } });
  assert.equal(success.status, 'succeeded', JSON.stringify(success));
  assert.equal(success.transactionStatus, 'Committed');
  assert.equal(await query(), 1);
  const undo = await execute('Post one normal Revit Undo', { mode: 'api', code: 'ctx.UiApp.PostCommand(RevitCommandId.LookupPostableCommandId(PostableCommand.Undo)); return true;' });
  assert.equal(undo.status, 'succeeded');
  await delay(1500);
  assert.equal(await query(), 0, 'One Undo must remove creation as well as rename');
  console.log('Atomic batch rollback, verification, JSON flow, and one Undo passed in Revit.');
} finally {
  if (outputPath) await writeFile(resolve(outputPath), JSON.stringify({ at: new Date().toISOString(), context: state.context, projectPath, results }, null, 2));
}
