import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DesktopController, validateAction, validateObserve, type DesktopTiming } from '../../src/host/desktop-controller.js';
import { DesktopRequestError } from '../../src/host/desktop-client.js';
import type { DesktopObservation, DesktopTransport } from '../../src/host/desktop-types.js';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZkAAAAASUVORK5CYII=';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function setup(timing: Partial<DesktopTiming> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'revcode-desktop-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const calls: { kind: string; input?: any; id?: string }[] = [];
  let guardError = '', actionError: Error | undefined, captureError = false, stops = 0, interruptions = 0;
  let releaseCapture: (() => void) | undefined;
  let blockCapture = false;
  let loseLeaseDuringAction = false;
  const transport: DesktopTransport = {
    request: async (kind, input, id) => {
      calls.push({ kind, input, id });
      if (kind === 'action') {
        const saved = JSON.parse(await readFile(join(dir, 'desktop/journal.json'), 'utf8'));
        expect(saved.operations.at(-1).receipt.status).toBe('unknown'); // intent precedes input
        if (loseLeaseDuringAction) transport.onState?.({ owned: false, unknown: false });
        if (actionError) throw actionError;
        return { status: 'dispatched', inserted: 3 };
      }
      if (kind === 'observe') {
        if (blockCapture) await new Promise<void>(resolve => { releaseCapture = resolve; });
        if (captureError) throw new DesktopRequestError('Capture unavailable.');
        return { observationId: randomUUID().replaceAll('-', ''), windowRef: 'b'.repeat(32), title: 'Revit', timestamp: new Date().toISOString(),
          bounds: { x: 0, y: 0, width: 1, height: 1 }, crop: { x: 0, y: 0, width: 1, height: 1 }, width: 1, height: 1, dpi: 96,
          windows: [], actionable: true, backend: 'fixture', mimeType: 'image/png', data: png } satisfies DesktopObservation;
      }
      return { status: 'owned' };
    }, stop: async () => { stops++; }, close: async () => {},
  };
  const controller = new DesktopController(transport, dir, () => { if (guardError) throw new Error(guardError); }, () => {}, () => { interruptions++; }, undefined,
    { countdownMs: 0, recoveryDelayMs: 0, inputPollMs: 0, inputAttempts: 3, ...timing });
  await controller.init(); cleanup.push(() => controller.close().catch(() => {}));
  return { controller, transport, dir, calls, tools: controller.beginTurn('doc'),
    guard: (error: string) => { guardError = error; }, failAction: (error: Error) => { actionError = error; },
    failCapture: () => { captureError = true; }, block: () => { blockCapture = true; }, release: () => releaseCapture?.(),
    loseLease: () => { loseLeaseDuringAction = true; }, stops: () => stops, interruptions: () => interruptions };
}

it('starts once per turn, delivers PNGs, journals before input, and deduplicates action IDs', async () => {
  const fixture = await setup();
  const image = await fixture.tools.observe({});
  expect(image.data).toBe(png);
  const input = { observationId: image.observationId, action: 'click' as const, x: 0, y: 0 };
  const result = await fixture.tools.action('tool-call', input);
  expect(result.receipt.status).toBe('dispatched'); expect(result.observation?.data).toBe(png);
  expect(await fixture.tools.action('tool-call', input)).toEqual({ receipt: result.receipt });
  await expect(fixture.tools.action('tool-call', { ...input, x: 1 })).rejects.toThrow('different input');
  expect(fixture.calls.filter(call => call.kind === 'start')).toHaveLength(1);
  expect(fixture.calls.filter(call => call.kind === 'action')).toHaveLength(1);
  const state = fixture.controller.snapshot();
  expect(JSON.stringify(state)).not.toContain(png);
  expect(await fixture.controller.image(state.latest!.artifact)).toEqual(Buffer.from(png, 'base64'));
});

it('allows passive recovery capture while native input is fenced, without taking focus', async () => {
  const fixture = await setup(); fixture.guard('API outcome unknown');
  const image = await fixture.controller.observePassive();
  expect(image.actionable).toBe(false);
  expect(fixture.calls.map(call => call.kind)).toEqual(['observe']);
  await expect(fixture.tools.observe({})).rejects.toThrow('API outcome unknown');
});

it('blocks action when active document changes after observation', async () => {
  const fixture = await setup(); const image = await fixture.tools.observe({});
  fixture.guard('Active document changed');
  await expect(fixture.tools.action('action', { observationId: image.observationId, action: 'key', keys: ['ESC'] })).rejects.toThrow('Active document changed');
  expect(fixture.calls.some(call => call.kind === 'action')).toBe(false);
});

