// Production UI and transport with simulated Revit; no provider credentials.
import { chromium, expect } from '@playwright/test';
import { Dealer } from 'zeromq';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { createHost } from '../../dist/host/server.js';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZkAAAAASUVORK5CYII=';
const dir = await mkdtemp(join(tmpdir(), 'revcode-images-'));
let finish;
let receivedImages;
const host = await createHost({ instanceId: 'images', nativeToken: 'fixture', dataDir: dir, webDir: resolve('dist/web'), agent: {
  providers: [{ id: 'anthropic', models: [{ id: 'vision', name: 'Vision', supportsImages: true }] }],
  configured: () => true, setKey: async () => {}, abort: async () => finish?.(),
  prompt: async (_text, _settings, _context, _history, _execute, update, _desktop, _services, images) => {
    receivedImages = images; update('Inspecting attached images.');
    await new Promise(resolve => { finish = resolve; });
  },
} });
const native = new Dealer({ linger: 0 }); native.connect(host.nativeEndpoint);
const send = (type, payload) => native.send(JSON.stringify({ type, token: 'fixture', payload }));
const context = { instanceId: 'images', revitVersion: '2026', revitBuild: '26', runtime: '.NET 8', document: {
  token: 'doc', title: 'Drawing fixture', isFamily: false, isReadOnly: false, activeView: '3D', selection: [],
} };
await send('context', context);
const heartbeat = setInterval(() => void send('context', context).catch(() => {}), 1000);
const nativeLoop = (async () => {
  try { for await (const [frame] of native) {
    const { command } = JSON.parse(frame.toString());
    if (command?.kind !== 'execute') continue;
    const path = command.code.match(/FilePath = @"([^"]+)"/)[1];
    await writeFile(path + '.png', Buffer.from(png, 'base64'));
    await send('operation', { operationId: command.operationId, status: 'succeeded', result: { viewName: '3D' } });
  } } catch { /* teardown */ }
})();
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [], fontFailures = [], external = [];
page.on('pageerror', error => errors.push(error.message));
page.on('response', response => { if (response.url().endsWith('.woff2') && !response.ok()) fontFailures.push(response.url()); });
page.on('request', request => { if (request.url().startsWith('http') && !request.url().startsWith(host.url)) external.push(request.url()); });
try {
  await page.goto(`${host.url}/#${host.browserToken}`);
  await expect(page.getByRole('button', { name: 'New drawing', exact: true })).toBeEnabled();
  await page.getByLabel('Choose images').setInputFiles({ name: 'reference.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
  await expect(page.getByRole('button', { name: 'Annotate reference.png' })).toBeVisible();
  await page.getByRole('button', { name: 'Annotate reference.png' }).click();
  await expect(page.getByRole('button', { name: 'Save annotations', exact: true })).toBeEnabled({ timeout: 20000 });
  await page.getByRole('slider', { name: 'Image opacity' }).fill('45');
  await expect(page.getByRole('slider', { name: 'Image opacity' })).toHaveValue('45');
  await page.getByRole('button', { name: 'Save annotations', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Annotate reference.png' }).click();
  await expect(page.getByRole('slider', { name: 'Image opacity' })).toHaveValue('45');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'New drawing', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save drawing', exact: true })).toBeEnabled();
  const canvas = page.locator('canvas.excalidraw__canvas.interactive');
  await expect(canvas).toBeVisible();
  const box = await canvas.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 100, box.y + box.height / 2 + 60, { steps: 12 });
  await page.mouse.up();
  await page.keyboard.press('t');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2 + 100);
  await page.keyboard.insertText('Drawing note');
  await page.keyboard.press('Escape');
  await mkdir('.local', { recursive: true });
  await page.screenshot({ path: '.local/images-drawing.png' });
  await page.getByRole('button', { name: 'Save drawing', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Annotate Drawing.png' })).toBeVisible();
  await page.getByRole('button', { name: 'Annotate Drawing.png' }).click();
  await expect(page.getByRole('heading', { name: 'Edit drawing' })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Capture active view', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Annotate Active Revit view.png' })).toBeVisible();
  await page.getByRole('button', { name: 'Annotate Active Revit view.png' }).click();
  await expect(page.getByRole('button', { name: 'Save annotations', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.screenshot({ path: '.local/images-composer.png' });
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => receivedImages?.length).toBe(3);
  expect(receivedImages).toHaveLength(3);
  await expect(page.getByLabel('Image attachments')).toHaveCount(0);
  await expect(page.getByAltText('Attached image 3', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByAltText('Attached image 3', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect.poll(() => host.snapshot().busy).toBe(false);
  await page.reload();
  await expect(page.getByAltText('Attached image 3', { exact: true })).toBeVisible();
  expect(errors).toEqual([]); expect(fontFailures).toEqual([]); expect(external).toEqual([]);
  console.log('PASS image smoke: upload, annotate, draw, reopen, active-view capture, image-only send, provider payload, cancellation, reload, local fonts.');
} finally {
  finish?.(); clearInterval(heartbeat); await browser.close(); native.close(); await nativeLoop; await host.close();
  if (dirname(resolve(dir)) !== resolve(tmpdir()) || !basename(dir).startsWith('revcode-images-')) throw new Error('Unexpected temporary directory');
  await rm(dir, { recursive: true, force: true });
}
