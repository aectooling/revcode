import { expect, it, vi } from 'vitest';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureCode, createCaptureTool } from '../../src/host/capture-view.js';
import type { Operation } from '../../src/host/types.js';

it('rejects text-only models and invalid sizes before executing', async () => {
  const execute = vi.fn();
  await expect(createCaptureTool('', execute, false).execute('id', {})).rejects.toThrow('does not support images');
  await expect(createCaptureTool('', execute, true).execute('id', { pixelSize: 9999 })).rejects.toThrow('pixelSize');
  expect(execute).not.toHaveBeenCalled();
});

it.each([
  { zoom: 50 }, { zoomType: 'fitToPage', zoom: 50 },
  { zoomType: 'zoom', pixelSize: 1024 }, { zoomType: 'invalid' },
  ...[0, -1, 1001, 1.5, NaN, Infinity].map(zoom => ({ zoomType: 'zoom', zoom })),
])('rejects invalid or conflicting export sizing before dispatch: %j', async input => {
  const execute = vi.fn();
  await expect(createCaptureTool('', execute, true).execute('id', input as Parameters<ReturnType<typeof createCaptureTool>['execute']>[1])).rejects.toThrow();
  expect(execute).not.toHaveBeenCalled();
});

it('preserves fixed-width defaults and applies percentage sizing independently of region', () => {
  const fixed = captureCode({}, 'C:/capture');
  expect(fixed).toContain('ZoomType = ZoomFitType.FitToPage');
  expect(fixed).toContain('PixelSize = 1536');
  expect(fixed).not.toContain('Zoom =');
  for (const region of ['view', 'visible'] as const) {
    for (const zoom of [undefined, 1, 100, 1000]) {
      const code = captureCode({ region, zoomType: 'zoom', zoom }, 'C:/capture');
      expect(code).toContain(`ZoomType = ZoomFitType.Zoom, Zoom = ${zoom ?? 50}`);
      expect(code).toContain(`zoomType = "zoom", zoom = ${zoom ?? 50}, imageResolution = 150`);
      expect(code).not.toContain('PixelSize =');
      expect(code).toContain(region === 'view' ? 'ExportRange.SetOfViews' : 'ExportRange.VisibleRegionOfCurrentView');
    }
  }
});

it.each(['failed', 'unknown', 'captureError', 'missing', 'invalid', 'oversized'])('handles %s captures without sending image content', async scenario => {
  const dir = await mkdtemp(join(tmpdir(), 'revcode-capture-test-'));
  try {
    const tool = createCaptureTool(dir, async input => {
      const path = input.code.match(/FilePath = @"([^"]+)"/)![1] + '.png';
      if (scenario === 'invalid') await writeFile(path, 'not a PNG');
      if (scenario === 'oversized') await writeFile(path, Buffer.alloc(10 * 1024 * 1024 + 1));
      return { ...input, operationId: 'op', documentToken: 'doc', createdAt: '',
        status: ['failed', 'unknown'].includes(scenario) ? scenario : 'succeeded',
        result: scenario === 'captureError' ? { captureError: 'View cannot be exported' } : { viewId: 'view' },
      } as Operation;
    }, true);
    const result = tool.execute('id', {});
    if (['missing', 'invalid', 'oversized'].includes(scenario)) await expect(result).rejects.toThrow();
    else {
      const response = await result;
      expect(response.isError).toBe(true);
      expect(response.content.every(item => item.type === 'text')).toBe(true);
    }
    expect((await readdir(join(dir, 'captures'))).length).toBe(scenario === 'unknown' ? 1 : 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