it('Stop during capture prevents subsequent input and releases ownership immediately', async () => {
  const fixture = await setup(); fixture.block();
  const capture = fixture.tools.observe({});
  const rejection = expect(capture).rejects.toThrow('stopped');
  await expect.poll(() => fixture.calls.some(call => call.kind === 'observe')).toBe(true);
  await fixture.controller.stop(); expect(fixture.stops()).toBeGreaterThan(0);
  fixture.release(); await rejection;
  await expect(fixture.tools.action('action', { observationId: 'a'.repeat(32), action: 'key', keys: ['ESC'] })).rejects.toThrow('stopped');
});

it('transport failure persists unknown input and blocks API mutations even after host restart', async () => {
  const fixture = await setup(); const image = await fixture.tools.observe({});
  fixture.failAction(new Error('Disconnected after possible dispatch'));
  const result = await fixture.tools.action('action', { observationId: image.observationId, action: 'click', x: 0, y: 0 });
  expect(result.receipt.status).toBe('unknown'); expect(fixture.controller.fenced).toBe(true);
  expect(result.observation?.actionable).toBe(false);
  const restarted = new DesktopController(fixture.transport, fixture.dir, () => {}, () => {});
  await restarted.init(); expect(restarted.fenced).toBe(true);
  await expect(restarted.beginTurn('doc').observe({})).rejects.toThrow('confirmed outcome');
});

it('helper validation refusal is confirmed non-dispatch, while capture failure preserves a successful receipt', async () => {
  const fixture = await setup(); const image = await fixture.tools.observe({});
  fixture.loseLease(); // Heartbeat arrives before the action promise resumes.
  fixture.failAction(new DesktopRequestError('Stale image'));
  const refused = await fixture.tools.action('refused', { observationId: image.observationId, action: 'click', x: 0, y: 0 });
  expect(refused.receipt.status).toBe('not-dispatched'); expect(fixture.controller.fenced).toBe(false);
  expect(refused.observation?.actionable).toBe(false);
  expect(fixture.controller.snapshot()).toMatchObject({ status: 'paused', error: 'Stale image' });
  fixture.transport.onState?.({ owned: false, unknown: false });
  expect(fixture.interruptions()).toBe(0); // Deliver the refusal to the model, not a generic abort.
});

it('lease loss while awaiting a dispatched receipt still interrupts control', async () => {
  const fixture = await setup(); const image = await fixture.tools.observe({}); fixture.loseLease();
  const result = await fixture.tools.action('interrupted', { observationId: image.observationId, action: 'click', x: 0, y: 0 });
  expect(result.receipt.status).toBe('dispatched');
  expect(result.observation?.actionable).toBe(false);
  expect(fixture.interruptions()).toBe(1);
  expect(fixture.controller.snapshot().status).toBe('paused');
});

it('post-action screenshot failure cannot erase dispatch or permit replay', async () => {
  const fixture = await setup(); const image = await fixture.tools.observe({}); fixture.failCapture();
  const input = { observationId: image.observationId, action: 'click' as const, x: 0, y: 0 };
  const result = await fixture.tools.action('action', input);
  expect(result.receipt.status).toBe('dispatched'); expect(result.captureError).toContain('Capture unavailable');
  expect(await fixture.tools.action('action', input)).toEqual({ receipt: result.receipt });
  expect(fixture.calls.filter(call => call.kind === 'action')).toHaveLength(1);
});

it('a lost lease aborts the workflow instead of reacquiring focus', async () => {
  const fixture = await setup(); await fixture.tools.observe({});
  fixture.transport.onState?.({ owned: false, unknown: false });
  expect(fixture.interruptions()).toBe(1);
  expect(fixture.controller.snapshot().error).toContain('Desktop control paused');
  await expect(fixture.tools.observe({})).rejects.toThrow('stopped');
  expect(fixture.calls.filter(call => call.kind === 'start')).toHaveLength(1);
});

it('journal failure remains fenced even if the helper subsequently exits', async () => {
  const fixture = await setup(); const image = await fixture.tools.observe({});
  const request = fixture.transport.request;
  fixture.transport.request = async (kind, input, id) => {
    const result = await request(kind, input, id);
    if (kind === 'action') await mkdir(join(fixture.dir, 'desktop/journal.json.tmp'));
    return result;
  };
  await expect(fixture.tools.action('action', { observationId: image.observationId, action: 'click', x: 0, y: 0 })).rejects.toThrow();
  expect(fixture.controller.fenced).toBe(true);
  fixture.transport.onState?.({ owned: false, unknown: true, error: 'Helper exited' });
  expect(fixture.controller.fenced).toBe(true);
});

