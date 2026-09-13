// Manual phase-one driver. No model, API operation, or automatic input retry.
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, open, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { DesktopWorkflow } from './desktop-workflow.mjs';

const [executable, pidText, outputDirectory, inputFlag] = process.argv.slice(2);
if (process.platform !== 'win32' || !executable || !/^\d+$/.test(pidText ?? '') || !outputDirectory || (inputFlag && inputFlag !== '--enable-input')) {
  throw new Error('Usage: node scripts/desktop-spike.mjs <helper.exe> <Revit PID> <new evidence directory> [--enable-input]');
}
const directory = resolve(outputDirectory);
await mkdir(directory, { recursive: false });
const journal = await open(resolve(directory, 'journal.jsonl'), 'ax');
const starts = execFileSync('powershell.exe', ['-NoProfile', '-Command',
  `@(${Number(pidText)},${process.pid}) | ForEach-Object { (Get-Process -Id $_).StartTime.ToUniversalTime().Ticks.ToString() }`], { encoding: 'utf8', windowsHide: true }).trim().split(/\r?\n/);
if (starts.length !== 2 || starts.some(value => !/^\d+$/.test(value))) throw new Error('Could not bind process start identities.');
const helper = spawn(resolve(executable), [pidText, starts[0], String(process.pid), starts[1], ...(inputFlag ? [inputFlag] : [])], { windowsHide: true, stdio: ['pipe', 'pipe', 'inherit'] });
let generation, closed = false;
const pending = new Map();
let journalChain = Promise.resolve();
function record(entry) {
  journalChain = journalChain.then(async () => { await journal.write(`${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`); await journal.sync(); });
  return journalChain;
}
const lines = createInterface({ input: helper.stdout, crlfDelay: Infinity });
lines.on('line', line => {
  const response = JSON.parse(line);
  const waiter = pending.get(response.requestId);
  if (waiter) { pending.delete(response.requestId); clearTimeout(waiter.timer); waiter.resolve(response); }
});
function disconnected(error) {
  closed = true;
  for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(error); }
  pending.clear();
}
helper.on('error', disconnected);
helper.stdin.on('error', disconnected);
helper.on('exit', code => disconnected(new Error(`Helper exited (${code}); inspect journal before further input. Never replay actions.`)));
async function send(fields, persist = true) {
  if (closed) throw new Error('Helper is closed.');
  const request = { version: 1, requestId: randomUUID(), generation, ...fields };
  if (persist) await record({ kind: 'intent', request });
  const response = await new Promise((resolveResponse, reject) => {
    const timer = setTimeout(() => {
      pending.delete(request.requestId);
      helper.stdin.write(`${JSON.stringify({ version: 1, requestId: randomUUID(), kind: 'stop' })}\n`);
      reject(new Error('Helper timeout; input outcome may be unknown. Inspect journal. No retry was sent.'));
    }, 15000);
    pending.set(request.requestId, { resolve: resolveResponse, reject, timer });
    helper.stdin.write(`${JSON.stringify(request)}\n`);
  });
  if (response.result?.data) {
    const { data, ...metadata } = response.result;
    const artifact = `${metadata.observationId}.png`;
    const bytes = Buffer.from(data, 'base64');
    await writeFile(resolve(directory, artifact), bytes, { flag: 'wx' });
    response.result = { ...metadata, artifact, digest: createHash('sha256').update(bytes).digest('hex') };
  }
  if (persist) await record({ kind: 'response', response });
  return response;
}
let heartbeat;
let active;
let running;
async function workflowSend(fields) {
  // Stop bypasses disk writes so a slow/full journal cannot delay cancellation.
  const response = await send(fields, fields.kind !== 'stop');
  console.log(JSON.stringify(response, null, 2));
  if (response.error) throw new Error(response.error);
  return response.result;
}
try {
  const hello = await send({ kind: 'hello' }); generation = hello.generation;
  console.log(JSON.stringify(hello, null, 2));
  heartbeat = setInterval(() => { void send({ kind: 'heartbeat' }, false).catch(error => console.error(error.message)); }, 2000);
  const workflow = new DesktopWorkflow(workflowSend, (ms, signal) => delay(ms, undefined, { signal }), !!inputFlag);
  console.log('Capture: {"kind":"observe"}. You have 3 seconds to activate Revit and release all keys/buttons. Control is released after capture so you can review the PNG.');
  console.log('Then stage one action: {"kind":"action","action":"click","x":100,"y":100}. Activate Revit again during the delay. A fresh image must match the reviewed PNG or input is refused.');
  console.log('Optional delaySeconds: 1–30. Stop: {"kind":"stop"}, also during the delay. Ctrl+Alt+F12 stops input while the helper owns control.');
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of input) {
    try {
      const fields = JSON.parse(line);
      if (fields.kind === 'stop') {
        active?.abort();
        workflow.reference = undefined;
        void workflowSend({ kind: 'stop' }).catch(error => console.error(error.message));
      } else {
        if (active) throw new Error('A staged command is running. Stop it or wait for completion.');
        const controller = new AbortController();
        active = controller;
        running = workflow.run(fields, controller.signal)
          .catch(error => console.error(error.message))
          .finally(() => { active = undefined; });
      }
    } catch (error) { console.error(error.message); }
  }
} finally {
  active?.abort();
  await running;
  clearInterval(heartbeat);
  if (!closed) { try { await send({ kind: 'stop' }, false); } catch { /* watchdog/EOF releases the lease */ } helper.stdin.end(); }
  await journalChain; await journal.close();
}
