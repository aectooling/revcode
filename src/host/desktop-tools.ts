import { Type } from 'typebox';
import type { DesktopActionInput, DesktopObservation, DesktopObserveInput, DesktopTools } from './desktop-types.js';

export function createDesktopTools(desktop: DesktopTools | undefined, supportsImages: boolean) {
  const requireDesktop = () => {
    if (!supportsImages) throw new Error('Desktop tools require an image-capable selected model. Select a vision model; no provider is switched automatically.');
    if (!desktop) throw new Error('Desktop control is unavailable in this host. Install the current Revcode package.');
    return desktop;
  };
  const content = (observation: DesktopObservation) => {
    const { data, ...metadata } = observation;
    return [{ type: 'text' as const, text: JSON.stringify(metadata) }, { type: 'image' as const, data, mimeType: observation.mimeType }];
  };
  return [
    {
      name: 'revit_ui_observe', label: 'Observe Revit desktop',
      description: 'See the real Revit window, ribbon and owned dialogs as an image. The host shows a hands-off countdown before acquiring input control. Accidental user input triggers a bounded wait and fresh observation, with a warning before returning focus to Revit. Use a fresh actionable observation for each action; coordinates are relative to the returned image.',
      parameters: Type.Object({ windowRef: Type.Optional(Type.String()), maxWidth: Type.Optional(Type.Integer({ minimum: 64, maximum: 2048 })),
        crop: Type.Optional(Type.Object({ x: Type.Integer({ minimum: 0 }), y: Type.Integer({ minimum: 0 }), width: Type.Integer({ minimum: 1 }), height: Type.Integer({ minimum: 1 }) })) }),
      execute: async (_id: string, input: DesktopObserveInput, signal?: AbortSignal) => {
        const observation = await requireDesktop().observe(input, signal);
        return { content: content(observation), details: { observationId: observation.observationId, actionable: observation.actionable } };
      },
    },
    {
      name: 'revit_ui_action', label: 'Interact with Revit desktop',
      description: 'Perform one move, left click, scroll, Unicode typing action or named key chord using a fresh actionable desktop observation. Pointer coordinates come from that image. Dispatch is not success: inspect the returned screenshot and query the API where appropriate. Never retry an unknown result.',
      parameters: Type.Object({ observationId: Type.String(), action: Type.Union(['move', 'click', 'scroll', 'type', 'key'].map(value => Type.Literal(value))),
        x: Type.Optional(Type.Number({ minimum: 0 })), y: Type.Optional(Type.Number({ minimum: 0 })), text: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
        keys: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: 3 })),
        direction: Type.Optional(Type.Union(['up', 'down', 'left', 'right'].map(value => Type.Literal(value)))), notches: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })) }),
      execute: async (id: string, input: DesktopActionInput, signal?: AbortSignal) => {
        const result = await requireDesktop().action(id, input, signal);
        const recovered = result.receipt.status === 'not-dispatched' && result.receipt.inserted === 0 &&
          ['input', 'observe'].includes(result.receipt.recovery ?? '') && result.observation?.actionable === true;
        const nextStep = recovered ? 'No input was sent. Recovery completed. Use the returned fresh screenshot to choose the next action and continue the task.' : undefined;
        return { content: [{ type: 'text' as const, text: JSON.stringify({ receipt: result.receipt, captureError: result.captureError, nextStep }) }, ...(result.observation ? content(result.observation) : [])],
          details: { receipt: result.receipt, captureError: result.captureError, recovered }, isError: result.receipt.status !== 'dispatched' && !recovered };
      },
    },
  ];
}
