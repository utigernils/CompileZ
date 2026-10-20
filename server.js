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
  const initialPath = options.initialPath || process.env.PROJECT_PATH || path.join(baseDir, 'examples', 'signal-node');
  const roots = await Promise.all((options.roots || (process.env.BROWSE_ROOTS || `${baseDir},/home,/dev/shm`).split(','))
    .map((root) => fs.realpath(root.trim())));
  const maxConcurrent = Math.max(1, Math.min(16, Number(options.maxConcurrent ?? process.env.MAX_CONCURRENT_BUILDS) || 2));
  const token = options.token ?? process.env.COMPILEZ_TOKEN;
  const builds = [];
  const processes = new Map();
  let projectPath = await validDirectory(initialPath);
  let stats = { cpu: null, temperature: null, memoryUsed: null, memoryTotal: null, cores: os.cpus().length, hostname: os.hostname(), updatedAt: null };
  let closing = false;
  let statsBusy = false;
  let persistTimer;
  let persistQueue = Promise.resolve();
  let configQueue = Promise.resolve();
  let configVersion = 0;

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
    if (saved.projectPath) projectPath = await validDirectory(saved.projectPath).catch(() => projectPath);
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn('History could not be restored:', error.message);
  }

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
    return { projectPath, builds: builds.map(({ logs, logSequence, ...build }) => build), stats, maxConcurrent, roots };
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
    const saved = JSON.stringify({ projectPath, builds });
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
    persistTimer = setTimeout(() => persist().catch((error) => console.error('History save failed:', error.message)), 300);
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
      return { command: process.env.PIO_COMMAND || 'pio', args: ['run'], display: 'pio run' };
    }
    if (await fs.stat(path.join(directory, 'compile.sh')).then((stat) => stat.isFile(), () => false)) {
      return { command: '/bin/bash', args: ['compile.sh'], display: 'bash compile.sh' };
    }
    throw new Error('No platformio.ini or compile.sh found in this directory');
  }

  async function findArtifact(directory) {
    const candidates = [];
    for (const candidate of ['firmware.bin', 'build/firmware.bin', 'dist/firmware.bin']) {
      candidates.push(path.join(directory, candidate));
    }
    const environments = await fs.readdir(path.join(directory, '.pio/build'), { withFileTypes: true }).catch(() => []);
    for (const environment of environments.filter((entry) => entry.isDirectory()).sort((first, second) => first.name.localeCompare(second.name))) {
      candidates.push(path.join(directory, '.pio/build', environment.name, 'firmware.bin'));
    }
    const artifacts = await Promise.all(candidates.map(async (target) => {
      const stat = await fs.stat(target).catch(() => null);
      return stat?.isFile() ? { target, modified: stat.mtimeMs } : null;
    }));
    return artifacts.filter(Boolean).sort((first, second) => second.modified - first.modified)[0]?.target || null;
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
            if (artifactStat.mtimeMs < Date.parse(build.startedAt) - 1000) {
              appendLog(build, 'Existing firmware is older than this build; download omitted.\n', 'system');
            } else {
              await fs.copyFile(resolved, path.join(dataDir, 'artifacts', `${build.id}.bin`));
              build.artifact = { name: `${build.project}-${build.id.slice(0, 8)}.bin`, bytes: artifactStat.size };
            }
          } else appendLog(build, 'Build succeeded. No firmware.bin was produced.\n', 'system');
        } catch (artifactError) { appendLog(build, `Artifact unavailable: ${artifactError.message}\n`, 'stderr'); }
        build.progress = 100;
      }
      build.status = build.status === 'cancelling' ? 'cancelled' : finalStatus;
      build.finishedAt = new Date().toISOString();
      build.step = cancelled ? 'Build cancelled' : build.status === 'completed' ? 'Build completed successfully' : `Build failed (${error?.code || signal || code})`;
      appendLog(build, `${build.step}\n`, 'system');
      processes.delete(build.id);
      publish();
      pump();
    };
    try {
      await validDirectory(build.path);
      const command = await commandFor(build.path);
      if (build.status === 'cancelling' || closing) return finish(null, 'SIGTERM');
      build.command = command.display;
      appendLog(build, `$ ${command.display}\n`, 'system');
      child = spawn(command.command, command.args, {
        cwd: build.path, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, FORCE_COLOR: '0', TERM: 'dumb', CI: '1' }
      });
      processes.set(build.id, { child });
      for (const stream of ['stdout', 'stderr']) {
        const decoder = new StringDecoder('utf8');
        child[stream].on('data', (chunk) => appendLog(build, decoder.write(chunk), stream));
        child[stream].on('end', () => appendLog(build, decoder.end(), stream));
      }
      child.once('error', (error) => { void finish(null, null, error); });
      child.once('close', (code, signal) => { void finish(code, signal); });
      publish();
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

  const route = (handler) => (request, response, next) => Promise.resolve(handler(request, response)).catch(next);
  app.get('/api/state', (_request, response) => response.json(snapshot()));
  app.get('/api/directories', route(async (request, response) => {
    const directory = await validDirectory(request.query.path || projectPath);
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const folders = entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.')).map((entry) => ({ name: entry.name, path: path.join(directory, entry.name) })).sort((first, second) => first.name.localeCompare(second.name));
    const parent = path.dirname(directory);
    response.json({ path: directory, parent: roots.some((root) => inside(root, parent)) ? parent : null, roots, folders });
  }));
  app.put('/api/project', route(async (request, response) => {
    projectPath = await validDirectory(request.body.path);
    publish();
    response.json({ path: projectPath });
  }));
  app.get('/api/config', route(async (request, response) => {
    const directory = await validDirectory(request.query.path || projectPath);
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
    const directory = await validDirectory(request.body.path || projectPath);
    await commandFor(directory);
    if (builds.filter((build) => activeStatuses.has(build.status) || build.status === 'queued').length >= 32) return response.status(429).json({ error: 'The build queue is full' });
    const build = { id: randomUUID(), project: path.basename(directory), path: directory, status: 'queued', createdAt: new Date().toISOString(), startedAt: null, finishedAt: null, step: 'Waiting for an available worker', progress: null, logs: [], logSequence: 0, artifact: null };
    builds.unshift(build);
    while (builds.length > 50) {
      const removable = builds.findLastIndex((item) => !activeStatuses.has(item.status) && item.status !== 'queued');
      if (removable < 0) break;
      const [removed] = builds.splice(removable, 1);
      void fs.unlink(path.join(dataDir, 'artifacts', `${removed.id}.bin`)).catch(() => {});
    }
    publish();
    pump();
    response.status(202).json({ id: build.id });
  }));
  app.post('/api/builds/:id/cancel', (request, response) => {
    const build = builds.find((item) => item.id === request.params.id);
    if (!build) return response.status(404).json({ error: 'Build not found' });
    if (build.status === 'queued') {
      build.status = 'cancelled';
      build.finishedAt = new Date().toISOString();
      build.step = 'Cancelled before starting';
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
  });
  app.get('/api/builds/:id/logs', (request, response) => {
    const build = builds.find((item) => item.id === request.params.id);
    if (!build) return response.status(404).json({ error: 'Build not found' });
    response.json({ buildId: build.id, logs: build.logs });
  });
  app.get('/api/builds/:id/artifact', (request, response, next) => {
    const build = builds.find((item) => item.id === request.params.id);
    if (!build?.artifact || build.status !== 'completed') return response.status(404).json({ error: 'No firmware artifact available' });
    response.download(path.join(dataDir, 'artifacts', `${build.id}.bin`), build.artifact.name, (error) => { if (error) next(error); });
  });
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
          if (!processes.size) { clearInterval(poll); clearTimeout(deadline); resolve(); }
        }, 30);
      });
      await new Promise((resolve) => io.close(resolve));
      await persist();
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