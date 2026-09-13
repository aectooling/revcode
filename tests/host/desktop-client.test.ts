import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { DesktopClient, DesktopRequestError } from '../../src/host/desktop-client.js';

const fixture = vi.hoisted(() => ({ spawn: undefined as any, execFile: undefined as any }));
vi.mock('node:child_process', () => ({
  spawn: (...args: any[]) => fixture.spawn(...args),
  execFile: (...args: any[]) => fixture.execFile(...args),
}));

const clients: DesktopClient[] = [];
afterEach(async () => { for (const client of clients.splice(0)) await client.close(); });

function setup() {
  const requests: any[] = [];
  const child = new EventEmitter() as any;
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = vi.fn(() => { child.emit('exit', 0); });
  let holdCapture = false;
  const respond = (request: any, result: unknown, error?: string, generation = 'generation-1') => {
    child.stdout.write(JSON.stringify({ version: 1, requestId: request.requestId, generation, result, error }) + '\n');
  };
  child.stdin = new Writable({ write(chunk, _encoding, done) {
    const request = JSON.parse(chunk.toString()); requests.push(request);
    queueMicrotask(() => {
      if (request.kind === 'hello') respond(request, { generation: 'generation-1' });
      else if (request.kind === 'observe' && holdCapture) return;
      else if (request.kind === 'action') respond(request, null, 'Stale observation');
      else respond(request, { status: request.kind === 'start' ? 'owned' : 'stopped' });
    });
    done();
  } });
  fixture.execFile = vi.fn((_exe, _args, _options, callback) => callback(null, { stdout: '639000000000000000\n' }));
  fixture.spawn = vi.fn(() => child);
  const client = new DesktopClient('C:/package/desktop/Revcode.Desktop.exe', 1234, '639000000000000001');
  clients.push(client);
  return { client, child, requests, respond, launch: fixture.spawn, hold: () => { holdCapture = true; } };
}

it('launches hidden with exact process identities and sends versioned generation-bound requests', async () => {
  const fixture = setup(); await fixture.client.request('start');
  expect(fixture.requests.map(r => r.kind)).toEqual(['hello', 'start']);
  expect(fixture.requests[1]).toMatchObject({ version: 1, generation: 'generation-1' });
  expect(fixture.launch).toHaveBeenCalledWith('C:/package/desktop/Revcode.Desktop.exe',
    ['1234', '639000000000000001', String(process.pid), '639000000000000000', '--enable-input'],
    { windowsHide: true, stdio: 'pipe' });
});

it('Stop reaches the helper while an observation response is pending', async () => {
  const fixture = setup(); await fixture.client.request('start'); fixture.hold();
  const capture = fixture.client.request('observe');
  await expect.poll(() => fixture.requests.some(r => r.kind === 'observe')).toBe(true);
  await fixture.client.stop(); expect(fixture.requests.at(-1).kind).toBe('stop');
  fixture.respond(fixture.requests.find(r => r.kind === 'observe'), { observationId: 'image' });
  expect(await capture).toEqual({ observationId: 'image' });
});

it('distinguishes a confirmed helper rejection from a transport failure', async () => {
  const fixture = setup();
  await expect(fixture.client.request('action', { action: 'click' })).rejects.toBeInstanceOf(DesktopRequestError);
  fixture.hold(); const capture = fixture.client.request('observe');
  const rejected = expect(capture).rejects.toThrow('exited');
  await expect.poll(() => fixture.requests.some(r => r.kind === 'observe')).toBe(true);
  fixture.child.emit('exit', 1); await rejected;
  await expect(fixture.client.request('start')).rejects.toThrow('exited');
});

it('rejects a changed helper generation instead of replaying the request', async () => {
  const fixture = setup(); await fixture.client.request('start'); fixture.hold();
  const capture = fixture.client.request('observe');
  const rejected = expect(capture).rejects.toThrow('generation');
  await expect.poll(() => fixture.requests.some(r => r.kind === 'observe')).toBe(true);
  fixture.respond(fixture.requests.at(-1), {}, undefined, 'new-generation'); await rejected;
  expect(fixture.child.kill).toHaveBeenCalledOnce();
});
