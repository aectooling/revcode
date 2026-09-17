import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extract, powershell } from './windows.mjs';
import { removeOwned } from './files.mjs';

const windows = { skip: process.platform !== 'win32' };
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'revcode ZIP test '));
  t.after(() => removeOwned(tmpdir(), root));
  return root;
}

function zip(archive, entry) {
  powershell(`Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.IO.Compression
$zip = [IO.Compression.ZipFile]::Open($env:TEST_ARCHIVE, [IO.Compression.ZipArchiveMode]::Create)
try {
  $entry = $zip.CreateEntry($env:TEST_ENTRY)
  $writer = New-Object IO.StreamWriter($entry.Open())
  try { $writer.Write('payload contents') } finally { $writer.Dispose() }
} finally { $zip.Dispose() }`, { TEST_ARCHIVE: archive, TEST_ENTRY: entry });
}

test('ZIP extraction supports Unicode profile paths, spaces and paths longer than MAX_PATH', windows, t => {
  const root = fixture(t), archive = join(root, 'payload archive.zip');
  const entry = `${'nested-dependency/'.repeat(18)}payload file.txt`;
  zip(archive, entry);
  const destination = join(root, '日本語 profile with spaces', 'packages', '0.1.2');
  assert.ok(join(destination, entry).length > 260);
  extract(archive, destination);
  assert.equal(readFileSync(join(destination, entry), 'utf8'), 'payload contents');
});

test('ZIP extraction reports invalid archives', windows, t => {
  const root = fixture(t), archive = join(root, 'broken.zip');
  writeFileSync(archive, 'not a ZIP');
  assert.throws(() => extract(archive, join(root, 'output')), /Payload extraction failed:/);
});

test('ZIP extraction rejects parent traversal', windows, t => {
  const root = fixture(t), archive = join(root, 'unsafe.zip');
  zip(archive, '../escaped.txt');
  assert.throws(() => extract(archive, join(root, 'output')), /Payload extraction failed:/);
  assert.equal(existsSync(join(root, 'escaped.txt')), false);
});
