import { mkdir, readFile, readdir, rm, writeFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const projectDirectory = path.dirname(fileURLToPath(import.meta.url));

function randomSource(seed) {
  let state = seed || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}

async function writeChanged(file, content) {
  if (await readFile(file, 'utf8').catch(() => null) !== content) await writeFile(file, content);
}

export async function generateWorkload({ directory = projectDirectory, units = 192, functions = 64, operations = 48, seed = 2026 } = {}) {
  for (const [key, value, maximum] of [['units', units, 512], ['functions', functions, 256], ['operations', operations, 256], ['seed', seed, 4294967295]]) {
    if (!Number.isInteger(value) || value < 1 || value > maximum) throw new Error(`${key} must be an integer between 1 and ${maximum}`);
  }
  const generated = path.join(directory, 'src', 'generated');
  await mkdir(generated, { recursive: true });
  const random = randomSource(seed);
  const expected = new Set(['workload.h', 'workload.cpp', 'manifest.json']);
  const declarations = [];
  const workers = [];
  let bytes = 0;
  for (let unit = 0; unit < units; unit++) {
    const name = `unit_${String(unit).padStart(3, '0')}`;
    expected.add(`${name}.h`);
    expected.add(`${name}.cpp`);
    const header = ['#pragma once', '', 'namespace compilez_heavy {', `float ${name}(float value);`];
    const source = [`#include "${name}.h"`, '#include <array>', '#include <algorithm>', '#include <numeric>', '#include <cmath>', '#include <cstdint>', '#include <complex>', '', 'namespace compilez_heavy {'];
    for (let index = 0; index < functions; index++) {
      const functionName = `${name}_math_${index}`;
      header.push(`float ${functionName}(float value);`);
      source.push(`__attribute__((noinline)) float ${functionName}(float value) {`);
      for (let operation = 0; operation < operations; operation++) {
        const scale = (0.5 + random() * 0.7).toFixed(7);
        const offset = (random() * 0.3).toFixed(7);
        source.push(`  value = std::fma(value, ${scale}f, ${offset}f);`);
        if (operation % 6 === 5) source.push('  value = std::sin(value);');
      }
      source.push('  return value;', '}', '');
    }
    source.push(`float ${name}(float value) {`);
    for (let index = 0; index < Math.min(4, functions); index++) source.push(`  value = ${name}_math_${index}(value);`);
    source.push('  return value;', '}', '}', '');
    header.push('}', '');
    const headerText = header.join('\n');
    const sourceText = source.join('\n');
    await writeChanged(path.join(generated, `${name}.h`), headerText);
    await writeChanged(path.join(generated, `${name}.cpp`), sourceText);
    bytes += Buffer.byteLength(headerText) + Buffer.byteLength(sourceText);
    declarations.push(`float ${name}(float value);`);
    workers.push(`  ${name}`);
  }
  const registry = `#include "workload.h"\n#include <array>\n\nnamespace compilez_heavy {\n${declarations.join('\n')}\nusing Worker = float (*)(float);\nconst std::array<Worker, ${units}> workers = {{\n${workers.join(',\n')}\n}};\nfloat run(float value) {\n  for (auto worker : workers) value = worker(value);\n  return value;\n}\n}\n`;
  await writeChanged(path.join(generated, 'workload.h'), `#pragma once\n\nnamespace compilez_heavy {\nconstexpr unsigned int unit_count = ${units};\nfloat run(float value);\n}\n`);
  await writeChanged(path.join(generated, 'workload.cpp'), registry);
  for (const entry of await readdir(generated)) {
    if (!expected.has(entry) && /^unit_\d+\.(cpp|h)$/.test(entry)) await rm(path.join(generated, entry));
  }
  const manifest = { units, functionsPerUnit: functions, operationsPerFunction: operations, seed, generatedMathFunctions: units * functions, bytes };
  await writeChanged(path.join(generated, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: {
    units: { type: 'string', default: '192' },
    functions: { type: 'string', default: '64' },
    operations: { type: 'string', default: '48' },
    seed: { type: 'string', default: '2026' },
    copies: { type: 'string', default: '0' },
    help: { type: 'boolean', default: false }
  } });
  if (values.help) {
    console.log('node generate.mjs [--units 192] [--functions 64] [--operations 48] [--seed 2026] [--copies 5]');
  } else {
    const settings = Object.fromEntries(['units', 'functions', 'operations', 'seed'].map((key) => [key, Number(values[key])]));
    const copies = Number(values.copies);
    if (!Number.isInteger(copies) || copies < 0 || copies > 16) throw new Error('copies must be an integer between 0 and 16');
    const result = await generateWorkload(settings);
    console.log(`Generated ${result.units} .cpp/.h pairs, ${result.generatedMathFunctions} math functions, ${(result.bytes / 1024 ** 2).toFixed(1)} MB of C++ sources.`);
    console.log(`Project: ${projectDirectory}`);
    for (let index = 1; index <= copies; index++) {
      const target = path.join(projectDirectory, 'copies', `worker-${String(index).padStart(2, '0')}`);
      await mkdir(path.join(target, 'src'), { recursive: true });
      await copyFile(path.join(projectDirectory, 'platformio.ini'), path.join(target, 'platformio.ini'));
      await copyFile(path.join(projectDirectory, 'src', 'main.cpp'), path.join(target, 'src', 'main.cpp'));
      await generateWorkload({ ...settings, directory: target, seed: (settings.seed + index) % 4294967295 || 1 });
      console.log(`Independent project: ${target}`);
    }
    console.log('Sources are deterministic. Change --seed or run pio run -t clean before measuring another full compilation.');
  }
}