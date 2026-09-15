import { expect, it } from 'vitest';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCaptureTool } from '../../src/host/capture-view.js';
import type { Operation } from '../../src/host/types.js';

it.each(['failed', 'unknown', 'oversized'])('handles %s captures without sending image content', async scenario => {
  const dir = await mkdtemp(join(tmpdir(), 'revcode-capture-test-'));
  try {
    const tool = createCaptureTool(dir, async input => {
      const path = input.code.match(/FilePath = @"([^"]+)"/)![1] + '.png';
      if (scenario === 'oversized') await writeFile(path, Buffer.alloc(10 * 1024 * 1024 + 1));
      return { ...input, operationId: 'op', documentToken: 'doc', createdAt: '',
        status: ['failed', 'unknown'].includes(scenario) ? scenario : 'succeeded',
        result: { viewId: 'view' },
      } as Operation;
    }, true);
    const result = tool.execute('id', {});
    if (scenario === 'oversized') await expect(result).rejects.toThrow();
    else {
      const response = await result;
      expect(response.isError).toBe(true);
      expect(response.content.every(item => item.type === 'text')).toBe(true);
    }
    expect((await readdir(join(dir, 'captures'))).length).toBe(scenario === 'unknown' ? 1 : 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