it('rejects concurrent requests and old observation IDs', async () => {
  const fixture = await setup(); const old = await fixture.tools.observe({}); await fixture.tools.observe({});
  await expect(fixture.tools.action('old', { observationId: old.observationId, action: 'click', x: 0, y: 0 })).rejects.toThrow('Observe');
  fixture.block(); const pending = fixture.controller.observePassive();
  await expect(fixture.controller.observePassive()).rejects.toThrow('Another'); fixture.release(); await pending;
});

it('validates bounded desktop contracts and removes model-supplied process/dispatch fields', () => {
  const base = { observationId: 'a'.repeat(32), action: 'click' as const, x: 0, y: 0 };
  expect(validateAction({ ...base, pid: 123 } as any)).toEqual(base);
  expect(() => validateAction({ ...base, x: NaN })).toThrow();
  expect(() => validateAction({ ...base, action: 'type', text: '\ud800' })).toThrow();
  expect(() => validateAction({ ...base, action: 'key', keys: ['WIN'] })).toThrow();
  expect(() => validateObserve({ maxWidth: 9000 })).toThrow();
});

it('a revoked observation with a retained lease recovers without restarting or replaying', async () => {
  const f = await setup(); const frame = await f.tools.observe({});
  f.failAction(new DesktopRequestError('Observe before each action.'));
  const action = { observationId: frame.observationId, action: 'click' as const, x: 0, y: 0 };
  const result = await f.tools.action('stale', action);
  expect(result.receipt.status).toBe('not-dispatched');
  expect(result.observation?.actionable).toBe(true);
  expect((await f.tools.observe({})).actionable).toBe(true);
  await f.tools.action('stale', action);
  expect(f.calls.filter(c => c.kind === 'start')).toHaveLength(1);
  expect(f.calls.filter(c => c.kind === 'action')).toHaveLength(1);
});

it('cursor refresh returns a new frame and permits a new action in the same turn without replay', async () => {
  const f = await setup(); const frame = await f.tools.observe({});
  const request = f.transport.request;
  let actions = 0;
  f.transport.request = async (kind, input, id) => {
    const result = await request(kind, input, id);
    if (kind === 'action' && ++actions === 1)
      return { status: 'not-dispatched', inserted: 0, owned: true, recovery: 'observe', error: 'The cursor changed after the screenshot. Observe again before sending more input.' };
    return result;
  };
  const input = { observationId: frame.observationId, action: 'click' as const, x: 0, y: 0 };
  const refused = await f.tools.action('cursor-changed', input);
  expect(refused.receipt).toMatchObject({ status: 'not-dispatched', recovery: 'observe' });
  expect(refused.observation?.actionable).toBe(true);
  expect(f.controller.snapshot().status).toBe('controlling');
  expect(f.interruptions()).toBe(0);
  await f.tools.action('cursor-changed', input);
  expect(actions).toBe(1);
  const next = await f.tools.action('fresh-click', { ...input, observationId: refused.observation!.observationId });
  expect(next.receipt.status).toBe('dispatched');
  expect(actions).toBe(2);
  expect(f.calls.filter(c => c.kind === 'start')).toHaveLength(1);
});

it('publishes a preparation countdown and Stop cancels it before native launch', async () => {
  const f = await setup({ countdownMs: 3000 });
  const observation = f.tools.observe({});
  const rejected = expect(observation).rejects.toThrow('stopped');
  expect(f.controller.snapshot()).toMatchObject({ status: 'preparing', countdownEndsAt: expect.any(Number) });
  expect(f.calls).toEqual([]);
  await f.controller.stop(); await rejected;
  expect(f.calls).toEqual([]);
  expect(f.controller.snapshot().countdownEndsAt).toBeUndefined();
});

