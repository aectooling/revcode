import { expect, it } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPiAgent } from '../../src/host/pi-agent.js';
import type { DesktopObservation } from '../../src/host/desktop-types.js';

it.each([true, false])('real Pi SDK transmits desktop images and gates actions on image capability (%s)', async vision => {
  const dir = await mkdtemp(join(tmpdir(), 'revcode-desktop-pi-'));
  const requests: any[] = [];
  const image: DesktopObservation = { observationId: 'a'.repeat(32), windowRef: 'b'.repeat(32), title: 'Revit', timestamp: new Date().toISOString(),
    bounds: { x: 0, y: 0, width: 1, height: 1 }, crop: { x: 0, y: 0, width: 1, height: 1 }, width: 1, height: 1, dpi: 96,
    windows: [], actionable: true, backend: 'fixture', mimeType: 'image/png',
    data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZkAAAAASUVORK5CYII=' };
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunk = (delta: object, finish_reason: string | null = null) => res.write(`data: ${JSON.stringify({ id: 'desktop-fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    if (requests.length <= 2) {
      const observe = requests.length === 1;
      chunk({ role: 'assistant', tool_calls: [{ index: 0, id: `desktop_call_${requests.length}`, type: 'function', function: {
        name: observe ? 'revit_ui_observe' : 'revit_ui_action', arguments: JSON.stringify(observe ? {} : { observationId: image.observationId, action: 'click', x: 0, y: 0 }),
      } }] }); chunk({}, 'tool_calls');
    } else { chunk({ role: 'assistant', content: 'Desktop check complete.' }); chunk({}, 'stop'); }
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const agent = await createPiAgent(dir, dir, runtime => runtime.registerProvider('openai', {
      api: 'openai-completions', baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, apiKey: 'fixture-key',
      models: [{ id: 'fixture', name: 'Fixture', reasoning: false, input: vision ? ['text', 'image'] : ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1000 }],
    }));
    let observes = 0, actions = 0;
    await agent.prompt('Inspect Revit and click the visible test control.', { provider: 'openai', model: 'fixture', configured: true },
      { instanceId: 'fixture', revitVersion: '2026', revitBuild: '26.3', runtime: '.NET 8', document: null }, [],
      async () => { throw new Error('Unexpected C# execution'); }, () => {}, {
        observe: async () => { observes++; return image; },
        action: async (id, input) => {
          actions++; expect(id).toContain('desktop_call_2'); expect(input).toMatchObject({ observationId: image.observationId, action: 'click', x: 0, y: 0 });
          return { receipt: { status: 'dispatched', inserted: 3 }, observation: image };
        },
      });
    expect(requests[0].tools.map((tool: any) => tool.function.name)).toEqual(['revit_execute_csharp', 'revit_capture_view', 'revit_ui_observe', 'revit_ui_action']);
    expect(observes).toBe(vision ? 1 : 0); expect(actions).toBe(vision ? 1 : 0);
    const received = JSON.stringify(requests.at(-1).messages);
    if (vision) { expect(received).toContain(`data:image/png;base64,${image.data}`); expect(received).toContain('dispatched'); }
    else { expect(received).toContain('image-capable'); expect(received).not.toContain('data:image/png'); }
    expect(await readdir(join(dir, 'pi'))).not.toContain('sessions'); // No duplicate base64 image logs.
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); }
}, 30000);
