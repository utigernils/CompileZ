import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { io } from 'socket.io-client';
import { createCompileZ } from '../server.js';

async function waitFor(check, message = 'condition', timeout = 7000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${message}`);
}

test('config reads, atomic saves, broadcasts, conflicts and filesystem boundaries', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'compilez-config-'));
  const first = path.join(root, 'alpha');
  const second = path.join(root, 'beta');
  await fs.mkdir(first);
  await fs.mkdir(second);
  const server = await createCompileZ({ roots: [root], initialPath: first, dataDir: path.join(root, 'data'), hardware: false });
  const address = await server.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${address.port}`;
  const clients = [io(base), io(base)];
  const received = [[], []];
  clients.forEach((client, index) => client.on('config:saved', (config) => received[index].push(config)));
  context.after(async () => { clients.forEach((client) => client.disconnect()); await server.close(); await fs.rm(root, { recursive: true, force: true }); });
  const request = async (url, method = 'GET', body) => {
    const response = await fetch(`${base}${url}`, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  await waitFor(() => clients.every((client) => client.connected));
  const missing = (await request('/api/config')).body;
  assert.equal(missing.content, '');
  assert.equal(missing.exists, false);
  const content = '; exact raw text\r\n[env:nuc]\r\nbuild_flags = -DVALUE="<hello>"\r\n';
  const saved = await request('/api/config', 'PUT', { path: first, content, revision: missing.revision });
  assert.equal(saved.status, 200);
  assert.equal(await fs.readFile(path.join(first, 'platformio.ini'), 'utf8'), content);
  await waitFor(() => received.every((events) => events.length === 1), 'config broadcast to both clients');
  assert.ok(received.every((events) => events[0].content === content && events[0].path === first));
  assert.equal((await request('/api/config')).body.content, content);
  assert.equal((await request('/api/config', 'PUT', { path: first, content: 'stale', revision: missing.revision })).status, 409);
  const competing = await Promise.all(['one', 'two'].map((text) => request('/api/config', 'PUT', { path: first, content: text, revision: saved.body.revision })));
  assert.deepEqual(competing.map((result) => result.status).sort(), [200, 409]);
  await request('/api/project', 'PUT', { path: second });
  assert.equal((await request('/api/config')).body.content, '');
  assert.equal((await request(`/api/config?path=${encodeURIComponent(first)}`)).body.exists, true);
  assert.equal((await request('/api/config', 'PUT', { path: second, content: 'x'.repeat(65_537), revision: 'missing' })).status, 400);
  assert.equal((await request('/api/config', 'PUT', { path: '/etc', content: 'no', revision: 'missing' })).status, 400);
  await fs.symlink(path.join(first, 'platformio.ini'), path.join(second, 'platformio.ini'));
  assert.equal((await request('/api/config')).status, 400);
  assert.equal((await request('/api/config', 'PUT', { path: second, content: 'no', revision: 'missing' })).status, 400);
});

test('shared paths, concurrent isolated builds, queue, cancellation, artifacts and failures', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'compilez-'));
  const first = path.join(root, 'alpha');
  const second = path.join(root, 'beta');
  const bad = path.join(root, 'broken');
  for (const directory of [first, second, bad]) await fs.mkdir(directory);
  await fs.writeFile(path.join(first, 'compile.sh'), 'echo alpha-start\nsleep 0.5\nprintf alpha > firmware.bin\necho "[100%] alpha-done"\n');
  await fs.writeFile(path.join(second, 'compile.sh'), 'echo beta-start\nsleep 0.5\nprintf beta > firmware.bin\necho beta-done\n');
  await fs.writeFile(path.join(bad, 'compile.sh'), 'echo broken >&2\nexit 9\n');
  const server = await createCompileZ({ roots: [root], initialPath: first, dataDir: path.join(root, 'data'), hardware: false, maxConcurrent: 2 });
  const address = await server.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${address.port}`;
  const clients = [io(base), io(base)];
  context.after(async () => { clients.forEach((client) => client.disconnect()); await server.close(); await fs.rm(root, { recursive: true, force: true }); });
  const states = [];
  const logs = [];
  clients.forEach((client, index) => { client.on('state', (state) => { states[index] = state; }); client.on('build:log', (entry) => logs.push(entry)); });
  const request = async (url, method = 'GET', body) => {
    const response = await fetch(`${base}${url}`, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  await waitFor(() => states.length === 2, 'both socket snapshots');
  await request('/api/project', 'PUT', { path: second });
  await waitFor(() => states.every((state) => state.projectPath === second), 'shared project path');
  const alpha = (await request('/api/builds', 'POST', { path: first, name: 'Alpha release' })).body.id;
  const beta = (await request('/api/builds', 'POST', { path: second, name: 'Beta release' })).body.id;
  await waitFor(() => states[1].builds.filter((build) => build.status === 'running').length === 2, 'concurrent builds');
  const queued = (await request('/api/builds', 'POST', { path: first, name: 'Queued release' })).body.id;
  assert.equal(states[0].projectPath, second);
  await waitFor(() => states[0].builds.find((build) => build.id === queued)?.status === 'queued');
  await request(`/api/builds/${queued}/cancel`, 'POST');
  await waitFor(() => states[1].builds.find((build) => build.id === queued)?.status === 'cancelled');
  await waitFor(() => states[0].builds.filter((build) => build.status === 'completed').length === 2, 'successful builds');
  const alphaLogs = (await request(`/api/builds/${alpha}/logs`)).body.logs.map((entry) => entry.text).join('');
  const betaLogs = (await request(`/api/builds/${beta}/logs`)).body.logs.map((entry) => entry.text).join('');
  assert.match(alphaLogs, /alpha-start/);
  assert.doesNotMatch(alphaLogs, /beta/);
  assert.match(betaLogs, /beta-start/);
  assert.equal(await (await fetch(`${base}/api/builds/${alpha}/artifact`)).text(), 'alpha');
  assert.equal(await (await fetch(`${base}/api/builds/${beta}/artifact`)).text(), 'beta');
  assert.ok(logs.some((entry) => entry.buildId === alpha));
  const failure = (await request('/api/builds', 'POST', { path: bad, name: 'Failure test' })).body.id;
  await waitFor(() => states[0].builds.find((build) => build.id === failure)?.status === 'failed');
  assert.equal(states[0].builds.find((build) => build.id === failure).exitCode, 9);
  await fs.writeFile(path.join(second, 'compile.sh'), 'echo waiting\nsleep 30\n');
  const cancelled = (await request('/api/builds', 'POST', { path: second, name: 'Cancel test' })).body.id;
  await waitFor(() => logs.some((entry) => entry.buildId === cancelled && entry.entry.text.includes('waiting')));
  await request(`/api/builds/${cancelled}/cancel`, 'POST');
  await waitFor(() => states[1].builds.find((build) => build.id === cancelled)?.status === 'cancelled');
  assert.equal((await request('/api/project', 'PUT', { path: '/etc' })).status, 400);
  await fs.symlink('/etc', path.join(root, 'escape'));
  assert.equal((await request(`/api/directories?path=${encodeURIComponent(path.join(root, 'escape'))}`)).status, 400);
  assert.equal((await request('/api/directories')).body.path, second);
});

test('same-project jobs serialize, choose fresh firmware, retain snapshots and restore history', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'compilez-history-'));
  const project = path.join(root, 'firmware');
  await fs.mkdir(project);
  await fs.writeFile(path.join(project, 'firmware.bin'), 'stale');
  await fs.utimes(path.join(project, 'firmware.bin'), 0, 0);
  await fs.writeFile(path.join(project, 'compile.sh'), 'set -e\ncount=$(cat count 2>/dev/null || printf 0)\ncount=$((count + 1))\nprintf "%s" "$count" > count\necho "starting-$count"\nsleep 0.2\nmkdir -p build\nprintf "firmware-%s" "$count" > build/firmware.bin\n');
  const options = { roots: [root], initialPath: project, dataDir: path.join(root, 'data'), hardware: false };
  let server = await createCompileZ(options);
  let address = await server.listen(0, '127.0.0.1');
  let base = `http://127.0.0.1:${address.port}`;
  context.after(async () => { await server.close(); await fs.rm(root, { recursive: true, force: true }); });
  const submit = async () => (await (await fetch(`${base}/api/builds`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Firmware release' }) })).json()).id;
  const first = await submit();
  const second = await submit();
  const snapshot = await (await fetch(`${base}/api/state`)).json();
  assert.equal(snapshot.builds.find((build) => build.id === second).status, 'queued');
  await waitFor(async () => {
    const state = await (await fetch(`${base}/api/state`)).json();
    assert.ok(state.builds.filter((build) => build.status === 'running').length <= 1);
    return state.builds.every((build) => build.status === 'completed');
  });
  assert.equal(await (await fetch(`${base}/api/builds/${first}/artifact`)).text(), 'firmware-1');
  assert.equal(await (await fetch(`${base}/api/builds/${second}/artifact`)).text(), 'firmware-2');
  await server.close();
  server = await createCompileZ(options);
  address = await server.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${address.port}`;
  const restored = await (await fetch(`${base}/api/state`)).json();
  assert.equal(restored.builds.length, 2);
  assert.equal(restored.builds[0].status, 'completed');
  assert.equal(await (await fetch(`${base}/api/builds/${first}/artifact`)).text(), 'firmware-1');
  assert.match(JSON.stringify(await (await fetch(`${base}/api/builds/${first}/logs`)).json()), /starting-1/);
});

test('authentication and origin checks cover HTTP and Socket.IO', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'compilez-auth-'));
  const server = await createCompileZ({ roots: [root], initialPath: root, dataDir: path.join(root, 'data'), hardware: false, token: 'integration-password' });
  const address = await server.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${address.port}`;
  const authorization = `Basic ${Buffer.from('compilez:integration-password').toString('base64')}`;
  const client = io(base, { extraHeaders: { Authorization: authorization } });
  const denied = io(base, { reconnection: false });
  context.after(async () => { client.disconnect(); denied.disconnect(); await server.close(); await fs.rm(root, { recursive: true, force: true }); });
  const rejected = new Promise((resolve) => denied.once('connect_error', resolve));
  await waitFor(() => client.connected, 'authenticated socket');
  assert.ok(await rejected);
  assert.equal((await fetch(`${base}/api/state`)).status, 401);
  assert.equal((await fetch(`${base}/api/state`, { headers: { Authorization: authorization } })).status, 200);
  assert.equal((await fetch(`${base}/api/project`, { method: 'PUT', headers: { Authorization: authorization, Origin: 'https://untrusted.example', 'Content-Type': 'application/json' }, body: JSON.stringify({ path: root }) })).status, 403);
});

test('missing compiler executable fails the build without stopping the server', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'compilez-spawn-'));
  await fs.writeFile(path.join(root, 'platformio.ini'), '[env:test]\n');
  const previous = process.env.PIO_COMMAND;
  process.env.PIO_COMMAND = path.join(root, 'missing-pio');
  const server = await createCompileZ({ roots: [root], initialPath: root, dataDir: path.join(root, 'data'), hardware: false });
  const address = await server.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${address.port}`;
  context.after(async () => {
    if (previous === undefined) delete process.env.PIO_COMMAND;
    else process.env.PIO_COMMAND = previous;
    await server.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const build = await (await fetch(`${base}/api/builds`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Missing compiler' }) })).json();
  const result = await waitFor(async () => {
    const state = await (await fetch(`${base}/api/state`)).json();
    return state.builds.find((item) => item.id === build.id && item.status === 'failed');
  });
  assert.equal(result.step, 'Build failed (ENOENT)');
  assert.equal((await fetch(`${base}/api/state`)).status, 200);
});

test('required names, timestamps, synced deletion and all-time statistics survive a restart', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'compilez-stats-'));
  const first = path.join(root, 'firmware');
  const broken = path.join(root, 'broken');
  const dataDir = path.join(root, 'data');
  await fs.mkdir(first);
  await fs.mkdir(broken);
  await fs.writeFile(path.join(first, 'compile.sh'), 'echo building\nsleep 0.3\nprintf binary > firmware.bin\n');
  await fs.writeFile(path.join(broken, 'compile.sh'), 'echo failed >&2\nexit 4\n');
  const options = { roots: [root], initialPath: first, dataDir, hardware: false };
  let server = await createCompileZ(options);
  let address = await server.listen(0, '127.0.0.1');
  let base = `http://127.0.0.1:${address.port}`;
  const clients = [io(base), io(base)];
  const states = [];
  clients.forEach((client, index) => client.on('state', (state) => { states[index] = state; }));
  context.after(async () => { clients.forEach((client) => client.disconnect()); await server.close(); await fs.rm(root, { recursive: true, force: true }); });
  const request = async (url, method = 'GET', body) => {
    const response = await fetch(`${base}${url}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  await waitFor(() => states.length === 2);
  for (const name of [undefined, '', '   ', 'x'.repeat(101), 'bad\nname']) {
    assert.equal((await request('/api/builds', 'POST', { path: first, name })).status, 400);
  }
  assert.equal((await request('/api/state')).body.builds.length, 0);
  const release = (await request('/api/builds', 'POST', { path: first, name: ' Release <v1> ' })).body.id;
  await waitFor(() => states[0].builds.find((build) => build.id === release)?.status === 'running');
  assert.equal(states[0].builds.find((build) => build.id === release).name, 'Release <v1>');
  assert.equal((await request(`/api/builds/${release}`, 'DELETE')).status, 409);
  const queued = (await request('/api/builds', 'POST', { path: first, name: 'Queued build' })).body.id;
  assert.equal((await request(`/api/builds/${queued}`, 'DELETE')).status, 409);
  await request(`/api/builds/${queued}/cancel`, 'POST');
  const failure = (await request('/api/builds', 'POST', { path: broken, name: 'Failure test' })).body.id;
  await waitFor(() => states.every((state) => state.buildStatistics.totalBuilds === 3), 'all clients receive cumulative statistics');
  const build = states[0].builds.find((item) => item.id === release);
  assert.equal(build.status, 'completed');
  assert.ok(Date.parse(build.finishedAt) >= Date.parse(build.startedAt));
  assert.equal(build.durationMs, Date.parse(build.finishedAt) - Date.parse(build.startedAt));
  const metrics = (await request('/api/stats')).body;
  assert.equal(metrics.totalBuilds, 3);
  assert.equal(metrics.successCount, 1);
  assert.equal(metrics.failureCount, 1);
  assert.equal(metrics.cancelledCount, 1);
  assert.equal(metrics.successRate, 50);
  assert.equal(metrics.failureRate, 50);
  assert.equal(metrics.mostCompiledProject.path, first);
  assert.equal(metrics.mostCompiledProject.count, 2);
  assert.ok(metrics.totalDurationMs >= build.durationMs);
  assert.ok(metrics.longestDurationMs >= build.durationMs);
  assert.equal(metrics.averageDurationMs, metrics.totalDurationMs / 3);
  assert.equal((await request(`/api/builds/${release}`, 'DELETE')).status, 200);
  assert.equal((await request(`/api/builds/${failure}`, 'DELETE')).status, 200);
  await waitFor(() => states.every((state) => state.builds.length === 1), 'deletion broadcast to both clients');
  assert.equal((await fetch(`${base}/api/builds/${release}/artifact`)).status, 404);
  assert.equal((await request(`/api/builds/${release}/logs`)).status, 404);
  assert.equal((await request('/api/stats')).body.totalBuilds, 3);
  assert.equal(JSON.parse(await fs.readFile(path.join(dataDir, 'stats.json'), 'utf8')).totalBuilds, 3);
  assert.equal(JSON.parse(await fs.readFile(path.join(dataDir, 'history.json'), 'utf8')).builds.length, 1);
  clients.forEach((client) => client.disconnect());
  await server.close();
  server = await createCompileZ(options);
  address = await server.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${address.port}`;
  assert.deepEqual((await request('/api/stats')).body, metrics);
  assert.equal((await request('/api/state')).body.builds.length, 1);
});