it('waits through accidental input then returns a new actionable frame without replaying an action', async () => {
  const f = await setup(); const first = await f.tools.observe({}); const request = f.transport.request;
  let recovering = true;
  f.transport.request = async (kind, input, id) => {
    const result = await request(kind, input, id);
    if (kind === 'action') return { status: 'not-dispatched', inserted: 0, owned: true, recovery: 'input' };
    if (kind === 'recover') { recovering = false; return { recovered: true }; }
    if (kind === 'observe' && recovering) return { ...result as object, actionable: false, owned: true, recovery: 'input' };
    return result;
  };
  const result = await f.tools.action('accidental-input', { observationId: first.observationId, action: 'click', x: 0, y: 0 });
  expect(result.receipt.status).toBe('not-dispatched');
  expect(result.observation?.actionable).toBe(true);
  expect(result.observation?.observationId).not.toBe(first.observationId);
  expect(f.controller.snapshot().status).toBe('controlling');
  expect(f.calls.filter(c => c.kind === 'action')).toHaveLength(1);
  expect(f.calls.filter(c => c.kind === 'recover')).toHaveLength(1);
  expect(f.interruptions()).toBe(0);
});

it('Stop during input recovery cancels the countdown and never reacquires focus', async () => {
  const f = await setup({ recoveryDelayMs: 3000 }); const request = f.transport.request;
  f.transport.request = async (kind, input, id) => {
    const result = await request(kind, input, id);
    return kind === 'observe' ? { ...result as object, actionable: false, owned: true, recovery: 'input' } : result;
  };
  const capture = f.tools.observe({}); const rejected = expect(capture).rejects.toThrow('stopped');
  await expect.poll(() => f.controller.snapshot().status).toBe('recovering');
  await f.controller.stop(); await rejected;
  expect(f.calls.some(c => c.kind === 'recover' || c.kind === 'action')).toBe(false);
});

it('bounds quiet-input polling and releases the native lease if activity continues', async () => {
  const f = await setup(); const request = f.transport.request;
  f.transport.request = async (kind, input, id) => {
    const result = await request(kind, input, id);
    return kind === 'observe' ? { ...result as object, actionable: false, owned: true, recovery: 'input' } : result;
  };
  const frame = await f.tools.observe({});
  expect(frame).toMatchObject({ actionable: false, owned: false });
  expect(frame.recovery).toBeUndefined();
  expect(f.controller.snapshot().status).toBe('paused');
  expect(f.calls.filter(c => c.kind === 'recover')).toHaveLength(3);
  expect(f.stops()).toBe(1);
});

it('limits automatic recovery to three episodes per turn', async () => {
  const f = await setup(); const request = f.transport.request; let recovering = true;
  f.transport.request = async (kind, input, id) => {
    const result = await request(kind, input, id);
    if (kind === 'recover') recovering = false;
    return kind === 'observe' && recovering ? { ...result as object, actionable: false, owned: true, recovery: 'input' } : result;
  };
  for (let i = 0; i < 3; i++) { recovering = true; expect((await f.tools.observe({})).actionable).toBe(true); }
  recovering = true;
  expect((await f.tools.observe({})).actionable).toBe(false);
  expect(f.calls.filter(c => c.kind === 'recover')).toHaveLength(3);
  expect(f.controller.snapshot().status).toBe('paused');
});

it('does not repeatedly take focus if input returns after a successful recovery request', async () => {
  const f = await setup(); const request = f.transport.request;
  f.transport.request = async (kind, input, id) => {
    const result = await request(kind, input, id);
    if (kind === 'recover') return { recovered: true };
    return kind === 'observe' ? { ...result as object, actionable: false, owned: true, recovery: 'input' } : result;
  };
  expect((await f.tools.observe({})).actionable).toBe(false);
  expect(f.calls.filter(c => c.kind === 'recover')).toHaveLength(1);
  expect(f.controller.snapshot().status).toBe('paused');
});

it('never recovers or replays an unknown action even if the helper offers input recovery', async () => {
  const f = await setup(); const frame = await f.tools.observe({}); const request = f.transport.request;
  f.transport.request = async (kind, input, id) => {
    const result = await request(kind, input, id);
    if (kind === 'action') return { status: 'unknown', inserted: 1, owned: true, recovery: 'input' };
    return kind === 'observe' ? { ...result as object, actionable: false, owned: true, recovery: 'input' } : result;
  };
  const result = await f.tools.action('partial', { observationId: frame.observationId, action: 'click', x: 0, y: 0 });
  expect(f.controller.fenced).toBe(true); expect(result.observation?.actionable).toBe(false);
  expect(f.calls.some(c => c.kind === 'recover')).toBe(false);
});

