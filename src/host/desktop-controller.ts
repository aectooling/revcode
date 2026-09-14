import type { DesktopActivity } from './desktop-types.js';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, readdir, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DesktopRequestError } from './desktop-client.js';
import type { DesktopActionInput, DesktopEvidence, DesktopObservation, DesktopObserveInput, DesktopOperation, DesktopReceipt, DesktopState, DesktopTools, DesktopTransport } from './desktop-types.js';

export interface DesktopTiming { countdownMs: number; recoveryDelayMs: number; inputPollMs: number; inputAttempts: number }
const defaultTiming: DesktopTiming = { countdownMs: 3000, recoveryDelayMs: 3000, inputPollMs: 500, inputAttempts: 20 };

export class DesktopController {
  private operations: DesktopOperation[] = [];
  private nativeUnknown = false;
  private activity: DesktopActivity[] = [];
  private latest?: DesktopEvidence;
  private frame?: DesktopObservation;
  private status: DesktopState['status'];
  private error?: string;
  private epoch = 0;
  private attempted = false;
  private recoveries = 0;
  private countdownEndsAt?: number;
  private cancelDelay?: () => void;
  private pending = false;
  private receivingAction = false;
  private lostLeaseDuringAction = false;
  private saveChain = Promise.resolve();
  private readonly directory: string;
  private readonly journal: string;

  constructor(private transport: DesktopTransport | undefined, dataDir: string,
    private guard: (documentToken: string | null) => void, private changed: () => void, private interrupted: (reason?: string) => void = () => {},
    private contextSnapshot: () => DesktopObservation['context'] = () => undefined,
    private timing: DesktopTiming = defaultTiming) {
    this.directory = resolve(dataDir, 'desktop');
    this.journal = resolve(this.directory, 'journal.json');
    this.status = transport ? 'idle' : 'unavailable';
    if (transport) transport.onState = state => {
      if (state.unknown) {
        const newNativeUnknown = state.inputUnknown === true && !this.nativeUnknown;
        this.nativeUnknown ||= state.inputUnknown === true;
        const active = this.status === 'controlling' || this.pending || this.receivingAction || newNativeUnknown;
        this.status = this.nativeUnknown || this.fenced || this.operations.some(op => op.receipt.status === 'unknown') ? 'unknown' : 'unavailable';
        this.error = state.error ?? 'Desktop helper unavailable. Inspect Revit before continuing.';
        if (active) ++this.epoch;
        this.cancelDelay?.(); this.countdownEndsAt = undefined;
        this.frame = undefined;
        if (newNativeUnknown) void this.persist().catch(() => {});
        if (active) this.interrupted(this.error);
      } else if (!state.owned && this.controlActive) {
        // A refusal and heartbeat can arrive in the same stdout chunk. Let the
        // pending receipt distinguish a refusal from interruption after input.
        if (this.receivingAction) { this.lostLeaseDuringAction = true; this.error = state.error; }
        else this.pauseForLostLease(state.error);
      }
      this.changed();
    };
  }

  private pauseForLostLease(reason?: string) {
    this.status = 'paused'; this.frame = undefined; ++this.epoch;
    this.cancelDelay?.(); this.countdownEndsAt = undefined;
    this.error = reason ?? this.error ?? 'Desktop control paused: Revit lost focus, user input was detected, or the control lease expired.';
    this.interrupted(this.error);
  }

