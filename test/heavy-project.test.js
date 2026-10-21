import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { generateWorkload } from '../example-heavy-project/generate.mjs';

test('heavy generator is deterministic, tunable and removes stale generated units', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'compilez-generator-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const settings = { directory, units: 3, functions: 4, operations: 8, seed: 2026 };
  const manifest = await generateWorkload(settings);
  const generated = path.join(directory, 'src', 'generated');
  const first = await fs.readFile(path.join(generated, 'unit_000.cpp'), 'utf8');
  const originalStat = await fs.stat(path.join(generated, 'unit_000.cpp'));
  assert.equal(manifest.generatedMathFunctions, 12);
  assert.match(first, /std::fma/);
  assert.match(first, /std::sin/);
  await generateWorkload(settings);
  assert.equal(await fs.readFile(path.join(generated, 'unit_000.cpp'), 'utf8'), first);
  assert.equal((await fs.stat(path.join(generated, 'unit_000.cpp'))).mtimeMs, originalStat.mtimeMs);
  await generateWorkload({ ...settings, seed: 2027, units: 2 });
  assert.notEqual(await fs.readFile(path.join(generated, 'unit_000.cpp'), 'utf8'), first);
  await assert.rejects(fs.stat(path.join(generated, 'unit_002.cpp')), { code: 'ENOENT' });
  assert.match(await fs.readFile(path.join(generated, 'workload.h'), 'utf8'), /unit_count = 2/);
  await assert.rejects(generateWorkload({ ...settings, units: 0 }), /units must be/);
});