import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DesktopWorkflow } from './desktop-workflow.mjs';

const frame = {
  observationId: 'old', actionable: true, digest: 'png-hash', windowRef: 'revit', foregroundWindowRef: 'revit',
  bounds: { x: -1920, y: 0, width: 800, height: 600 }, crop: { x: -1920, y: 0, width: 800, height: 600 },
  width: 800, height: 600, dpi: 144, windows: [{ windowRef: 'revit', title: 'Revit' }],
};
const action = { kind: 'action', action: 'click', x: 20, y: 30 };
function fixture(next = frame) {
  const calls = [];
  const workflow = new DesktopWorkflow(async request => {
    calls.push(request);
    return request.kind === 'observe' ? { ...next, observationId: 'fresh' } : { status: 'dispatched' };
  }, async () => { calls.push({ kind: 'delay' }); }, true);
  workflow.reference = { capture: { kind: 'observe' }, frame };
  return { workflow, calls, signal: new AbortController().signal };
}

test('capture releases control before the tester reviews the image', async () => {
  const { workflow, calls, signal } = fixture();
  await workflow.run({ kind: 'observe' }, signal);
  assert.deepEqual(calls.map(c => c.kind), ['delay', 'start', 'observe', 'stop']);
  assert.equal(workflow.reference.frame.observationId, 'fresh');
});

test('staged action captures after focus delay and uses only the fresh ID', async () => {
  const { workflow, calls, signal } = fixture();
  await workflow.run(action, signal);
  assert.deepEqual(calls.map(c => c.kind), ['delay', 'start', 'observe', 'action', 'observe', 'stop']);
  assert.equal(calls.find(c => c.kind === 'action').observationId, 'fresh');
});

for (const change of [{ digest: 'changed-pixels' }, { dpi: 192 }, { windowRef: 'other' }, { width: 900 }, { actionable: false }]) {
  test(`changed evidence blocks input: ${JSON.stringify(change)}`, async () => {
    const { workflow, calls, signal } = fixture({ ...frame, ...change });
    await assert.rejects(workflow.run(action, signal), /changed/);
    assert.equal(calls.some(c => c.kind === 'action'), false);
    assert.equal(calls.at(-1).kind, 'stop');
  });
}

test('Stop during staging prevents start, capture and input', async () => {
  const controller = new AbortController();
  const { workflow, calls } = fixture();
  workflow.wait = async () => controller.abort();
  await assert.rejects(workflow.run(action, controller.signal), /abort/i);
  assert.deepEqual(calls.map(c => c.kind), ['stop']);
});

test('Stop during capture prevents input even if capture returns actionable', async () => {
  const controller = new AbortController();
  const { workflow, calls } = fixture();
  const send = workflow.send;
  workflow.send = async request => {
    const result = await send(request);
    if (request.kind === 'observe') controller.abort();
    return result;
  };
  await assert.rejects(workflow.run(action, controller.signal), /abort/i);
  assert.equal(calls.some(c => c.kind === 'action'), false);
  assert.equal(workflow.reference, undefined);
  assert.equal(calls.at(-1).kind, 'stop');
});

test('failed post-action capture never retries input and consumes prior evidence', async () => {
  const { workflow, calls, signal } = fixture();
  const send = workflow.send;
  let captures = 0;
  workflow.send = async request => {
    if (request.kind === 'observe' && ++captures === 2) throw new Error('capture failed');
    return send(request);
  };
  await assert.rejects(workflow.run(action, signal), /capture failed/);
  assert.equal(calls.filter(c => c.kind === 'action').length, 1);
  assert.equal(workflow.reference, undefined);
  assert.equal(calls.at(-1).kind, 'stop');
});

test('Stop during post-action capture cannot restore cleared review evidence', async () => {
  const controller = new AbortController();
  const { workflow, calls } = fixture();
  const send = workflow.send;
  let captures = 0;
  workflow.send = async request => {
    const result = await send(request);
    if (request.kind === 'observe' && ++captures === 2) controller.abort();
    return result;
  };
  await assert.rejects(workflow.run(action, controller.signal), /abort/i);
  assert.equal(workflow.reference, undefined);
  assert.equal(calls.filter(c => c.kind === 'action').length, 1);
  assert.equal(calls.at(-1).kind, 'stop');
});

test('transport failure consumes prior evidence and releases control', async () => {
  const { workflow, calls, signal } = fixture();
  const send = workflow.send;
  workflow.send = async request => {
    if (request.kind === 'action') throw new Error('disconnected');
    return send(request);
  };
  await assert.rejects(workflow.run(action, signal), /disconnected/);
  assert.equal(workflow.reference, undefined);
  assert.equal(calls.at(-1).kind, 'stop');
});
