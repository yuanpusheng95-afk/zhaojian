import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const roots = ['src', 'test', 'test-integration', 'scripts'];
const files = [];

for (const root of roots) {
  try {
    await collect(root);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], {
    stdio: 'inherit',
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

async function collect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) await collect(entryPath);
    else if (entry.isFile() && entry.name.endsWith('.mjs')) files.push(entryPath);
  }
}
