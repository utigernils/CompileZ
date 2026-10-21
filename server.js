import express from 'express';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import si from 'systeminformation';
import { spawn } from 'node:child_process';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import os from 'node:os';

const baseDir = path.dirname(fileURLToPath(import.meta.url));
const activeStatuses = new Set(['running', 'cancelling']);
const inside = (root, target) => {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};

export async function createCompileZ(options = {}) {
  const app = express();
  const httpServer = createServer(app);
  const io = new Server(httpServer, { maxHttpBufferSize: 16_384 });
  const dataDir = options.dataDir || process.env.DATA_DIR || path.join(baseDir, '.data');
  const roots = await Promise.all((options.roots || (process.env.BROWSE_ROOTS || `${baseDir},/home,/dev/shm`).split(','))
    .map((root) => fs.realpath(root.trim())));
  const maxConcurrent = Math.max(1, Math.min(16, Number(options.maxConcurrent ?? process.env.MAX_CONCURRENT_BUILDS) || 2));
  const token = options.token ?? process.env.COMPILEZ_TOKEN;
  const builds = [];
  const flashes = [];
  const processes = new Map();
  const defaultProjectPath = await validDirectory(options.initialPath || process.env.PROJECT_PATH || roots[0]).catch(async (error) => {
    if (options.initialPath) throw error;
    console.warn('Initial project path unavailable; using the first browse root:', error.message);
    return validDirectory(roots[0]);
  });
  let stats = { cpu: null, temperature: null, memoryUsed: null, memoryTotal: null, cores: os.cpus().length, hostname: os.hostname(), updatedAt: null };
  let closing = false;
  let finishingBuilds = 0;
  let statsBusy = false;
  let persistTimer;
  let persistQueue = Promise.resolve();
  let configQueue = Promise.resolve();
  let configVersion = 0;
  let statisticsQueue = Promise.resolve();
  let buildStatistics = { schemaVersion: 1, totalBuilds: 0, totalDurationMs: 0, longestDurationMs: 0, successCount: 0, failureCount: 0, cancelledCount: 0, interruptedCount: 0, projects: {}, recentBuildIds: [], updatedAt: null };

  await fs.mkdir(path.join(dataDir, 'artifacts'), { recursive: true });
  try {
    const saved = JSON.parse(await fs.readFile(path.join(dataDir, 'history.json'), 'utf8'));
    for (const build of saved.builds.slice(0, 50)) {
      if (activeStatuses.has(build.status) || build.status === 'queued') {
        build.status = 'interrupted';
        build.step = 'Server restarted before this build finished';
        build.finishedAt = new Date().toISOString();
      }
      builds.push(build);
    }
    for (const flash of (saved.flashes || []).slice(0, 10)) {
      if (activeStatuses.has(flash.status)) {
        flash.status = 'interrupted';
        flash.finishedAt = new Date().toISOString();
        flash.step = 'Server restarted during upload; check the device before retrying';
      }
      flashes.push(flash);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn('History could not be restored:', error.message);
  }
  try {
    const saved = JSON.parse(await fs.readFile(path.join(dataDir, 'stats.json'), 'utf8'));
    const counters = ['totalBuilds', 'totalDurationMs', 'longestDurationMs', 'successCount', 'failureCount', 'cancelledCount', 'interruptedCount'];
    if (saved.schemaVersion !== 1 || !counters.every((key) => Number.isFinite(saved[key]) && saved[key] >= 0) || !saved.projects || !Array.isArray(saved.recentBuildIds)) throw new Error('Invalid statistics format');
    buildStatistics = saved;
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`Cannot load stats.json; preserve and repair this file before restarting: ${error.message}`);
  }
  for (const build of builds) {
    build.name ||= build.project;
    build.durationMs = buildDuration(build);
    recordBuildStatistics(build);
  }
  await persistStatistics();

  function authorized(request) {
    if (!token) return true;
    const expected = Buffer.from(`Basic ${Buffer.from(`compilez:${token}`).toString('base64')}`);
    const actual = Buffer.from(request.headers.authorization || '');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  app.disable('x-powered-by');
  app.use((request, response, next) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'same-origin');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    if (!authorized(request)) {
      response.setHeader('WWW-Authenticate', 'Basic realm="CompileZ", charset="UTF-8"');
      return response.status(401).send('Authentication required');
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && request.headers.origin && request.headers.origin !== `${request.protocol}://${request.headers.host}`) {
      return response.status(403).json({ error: 'Cross-origin requests are not allowed' });
    }
    next();
  });
  io.engine.on('initial_headers', (headers) => { headers['X-Content-Type-Options'] = 'nosniff'; });
  io.engine.opts.allowRequest = (request, callback) => {
    const origin = request.headers.origin;
    const sameOrigin = !origin || origin === `http://${request.headers.host}` || origin === `https://${request.headers.host}`;
    callback(null, sameOrigin && authorized(request));
  };
  io.use((socket, next) => authorized(socket.request) ? next() : next(new Error('Authentication required')));
  app.use('/api/config', express.json({ limit: '512kb' }));
  app.use(express.json({ limit: '16kb' }));

  async function validDirectory(value) {
    if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error('Choose an absolute server directory');
    const resolved = await fs.realpath(value);
    if (!roots.some((root) => inside(root, resolved))) throw new Error('Directory is outside the configured browse roots');
    if (!(await fs.stat(resolved)).isDirectory()) throw new Error('The selected path is not a directory');
    return resolved;
  }

  function snapshot() {
    return { defaultProjectPath, builds: builds.map(({ logs, logSequence, statisticsRecorded, ...build }) => build), flashes: flashes.map(({ logs, logSequence, ...flash }) => flash), stats, buildStatistics: statisticsSnapshot(), maxConcurrent, roots };
  }

  function buildDuration(build) {
    return build.startedAt && build.finishedAt ? Math.max(0, Date.parse(build.finishedAt) - Date.parse(build.startedAt)) || 0 : 0;
  }

  function statisticsSnapshot() {
    const { projects, recentBuildIds, ...summary } = buildStatistics;
    const mostCompiled = Object.entries(projects).sort((first, second) => second[1] - first[1] || first[0].localeCompare(second[0]))[0];
    const outcomes = summary.successCount + summary.failureCount;
    return { ...summary, averageDurationMs: summary.totalBuilds ? summary.totalDurationMs / summary.totalBuilds : 0, successRate: outcomes ? summary.successCount / outcomes * 100 : 0, failureRate: outcomes ? summary.failureCount / outcomes * 100 : 0, mostCompiledProject: mostCompiled ? { path: mostCompiled[0], count: mostCompiled[1] } : null };
  }

  function recordBuildStatistics(build) {
    const counter = { completed: 'successCount', failed: 'failureCount', cancelled: 'cancelledCount', interrupted: 'interruptedCount' }[build.status];
    if (!counter || build.statisticsRecorded || buildStatistics.recentBuildIds.includes(build.id)) return;
    build.durationMs = buildDuration(build);
    buildStatistics.totalBuilds++;
    buildStatistics[counter]++;
    buildStatistics.totalDurationMs += build.durationMs;
    buildStatistics.longestDurationMs = Math.max(buildStatistics.longestDurationMs, build.durationMs);
    buildStatistics.projects[build.path] = (buildStatistics.projects[build.path] || 0) + 1;
    buildStatistics.updatedAt = new Date().toISOString();
    buildStatistics.recentBuildIds.push(build.id);
    buildStatistics.recentBuildIds = buildStatistics.recentBuildIds.slice(-128);
    build.statisticsRecorded = true;
  }

  function persistStatistics() {
    const saved = JSON.stringify(buildStatistics);
    statisticsQueue = statisticsQueue.catch(() => {}).then(async () => {
      const temporary = path.join(dataDir, 'stats.tmp');
      await fs.writeFile(temporary, saved);
      await fs.rename(temporary, path.join(dataDir, 'stats.json'));
    });
    return statisticsQueue;
  }

  async function completeStatistics(build) {
    recordBuildStatistics(build);
    try { await persistStatistics(); }
    catch (error) { console.error('Statistics save failed:', error.message); }
  }

  function configTask(task) {
    const result = configQueue.catch(() => {}).then(task);
    configQueue = result;
    return result;
  }

  async function readConfig(directory) {
    let handle;
    let content = '';
    let exists = false;
    try {
      handle = await fs.open(path.join(directory, 'platformio.ini'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error('platformio.ini must be a regular file, not a directory or symbolic link');
      const buffer = Buffer.alloc(65_537);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 65_536 || stat.size > 65_536) throw new Error('Config files are limited to 64 KB');
      content = buffer.subarray(0, bytesRead).toString('utf8');
      exists = true;
    } catch (error) {
      if (error.code === 'ELOOP') throw new Error('Config symbolic links are not supported');
      if (error.code !== 'ENOENT') throw error;
    } finally { await handle?.close(); }
    return { path: directory, filename: 'platformio.ini', content, exists, revision: exists ? createHash('sha256').update(content).digest('hex') : 'missing', version: configVersion };
  }

  function persist() {
    const saved = JSON.stringify({ builds, flashes });
    persistQueue = persistQueue.catch(() => {}).then(async () => {
      const temporary = path.join(dataDir, 'history.tmp');
      await fs.writeFile(temporary, saved);
      await fs.rename(temporary, path.join(dataDir, 'history.json'));
    });
    return persistQueue;
  }

  function publish() {
    io.emit('state', snapshot());
    clearTimeout(persistTimer);
    if (!closing) persistTimer = setTimeout(() => persist().catch((error) => console.error('History save failed:', error.message)), 300);
  }

  function appendLog(build, text, stream = 'stdout') {
    if (!text) return;
    const entry = { sequence: ++build.logSequence, text: text.slice(0, 8192), stream, timestamp: Date.now() };
    build.logs.push(entry);
    if (build.logs.length > 400) build.logs.shift();
    const clean = text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').trim();
    const lines = clean.split(/[\r\n]+/).filter(Boolean);
    build.step = (lines.at(-1) || build.step).slice(0, 200);
    const percent = [...clean.matchAll(/(?:\[|\b)(\d{1,3})%/g)].at(-1);
    if (percent) build.progress = Math.max(build.progress || 0, Math.min(99, Number(percent[1])));
    io.emit('build:log', { buildId: build.id, entry });
    io.emit('build:update', { id: build.id, step: build.step, progress: build.progress });
  }

  async function commandFor(directory) {
    if (await fs.stat(path.join(directory, 'platformio.ini')).then(() => true, () => false)) {
      return { command: process.env.PIO_COMMAND || 'pio', args: ['run'], display: 'pio run', prepare: { args: ['run', '--target', 'clean'], display: 'pio run --target clean' } };
    }
    if (await fs.stat(path.join(directory, 'compile.sh')).then((stat) => stat.isFile(), () => false)) {
      return { command: '/bin/bash', args: ['compile.sh'], display: 'bash compile.sh' };
    }
    throw new Error('No platformio.ini or compile.sh found in this directory');
  }

  async function findArtifact(directory) {
    const candidates = [];
    const names = ['firmware.merged.bin', 'merged-flash.bin', 'merged.bin', 'firmware.bin', 'firmware.hex'];
    for (const folder of ['', 'build', 'dist']) {
      for (const name of names) candidates.push(path.join(directory, folder, name));
    }
    const environments = await fs.readdir(path.join(directory, '.pio/build'), { withFileTypes: true }).catch(() => []);
    for (const environment of environments.filter((entry) => entry.isDirectory()).sort((first, second) => first.name.localeCompare(second.name))) {
      for (const name of names) candidates.push(path.join(directory, '.pio/build', environment.name, name));
    }
    const artifacts = await Promise.all(candidates.map(async (target) => {
      const stat = await fs.stat(target).catch(() => null);
      return stat?.isFile() ? { target, modified: stat.mtimeMs, combined: /(?:merged|merged-flash)\.bin$/.test(target) } : null;
    }));
    return artifacts.filter(Boolean).sort((first, second) => second.modified - first.modified || Number(second.combined) - Number(first.combined))[0]?.target || null;
  }

  async function archivedArtifact(id) {
    if (!/^[a-f0-9-]{36}$/i.test(id)) return null;
    let extension = '.bin';
    let stat = await fs.lstat(path.join(dataDir, 'artifacts', `${id}${extension}`)).catch((error) => { if (error.code !== 'ENOENT') throw error; return null; });
    if (!stat) {
      extension = '.hex';
      stat = await fs.lstat(path.join(dataDir, 'artifacts', `${id}${extension}`)).catch((error) => { if (error.code !== 'ENOENT') throw error; return null; });
    }
    if (!stat?.isFile()) return null;
    const metadata = await fs.readFile(path.join(dataDir, 'artifacts', `${id}.json`), 'utf8').then(JSON.parse).catch(() => ({}));
    const legacy = builds.find((build) => build.id === id);
    return { id, extension, combined: metadata.combined ?? null, sourceName: metadata.sourceName || '', name: path.basename(metadata.name || legacy?.artifact?.name || `${id}${extension}`), buildName: metadata.buildName || legacy?.name || id.slice(0, 8), projectPath: metadata.projectPath || legacy?.path || '', createdAt: metadata.createdAt || legacy?.finishedAt || stat.mtime.toISOString(), bytes: stat.size };
  }

  function signalGroup(child, signal) {
    if (!child.pid) return;
    try { process.kill(-child.pid, signal); } catch (error) {
      if (error.code !== 'ESRCH') console.error('Could not signal compiler:', error.message);
    }
  }

  async function startBuild(build) {
    build.status = 'running';
    build.startedAt = new Date().toISOString();
    build.step = 'Preparing build environment';
    publish();
    let child;
    let finalized = false;
    const finish = async (code, signal, error) => {
      if (finalized) return;
      finalized = true;
      finishingBuilds++;
      const record = processes.get(build.id);
      clearTimeout(record?.killTimer);
      if (child) signalGroup(child, 'SIGKILL');
      const cancelled = build.status === 'cancelling' || closing;
      const finalStatus = cancelled ? 'cancelled' : code === 0 && !error ? 'completed' : 'failed';
      build.exitCode = code;
      if (error) appendLog(build, `${error.message}\n`, 'stderr');
      if (finalStatus === 'completed') {
        try {
          const artifact = await findArtifact(build.path);
          if (artifact) {
            const resolved = await fs.realpath(artifact);
            if (!inside(build.path, resolved)) throw new Error('Artifact symlink points outside the project');
            const artifactStat = await fs.stat(resolved);
            const extension = path.extname(resolved);
            const temporary = path.join(dataDir, 'artifacts', `${build.id}${extension}.tmp`);
            try {
              await fs.copyFile(resolved, temporary, constants.COPYFILE_EXCL);
              await fs.rename(temporary, path.join(dataDir, 'artifacts', `${build.id}${extension}`));
              build.artifact = { name: `${build.project}-${build.id.slice(0, 8)}${extension}`, bytes: artifactStat.size };
              await fs.writeFile(path.join(dataDir, 'artifacts', `${build.id}.json`), JSON.stringify({ id: build.id, ...build.artifact, sourceName: path.basename(artifact), combined: /(?:merged|merged-flash)\.bin$/.test(artifact), buildName: build.name, projectPath: build.path, createdAt: new Date().toISOString() }), { flag: 'wx' });
              io.emit('artifacts:changed');
            } finally { await fs.unlink(temporary).catch(() => {}); }
          } else appendLog(build, 'Build succeeded. No firmware.bin was produced.\n', 'system');
        } catch (artifactError) { appendLog(build, `Artifact unavailable: ${artifactError.message}\n`, 'stderr'); }
        build.progress = 100;
      }
      build.status = build.status === 'cancelling' ? 'cancelled' : finalStatus;
      build.finishedAt = new Date().toISOString();
      build.step = cancelled ? 'Build cancelled' : build.status === 'completed' ? 'Build completed successfully' : `Build failed (${error?.code || signal || code})`;
      appendLog(build, `${build.step}\n`, 'system');
      processes.delete(build.id);
      await completeStatistics(build);
      publish();
      finishingBuilds--;
      pump();
    };
    try {
      await validDirectory(build.path);
      const command = await commandFor(build.path);
      const phases = command.prepare ? [command.prepare, command] : [command];
      for (const phase of phases) {
        if (build.status === 'cancelling' || closing) return finish(null, 'SIGTERM');
        build.command = phase.display;
        appendLog(build, `$ ${phase.display}\n`, 'system');
        const outcome = await new Promise((resolve) => {
          child = spawn(command.command, phase.args, {
            cwd: build.path, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, FORCE_COLOR: '0', TERM: 'dumb', CI: '1', COMPILEZ_CLEAN_BUILD: '1' }
          });
          processes.set(build.id, { child });
          for (const stream of ['stdout', 'stderr']) {
            const decoder = new StringDecoder('utf8');
            child[stream].on('data', (chunk) => appendLog(build, decoder.write(chunk), stream));
            child[stream].on('end', () => appendLog(build, decoder.end(), stream));
          }
          child.once('error', (error) => resolve({ code: null, signal: null, error }));
          child.once('close', (code, signal) => resolve({ code, signal }));
          publish();
        });
        clearTimeout(processes.get(build.id)?.killTimer);
        signalGroup(child, 'SIGKILL');
        if (outcome.code !== 0 || outcome.error || build.status === 'cancelling' || closing) return finish(outcome.code, outcome.signal, outcome.error);
      }
      await finish(0, null);
    } catch (error) { await finish(null, null, error); }
  }

  function pump() {
    if (closing) return;
    let running = builds.filter((build) => activeStatuses.has(build.status)).length;
    for (const build of [...builds].reverse()) {
      if (running >= maxConcurrent) break;
      if (build.status !== 'queued' || builds.some((other) => activeStatuses.has(other.status) && other.path === build.path)) continue;
      running++;
      void startBuild(build);
    }
  }

  async function serialDevices() {
    if (process.platform !== 'linux') throw new Error('Server USB discovery currently requires Linux');
    const entries = await fs.readdir('/sys/class/tty');
    const devices = await Promise.all(entries.filter((name) => /^(ttyUSB|ttyACM)\d+$/.test(name)).map(async (name) => {
      const port = `/dev/${name}`;
      let device;
      try { device = await fs.realpath(`/sys/class/tty/${name}/device`); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
      const details = {};
      while (device.startsWith('/sys/devices/')) {
        for (const key of ['product', 'manufacturer', 'serial', 'idVendor', 'idProduct']) {
          if (details[key]) continue;
          try { details[key] = (await fs.readFile(path.join(device, key), 'utf8')).trim(); }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
        if (details.idVendor) break;
        device = path.dirname(device);
      }
      return { port, name: details.product || 'USB serial device', manufacturer: details.manufacturer || '', serial: details.serial || '', vendorId: details.idVendor || '', productId: details.idProduct || '' };
    }));
    return devices.filter(Boolean).sort((first, second) => first.port.localeCompare(second.port));
  }

  function flashParameters(value, tool) {
    if (typeof value !== 'string' || value.length > 2048) throw new Error('Extra parameters must be text of at most 2048 characters');
    const tokens = value.trim() ? value.trim().split(/\s+/) : [];
    const before = [];
    const after = [];
    const espOptions = {
      '--before': /^(default_reset|usb_reset|no_reset|no_reset_no_sync)$/,
      '--after': /^(hard_reset|soft_reset|no_reset|no_reset_stub)$/,
      '--connect-attempts': /^[1-9]\d?$/,
      '--flash_mode': /^(keep|qio|qout|dio|dout)$/,
      '--flash_freq': /^(keep|80m|60m|48m|40m|30m|26m|24m|20m|16m|15m|12m)$/,
      '--flash_size': /^(keep|detect|256KB|512KB|[1248]MB|16MB|32MB|64MB|128MB|2MB-c1|4MB-c1)$/,
      '--spi-connection': /^(SPI|HSPI|\d+,\d+,\d+,\d+,\d+)$/
    };
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index];
      if (tool === 'esp') {
        if (['--compress', '--no-compress'].includes(token)) { after.push(token); continue; }
        const [flag, ...inline] = token.split('=');
        const pattern = espOptions[flag];
        if (!pattern) throw new Error(`Unsupported esptool parameter: ${flag}. Use the dedicated fields for chip, port, baud and offset.`);
        const argument = inline.length ? inline.join('=') : tokens[++index];
        if (!argument || !pattern.test(argument)) throw new Error(`Invalid value for ${flag}`);
        const destination = ['--before', '--after', '--connect-attempts'].includes(flag) ? before : after;
        destination.push(flag, argument);
      } else {
        if (['-v', '-D'].includes(token)) { before.push(token); continue; }
        if (!['-B', '-i'].includes(token)) throw new Error(`Unsupported avrdude parameter: ${token}. Allowed: -v, -D, -B <bitclock>, -i <delay>.`);
        const argument = tokens[++index];
        if (!argument || !/^\d+(?:\.\d+)?$/.test(argument) || Number(argument) <= 0) throw new Error(`Invalid value for ${token}`);
        before.push(token, argument);
      }
    }
    return { before, after };
  }

  function appendFlashLog(flash, text, stream = 'system') {
    if (!text) return;
    const entry = { sequence: ++flash.logSequence, text: text.slice(0, 8192), stream, timestamp: Date.now() };
    flash.logs.push(entry);
    if (flash.logs.length > 400) flash.logs.shift();
    io.emit('flash:log', { flashId: flash.id, entry });
  }

  async function startFlash(flash, parameters, image) {
    let child;
    let timeout;
    try {
      timeout = setTimeout(() => {
        if (!activeStatuses.has(flash.status)) return;
        flash.status = 'cancelling';
        flash.step = 'Upload timed out after 10 minutes';
        appendFlashLog(flash, `${flash.step}\n`, 'stderr');
        const record = processes.get(flash.id);
        if (record) {
          signalGroup(record.child, 'SIGTERM');
          record.killTimer = setTimeout(() => signalGroup(record.child, 'SIGKILL'), 2500);
        }
        publish();
      }, 600_000);
      for (const stub of flash.tool === 'esp' ? [true, false] : [false]) {
        if (flash.status === 'cancelling' || closing) break;
        flash.step = flash.tool === 'esp' ? stub ? 'Uploading with ESP stub' : 'Retrying without ESP stub' : 'Uploading with avrdude';
        const command = flash.tool === 'esp' ? process.env.ESPTOOL_COMMAND || 'esptool.py' : process.env.AVRDUDE_COMMAND || 'avrdude';
        const args = flash.tool === 'esp'
          ? ['--chip', flash.board, '--port', flash.port, '--baud', String(flash.baud), ...parameters.before, ...(!stub ? ['--no-stub'] : []), 'write_flash', ...parameters.after, flash.offset, image]
          : ['-p', flash.board, '-c', flash.programmer, '-P', flash.port, '-b', String(flash.baud), ...parameters.before, '-U', `flash:w:${image}:${flash.extension === '.hex' ? 'i' : 'r'}`];
        appendFlashLog(flash, `$ ${[command, ...args].map((part) => JSON.stringify(part)).join(' ')}\n`);
        publish();
        const outcome = await new Promise((resolve) => {
          child = spawn(command, args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PYTHONUNBUFFERED: '1', TERM: 'dumb' } });
          processes.set(flash.id, { child });
          for (const stream of ['stdout', 'stderr']) {
            const decoder = new StringDecoder('utf8');
            child[stream].on('data', (chunk) => appendFlashLog(flash, decoder.write(chunk), stream));
            child[stream].on('end', () => appendFlashLog(flash, decoder.end(), stream));
          }
          child.once('error', (error) => resolve({ code: null, error }));
          child.once('close', (code, signal) => resolve({ code, signal }));
        });
        clearTimeout(processes.get(flash.id)?.killTimer);
        signalGroup(child, 'SIGKILL');
        processes.delete(flash.id);
        if (flash.status === 'cancelling' || closing) break;
        if (outcome.error) throw new Error(`Cannot start ${command}: ${outcome.error.message}. Install the upload tool on the compiler machine.`);
        if (outcome.code === 0) {
          flash.status = 'completed';
          flash.step = 'Firmware uploaded successfully';
          break;
        }
        if (flash.tool === 'esp' && stub && !outcome.signal) {
          appendFlashLog(flash, `Stub upload failed (exit ${outcome.code}). Retrying once with --no-stub.\n`, 'stderr');
          continue;
        }
        throw new Error(`Upload failed (${outcome.signal || outcome.code}). See upload output for details.`);
      }
    } catch (error) {
      appendFlashLog(flash, `${error.message}\n`, 'stderr');
      if (flash.status !== 'cancelling' && !closing) { flash.status = 'failed'; flash.step = error.message; }
    } finally {
      clearTimeout(timeout);
      clearTimeout(processes.get(flash.id)?.killTimer);
      if (child) signalGroup(child, 'SIGKILL');
      processes.delete(flash.id);
      if (flash.status === 'cancelling' || closing && flash.status === 'running') {
        flash.status = 'cancelled';
        flash.step = 'Upload stopped; firmware may be incomplete. Reflash before using the device.';
      }
      flash.finishedAt = new Date().toISOString();
      appendFlashLog(flash, `${flash.step}\n`);
      publish();
    }
  }

  const route = (handler) => (request, response, next) => Promise.resolve(handler(request, response)).catch(next);
  app.get('/api/flash/devices', route(async (_request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.json(await serialDevices());
  }));
  app.post('/api/flashes', route(async (request, response) => {
    if (closing) return response.status(503).json({ error: 'Server is shutting down' });
    const { artifactId, tool, port, board, programmer = '', offset = '0x0', baud, parameters = '' } = request.body;
    if (!['esp', 'avr'].includes(tool)) throw new Error('Choose ESP / esptool or AVR / avrdude');
    if (typeof board !== 'string' || !/^[a-zA-Z0-9_-]{1,48}$/.test(board)) throw new Error('Enter an ESP chip (e.g. esp32 or auto) or AVR part (e.g. m328p)');
    if (tool === 'avr' && (typeof programmer !== 'string' || !/^[a-zA-Z0-9_-]{1,48}$/.test(programmer))) throw new Error('Enter an avrdude programmer, e.g. arduino or wiring');
    if (!Number.isInteger(baud) || baud < 1200 || baud > 4_000_000) throw new Error('Baud rate must be an integer between 1200 and 4000000');
    if (tool === 'esp' && (typeof offset !== 'string' || !/^(?:0x[0-9a-fA-F]{1,8}|\d{1,10})$/.test(offset) || Number(offset) > 0xffffffff)) throw new Error('Enter a valid flash offset, e.g. 0x0 or 0x10000');
    const parsed = flashParameters(parameters, tool);
    const artifact = await archivedArtifact(artifactId);
    if (!artifact) return response.status(404).json({ error: 'Saved firmware not found' });
    if (tool === 'esp' && artifact.extension !== '.bin') throw new Error('ESP uploads require a .bin image');
    if (!(await serialDevices()).some((device) => device.port === port)) throw new Error('Choose a USB serial device connected to the compiler machine; refresh the list');
    if (!(await fs.stat(port)).isCharacterDevice()) throw new Error('The selected port is not a serial device');
    try { await fs.access(port, constants.R_OK | constants.W_OK); }
    catch (error) { throw new Error(`Cannot access ${port}: ${error.message}. Give the service account dialout access and restart CompileZ.`); }
    if (closing) return response.status(503).json({ error: 'Server is shutting down' });
    if (flashes.some((flash) => activeStatuses.has(flash.status))) return response.status(409).json({ error: 'Another upload is active. Wait for it to finish or stop it first.' });
    const flash = { id: randomUUID(), artifactId, name: artifact.buildName, extension: artifact.extension, tool, port, board, programmer, offset, baud, parameters, status: 'running', step: 'Preparing upload', startedAt: new Date().toISOString(), finishedAt: null, logs: [], logSequence: 0 };
    flashes.unshift(flash);
    flashes.splice(10);
    publish();
    void startFlash(flash, parsed, path.resolve(dataDir, 'artifacts', `${artifact.id}${artifact.extension}`));
    response.status(202).json({ id: flash.id });
  }));
  app.get('/api/flashes/:id/logs', (request, response) => {
    const flash = flashes.find((item) => item.id === request.params.id);
    if (!flash) return response.status(404).json({ error: 'Upload not found' });
    response.json({ logs: flash.logs });
  });
  app.post('/api/flashes/:id/cancel', (request, response) => {
    const flash = flashes.find((item) => item.id === request.params.id);
    if (!flash) return response.status(404).json({ error: 'Upload not found' });
    if (flash.status === 'running') {
      flash.status = 'cancelling';
      flash.step = 'Stopping upload; the device may need reflashing';
      const record = processes.get(flash.id);
      if (record) {
        signalGroup(record.child, 'SIGTERM');
        record.killTimer = setTimeout(() => signalGroup(record.child, 'SIGKILL'), 2500);
      }
      publish();
    }
    response.json({ status: flash.status });
  });
  app.get('/api/state', (_request, response) => response.json(snapshot()));
  app.get('/api/stats', (_request, response) => response.json(statisticsSnapshot()));
  app.get('/api/directories', route(async (request, response) => {
    const directory = await validDirectory(request.query.path || defaultProjectPath);
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const folders = entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.')).map((entry) => ({ name: entry.name, path: path.join(directory, entry.name) })).sort((first, second) => first.name.localeCompare(second.name));
    const parent = path.dirname(directory);
    response.json({ path: directory, parent: roots.some((root) => inside(root, parent)) ? parent : null, roots, folders });
  }));
  app.put('/api/project', route(async (request, response) => {
    const directory = await validDirectory(request.body.path);
    response.json({ path: directory });
  }));
  app.get('/api/config', route(async (request, response) => {
    const directory = await validDirectory(request.query.path || defaultProjectPath);
    const config = await configTask(() => readConfig(directory));
    response.setHeader('Cache-Control', 'no-store');
    response.json(config);
  }));
  app.put('/api/config', route(async (request, response) => {
    const directory = await validDirectory(request.body.path);
    const { content, revision } = request.body;
    if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > 65_536) return response.status(400).json({ error: 'Config must be text of at most 64 KB' });
    if (typeof revision !== 'string') return response.status(400).json({ error: 'Load the config before saving it' });
    const config = await configTask(async () => {
      const current = await readConfig(directory);
      if (revision !== current.revision) throw Object.assign(new Error('Config changed since it was loaded. Reload the latest file before saving.'), { status: 409 });
      const temporary = path.join(directory, `.platformio.ini.${randomUUID()}.tmp`);
      try {
        await fs.writeFile(temporary, content, { encoding: 'utf8', flag: 'wx', mode: 0o644 });
        await fs.rename(temporary, path.join(directory, 'platformio.ini'));
      } finally { await fs.unlink(temporary).catch(() => {}); }
      configVersion++;
      const saved = { path: directory, filename: 'platformio.ini', content, exists: true, revision: createHash('sha256').update(content).digest('hex'), version: configVersion };
      io.emit('config:saved', saved);
      return saved;
    });
    response.json(config);
  }));
  app.post('/api/builds', route(async (request, response) => {
    if (closing) return response.status(503).json({ error: 'Server is shutting down' });
    const name = typeof request.body.name === 'string' ? request.body.name.trim() : '';
    if (!name || name.length > 100 || /[\x00-\x1f\x7f]/.test(name)) return response.status(400).json({ error: 'Enter a build name of 1 to 100 characters without control characters' });
    const directory = await validDirectory(request.body.path);
    await commandFor(directory);
    if (builds.filter((build) => activeStatuses.has(build.status) || build.status === 'queued').length >= 32) return response.status(429).json({ error: 'The build queue is full' });
    const build = { id: randomUUID(), name, project: path.basename(directory), path: directory, status: 'queued', createdAt: new Date().toISOString(), startedAt: null, finishedAt: null, durationMs: 0, step: 'Waiting for an available worker', progress: null, logs: [], logSequence: 0, artifact: null };
    builds.unshift(build);
    while (builds.length > 50) {
      const removable = builds.findLastIndex((item) => !activeStatuses.has(item.status) && item.status !== 'queued');
      if (removable < 0) break;
      builds.splice(removable, 1);
    }
    publish();
    pump();
    response.status(202).json({ id: build.id });
  }));
  app.post('/api/builds/:id/cancel', route(async (request, response) => {
    const build = builds.find((item) => item.id === request.params.id);
    if (!build) return response.status(404).json({ error: 'Build not found' });
    if (build.status === 'queued') {
      build.status = 'cancelled';
      build.finishedAt = new Date().toISOString();
      build.step = 'Cancelled before starting';
      await completeStatistics(build);
    } else if (build.status === 'running') {
      build.status = 'cancelling';
      build.step = 'Stopping compiler process group';
      const record = processes.get(build.id);
      if (record) {
        signalGroup(record.child, 'SIGTERM');
        record.killTimer = setTimeout(() => signalGroup(record.child, 'SIGKILL'), 2500);
        record.killTimer.unref();
      }
    }
    publish();
    pump();
    response.json({ status: build.status });
  }));
  app.delete('/api/builds/:id', route(async (request, response) => {
    const index = builds.findIndex((build) => build.id === request.params.id);
    if (index < 0) return response.status(404).json({ error: 'Build not found' });
    const build = builds[index];
    if (activeStatuses.has(build.status) || build.status === 'queued' || processes.has(build.id)) return response.status(409).json({ error: 'Only finished builds can be deleted' });
    const currentIndex = builds.indexOf(build);
    if (currentIndex < 0) return response.status(404).json({ error: 'Build already deleted' });
    builds.splice(currentIndex, 1);
    await persist();
    publish();
    response.json({ id: build.id });
  }));
  app.get('/api/builds/:id/logs', (request, response) => {
    const build = builds.find((item) => item.id === request.params.id);
    if (!build) return response.status(404).json({ error: 'Build not found' });
    response.json({ buildId: build.id, logs: build.logs });
  });
  app.get('/api/artifacts', route(async (_request, response) => {
    const entries = await fs.readdir(path.join(dataDir, 'artifacts'));
    const artifacts = await Promise.all([...new Set(entries.filter((entry) => /\.(bin|hex)$/.test(entry)).map((entry) => entry.slice(0, -4)))].map((id) => archivedArtifact(id)));
    response.json(artifacts.filter(Boolean).sort((first, second) => second.createdAt.localeCompare(first.createdAt)));
  }));
  app.get('/api/builds/:id/artifact', route(async (request, response) => {
    const artifact = await archivedArtifact(request.params.id);
    if (!artifact) return response.status(404).json({ error: 'No firmware artifact available' });
    response.download(path.join(dataDir, 'artifacts', `${artifact.id}${artifact.extension}`), artifact.name);
  }));
  app.use('/vendor', express.static(path.join(baseDir, 'node_modules/lucide/dist/umd'), { maxAge: '1d' }));
  app.use(express.static(path.join(baseDir, 'public')));
  app.use((error, _request, response, _next) => {
    if (!response.headersSent) response.status(error.status || 400).json({ error: error.message || 'Request failed' });
  });
  io.on('connection', (socket) => socket.emit('state', snapshot()));

  async function updateStats() {
    if (statsBusy || closing) return;
    statsBusy = true;
    try {
      const [load, temperature, memory] = await Promise.all([si.currentLoad(), si.cpuTemperature().catch(() => ({ main: null })), si.mem()]);
      stats = { ...stats, cpu: Math.round(load.currentLoad * 10) / 10, temperature: temperature.main > 0 ? Math.round(temperature.main) : null, memoryUsed: memory.active, memoryTotal: memory.total, updatedAt: Date.now() };
      io.emit('stats', stats);
    } catch (error) { console.warn('Hardware sample unavailable:', error.message); }
    finally { statsBusy = false; }
  }
  const statsTimer = setInterval(updateStats, options.statsInterval || 2000);
  statsTimer.unref();
  if (options.hardware !== false) void updateStats();

  return {
    app, httpServer, io,
    listen(port = Number(process.env.PORT) || 3000, host = process.env.HOST || '0.0.0.0') {
      return new Promise((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(port, host, () => { httpServer.removeListener('error', reject); resolve(httpServer.address()); });
      });
    },
    async close() {
      closing = true;
      clearInterval(statsTimer);
      clearTimeout(persistTimer);
      for (const record of processes.values()) signalGroup(record.child, 'SIGTERM');
      await new Promise((resolve) => {
        const deadline = setTimeout(() => {
          for (const record of processes.values()) signalGroup(record.child, 'SIGKILL');
          clearInterval(poll);
          resolve();
        }, 2800);
        const poll = setInterval(() => {
          if (!processes.size && !finishingBuilds) { clearInterval(poll); clearTimeout(deadline); resolve(); }
        }, 30);
      });
      await new Promise((resolve) => io.close(resolve));
      await persist();
      await persistStatistics();
    }
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = await createCompileZ();
  const address = await server.listen();
  console.log(`CompileZ is listening on http://0.0.0.0:${address.port}`);
  if (!process.env.COMPILEZ_TOKEN) console.warn('Trusted LAN mode: no authentication. Set COMPILEZ_TOKEN before exposing this server.');
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    await server.close();
    process.exit(0);
  });
}