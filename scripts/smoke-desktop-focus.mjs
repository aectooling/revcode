// Live Windows check: acquire Revit focus and capture, without model-editing input.
// Build the host first. Start with chat foreground; Revit may be minimized.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { DesktopClient } from '../dist/host/desktop-client.js';

const [executable, pidText, outputDirectory, repeat] = process.argv.slice(2);
if (!executable || !/^\d+$/.test(pidText ?? '') || !outputDirectory || (repeat && repeat !== '--repeat'))
  throw new Error('Usage: node scripts/smoke-desktop-focus.mjs <helper.exe> <Revit PID> <new evidence directory> [--repeat]');
const directory = resolve(outputDirectory);
await mkdir(directory, { recursive: false });
const ticks = execFileSync('powershell.exe', ['-NoProfile', '-Command',
  `(Get-Process -Id ${Number(pidText)}).StartTime.ToUniversalTime().Ticks.ToString()`],
  { windowsHide: true, encoding: 'utf8', timeout: 10000 }).trim();
const client = new DesktopClient(resolve(executable), Number(pidText), ticks);
try {
 for (let attempt = 1; attempt <= (repeat ? 2 : 1); attempt++) {
  if (attempt > 1) {
    console.log('Same helper, second turn: switch to chat and move/click the mouse there during this five-second pause.');
    await delay(5000);
  }
  const start = await client.request('start');
  assert.equal(start.status, 'owned');
  const frame = await client.request('observe');
  assert.equal(frame.actionable, true, 'Expected a fresh foreground Revit observation.');
  const { data, ...metadata } = frame;
  const suffix = attempt === 1 ? '' : `-${attempt}`;
  await writeFile(resolve(directory, `revit${suffix}.png`), Buffer.from(data, 'base64'), { flag: 'wx' });
  await writeFile(resolve(directory, `observation${suffix}.json`), JSON.stringify(metadata, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ attempt, start, title: frame.title, actionable: frame.actionable, width: frame.width, height: frame.height, directory }));
  await client.stop();
 }
} finally {
  await client.close();
}