test('statistics migrate existing history once, including interrupted builds', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'compilez-migrate-'));
  const dataDir = path.join(root, 'data');
  await fs.mkdir(dataDir);
  await fs.writeFile(path.join(dataDir, 'history.json'), JSON.stringify({ projectPath: root, builds: [
    { id: 'legacy-success', project: 'legacy', path: root, status: 'completed', startedAt: '2026-10-01T10:00:00.000Z', finishedAt: '2026-10-01T10:00:02.500Z', logs: [], logSequence: 0 },
    { id: 'legacy-active', project: 'legacy', path: root, status: 'running', startedAt: new Date().toISOString(), finishedAt: null, logs: [], logSequence: 0 }
  ] }));
  const options = { roots: [root], initialPath: root, dataDir, hardware: false };
  let server = await createCompileZ(options);
  let address = await server.listen(0, '127.0.0.1');
  context.after(async () => { await server.close(); await fs.rm(root, { recursive: true, force: true }); });
  const state = await (await fetch(`http://127.0.0.1:${address.port}/api/state`)).json();
  assert.equal(state.builds[0].name, 'legacy');
  assert.equal(state.buildStatistics.totalBuilds, 2);
  assert.equal(state.buildStatistics.successCount, 1);
  assert.equal(state.buildStatistics.interruptedCount, 1);
  assert.ok(state.buildStatistics.totalDurationMs >= 2500);
  await server.close();
  server = await createCompileZ(options);
  address = await server.listen(0, '127.0.0.1');
  const restored = await (await fetch(`http://127.0.0.1:${address.port}/api/stats`)).json();
  assert.equal(restored.totalBuilds, 2);
});