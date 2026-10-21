const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const icons = () => lucide.createIcons({ attrs: { 'stroke-width': 1.65 } });
const activeStates = new Set(['running', 'cancelling']);
const labels = { queued: 'Queued', running: 'Running', cancelling: 'Stopping', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled', interrupted: 'Interrupted' };
const statusIcons = { queued: 'clock-3', running: 'loader-circle', cancelling: 'loader-circle', completed: 'circle-check', failed: 'circle-x', cancelled: 'circle-slash', interrupted: 'circle-alert' };
let state = { builds: [], stats: {}, maxConcurrent: 2, roots: [] };
let projectPath = '';
let pathRequest = 0;
let selectedId = null;
let filter = 'all';
let connected = false;
let follow = true;
let directory = null;
let browseRequest = 0;
let submitting = false;
let config = null;
let configLoadId = 0;
let configNeedsReload = true;
let savingConfig = false;
let configError = '';
let deleteId = null;
const logCache = new Map();
const samples = { cpu: [], temperature: [], memory: [] };
const socket = io({ reconnectionDelayMax: 3000 });
const escapeHtml = (text) => String(text ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const fileName = (target) => target.split('/').filter(Boolean).at(-1) || '/';
const formatBytes = (bytes) => bytes == null ? '--' : (bytes / 1024 ** 3).toFixed(1);
const selectedBuild = () => state.builds.find((build) => build.id === selectedId);

async function api(url, method = 'GET', body) {
  const response = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `Request failed (${response.status})`);
  return result;
}

function toast(message, error = false) {
  const element = document.createElement('div');
  element.className = `toast ${error ? 'error' : ''}`;
  element.textContent = message;
  $('#toasts').append(element);
  setTimeout(() => element.remove(), 4500);
}

function setConnection(value) {
  connected = value;
  $('#connection-dot').classList.toggle('offline', !value);
  $('#connection-label').textContent = value ? 'Connected' : 'Reconnecting';
  const footerStatus = $('#footer-status');
  if (footerStatus) footerStatus.textContent = value ? 'All systems operational' : 'Connection lost. Reconnecting...';
  $('#compile-button').disabled = !value || submitting;
  $('#browse-button').disabled = !value;
  $('#stop-button').disabled = !value || selectedBuild()?.status === 'cancelling';
  $('#confirm-delete').disabled = !value;
  renderConfigControls();
}

socket.on('connect', () => { configNeedsReload = true; setConnection(true); void loadArtifacts(); });
socket.on('disconnect', () => setConnection(false));
socket.on('connect_error', () => setConnection(false));
socket.on('state', (next) => {
  state = next;
  if (!projectPath) {
    projectPath = next.defaultProjectPath;
    let preferred = projectPath;
    try { preferred = sessionStorage.getItem('compilez-project-path') || projectPath; } catch {}
    configNeedsReload = false;
    void updatePath(preferred).catch(() => updatePath(next.defaultProjectPath).catch((error) => toast(error.message, true)));
  } else if (configNeedsReload) {
    configNeedsReload = false;
    void loadConfig(projectPath);
  }
  if (!selectedId && state.builds.length) void selectBuild(state.builds[0].id);
  if (selectedId && !selectedBuild()) { selectedId = null; if (state.builds.length) void selectBuild(state.builds[0].id); }
  for (const id of logCache.keys()) if (!state.builds.some((build) => build.id === id)) logCache.delete(id);
  renderStats(state.stats, false);
  renderQueue();
  renderTerminalHeading();
  renderWorkers();
  renderBuildStatistics();
  if (!selectedId) renderLogs();
  if (selectedId) void loadLogs(selectedId);
});
socket.on('stats', (stats) => { state.stats = stats; renderStats(stats, true); });
socket.on('artifacts:changed', () => { void loadArtifacts(); });
socket.on('config:saved', (saved) => {
  if (saved.path !== projectPath) return;
  if (config && saved.version < config.version) return;
  const hadDraft = config && $('#config-content').value !== config.content;
  configLoadId++;
  applyConfig(saved);
  if (!savingConfig) toast(hadDraft ? 'Shared config updated; unsaved edits replaced by the saved file' : 'Config updated by another client');
});
socket.on('build:log', ({ buildId, entry }) => {
  if (!logCache.has(buildId)) return;
  mergeLogs(buildId, [entry]);
  if (selectedId === buildId) renderLogs();
});
socket.on('build:update', ({ id, step, progress }) => {
  const build = state.builds.find((item) => item.id === id);
  if (!build) return;
  build.step = step;
  build.progress = progress;
  const preview = document.querySelector(`[data-step="${id}"]`);
  if (preview) { preview.textContent = step; preview.title = step; }
  if (id === selectedId) renderTerminalHeading();
});

function graph(id, values, color, maximum) {
  const canvas = $(id);
  const context = canvas.getContext('2d');
  const width = canvas.width;
  const height = canvas.height;
  context.clearRect(0, 0, width, height);
  if (!values.length) return;
  const padded = Array(32 - values.length).fill(values[0]).concat(values);
  const points = padded.map((value, index) => [index * width / 31, height - 5 - Math.min(1, value / maximum) * (height - 10)]);
  context.beginPath();
  context.moveTo(0, height);
  points.forEach(([horizontal, vertical]) => context.lineTo(horizontal, vertical));
  context.lineTo(width, height);
  const fill = context.createLinearGradient(0, 0, 0, height);
  fill.addColorStop(0, `${color}35`);
  fill.addColorStop(1, `${color}00`);
  context.fillStyle = fill;
  context.fill();
  context.beginPath();
  points.forEach(([horizontal, vertical], index) => index ? context.lineTo(horizontal, vertical) : context.moveTo(horizontal, vertical));
  context.strokeStyle = color;
  context.lineWidth = 1.4;
  context.stroke();
}

function renderStats(stats, record) {
  const cpu = stats.cpu;
  const temperature = stats.temperature;
  const memory = stats.memoryTotal ? stats.memoryUsed / stats.memoryTotal * 100 : null;
  $('#cpu-value').textContent = cpu == null ? '--' : cpu.toFixed(1);
  $('#temp-value').textContent = temperature ?? '--';
  $('#temp-label').textContent = temperature == null ? 'UNAVAILABLE' : temperature >= 80 ? 'HOT' : 'NORMAL';
  $('#memory-value').textContent = formatBytes(stats.memoryUsed);
  $('#memory-total').textContent = `/ ${formatBytes(stats.memoryTotal)} GB`;
  $('#memory-percent').textContent = memory == null ? '--%' : `${Math.round(memory)}%`;
  $('#cpu-cores').textContent = `${stats.cores || '--'} CORES`;
  const hostnameLabel = $('#host-name');
  if (hostnameLabel) hostnameLabel.textContent = stats.hostname || 'LOCAL BUILD SERVER';
  $('#cpu-meter').style.width = `${Math.min(100, cpu || 0)}%`;
  $('#temp-meter').style.width = `${Math.min(100, temperature || 0)}%`;
  $('#memory-meter').style.width = `${memory || 0}%`;
  if (stats.updatedAt) $('#sample-time').textContent = `Updated ${new Date(stats.updatedAt).toLocaleTimeString([], { hour12: false })}`;
  for (const [key, value] of Object.entries({ cpu, temperature, memory })) {
    if (value != null && (record || !samples[key].length)) {
      samples[key].push(value);
      if (samples[key].length > 32) samples[key].shift();
    }
  }
  graph('#cpu-chart', samples.cpu, '#b9f67a', 100);
  graph('#temp-chart', samples.temperature, '#e3b67a', 100);
  graph('#memory-chart', samples.memory, '#78c9cb', 100);
}

function renderWorkers() {
  const running = state.builds.filter((build) => activeStates.has(build.status)).length;
  const queued = state.builds.filter((build) => build.status === 'queued').length;
  $('#worker-value').textContent = running;
  $('#worker-limit').textContent = `/ ${state.maxConcurrent}`;
  $('#worker-state').textContent = running ? 'WORKING' : 'IDLE';
  $('#worker-state').classList.toggle('busy', Boolean(running));
  $('#worker-description').textContent = queued ? `${queued} build${queued === 1 ? '' : 's'} queued` : running ? 'Compilers in progress' : 'All systems ready';
  $('#worker-slots').innerHTML = Array.from({ length: state.maxConcurrent }, (_value, index) => `<span class="${index < running ? 'busy' : ''}"></span>`).join('');
  $('#execution-note').textContent = running ? `${running} active process${running === 1 ? '' : 'es'}` : 'No active processes';
}

function duration(build) {
  if (!build?.startedAt) return '00:00';
  const seconds = Math.max(0, Math.floor(((build.finishedAt ? Date.parse(build.finishedAt) : Date.now()) - Date.parse(build.startedAt)) / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function timestamp(value) {
  return value ? new Date(value).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : 'Not started';
}

function formatDuration(milliseconds) {
  const seconds = Math.max(0, Math.round((milliseconds || 0) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
}

function renderBuildStatistics() {
  const metrics = state.buildStatistics;
  if (!metrics) return;
  $('#stat-total').textContent = metrics.totalBuilds.toLocaleString();
  $('#stat-time').textContent = formatDuration(metrics.totalDurationMs);
  $('#stat-longest').textContent = formatDuration(metrics.longestDurationMs);
  $('#stat-average').textContent = formatDuration(metrics.averageDurationMs);
  $('#stat-success').textContent = metrics.successCount.toLocaleString();
  $('#stat-failed').textContent = metrics.failureCount.toLocaleString();
  $('#stat-success-rate').textContent = `${metrics.successRate.toFixed(1)}%`;
  $('#stat-failure-rate').textContent = `${metrics.failureRate.toFixed(1)}%`;
  $('#stat-success-bar').style.width = `${metrics.successRate}%`;
  $('#stat-failure-bar').style.width = `${metrics.failureRate}%`;
  $('#outcome-bar').setAttribute('aria-label', `${metrics.successRate.toFixed(1)}% successful, ${metrics.failureRate.toFixed(1)}% failed; excluding cancelled and interrupted builds`);
  $('#stat-outcome-total').textContent = `${metrics.successCount + metrics.failureCount} successful or failed builds`;
  $('#stat-cancelled').textContent = `${metrics.cancelledCount} cancelled`;
  $('#stat-interrupted').textContent = `${metrics.interruptedCount} interrupted`;
  $('#stat-project').textContent = metrics.mostCompiledProject?.path || 'No builds yet';
  $('#stat-project-count').textContent = `${metrics.mostCompiledProject?.count || 0} builds`;
  $('#stats-updated').textContent = metrics.updatedAt ? `Updated ${timestamp(metrics.updatedAt)}` : 'No completed builds';
}

async function loadArtifacts() {
  try {
    const artifacts = await api('/api/artifacts');
    $('#archive-count').textContent = `${artifacts.length} files`;
    $('#firmware-list').innerHTML = artifacts.length ? artifacts.map((artifact) => `<div class="firmware-item"><div><strong>${escapeHtml(artifact.buildName)}</strong><p class="mono">${escapeHtml(artifact.projectPath || artifact.id)}</p><span>${escapeHtml(timestamp(artifact.createdAt))} / ${(artifact.bytes / 1024).toFixed(1)} KB</span></div><a class="archive-download" href="/api/builds/${artifact.id}/artifact" aria-label="Download ${escapeHtml(artifact.buildName)} firmware"><i data-lucide="download"></i> .bin</a></div>`).join('') : '<p class="archive-empty">No saved firmware</p>';
    icons();
  } catch (error) { $('#firmware-list').textContent = error.message; }
}
$('#refresh-archive').addEventListener('click', () => { void loadArtifacts(); });

function renderQueue() {
  const active = state.builds.filter((build) => activeStates.has(build.status) || build.status === 'queued');
  const completed = state.builds.filter((build) => build.status === 'completed');
  const failed = state.builds.filter((build) => build.status === 'failed');
  $('#queue-count').textContent = state.builds.length;
  $('#active-count').textContent = active.length;
  $('#success-count').textContent = completed.length;
  $('#failed-count').textContent = failed.length;
  const visible = filter === 'active' ? active : filter === 'completed' ? completed : state.builds;
  $('#queue-list').innerHTML = visible.length ? visible.map((build) => {
    const name = escapeHtml(build.name || build.project);
    const finished = !activeStates.has(build.status) && build.status !== 'queued';
    const timing = `Started: ${build.startedAt || 'not started'}${build.finishedAt ? ` | Finished: ${build.finishedAt}` : ''}`;
    return `<article class="build-item ${build.id === selectedId ? 'selected' : ''} ${build.status}"><button class="build-select" data-build="${build.id}" aria-label="View ${name} ${labels[build.status]} build" aria-pressed="${build.id === selectedId}"><div class="build-item-top"><span class="build-item-icon ${build.status}"><i data-lucide="${statusIcons[build.status]}"></i></span><span class="build-project-name" title="${name}">${name}</span></div><div class="build-item-meta"><span class="build-label ${build.status}">${labels[build.status]}</span><span class="mono">#${build.id.slice(0, 8)}</span><span class="build-time" data-duration="${build.id}">${duration(build)}</span></div><div class="build-timestamp" title="${escapeHtml(timing)}">${build.startedAt ? `<time datetime="${build.startedAt}">${escapeHtml(timestamp(build.startedAt))}</time>` : 'Not started'}</div><div class="build-step" data-step="${build.id}" title="${escapeHtml(build.step)}">${escapeHtml(build.step)}</div>${activeStates.has(build.status) ? '<div class="queue-progress"><span></span></div>' : ''}</button>${build.artifact ? `<a class="artifact-link" href="/api/builds/${build.id}/artifact"><i data-lucide="download"></i> Download .bin <span>${(build.artifact.bytes / 1024).toFixed(1)} KB</span></a>` : ''}${build.status === 'queued' ? `<button class="cancel-queued" data-cancel="${build.id}" title="Cancel queued build" aria-label="Cancel queued ${name} build"><i data-lucide="x"></i></button>` : ''}${finished ? `<button class="delete-build icon-button" data-delete="${build.id}" title="Delete build" aria-label="Delete ${name}"><i data-lucide="trash-2"></i></button>` : ''}</article>`;
  }).join('') : `<div class="queue-empty"><div class="empty-stack"><i data-lucide="${filter === 'all' ? 'layers-2' : 'list-filter'}"></i></div><h3>${filter === 'all' ? 'No builds yet' : `No ${filter} builds`}</h3></div>`;
  icons();
}

function mergeLogs(id, logs) {
  const entries = logCache.get(id) || new Map();
  for (const entry of logs) entries.set(entry.sequence, entry);
  const sequences = [...entries.keys()].sort((first, second) => first - second);
  for (const sequence of sequences.slice(0, Math.max(0, sequences.length - 400))) entries.delete(sequence);
  logCache.set(id, entries);
}

async function loadLogs(id) {
  try {
    const result = await api(`/api/builds/${id}/logs`);
    mergeLogs(id, result.logs);
    if (selectedId === id) renderLogs();
  } catch (error) { if (state.builds.some((build) => build.id === id)) toast(error.message, true); }
}

async function selectBuild(id) {
  selectedId = id;
  if (!logCache.has(id)) logCache.set(id, new Map());
  renderQueue();
  renderTerminalHeading();
  renderLogs();
  await loadLogs(id);
}

function renderTerminalHeading() {
  const build = selectedBuild();
  const running = build && activeStates.has(build.status);
  $('#terminal-status').textContent = build ? labels[build.status].toUpperCase() : 'STANDBY';
  $('#terminal-status').className = `build-status-badge ${build?.status || ''}`;
  $('#terminal-project').textContent = build ? build.name || build.project : 'No build selected';
  $('#terminal-project').title = build?.path || '';
  $('#terminal-id').textContent = build ? `#${build.id.slice(0, 8)}` : 'SESSION / --';
  $('#stop-button').hidden = !running && build?.status !== 'queued';
  $('#stop-button').disabled = !connected || build?.status === 'cancelling';
  $('#terminal-live').textContent = running ? 'Streaming output' : build ? labels[build.status] : 'Terminal ready';
  $('#terminal-live-dot').classList.toggle('offline', !running);
  $('#build-progress').classList.toggle('indeterminate', Boolean(running && build.progress == null));
  $('#build-progress').classList.toggle('failed', build?.status === 'failed');
  $('#progress-fill').style.width = build?.progress != null ? `${build.progress}%` : '0%';
  $('#elapsed').textContent = duration(build);
  $('#download-logs').disabled = !build;
}

function cleanOutput(text) {
  return text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r(?!\n)/g, '\n').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
}

function renderLogs() {
  const entries = [...(logCache.get(selectedId)?.values() || [])].sort((first, second) => first.sequence - second.sequence);
  const hasBuild = Boolean(selectedBuild());
  $('#terminal-empty').hidden = hasBuild;
  $('#log-lines').hidden = !hasBuild;
  const fragment = document.createDocumentFragment();
  for (const entry of entries) {
    const span = document.createElement('span');
    span.className = `log-${entry.stream}`;
    span.textContent = cleanOutput(entry.text);
    fragment.append(span);
  }
  $('#log-lines').replaceChildren(fragment);
  const text = entries.map((entry) => entry.text).join('');
  $('#line-count').textContent = `${text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0} lines`;
  if (follow) $('#terminal-output').scrollTop = $('#terminal-output').scrollHeight;
}

async function updatePath(target) {
  const request = ++pathRequest;
  const result = await api('/api/project', 'PUT', { path: target });
  if (request === pathRequest) {
    const changed = projectPath !== result.path || !config;
    projectPath = result.path;
    $('#project-path').value = projectPath;
    $('#project-path').title = projectPath;
    $('#project-name').textContent = fileName(projectPath);
    try { sessionStorage.setItem('compilez-project-path', projectPath); } catch {}
    if (changed) void loadConfig(projectPath);
  }
  return result.path;
}

$('#project-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!connected || submitting) return;
  const name = $('#build-name').value.trim();
  if (!name) { $('#build-name').setCustomValidity('Enter a build name'); $('#build-name').reportValidity(); return; }
  const target = $('#project-path').value.trim();
  submitting = true;
  $('#compile-button').disabled = true;
  try {
    const directory = await updatePath(target);
    const build = await api('/api/builds', 'POST', { path: directory, name });
    await selectBuild(build.id);
    toast('Build added to the queue');
  } catch (error) { toast(error.message, true); }
  finally { submitting = false; $('#compile-button').disabled = !connected; }
});
$('#build-name').addEventListener('input', () => $('#build-name').setCustomValidity(''));
$('#project-path').addEventListener('change', async () => {
  try { await updatePath($('#project-path').value.trim()); }
  catch (error) { toast(error.message, true); $('#project-path').value = projectPath; }
});

async function cancelBuild(id) {
  try { await api(`/api/builds/${id}/cancel`, 'POST'); toast('Cancellation requested'); }
  catch (error) { toast(error.message, true); }
}
$('#stop-button').addEventListener('click', () => { if (selectedId) void cancelBuild(selectedId); });
$('#queue-list').addEventListener('click', (event) => {
  const remove = event.target.closest('[data-delete]');
  const cancel = event.target.closest('[data-cancel]');
  const build = event.target.closest('[data-build]');
  if (remove) {
    deleteId = remove.dataset.delete;
    const target = state.builds.find((item) => item.id === deleteId);
    $('#delete-build-name').textContent = target?.name || target?.project || '';
    $('#delete-modal').showModal();
  } else if (cancel) void cancelBuild(cancel.dataset.cancel);
  else if (build) void selectBuild(build.dataset.build);
});
$('#close-delete').addEventListener('click', () => $('#delete-modal').close());
$('#cancel-delete').addEventListener('click', () => $('#delete-modal').close());
$('#confirm-delete').addEventListener('click', async () => {
  if (!deleteId || !connected) return;
  $('#confirm-delete').disabled = true;
  try {
    await api(`/api/builds/${deleteId}`, 'DELETE');
    $('#delete-modal').close();
    toast('Build deleted');
  } catch (error) { toast(error.message, true); }
  finally { $('#confirm-delete').disabled = !connected; }
});

function switchView(view) {
  $$('[data-view]').forEach((tab) => {
    const selected = tab.dataset.view === view;
    tab.classList.toggle('selected', selected);
    tab.setAttribute('aria-selected', selected);
    tab.tabIndex = selected ? 0 : -1;
  });
  $('#compile-view').hidden = view !== 'compile';
  $('#stats-view').hidden = view !== 'stats';
}
$$('[data-view]').forEach((tab) => {
  tab.addEventListener('click', () => switchView(tab.dataset.view));
  tab.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const view = event.key === 'Home' ? 'compile' : event.key === 'End' ? 'stats' : tab.dataset.view === 'compile' ? 'stats' : 'compile';
    switchView(view);
    $(`#${view}-tab`).focus();
  });
});
$$('[data-filter]').forEach((button) => button.addEventListener('click', () => {
  filter = button.dataset.filter;
  $$('[data-filter]').forEach((tab) => { tab.classList.toggle('selected', tab === button); tab.setAttribute('aria-pressed', tab === button); });
  renderQueue();
}));
$('#wrap-button').addEventListener('click', () => {
  const enabled = $('#log-lines').classList.toggle('wrapped');
  $('#wrap-button').classList.toggle('active', enabled);
  $('#wrap-button').setAttribute('aria-pressed', enabled);
});
$('#follow-button').addEventListener('click', () => {
  follow = !follow;
  $('#follow-button').classList.toggle('active', follow);
  $('#follow-button').setAttribute('aria-pressed', follow);
  if (follow) $('#terminal-output').scrollTop = $('#terminal-output').scrollHeight;
});
$('#download-logs').addEventListener('click', () => {
  if (!selectedId) return;
  const logs = [...(logCache.get(selectedId)?.values() || [])].sort((first, second) => first.sequence - second.sequence).map((entry) => cleanOutput(entry.text)).join('');
  const url = URL.createObjectURL(new Blob([logs], { type: 'text/plain' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `compilez-${selectedId.slice(0, 8)}.log`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

async function browse(target) {
  const request = ++browseRequest;
  directory = null;
  $('#select-directory').disabled = true;
  $('#directory-list').innerHTML = '<div class="directory-message">Reading server filesystem...</div>';
  try {
    const result = await api(`/api/directories?path=${encodeURIComponent(target)}`);
    if (request !== browseRequest) return;
    directory = result;
    $('#directory-path').value = directory.path;
    $('#directory-up').disabled = !directory.parent;
    $('#select-directory').disabled = false;
    $('#root-buttons').innerHTML = directory.roots.map((root) => `<button class="root-button ${directory.path === root ? 'selected' : ''}" data-root="${escapeHtml(root)}"><i data-lucide="hard-drive"></i>${escapeHtml(root)}</button>`).join('');
    $('#directory-list').innerHTML = directory.folders.length ? directory.folders.map((folder) => `<button class="directory-entry" data-directory="${escapeHtml(folder.path)}"><i data-lucide="folder"></i><span>${escapeHtml(folder.name)}</span><i data-lucide="chevron-right"></i></button>`).join('') : '<div class="directory-message"><i data-lucide="folder-open"></i>No subdirectories</div>';
    $('#directory-count').textContent = `${directory.folders.length} directories`;
    icons();
  } catch (error) {
    if (request !== browseRequest) return;
    $('#directory-list').replaceChildren(Object.assign(document.createElement('div'), { className: 'directory-message', textContent: error.message }));
    toast(error.message, true);
  }
}
function openBrowser() {
  $('#directory-modal').showModal();
  void browse(projectPath);
}
$('#browse-button').addEventListener('click', openBrowser);
$('#close-browser').addEventListener('click', () => $('#directory-modal').close());
$('#directory-form').addEventListener('submit', (event) => { event.preventDefault(); void browse($('#directory-path').value.trim()); });
$('#directory-up').addEventListener('click', () => { if (directory?.parent) void browse(directory.parent); });
$('#root-buttons').addEventListener('click', (event) => { const button = event.target.closest('[data-root]'); if (button) void browse(button.dataset.root); });
$('#directory-list').addEventListener('click', (event) => { const button = event.target.closest('[data-directory]'); if (button) void browse(button.dataset.directory); });
$('#select-directory').addEventListener('click', async () => {
  if (!directory) return;
  $('#select-directory').disabled = true;
  try { await updatePath(directory.path); $('#directory-modal').close(); toast('Project directory selected'); }
  catch (error) { toast(error.message, true); }
  finally { $('#select-directory').disabled = false; }
});
$('#server-button').addEventListener('click', () => {
  const details = { Hostname: state.stats.hostname || '--', 'Build workers': state.maxConcurrent, 'Browse roots': state.roots.join(', '), 'Telemetry interval': '2 seconds', 'Build engines': 'PlatformIO / compile.sh', 'History retention': '50 builds / 400 log chunks per build' };
  $('#server-details').innerHTML = Object.entries(details).map(([key, value]) => `<div><dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('');
  $('#server-modal').showModal();
});
$('#close-server').addEventListener('click', () => $('#server-modal').close());

function renderConfigControls() {
  const dirty = Boolean(config && $('#config-content').value !== config.content);
  $('#save-config').disabled = !connected || !config || savingConfig || Boolean(configError);
  $('#reload-config').disabled = !connected || savingConfig;
  $('#config-content').disabled = !config || savingConfig;
  $('#config-status').textContent = configError || (savingConfig ? 'Writing to disk...' : !config ? 'Reading platformio.ini...' : dirty ? 'Unsaved changes' : config.exists ? 'File saved / synced' : 'File not found / new config');
  $('#config-status').classList.toggle('unsaved', dirty);
  $('#config-status').classList.toggle('error', Boolean(configError));
}

function applyConfig(next) {
  if (next.path !== projectPath || (config && next.version < config.version)) return;
  config = next;
  configError = '';
  $('#config-content').value = next.content;
  $('#config-path').textContent = `${next.path}/platformio.ini`;
  renderConfigControls();
}

async function loadConfig(target) {
  const request = ++configLoadId;
  if (config && $('#config-content').value !== config.content) toast('Unsaved config edits replaced by the selected project file');
  config = null;
  configError = '';
  $('#config-content').value = '';
  $('#config-path').textContent = `${target}/platformio.ini`;
  renderConfigControls();
  try {
    const next = await api(`/api/config?path=${encodeURIComponent(target)}`);
    if (request === configLoadId && target === projectPath) applyConfig(next);
  } catch (error) {
    if (request !== configLoadId) return;
    configError = error.message;
    renderConfigControls();
    toast(error.message, true);
  }
}

$('#config-content').addEventListener('input', renderConfigControls);
$('#reload-config').addEventListener('click', () => {
  if (config && $('#config-content').value !== config.content && !window.confirm('Discard unsaved config changes and reload from disk?')) return;
  void loadConfig(projectPath);
});
$('#save-config').addEventListener('click', async () => {
  if (!config || savingConfig || !connected) return;
  const target = config.path;
  const content = $('#config-content').value;
  const revision = config.revision;
  savingConfig = true;
  renderConfigControls();
  try {
    const saved = await api('/api/config', 'PUT', { path: target, content, revision });
    applyConfig(saved);
    toast('File saved!');
  } catch (error) { toast(error.message, true); }
  finally { savingConfig = false; renderConfigControls(); }
});
$$('dialog').forEach((dialog) => dialog.addEventListener('click', (event) => { if (event.target === dialog) { const bounds = dialog.getBoundingClientRect(); if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close(); } }));
setInterval(() => {
  $('#elapsed').textContent = duration(selectedBuild());
  $$('[data-duration]').forEach((element) => { const build = state.builds.find((item) => item.id === element.dataset.duration); element.textContent = duration(build); });
}, 1000);
icons();
setConnection(false);