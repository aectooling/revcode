import { mkdir, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Type } from 'typebox';
import type { Agent, Operation } from './types.js';

export const captureParameters = Type.Object({
  documentToken: Type.Optional(Type.String({ minLength: 1 })),
  viewId: Type.Optional(Type.String({ minLength: 1, description: 'View UniqueId from a C# query. Omit for the target document’s active view.' })),
  region: Type.Optional(Type.Union([Type.Literal('view'), Type.Literal('visible')], { description: 'Default view exports the whole view. visible captures the current viewport and requires the target view/document to be active.' })),
  zoomType: Type.Optional(Type.Union([Type.Literal('fitToPage'), Type.Literal('zoom')], { description: 'Export sizing mode, not viewport zoom. Default fitToPage uses pixelSize; zoom uses a percentage at 150 DPI.' })),
  zoom: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000, description: 'Export scale percentage, only with zoomType zoom. Defaults to Revit’s 50%. Tool accepts 1–1000; Revit may reject values depending on export constraints.' })),
  pixelSize: Type.Optional(Type.Integer({ minimum: 256, maximum: 2048, description: 'Image width in pixels, only with zoomType fitToPage (the default). Defaults to 1536.' })),
});

interface CaptureInput { documentToken?: string; viewId?: string; region?: 'view' | 'visible'; pixelSize?: number; zoomType?: 'fitToPage' | 'zoom'; zoom?: number }
const literal = (value: string) => '@"' + value.replaceAll('"', '""') + '"';

// Use the normal execution journal, cancellation and document binding. Only the
// small metadata result crosses ZeroMQ; image bytes bypass the 256 KiB JSON cap.
export function captureCode(input: CaptureInput, directory: string): string {
  return `try {
var doc = ctx.Doc;
var view = ${input.viewId ? `doc.GetElement(${literal(input.viewId)}) as View` : 'doc.ActiveView'};
if (view == null || view.IsTemplate || !view.CanBePrinted)
    return new { captureError = "Choose an exportable non-template view using a C# view query." };
${input.region === 'visible' ? `if (ctx.UiDoc == null || ctx.UiDoc.Document != doc || ctx.UiDoc.ActiveView.Id != view.Id)
    return new { captureError = "Visible capture requires this document and view to be active. Request a view change in a separate API call, then verify activation before capturing." };
ctx.UiDoc.RefreshActiveView();` : ''}
ctx.CheckCancellation();
using var options = new ImageExportOptions {
    FilePath = ${literal(join(directory, 'capture'))},
    ExportRange = ExportRange.${input.region === 'visible' ? 'VisibleRegionOfCurrentView' : 'SetOfViews'},
    ${input.zoomType === 'zoom' ? `ZoomType = ZoomFitType.Zoom, Zoom = ${input.zoom ?? 50},` : `ZoomType = ZoomFitType.FitToPage, FitDirection = FitDirectionType.Horizontal,
    PixelSize = ${input.pixelSize ?? 1536},`}
    ImageResolution = ImageResolution.DPI_150,
    HLRandWFViewsFileType = ImageFileType.PNG, ShadowViewsFileType = ImageFileType.PNG
};
${input.region === 'visible' ? '' : 'options.SetViewsAndSheets(new List<ElementId> { view.Id });'}
doc.ExportImage(options);
return new { documentToken = ctx.GetDocumentToken(doc), viewId = view.UniqueId, viewName = view.Name,
    viewType = view.ViewType.ToString(), region = "${input.region ?? 'view'}",
    zoomType = "${input.zoomType ?? 'fitToPage'}", ${input.zoomType === 'zoom' ? `zoom = ${input.zoom ?? 50}` : `pixelSize = ${input.pixelSize ?? 1536}`}, imageResolution = 150 };
} catch (OperationCanceledException) { throw; }
catch (Exception ex) { return new { captureError = ex.Message }; }`;
}

export function createCaptureTool(dataDir: string, execute: Parameters<Agent['prompt']>[4], supportsImages: boolean) {
  return { name: 'revit_capture_view', label: 'Capture Revit view',
    description: 'Inspect a Revit view as a PNG image. Exports a specific view without activating it; defaults to the target document’s active view. Use C# to discover view UniqueIds or adjust orientation/crop first. visible region requires an already active view. Requires an image-capable model.',
    parameters: captureParameters,
    execute: async (_id: string, input: CaptureInput, signal?: AbortSignal) => {
      if (!supportsImages) throw new Error('The selected model does not support images. Select an image-capable model to inspect a capture.');
      if (input.pixelSize !== undefined && (!Number.isInteger(input.pixelSize) || input.pixelSize < 256 || input.pixelSize > 2048)) throw new Error('pixelSize must be an integer from 256 to 2048.');
      if (input.region !== undefined && !['view', 'visible'].includes(input.region)) throw new Error('Invalid capture region.');
      if (input.zoomType !== undefined && !['fitToPage', 'zoom'].includes(input.zoomType)) throw new Error('zoomType must be fitToPage or zoom.');
      if (input.zoom !== undefined && (!Number.isInteger(input.zoom) || input.zoom < 1 || input.zoom > 1000)) throw new Error('zoom must be an integer percentage from 1 to 1000.');
      if (input.zoom !== undefined && input.zoomType !== 'zoom') throw new Error('Set zoomType to zoom when supplying zoom.');
      if (input.zoomType === 'zoom' && input.pixelSize !== undefined) throw new Error('pixelSize applies only to zoomType fitToPage. Omit pixelSize for percentage zoom.');
      signal?.throwIfAborted();
      const root = join(dataDir, 'captures');
      await mkdir(root, { recursive: true, mode: 0o700 });
      const directory = await mkdtemp(join(root, 'view-'));
      let operation: Operation | undefined;
      try {
        operation = await execute({ code: captureCode(input, directory), mode: 'api', ...(input.documentToken === undefined ? {} : { documentToken: input.documentToken }) }, signal);
        const result = operation.result as { captureError?: string } | undefined;
        if (operation.status !== 'succeeded' || result?.captureError) {
          return { content: [{ type: 'text' as const, text: JSON.stringify(operation) }], details: operation, isError: true };
        }
        signal?.throwIfAborted();
        const files = (await readdir(directory)).filter(name => name.toLowerCase().endsWith('.png'));
        if (files.length !== 1) throw new Error('Revit did not produce exactly one PNG for the requested view.');
        const path = join(directory, files[0]!);
        if ((await stat(path)).size > 10 * 1024 * 1024) throw new Error('Capture exceeds 10 MiB. Reduce zoom, or use zoomType fitToPage with a smaller pixelSize.');
        const bytes = await readFile(path);
        if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('Revit produced an invalid PNG.');
        return { content: [{ type: 'text' as const, text: JSON.stringify(operation) },
          { type: 'image' as const, data: bytes.toString('base64'), mimeType: 'image/png' }], details: operation };
      } finally {
        // An unknown/disconnected execution may still be exporting. Preserve its
        // unique directory rather than racing Revit or reusing the output path.
        if (operation && ['succeeded', 'failed', 'cancelled'].includes(operation.status)) await rm(directory, { recursive: true, force: true });
      }
    },
  };
}
