// Run after npm run build. Exercises the same private stdin shutdown used by the ribbon.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const root = await mkdtemp(join(tmpdir(), 'revcode-host-lifecycle-'));
const discoveryPath = join(root, 'discovery.json');
const instance = randomUUID();
async function generation(stopDuringStartup = false) {
  const child = spawn(process.execPath, [resolve('dist/host/index.js'), '--instance', instance,
    '--discovery', discoveryPath, '--data-dir', join(root, 'data'), '--user-dir', join(root, 'user'),
    '--shutdown-stdin'], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, REVCODE_NATIVE_TOKEN: randomUUID(), PI_CODING_AGENT_DIR: join(root, 'pi'),
      REVCODE_PI_AUTH_PATH: join(root, 'auth.json') },
  });
  let logs = '';
  child.stdout.on('data', chunk => { logs += chunk; });
  child.stderr.on('data', chunk => { logs += chunk; });
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => resolve(code));
  });
  const timeout = setTimeout(() => child.kill(), 30_000);
  try {
    let discovery;
    if (!stopDuringStartup) {
      for (let attempt = 0; attempt < 200; attempt++) {
        assert.equal(child.exitCode, null, logs);
        try { discovery = JSON.parse(await readFile(discoveryPath, 'utf8')); break; } catch { }
        await delay(100);
      }
      assert.ok(discovery, `Host did not become ready: ${logs}`);
      const response = await fetch(`${discovery.url}/api/state`, {
        headers: { Authorization: `Bearer ${discovery.browserToken}` },
      });
      assert.equal(response.status, 200);
    }
    child.stdin.end();
    assert.equal(await exited, 0, logs);
    await assert.rejects(access(discoveryPath), { code: 'ENOENT' });
    if (discovery) await assert.rejects(fetch(`${discovery.url}/api/state`));
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null) { child.kill(); await exited; }
  }
}

try {
  await generation();
  await generation(); // Same instance/journal, new host after the old one has exited.
  await generation(true);
  console.log('PASS: graceful stop, restart with the same journal, and stop during startup.');
} finally {
  await rm(root, { recursive: true, force: true });
}