it('fences contradictory zero-input refusals with nonzero inserted input', async () => {
  const f = await setup(); const frame = await f.tools.observe({}); const request = f.transport.request;
  f.transport.request = async (kind, input, id) => kind === 'action'
    ? { status: 'not-dispatched', inserted: 1, owned: true, recovery: 'input' }
    : request(kind, input, id);
  const result = await f.tools.action('contradictory', { observationId: frame.observationId, action: 'click', x: 0, y: 0 });
  expect(result.receipt.status).toBe('unknown');
  expect(f.controller.fenced).toBe(true);
  expect(f.calls.some(c => c.kind === 'recover')).toBe(false);
});

it('an unused helper exit does not invalidate or interrupt the current API turn', async () => {
  const f = await setup(); await f.tools.observe({}); await f.controller.endTurn();
  f.controller.beginTurn('doc');
  f.transport.onState?.({ owned: false, unknown: true, error: 'Helper exited' });
  expect(f.controller.snapshot().status).toBe('unavailable');
  expect(f.interruptions()).toBe(0);
});

it.each([false, true])('bounds observation-only recovery (always settling: %s)', async alwaysSettling => {
  const f = await setup(); const request = f.transport.request;
  let captures = 0;
  f.transport.request = async (kind, input, id) => {
    const result = await request(kind, input, id);
    if (kind === 'observe' && (++captures < 3 || alwaysSettling))
      return { ...result as object, actionable: false, owned: true, recovery: 'observe', reason: 'Dialog settling' };
    return result;
  };
  const frame = await f.tools.observe({});
  expect(captures).toBe(3);
  expect(frame.actionable).toBe(!alwaysSettling);
  expect(f.calls.filter(c => c.kind === 'start')).toHaveLength(1);
  expect(f.calls.some(c => c.kind === 'action')).toBe(false);
});

it('Stop during settling prevents another capture or actionable result', async () => {
  const f = await setup(); const request = f.transport.request;
  f.transport.request = async (kind, input, id) => {
    const result = await request(kind, input, id);
    if (kind === 'observe') return { ...result as object, actionable: false, owned: true, recovery: 'observe' };
    return result;
  };
  const capture = f.tools.observe({});
  const rejected = expect(capture).rejects.toThrow('stopped');
  await expect.poll(() => f.calls.some(c => c.kind === 'observe')).toBe(true);
  await f.controller.stop(); await rejected;
  expect(f.calls.filter(c => c.kind === 'observe')).toHaveLength(1);
});

it('preserves native interference reason when capture reports lease loss before heartbeat', async () => {
  const f = await setup(); const request = f.transport.request;
  f.transport.request = async (kind, input, id) => {
    const result = await request(kind, input, id);
    if (kind === 'observe') return { ...result as object, actionable: false, owned: false, reason: 'Mouse moved during capture.' };
    return result;
  };
  const frame = await f.tools.observe({});
  expect(frame.reason).toBe('Mouse moved during capture.');
  expect(f.controller.snapshot()).toMatchObject({ status: 'paused', error: frame.reason });
  expect(f.calls.filter(c => c.kind === 'observe')).toHaveLength(1);
});

it('native unknown activation input fences API work and survives restart without an action entry', async () => {
  const f = await setup();
  f.transport.onState?.({ owned: false, unknown: true, inputUnknown: true, error: 'Activation key release failed.' });
  expect(f.controller.fenced).toBe(true);
  expect(f.interruptions()).toBe(1);
  await f.controller.close(); // Flush the durable native fence.
  const restarted = new DesktopController(f.transport, f.dir, () => {}, () => {});
  await restarted.init();
  expect(restarted.fenced).toBe(true);
  expect(restarted.snapshot().operations).toEqual([]);
  await expect(restarted.beginTurn('doc').observe({})).rejects.toThrow('confirmed outcome');
});

it('a late non-dispatch receipt cannot clear an independently reported native unknown fence', async () => {
  const f = await setup(); const frame = await f.tools.observe({}); const request = f.transport.request;
  f.transport.request = async (kind, input, id) => {
    if (kind === 'action') {
      f.transport.onState?.({ owned: false, unknown: true, inputUnknown: true, error: 'Native input release failed.' });
      return { status: 'not-dispatched', inserted: 0, owned: false };
    }
    return request(kind, input, id);
  };
  const result = await f.tools.action('late-refusal', { observationId: frame.observationId, action: 'click', x: 0, y: 0 });
  expect(result.receipt.status).toBe('not-dispatched');
  expect(f.controller.snapshot().error).toBe('Native input release failed.');
  expect(f.controller.fenced).toBe(true);
  expect(result.observation?.actionable).toBe(false);
});
