import type { ExecuteInput, Snippet } from './types.js';

/** Normalize before journaling so identity includes the complete batch. */
export function validateExecuteInput(input: any): ExecuteInput {
  const fail = (message: string): never => { throw new Error(message); };
  if (!input || typeof input !== 'object') fail('Invalid execution request.');
  const snippet = (value: any): Snippet => {
    if (!value || typeof value.code !== 'string' || !value.code.trim() || Buffer.byteLength(value.code) > 65536) fail('C# code must be 1–65536 bytes.');
    if (value.usings !== undefined && (!Array.isArray(value.usings) || value.usings.length > 40 || value.usings.some((u: unknown) => typeof u !== 'string' || u.length > 200))) fail('Invalid usings.');
    return { code: value.code, ...(value.usings !== undefined ? { usings: value.usings } : {}) };
  };
  if (input.documentToken !== undefined && input.documentToken !== null && (typeof input.documentToken !== 'string' || !input.documentToken.trim() || input.documentToken.length > 200)) fail('Invalid document token.');
  if (input.transactionName !== undefined && (typeof input.transactionName !== 'string' || input.transactionName.length > 200)) fail('Invalid transaction name.');
  const common = { ...(input.transactionName !== undefined ? { transactionName: input.transactionName } : {}) };
  if (input.mode === 'batch') {
    if (typeof input.documentToken !== 'string' || !input.documentToken.trim()) fail('Batch requires an explicit document token.');
    if (input.code !== undefined || input.usings !== undefined) fail('Batch accepts steps, not top-level code/usings.');
    if (!Array.isArray(input.steps) || input.steps.length < 1 || input.steps.length > 20) fail('Batch requires 1–20 steps.');
    const steps = input.steps.map((step: any) => {
      if (!step || typeof step.name !== 'string' || !step.name.trim() || step.name.length > 100) fail('Each batch step requires a name of 1–100 characters.');
      return { name: step.name, ...snippet(step) };
    });
    const verify = input.verify === undefined ? undefined : snippet(input.verify);
    const bytes = [...steps, ...(verify ? [verify] : [])].reduce((total, s) => total + Buffer.byteLength(s.code) + (s.usings ?? []).reduce((n: number, u: string) => n + Buffer.byteLength(u), 0), 0);
    if (bytes > 65536) fail('Combined batch source exceeds 64 KiB.');
    return { mode: 'batch', documentToken: input.documentToken, steps, ...(verify ? { verify } : {}), ...common };
  }
  if (!['query', 'modify', 'api'].includes(input.mode)) fail('mode must be query, modify, api or batch.');
  if (input.steps !== undefined || input.verify !== undefined) fail('Steps and verification require batch mode.');
  return { ...snippet(input), mode: input.mode, ...(input.documentToken !== undefined ? { documentToken: input.documentToken } : {}), ...common };
}
