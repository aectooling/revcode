import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import type { DesktopTransport } from './desktop-types.js';

export class DesktopRequestError extends Error {}

// One helper generation per host. A disconnect never silently starts a new
// generation: input may already have been inserted by the old one.
export class DesktopClient implements DesktopTransport {
  onState?: DesktopTransport['onState'];
  private child?: ChildProcessWithoutNullStreams;
  private ready?: Promise<void>;
  private cancellation = 0;
  private generation?: string;
  private failure?: Error;
  private timer?: NodeJS.Timeout;
  private pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>();

  constructor(private executable: string, private revitPid: number, private revitStartTicks: string) {}

  private async launch(cancellation: number) {
    if (!Number.isSafeInteger(this.revitPid) || this.revitPid <= 0 || !/^\d{15,20}$/.test(this.revitStartTicks)) throw new Error('Invalid Revit process identity. Reinstall the add-in.');
    const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-Command', `(Get-Process -Id ${process.pid}).StartTime.ToUniversalTime().Ticks.ToString()`], { windowsHide: true, timeout: 10000 });
    if (cancellation !== this.cancellation) throw new DesktopRequestError('Desktop workflow stopped before launch.');
    const start = stdout.trim();
    if (!/^\d{15,20}$/.test(start)) throw new Error('Could not verify the host process identity.');
    if (this.failure) throw this.failure;
    const child = this.child = spawn(this.executable, [String(this.revitPid), this.revitStartTicks, String(process.pid), start, '--enable-input'], { windowsHide: true, stdio: 'pipe' });
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 12 * 1024 * 1024) { this.fail(new Error('Desktop response exceeded its limit.')); return; }
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        try {
          const response = JSON.parse(line);
          if (response.version !== 1 || typeof response.generation !== 'string' || (this.generation && response.generation !== this.generation)) throw new Error('Desktop protocol/generation changed.');
          if (response.unknown === true) this.onState?.({ owned: false, unknown: true, inputUnknown: true, error: response.error ?? 'Native desktop input outcome is unknown.' });
          const waiter = this.pending.get(response.requestId);
          if (!waiter) continue;
          this.pending.delete(response.requestId); clearTimeout(waiter.timer);
          if (response.error) waiter.reject(new DesktopRequestError(String(response.error)));
          else waiter.resolve(response.result);
        } catch (error) { this.fail(error as Error); }
      }
    });
    child.stderr.on('data', () => { /* Diagnostics are not tool results or provider input. */ });
    child.on('error', error => this.fail(error));
    child.stdin.on('error', error => this.fail(error));
    child.on('exit', () => this.fail(new Error('Desktop helper exited. Inspect Revit before continuing.')));
    const hello = await this.send('hello', {}) as { generation?: string };
    if (!hello?.generation) throw new Error('Desktop helper did not identify its generation.');
    this.generation = hello.generation;
    let heartbeatPending = false;
    this.timer = setInterval(() => {
      if (heartbeatPending) return;
      heartbeatPending = true;
      void this.send('heartbeat', {}).then(value => {
        const state = value as { owned: boolean; unknown: boolean; error?: string };
        this.onState?.({ ...state, inputUnknown: state.unknown });
      })
        .catch(error => this.fail(error)).finally(() => { heartbeatPending = false; });
    }, 2000);
    this.timer.unref();
  }

  private fail(error: Error) {
    if (this.failure) return;
    this.failure = error;
    clearInterval(this.timer);
    for (const waiter of this.pending.values()) { clearTimeout(waiter.timer); waiter.reject(error); }
    this.pending.clear();
    this.onState?.({ owned: false, unknown: true, error: error.message });
    this.child?.kill(); // Only the separate helper, never Revit.
  }

  private send(kind: string, input: object, requestId: string = randomUUID()): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure);
    if (!this.child) return Promise.reject(new Error('Desktop helper has not started.'));
    if (this.pending.has(requestId)) return Promise.reject(new DesktopRequestError('Desktop request ID is already pending.'));
    const line = JSON.stringify({ ...input, version: 1, requestId, generation: this.generation, kind });
    if (Buffer.byteLength(line) > 16384 || this.pending.size >= 6) return Promise.reject(new DesktopRequestError('Desktop request limit exceeded.'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error('Desktop helper timed out. Input outcome may be unknown; do not retry.')), 20000);
      this.pending.set(requestId, { resolve, reject, timer });
      this.child!.stdin.write(line + '\n');
    });
  }

  async request(kind: 'start' | 'recover' | 'observe' | 'action', input: object = {}, requestId?: string) {
    const cancellation = this.cancellation;
    this.ready ??= this.launch(cancellation).catch(error => {
      if (error instanceof DesktopRequestError && cancellation !== this.cancellation) this.ready = undefined;
      else this.fail(error);
      throw error;
    });
    await this.ready;
    if (cancellation !== this.cancellation) throw new DesktopRequestError('Desktop workflow stopped before request.');
    return this.send(kind, input, requestId);
  }

  async stop() {
    ++this.cancellation;
    if (!this.child || this.failure) return;
    await this.send('stop', {});
  }

  async close() {
    try { await this.stop(); } finally {
      clearInterval(this.timer);
      this.fail(new Error('Desktop helper closed.'));
    }
  }
}
