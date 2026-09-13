import { describe, expect, it } from 'vitest';
import { validateExecuteInput } from '../../src/host/execute-input.js';

const batch = { mode: 'batch', documentToken: 'doc', steps: [{ name: 'Create', code: 'return 1;' }] };
describe('batch contract', () => {
  it('normalizes all steps and verification without dropping source', () => {
    const input = { ...batch, verify: { code: 'return true;' } };
    expect(validateExecuteInput(input)).toEqual(input);
  });
  it.each([
    { documentToken: undefined }, { documentToken: null }, { steps: [] },
    { steps: Array(21).fill(batch.steps[0]) }, { steps: [{ code: 'return 1;' }] },
    { code: 'return 1;' }, { verify: { code: '' } },
    { steps: [{ name: 'Large', code: '// ' + '文'.repeat(22000) }] },
    { steps: [{ name: 'A', code: 'return 1;' + ' '.repeat(40000) }], verify: { code: 'return true;' + ' '.repeat(30000) } },
  ])('rejects invalid batch %j', override => {
    expect(() => validateExecuteInput({ ...batch, ...override })).toThrow();
  });
  it('preserves single snippet compatibility and rejects ambiguous modes', () => {
    expect(validateExecuteInput({ mode: 'modify', code: 'return 1;' })).toEqual({ mode: 'modify', code: 'return 1;' });
    expect(() => validateExecuteInput({ ...batch, mode: 'modify', code: 'return 1;' })).toThrow();
  });
});
