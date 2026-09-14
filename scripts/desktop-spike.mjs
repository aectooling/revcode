// Manual image-review staging around the production desktop controller.
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { DesktopClient } from '../dist/host/desktop-client.js';
import { DesktopController } from '../dist/host/desktop-controller.js';
import { DesktopWorkflow } from './desktop-workflow.mjs';

const [executable, pidText, outputDirectory, inputFlag] = process.argv.slice(2);
if (process.platform !== 'win32' || !executable || !/^\d+$/.test(pidText ?? '') || !outputDirectory || (inputFlag && inputFlag !== '--enable-input'))
  throw new Error('Usage: node scripts/desktop-spike.mjs <helper.exe> <Revit PID> <new evidence directory> [--enable-input]');
const directory = resolve(outputDirectory);
await mkdir(directory, { recursive: false });
const ticks = execFileSync('powershell.exe', ['-NoProfile', '-Command',
  `(Get-Process -Id ${Number(pidText)}).StartTime.ToUniversalTime().Ticks.ToString()`],
  { windowsHide: true, encoding: 'utf8', timeout: 10000 }).trim();
const client = new DesktopClient(resolve(executable), Number(pidText), ticks);
let active, running;
// This standalone harness has no native API connection or document guard.
const desktop = new DesktopController(client, directory, () => {}, () => {}, reason => active?.abort(new Error(reason)));
await desktop.init();
async function record(frame) {
  const { data, ...metadata } = frame;
  const bytes = Buffer.from(data, 'base64');
  const evidence = { ...metadata, digest: createHash('sha256').update(bytes).digest('hex') };
  await writeFile(resolve(directory, `${frame.observationId}.png`), bytes, { flag: 'wx' });
  await writeFile(resolve(directory, `${frame.observationId}.json`), JSON.stringify(evidence, null, 2), { flag: 'wx' });
  console.log(JSON.stringify(evidence, null, 2));
  return evidence;
}
const workflow = new DesktopWorkflow(desktop, (ms, signal) => delay(ms, undefined, { signal }), !!inputFlag, record);
try {
  console.log('Capture: {"kind":"observe"}. Review the saved PNG after control is released.');
  console.log('Stage an action: {"kind":"action","action":"click","x":100,"y":100}. Input requires a fresh image matching the reviewed PNG.');
  console.log('Optional delaySeconds: 1–30, followed by the production control countdown. Stop: {"kind":"stop"}, or Ctrl+Alt+F12 while controlling.');
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of input) {
    try {
      const fields = JSON.parse(line);
      if (fields.kind === 'stop') {
        active?.abort(); workflow.reference = undefined;
        void desktop.stop().catch(error => console.error(error.message));
      } else {
        if (active) throw new Error('A staged command is running. Stop it or wait for completion.');
        const controller = active = new AbortController();
        running = workflow.run(fields, controller.signal)
          .then(result => { if (result) console.log(JSON.stringify(result, null, 2)); })
          .catch(error => console.error(error.message)).finally(() => { active = undefined; });
      }
    } catch (error) { console.error(error.message); }
  }
} finally {
  active?.abort();
  try { await desktop.stop(); } finally { await running; await desktop.close(); }
}
