// Live UI check after smoke-revit.mjs and one normal Revit Undo.
// Usage: node scripts/smoke-browser-revit.mjs <discovery.json> <results.json> <screenshot.png>
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
const [discoveryPath, reportPath, screenshotPath] = process.argv.slice(2);
if (!discoveryPath || !reportPath || !screenshotPath) throw new Error('Pass discovery, prior smoke report, and screenshot paths.');
const discovery = JSON.parse(await readFile(discoveryPath, 'utf8'));
const report = JSON.parse(await readFile(reportPath, 'utf8'));
const name = report.results.find(result => result.label === 'create level')?.result?.name;
assert.match(name ?? '', /^Revcode verified [a-f0-9-]+$/);
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  await page.goto(`${discovery.url}/#${discovery.browserToken}`);
  await expect(page.getByText('Revit connected', { exact: true })).toBeVisible();
  await expect(page).toHaveURL(`${discovery.url}/`);
  // Use the known launcher credential for verification; never print it.
  const state = await (await fetch(`${discovery.url}/api/state`, { headers: { Authorization: `Bearer ${discovery.browserToken}` } })).json();
  assert.equal(state.context.document.token, report.context.document.token);
  const count = state.operations.length;
  await page.getByRole('button', { name: 'C# console', exact: true }).click();
  await page.locator('#code').fill(`return new FilteredElementCollector(ctx.Doc).OfClass(typeof(Level)).Cast<Level>().Count(x => x.Name == "${name}");`);
  await page.getByLabel('Execution mode').selectOption('query');
  await page.getByRole('button', { name: 'Run C#' }).click();
  await expect.poll(async () => {
    const next = await (await fetch(`${discovery.url}/api/state`, { headers: { Authorization: `Bearer ${discovery.browserToken}` } })).json();
    const op = next.operations.at(-1);
    if (next.operations.length <= count || op.status !== 'succeeded') return undefined;
    return op.result;
  }, { timeout: 30_000 }).toBe(0);
  await page.locator('.operation').first().locator('summary').click();
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await page.reload();
  await expect(page.locator('.operation')).toHaveCount(count + 1);
  report.browser = { at: new Date().toISOString(), realRevitConsole: 'passed', normalUndoVerified: true, reloadWithoutReplay: true };
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log('PASS live browser console -> ZeroMQ -> Revit; normal Undo verified; reload did not replay execution.');
} finally { await browser.close(); }
