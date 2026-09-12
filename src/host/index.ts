import { parseArgs } from 'node:util';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { createHost } from './server.js';
import { createPiAgent } from './pi-agent.js';

const { values } = parseArgs({ options: { instance: { type: 'string' }, 'parent-pid': { type: 'string' }, discovery: { type: 'string' }, 'data-dir': { type: 'string' }, 'user-dir': { type: 'string' } } });
const nativeToken = process.env.REVCODE_NATIVE_TOKEN;
delete process.env.REVCODE_NATIVE_TOKEN;
if (!values.instance || !values.discovery || !values['data-dir'] || !nativeToken) throw new Error('Required: --instance --discovery --data-dir and REVCODE_NATIVE_TOKEN.');
const dataDir = resolve(values['data-dir']);
const userDir = values['user-dir'] ? resolve(values['user-dir']) : resolve(dataDir, '../../user');
const configuredPiDir = process.env.PI_CODING_AGENT_DIR;
const piDir = configuredPiDir?.startsWith('~/') ? resolve(homedir(), configuredPiDir.slice(2)) : resolve(configuredPiDir ?? resolve(homedir(), '.pi/agent'));
const authPath = resolve(process.env.REVCODE_PI_AUTH_PATH ?? resolve(piDir, 'auth.json'));
const host = await createHost({ instanceId: values.instance, nativeToken, dataDir, userDir, webDir: resolve(dirname(fileURLToPath(import.meta.url)), '../web'), agent: await createPiAgent(dataDir, userDir, undefined, authPath) });
const discovery = resolve(values.discovery);
await mkdir(dirname(discovery), { recursive: true, mode: 0o700 });
await writeFile(`${discovery}.tmp`, JSON.stringify({ protocolVersion: 1, instanceId: values.instance, url: host.url, nativeEndpoint: host.nativeEndpoint, browserToken: host.browserToken }), { mode: 0o600 });
await rename(`${discovery}.tmp`, discovery);
let exiting = false;
async function shutdown() { if (exiting) return; exiting = true; clearInterval(parentWatch); await host.close(); await rm(discovery, { force: true }); }
const parentPid = Number(values['parent-pid']);
const parentWatch = setInterval(() => { if (parentPid > 0) { try { process.kill(parentPid, 0); } catch { void shutdown(); } } }, 2000);
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