  async init() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      const saved = JSON.parse(await readFile(this.journal, 'utf8'));
      this.operations = Array.isArray(saved) ? saved : saved.operations;
      this.nativeUnknown = !Array.isArray(saved) && saved.nativeUnknown === true;
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (this.nativeUnknown || this.operations.some(op => op.receipt.status === 'unknown')) {
      this.status = 'unknown'; this.error = 'A desktop action has no confirmed outcome. Inspect Revit; do not replay.';
    }
    // Artifacts are bounded per host; old frames never authorize input after restart.
    for (const file of await readdir(this.directory)) if (/^[a-f0-9]{32}\.png$/.test(file)) await unlink(resolve(this.directory, file));
  }

  get inFlight() { return this.pending; }
  private get controlActive() { return this.status === 'controlling' || this.status === 'recovering'; }
  get fenced() { return this.status === 'unknown'; }
  snapshot(): DesktopState { return { activity: this.activity.map(item => ({ ...item })), available: !!this.transport && this.status !== 'unavailable', status: this.status, countdownEndsAt: this.countdownEndsAt, error: this.error, latest: this.latest, operations: this.operations.slice(-30) }; }

  private log(label: string) {
    const event: DesktopActivity = { id: randomUUID(), timestamp: new Date().toISOString(), label, status: 'running' };
    this.activity = [...this.activity.slice(-99), event];
    this.changed();
    return event;
  }

  private async delay(ms: number, epoch: number, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (epoch !== this.epoch) throw new Error('Desktop workflow stopped.');
    await new Promise<void>(resolve => {
      const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); if (this.cancelDelay === done) this.cancelDelay = undefined; resolve(); };
      const timer = setTimeout(done, ms);
      this.cancelDelay = done;
      signal?.addEventListener('abort', done, { once: true });
    });
    signal?.throwIfAborted();
    if (epoch !== this.epoch) throw new Error('Desktop workflow stopped.');
  }

  private persist() {
    const data = JSON.stringify({ operations: this.operations, nativeUnknown: this.nativeUnknown });
    this.saveChain = this.saveChain.then(async () => {
      await writeFile(this.journal + '.tmp', data, { mode: 0o600 });
      await rename(this.journal + '.tmp', this.journal);
    }).catch(error => {
      this.status = 'unknown'; this.error = 'Desktop journal could not be saved. Inspect Revit before further input.';
      this.frame = undefined; this.changed(); this.interrupted(this.error);
      void this.transport?.stop().catch(() => {});
      throw error;
    });
    return this.saveChain;
  }

  private requireTransport() {
    if (!this.transport) throw new Error('Desktop helper is unavailable. Build/install the current package and restart Revit.');
    return this.transport;
  }

  private async exclusive<T>(work: () => Promise<T>) {
    if (this.pending) throw new Error('Another desktop request is running.');
    this.pending = true; this.changed();
    try { return await work(); } finally { this.pending = false; this.changed(); }
  }

  private check(epoch: number, token: string | null, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (epoch !== this.epoch) throw new Error('Desktop workflow stopped. Start a new turn.');
    if (this.fenced) throw new Error(this.error ?? 'Desktop outcome unknown.');
    this.guard(token);
  }

  beginTurn(token: string | null): DesktopTools {
    const epoch = ++this.epoch;
    this.attempted = false;
    this.recoveries = 0;
    this.frame = undefined;
    return {
      observe: (input, signal) => this.exclusive(async () => {
        this.check(epoch, token, signal);
        const transport = this.requireTransport();
        if (!this.attempted) {
          this.attempted = true;
          try {
            this.status = 'preparing'; this.error = undefined;
            this.countdownEndsAt = Date.now() + this.timing.countdownMs; this.changed();
            await this.delay(this.timing.countdownMs, epoch, signal);
            this.check(epoch, token, signal);
            this.countdownEndsAt = undefined;
            await transport.request('start');
            this.check(epoch, token, signal);
            this.status = 'controlling'; this.error = undefined;
          } catch (error) {
            if (!this.fenced && this.status !== 'unavailable') this.status = 'paused';
            this.error = (error as Error).message;
            this.countdownEndsAt = undefined;
            await transport.stop(); throw error;
          }
        }
        const frame = await this.capture(input, false, signal, () => this.check(epoch, token, signal));
        this.check(epoch, token, signal);
        if (this.status !== 'controlling') frame.actionable = false;
        this.frame = frame.actionable ? frame : undefined;
        return frame;
      }),
      action: (requestId, input, signal) => this.exclusive(async () => {
        const action = validateAction(input);
        const fingerprint = JSON.stringify(action);
        const old = this.operations.find(op => op.requestId === requestId);
        if (old) {
          if (old.fingerprint !== fingerprint) throw new Error('Desktop request ID was reused for different input.');
          return { receipt: old.receipt };
        }
        this.check(epoch, token, signal);
        if (!this.frame?.actionable || this.frame.observationId !== action.observationId) throw new Error('Observe the desktop again before this action.');
        if (this.status !== 'controlling') throw new Error('Desktop control paused. Start a new turn after activating Revit.');
        if (this.operations.length >= 1000) throw new Error('Desktop action journal is full. Start a new Revit session after reviewing outcomes.');
        const op: DesktopOperation = { operationId: randomUUID(), requestId, fingerprint, input: action, documentToken: token,
          createdAt: new Date().toISOString(), receipt: { status: 'unknown', inserted: 0, error: 'Intent recorded without a dispatch receipt.' } };
        this.operations.push(op);
        this.frame = undefined;
        await this.persist();
        try { this.check(epoch, token, signal); }
        catch (error) {
          op.receipt = { status: 'not-dispatched', inserted: 0, error: (error as Error).message };
          await this.persist(); throw error;
        }
        const activity = this.log(action.action === 'type' ? `Type ${action.text!.length} characters`
          : action.action === 'key' ? `Press ${action.keys!.join(' + ')}`
          : `${action.action === 'move' ? 'Move pointer' : action.action === 'click' ? 'Click' : `Scroll ${action.direction}`} at ${Math.round(action.x!)}, ${Math.round(action.y!)}`);
        this.receivingAction = true;
        this.lostLeaseDuringAction = false;
        try {
          const result = await this.requireTransport().request('action', action, op.operationId) as DesktopReceipt;
          if (!result || !['dispatched', 'not-dispatched', 'unknown'].includes(result.status) || !Number.isInteger(result.inserted) || result.inserted < 0 ||
              (result.status === 'not-dispatched' && result.inserted !== 0)) throw new Error('Invalid desktop dispatch receipt.');
          op.receipt = result;
        } catch (error) {
          op.receipt = { status: error instanceof DesktopRequestError ? 'not-dispatched' : 'unknown', inserted: 0, error: (error as Error).message };
        }
        activity.status = op.receipt.status; activity.error = op.receipt.error; this.changed();
        if (op.receipt.status === 'unknown') { this.status = 'unknown'; this.error = op.receipt.error; }
        if (op.receipt.status === 'not-dispatched' && !this.fenced) {
          if (this.lostLeaseDuringAction || op.receipt.owned === false) this.status = 'paused';
          this.error = op.receipt.error;
        }
        this.receivingAction = false;
        if ((this.lostLeaseDuringAction || op.receipt.owned === false) && op.receipt.status === 'dispatched' && this.status === 'controlling') this.pauseForLostLease();
        this.lostLeaseDuringAction = false;
        await this.persist(); this.changed();
        // A missing screenshot is separate from whether input was dispatched.
        try {
          const observation = await this.capture({}, false, signal, () => this.check(epoch, token, signal));
          if (epoch !== this.epoch || signal?.aborted || this.fenced || this.status !== 'controlling') observation.actionable = false;
          else this.guard(token);
          this.frame = observation.actionable ? observation : undefined;
          if (observation.actionable && this.status === 'controlling') { this.error = undefined; this.changed(); }
          return { receipt: op.receipt, observation };
        } catch (error) { return { receipt: op.receipt, captureError: (error as Error).message }; }
      }),
    };
  }

  invalidateObservation() { this.frame = undefined; }

  async observePassive(input: DesktopObserveInput = {}) {
    return this.exclusive(async () => {
      this.frame = undefined;
      const observation = await this.capture(input, true);
      return observation;
    });
  }

  private async capture(input: DesktopObserveInput, passive = false, signal?: AbortSignal, check?: () => void): Promise<DesktopObservation> {
    const activity = this.log('Observe Revit desktop');
    try {
      const frame = await this.captureFrame(input, passive, signal, check);
      activity.status = 'captured'; activity.label = `Screenshot · ${frame.title}`;
      return frame;
    } catch (error) {
      activity.status = 'failed'; activity.error = (error as Error).message;
      throw error;
    } finally { this.changed(); }
  }

  private async captureFrame(input: DesktopObserveInput, passive = false, signal?: AbortSignal, check?: () => void): Promise<DesktopObservation> {
    const request = validateObserve(input);
    const epoch = this.epoch;
    let frame!: DesktopObservation;
    let inputAttempts = 0;
    let recoveryCompleted = false;
    for (let attempt = 0; ; attempt++) {
      frame = await this.requireTransport().request('observe', request) as DesktopObservation;
      if (!passive && !frame?.actionable && frame?.recovery === 'input' && frame?.owned === true && this.controlActive && epoch === this.epoch) {
        check?.();
        if (inputAttempts >= this.timing.inputAttempts || (inputAttempts === 0 && this.recoveries >= 3)) {
          frame.recovery = undefined; frame.actionable = false; frame.owned = false;
          frame.reason = 'Desktop control paused after repeated input interruptions. Release the mouse and keyboard and start a new turn.';
          this.status = 'paused'; this.error = frame.reason; this.countdownEndsAt = undefined;
          await this.requireTransport().stop(); break;
        }
        if (inputAttempts++ === 0) {
          ++this.recoveries; this.status = 'recovering'; this.error = undefined;
          this.countdownEndsAt = Date.now() + this.timing.recoveryDelayMs; this.changed();
          await this.delay(this.timing.recoveryDelayMs, epoch, signal);
          this.countdownEndsAt = undefined;
        } else await this.delay(this.timing.inputPollMs, epoch, signal);
        check?.();
        if (!recoveryCompleted) {
          const result = await this.requireTransport().request('recover') as { recovered?: boolean };
          recoveryCompleted = result?.recovered === true;
        }
        check?.();
        continue;
      }
      if (frame?.actionable && this.status === 'recovering' && epoch === this.epoch) { this.status = 'controlling'; this.error = undefined; this.changed(); }
      if (frame?.actionable || frame?.recovery !== 'observe' || frame?.owned !== true || passive ||
          !this.controlActive || epoch !== this.epoch || attempt >= inputAttempts + 2) break;
      await this.delay(150, epoch, signal);
      check?.();
      if (epoch !== this.epoch || !this.controlActive) break;
    }
    if (!frame || !/^[a-f0-9]{32}$/.test(frame.observationId) || frame.mimeType !== 'image/png' || typeof frame.data !== 'string' || frame.data.length > 12 * 1024 * 1024 ||
      !Number.isInteger(frame.width) || !Number.isInteger(frame.height) || frame.width <= 0 || frame.height <= 0 || frame.width * frame.height > 4_000_000) throw new Error('Invalid desktop image response.');
    const png = Buffer.from(frame.data, 'base64');
    if (png.length < 24 || png.length > 8 * 1024 * 1024 || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      png.readUInt32BE(16) !== frame.width || png.readUInt32BE(20) !== frame.height) throw new Error('Invalid desktop PNG dimensions.');
    frame.context = this.contextSnapshot();
    if (passive || this.fenced || !this.controlActive || epoch !== this.epoch || frame.owned === false) {
      frame.actionable = false; frame.recovery = undefined;
      frame.reason = frame.reason ?? this.error ?? 'Desktop control is not active.';
    }
    if (!passive && !frame.actionable && frame.recovery !== 'observe' && this.controlActive) {
      this.status = 'paused'; this.error = frame.reason ?? 'No actionable desktop observation.';
    }
    const { data: _, ...metadata } = frame;
    const artifact = frame.observationId + '.png';
    await writeFile(resolve(this.directory, artifact), png, { mode: 0o600 });
    this.latest = { ...metadata, artifact };
    const artifacts = (await readdir(this.directory)).filter(file => /^[a-f0-9]{32}\.png$/.test(file));
    // Keep only the latest frame on disk; operation metadata retains its source ID.
    for (const file of artifacts) if (file !== artifact) await unlink(resolve(this.directory, file));
    this.changed();
    return frame;
  }

  async image(artifact: string) {
    if (artifact !== this.latest?.artifact) throw new Error('Desktop image is no longer retained. Capture again.');
    return readFile(resolve(this.directory, artifact));
  }

  async stop() {
    ++this.epoch;
    this.cancelDelay?.(); this.countdownEndsAt = undefined;
    this.frame = undefined;
    if (!this.fenced && this.transport && this.status !== 'unavailable') this.status = 'paused';
    this.changed();
    await this.transport?.stop();
  }

  async endTurn() {
    await this.stop();
    if (!this.fenced && this.transport && this.status !== 'unavailable') this.status = 'idle';
    this.changed();
  }

  async close() { try { await this.stop(); } finally { await this.transport?.close(); await this.saveChain; } }
}

