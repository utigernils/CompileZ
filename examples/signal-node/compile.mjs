import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const steps = [
  [4, 'Resolving signal-node dependencies'],
  [12, 'Configuring local build environment'],
  [23, 'Compiling src/main.cpp'],
  [36, 'Compiling src/sensors/temperature.cpp'],
  [48, 'Compiling src/network/transport.cpp'],
  [62, 'Archiving build/libsignal.a'],
  [76, 'Linking build/firmware.elf'],
  [88, 'Checking firmware size'],
  [96, 'Generating build/firmware.bin']
];
console.log('COMPILEZ / SIGNAL NODE');
console.log('Reference binary pipeline | local environment\n');
console.log('This sample creates a test binary, not flashable device firmware.\n');
for (const [percent, step] of steps) {
  await new Promise((resolve) => setTimeout(resolve, 650));
  console.log(`[${String(percent).padStart(3)}%] ${step}`);
}
await mkdir('build', { recursive: true });
const payload = Buffer.alloc(64 * 1024);
payload.write('COMPILEZ-SAMPLE-BINARY\n');
const digest = createHash('sha256').update(new Date().toISOString()).digest();
for (let offset = 64; offset < payload.length; offset += digest.length) digest.copy(payload, offset);
await writeFile('build/firmware.bin', payload);
console.log('\nRAM:   [==        ]  18.4%');
console.log('Flash: [====      ]  37.2%');
console.log('Binary: build/firmware.bin (65,536 bytes)');
console.log('\n[100%] BUILD SUCCESSFUL');