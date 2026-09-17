import { statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { files } from './files.mjs';

export function measurePayload(directory) {
  const components = {};
  let bytes = 0, count = 0;
  for (const name of files(directory)) {
    const size = statSync(join(directory, name)).size;
    const group = name.includes('/') ? name.split('/')[0] : '(root files)';
    const component = components[group] ??= { files: 0, bytes: 0 };
    component.files++;
    component.bytes += size;
    count++;
    bytes += size;
  }
  return { files: count, bytes, components };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length < 3 || process.argv.length > 4)
    throw new Error('Usage: measure-payload.mjs <payload> [payload.zip]');
  const report = measurePayload(resolve(process.argv[2]));
  if (process.argv[3]) report.archiveBytes = statSync(resolve(process.argv[3])).size;
  console.log(JSON.stringify(report, null, 2));
}
