import test from 'node:test';
import assert from 'node:assert/strict';
import { requiresSigning, assertSigning } from '../release.mjs';

test('unsigned releases require explicit configuration; signed is the default', () => {
  assert.equal(requiresSigning({}), true);
  assert.equal(requiresSigning({ signing: 'signed' }), true);
  assert.equal(requiresSigning({ signing: 'unsigned' }), false);
  assert.throws(() => requiresSigning({ signing: false }), /signing must/);
  assert.throws(() => requiresSigning({ signing: 'unsinged' }), /signing must/);
});

test('publication rejects artifacts whose signing status differs from policy', () => {
  assertSigning({ signing: 'unsigned' }, { signed: false });
  assertSigning({}, { signed: true });
  assert.throws(() => assertSigning({}, { signed: false }), /signing status/);
  assert.throws(() => assertSigning({ signing: 'unsigned' }, { signed: true }), /signing status/);
  assert.throws(() => assertSigning({ signing: 'unsigned' }, {}), /signing status/);
});