export function validateObserve(input: DesktopObserveInput): DesktopObserveInput {
  if (!input || typeof input !== 'object') throw new Error('Expected observation options.');
  if (input.windowRef !== undefined && (typeof input.windowRef !== 'string' || !/^[a-f0-9]{32}$/.test(input.windowRef))) throw new Error('Invalid window reference.');
  if (input.maxWidth !== undefined && (!Number.isInteger(input.maxWidth) || input.maxWidth < 64 || input.maxWidth > 2048)) throw new Error('maxWidth must be 64–2048.');
  if (input.crop && (!['x', 'y', 'width', 'height'].every(key => Number.isInteger((input.crop as any)[key])) || input.crop.x < 0 || input.crop.y < 0 || input.crop.width <= 0 || input.crop.height <= 0 || input.crop.width * input.crop.height > 16_000_000)) throw new Error('Invalid screenshot crop.');
  return { ...(input.windowRef !== undefined ? { windowRef: input.windowRef } : {}), ...(input.maxWidth !== undefined ? { maxWidth: input.maxWidth } : {}), ...(input.crop ? { crop: input.crop } : {}) };
}

export function validateAction(input: DesktopActionInput): DesktopActionInput {
  if (!input || typeof input !== 'object' || !/^[a-f0-9]{32}$/.test(input.observationId) || !['move', 'click', 'scroll', 'type', 'key'].includes(input.action)) throw new Error('A fresh observationId and supported action are required.');
  const action: DesktopActionInput = { observationId: input.observationId, action: input.action };
  if (['move', 'click', 'scroll'].includes(input.action)) {
    if (typeof input.x !== 'number' || typeof input.y !== 'number' || !Number.isFinite(input.x) || !Number.isFinite(input.y) || input.x < 0 || input.y < 0) throw new Error('Pointer actions require finite image coordinates.');
    action.x = input.x; action.y = input.y;
  }
  if (input.action === 'scroll') {
    if (!['up', 'down', 'left', 'right'].includes(input.direction ?? '') || !Number.isInteger(input.notches) || input.notches! < 1 || input.notches! > 10) throw new Error('Scroll needs direction and 1–10 notches.');
    action.direction = input.direction; action.notches = input.notches;
  }
  if (input.action === 'type') {
    if (typeof input.text !== 'string' || !input.text.length || input.text.length > 1024 || /[\x00-\x1f\x7f]/.test(input.text) || Buffer.from(input.text, 'utf8').toString('utf8') !== input.text) throw new Error('Type needs 1–1024 printable UTF-16 units.');
    action.text = input.text;
  }
  if (input.action === 'key') {
    const allowed = new Set(['CTRL', 'SHIFT', 'ALT', 'ENTER', 'TAB', 'ESC', 'BACKSPACE', 'DELETE', 'HOME', 'END', 'LEFT', 'UP', 'RIGHT', 'DOWN', 'A', 'F']);
    if (!Array.isArray(input.keys) || input.keys.length < 1 || input.keys.length > 3 || new Set(input.keys).size !== input.keys.length || input.keys.some(key => !allowed.has(key))) throw new Error('Unsupported key chord.');
    action.keys = input.keys;
  }
  return action;
}
