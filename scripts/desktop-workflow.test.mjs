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
  const tools = {
    observe: async () => { calls.push({ kind: 'observe' }); return { ...next, observationId: 'fresh' }; },
    action: async (id, input) => {
      calls.push({ kind: 'action', ...input });
      return { receipt: { status: 'dispatched', inserted: 3 }, observation: { ...frame, observationId: 'after' } };
    },
  };
  const desktop = {
    beginTurn: () => { calls.push({ kind: 'start' }); return tools; },
    observePassive: async () => { calls.push({ kind: 'passive' }); return { ...frame, actionable: false }; },
    endTurn: async () => { calls.push({ kind: 'stop' }); },
  };
  const workflow = new DesktopWorkflow(desktop, async () => { calls.push({ kind: 'delay' }); }, true, async frame => frame);
  workflow.reference = { capture: {}, frame };
  return { workflow, tools, calls, signal: new AbortController().signal };
}

test('capture releases production control before image review', async () => {
  const { workflow, calls, signal } = fixture();
  await workflow.run({ kind: 'observe' }, signal);
  assert.deepEqual(calls.map(c => c.kind), ['delay', 'start', 'observe', 'stop']);
  assert.equal(workflow.reference.frame.observationId, 'fresh');
});

test('staging uses the fresh ID and the production post-action screenshot', async () => {
  const { workflow, calls, signal } = fixture();
  const result = await workflow.run(action, signal);
  assert.deepEqual(calls.map(c => c.kind), ['delay', 'start', 'observe', 'action', 'stop']);
  assert.equal(calls.find(c => c.kind === 'action').observationId, 'fresh');
  assert.equal(workflow.reference.frame.observationId, 'after');
  assert.equal(result.receipt.status, 'dispatched');
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

test('Stop during capture cannot authorize input', async () => {
  const controller = new AbortController();
  const { workflow, tools, calls } = fixture();
  tools.observe = async () => { controller.abort(); return frame; };
  await assert.rejects(workflow.run(action, controller.signal), /abort/i);
  assert.equal(calls.some(c => c.kind === 'action'), false);
  assert.equal(workflow.reference, undefined);
});

test('post-action capture failure preserves the receipt without retry or review evidence', async () => {
  const { workflow, tools, signal } = fixture();
  let actions = 0;
  tools.action = async () => { actions++; return { receipt: { status: 'dispatched', inserted: 3 }, captureError: 'capture failed' }; };
  const result = await workflow.run(action, signal);
  assert.equal(result.captureError, 'capture failed');
  assert.equal(result.receipt.status, 'dispatched');
  assert.equal(actions, 1);
  assert.equal(workflow.reference, undefined);
});

test('Stop during post-action evidence writing cannot restore the review reference', async () => {
  const controller = new AbortController();
  const { workflow, calls } = fixture();
  workflow.record = async value => { if (value.observationId === 'after') controller.abort(); return value; };
  await assert.rejects(workflow.run(action, controller.signal), /abort/i);
  assert.equal(workflow.reference, undefined);
  assert.equal(calls.filter(c => c.kind === 'action').length, 1);
});

test('transport failure consumes prior evidence and releases control', async () => {
  const { workflow, tools, calls, signal } = fixture();
  tools.action = async () => { throw new Error('disconnected'); };
  await assert.rejects(workflow.run(action, signal), /disconnected/);
  assert.equal(workflow.reference, undefined);
  assert.equal(calls.at(-1).kind, 'stop');
});

test('passive capture never begins a control turn or permits actions', async () => {
  const { workflow, calls, signal } = fixture();
  workflow.inputEnabled = false;
  await workflow.run({ kind: 'observe' }, signal);
  await assert.rejects(workflow.run(action, signal), /input enabled/);
  assert.deepEqual(calls.map(c => c.kind), ['delay', 'passive', 'stop']);
});
