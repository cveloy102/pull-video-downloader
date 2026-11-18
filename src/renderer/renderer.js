'use strict';

const ICONS = {
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v4h16v-4"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a18 18 0 0 1 0 18 18 18 0 0 1 0-18Z"/>',
  record: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3"/>',
  history: '<path d="M3 5v5h5M3.5 10a8.5 8.5 0 1 1 1.2 7M12 7v5l3 2"/>',
  settings: '<path d="m9 3-.6 2.3-2 .9L4.2 6 2 10l1.8 1.5v2L2 15l2.2 4 2.2-.2 2 .9L9 22h5l.6-2.3 2-.9 2.2.2 2.2-4-1.8-1.5v-2L21 10l-2.2-4-2.2.2-2-.9L14 3Z" transform="translate(.5 -1) scale(.95)"/><circle cx="12" cy="12" r="3"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
  moon: '<path d="M20 14.5A8.8 8.8 0 0 1 9.5 4 8.8 8.8 0 1 0 20 14.5Z"/>',
  'arrow-down-right': '<path d="M5 5l14 14M5 19h14V5"/>',
  'arrow-right': '<path d="M4 12h15m-6-6 6 6-6 6"/>',
  'arrow-left': '<path d="M20 12H5m6-6-6 6 6 6"/>',
  'arrow-up-right': '<path d="M5 19 19 5M5 5h14v14"/>',
  link: '<path d="m10 14 4-4M9 16l-2 2a4.2 4.2 0 0 1-6-6l5-5a4.2 4.2 0 0 1 6 0m0 10a4.2 4.2 0 0 0 6 0l5-5a4.2 4.2 0 0 0-6-6l-2 2" transform="translate(2 0) scale(.85)"/>',
  clipboard: '<path d="M9 5H6a2 2 0 0 0-2 2v13h16V7a2 2 0 0 0-2-2h-3M9 3h6v4H9Z"/>',
  folder: '<path d="M3 7V4h6l3 3h9v13H3Zm0 0h18"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v.1"/>',
  refresh: '<path d="M20 4v6h-6M4 20v-6h6M4.4 8a8 8 0 0 1 13-4L20 7M4 17l2.6 3A8 8 0 0 0 19.6 16"/>',
  trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>',
  radar: '<circle cx="12" cy="12" r="9"/><path d="M12 3v9l6.5 6.5M16 8a5.7 5.7 0 1 0 1 7"/><circle cx="9" cy="14" r="1"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  play: '<path d="m8 5 11 7-11 7Z"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3m6 0h4"/>',
  layers: '<path d="m12 3 10 5-10 5L2 8Zm-9 10 9 5 9-5M3 18l9 5 9-5" transform="translate(0 -1)"/>',
};

const $ = (id) => document.getElementById(id);
const api = window.pull;
const ui = { route: 'downloads', filter: 'all', analysis: null, analysisUrl: '', audioOnly: false, analysisToken: 0, modal: false, captureSources: [], selectedSource: null, recorder: null, captureStream: null, recordingId: null, recordingStarted: 0, recordingTimer: null, chunkWrites: Promise.resolve(), recordingError: null, lastRecordingId: null, lastRecordingPath: null, captureBusy: false, lastCandidates: '', resumeJob: null, resumedIds: new Set(), downloadedIds: new Set(), autoTried: new Set(), browserReason: '', lastJobs: '', lastBounds: '', closeRequested: false, finishPromise: null };
let state = { settings: { theme: 'light', closeToTray: true, launchAtLogin: false, directory: '', quality: 'best', concurrency: 2 }, jobs: [], recordings: [], candidates: [], browser: {}, tools: {} };
const ACTIVE = new Set(['queued', 'analyzing', 'downloading', 'merging', 'processing', 'starting']);

function icon(name) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  node.setAttribute('viewBox', '0 0 24 24'); node.setAttribute('aria-hidden', 'true');
  node.innerHTML = ICONS[name] || ICONS.download;
  return node;
}
function el(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; }
function mountIcons(root = document) { root.querySelectorAll('[data-icon]').forEach(node => node.replaceChildren(icon(node.dataset.icon))); }
function buttonIcon(name, title, handler, extra = '') { const button = el('button', `icon-button ${extra}`); button.type = 'button'; button.title = title; button.setAttribute('aria-label', title); button.append(icon(name)); button.addEventListener('click', () => runAction(handler, button)); return button; }
function errorMessage(error) { return String(error?.message || error || 'Неизвестная ошибка').replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '').replace(/^Error:\s*/, ''); }
function toast(message, isError = false) { const item = el('div', `toast${isError ? ' error' : ''}`, String(message)); $('toasts').append(item); setTimeout(() => item.remove(), isError ? 8500 : 4500); }
async function runAction(action, button) { if (button) button.disabled = true; try { return await action(); } catch (error) { toast(errorMessage(error), true); } finally { if (button?.isConnected) button.disabled = false; } }
function call(name, ...args) { if (!api || typeof api[name] !== 'function') return Promise.reject(new Error(`Функция «${name}» недоступна. Открой PULL как приложение.`)); return api[name](...args); }
function hostOf(url) { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return 'Видео'; } }
function cleanUrl(value) { const input = String(value || '').trim(); const url = new URL(/^[a-z][a-z\d+.-]*:/i.test(input) ? input : `https://${input}`); if (!['https:', 'http:'].includes(url.protocol)) throw new Error('Вставь ссылку, которая начинается с https:// или http://'); return url.href; }
function seconds(value) { const number = Number(value); if (!Number.isFinite(number) || number < 0) return ''; const secs = Math.floor(number); const h = Math.floor(secs / 3600); const m = Math.floor((secs % 3600) / 60); const s = String(secs % 60).padStart(2, '0'); return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`; }
function bytes(value) { const n = Number(value); if (!Number.isFinite(n) || n <= 0) return ''; const units = ['Б', 'КБ', 'МБ', 'ГБ']; const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), 3); return `${(n / 1024 ** i).toFixed(i < 2 ? 0 : 1)} ${units[i]}`; }
function percent(value) { const n = Number(value); return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0; }
function speedLabel(value) { return typeof value === 'number' ? (bytes(value) ? `${bytes(value)}/с` : '') : String(value || ''); }
function imageFor(url) { if (typeof url !== 'string' || !/^(https?:|data:image\/)/i.test(url)) return null; const image = el('img'); image.src = url; image.alt = ''; image.referrerPolicy = 'no-referrer'; image.addEventListener('error', () => image.replaceWith(icon('play')), { once: true }); return image; }
function isRecording() { return ui.recorder && ui.recorder.state !== 'inactive'; }

function navigate(route) {
  if (!$(`page-${route}`)) route = 'downloads';
  ui.route = route;
  document.querySelectorAll('.page').forEach(page => page.classList.toggle('active', page.id === `page-${route}`));
  document.querySelectorAll('.rail [data-route]').forEach(button => button.classList.toggle('active', button.dataset.route === route));
  $('titlebarPage').textContent = ({ downloads: 'Загрузки', browser: 'Браузер', recording: 'Запись экрана', history: 'История', settings: 'Настройки' })[route];
  requestAnimationFrame(syncBrowserBounds);
}
async function syncBrowserBounds() {
  const rect = $('browserSlot').getBoundingClientRect();
  const bounds = { x: Math.round(rect.x + 1), y: Math.round(rect.y + 1), width: Math.max(0, Math.floor(rect.width - 2)), height: Math.max(0, Math.floor(rect.height - 2)), visible: ui.route === 'browser' && !ui.modal && !document.hidden && rect.width > 0 && rect.height > 0 };
  const key = JSON.stringify(bounds); if (key === ui.lastBounds) return; ui.lastBounds = key;
  try { await call('setBrowserBounds', bounds); } catch { /* Main process may still be starting. */ }
}
const systemDark = window.matchMedia('(prefers-color-scheme: dark)');
function resolvedTheme() { const theme = state.settings?.theme || 'light'; return theme === 'system' ? (systemDark.matches ? 'dark' : 'light') : theme; }
function applyTheme() {
  const theme = state.settings?.theme || 'light'; const resolved = resolvedTheme();
  document.documentElement.dataset.theme = resolved;
  for (const [id, value] of [['themeSystem', 'system'], ['themeLight', 'light'], ['themeDark', 'dark']]) $(id).classList.toggle('selected', theme === value);
  $('quickTheme').replaceChildren(icon(resolved === 'light' ? 'moon' : 'sun'));
  $('quickTheme').title = resolved === 'light' ? 'Тёмная тема' : 'Светлая тема';
}
const QUALITY_LABELS = { best: 'Лучшее', 4320: '8K', 2160: 'До 4K', 1440: 'До 1440p', 1080: 'До 1080p', 720: 'До 720p', 480: 'До 480p' };
async function saveSettings(patch) { await call('updateSettings', patch); state.settings = { ...state.settings, ...patch }; renderSettings(); }
let reportedUpdateVersion = '';
function renderUpdate() {
  const update = state.update || {}; const version = state.version || '';
  $('appVersion').textContent = version ? 'v' + version : '';
  const text = {
    disabled: 'Обновления работают в установленной версии',
    idle: 'Проверю обновления в фоне',
    checking: 'Проверяю обновления…',
    latest: update.appliedVersion ? 'Обновлено до ' + update.appliedVersion : 'Установлена последняя версия',
    unavailable: 'Файл обновления пока недоступен',
    downloading: 'Загружаю версию ' + update.version + (update.percent ? ' · ' + update.percent + '%' : '') + '…',
    ready: update.error || 'Версия ' + update.version + ' готова к установке',
    installing: 'Устанавливаю версию ' + update.version + '…',
    error: update.error || 'Не удалось проверить обновления'
  }[update.status] || '';
  $('updateStatus').textContent = text;
  $('checkUpdates').hidden = ['ready', 'installing'].includes(update.status);
  $('checkUpdates').disabled = ['checking', 'downloading', 'disabled'].includes(update.status);
  $('installUpdate').hidden = !['ready', 'installing'].includes(update.status);
  $('installUpdate').disabled = update.status === 'installing';
  $('installUpdate').textContent = update.status === 'installing' ? 'Обновление…' : 'Перезапустить и обновить';
  const pill = $('footerUpdate');
  const active = ['downloading', 'ready', 'installing'].includes(update.status);
  pill.hidden = !active;
  pill.dataset.status = update.status || '';
  pill.disabled = update.status !== 'ready';
  if (update.status === 'ready') pill.textContent = 'Обновить до ' + update.version;
  else if (update.status === 'installing') pill.textContent = 'Устанавливаю обновление…';
  else pill.textContent = 'Загружаю обновление ' + (update.percent || 0) + '%';
  const applied = $('updateApplied');
  applied.hidden = active || !update.appliedVersion;
  applied.textContent = update.appliedVersion ? '✓ Обновлено до ' + update.appliedVersion : '';
  if (update.appliedVersion && reportedUpdateVersion !== update.appliedVersion) {
    reportedUpdateVersion = update.appliedVersion;
    toast('PULL обновлён до версии ' + update.appliedVersion);
  }
}
function renderSettings() {
  const settings = state.settings || {}; const directory = settings.directory || 'Выбери папку в настройках';
  $('downloadDirectory').textContent = directory; $('changeFolderInline').title = `Изменить папку: ${directory}`; $('settingsDirectory').textContent = directory; $('settingsDirectory').title = directory;
  $('chipQuality').textContent = QUALITY_LABELS[settings.quality] || 'Лучшее'; $('chipConcurrency').textContent = String(settings.concurrency || 2);
  $('closeToTray').checked = settings.closeToTray !== false; $('launchAtLogin').checked = settings.launchAtLogin === true; $('autoDownloadFound').checked = settings.autoDownloadFound === true;
  if (document.activeElement !== $('defaultQuality')) $('defaultQuality').value = String(settings.quality || 'best');
  if (document.activeElement !== $('concurrency')) $('concurrency').value = String(settings.concurrency || 2);
  const ready = state.tools?.ready;
  $('engineLight').className = `status-light${ready ? ' ready' : state.tools?.error ? ' error' : ''}`;
  $('engineLabel').textContent = ready ? 'Движок готов' : state.tools?.error ? 'Нужна настройка' : 'Подготовка движка';
  renderUpdate();
  // Test builds show their version next to the signature so they are easy to tell apart.
  if (state.version) document.querySelector('.signature').textContent = /-/.test(state.version) ? `v${state.version} · by Cveloy` : 'by Cveloy';
  $('engineDetail').textContent = ready ? 'yt-dlp · FFmpeg' : state.tools?.error ? 'Подробнее в настройках' : 'Проверяем компоненты';
  $('engineBanner').hidden = !state.tools?.error; $('engineBannerText').textContent = state.tools?.error || '';
  $('ytDlpStatus').textContent = state.tools?.ytDlp ? 'Готов к работе' : state.tools?.error || 'Проверка…';
  $('ffmpegStatus').textContent = state.tools?.ffmpeg ? 'Готов к работе' : state.tools?.error || 'Проверка…';
  $('extensionToken').value = state.extension?.token || '';
  $('copyExtensionToken').disabled = !state.extension?.token;
  $('openExtensionFolder').disabled = !state.extension?.path;
  $('extensionStatus').textContent = state.extension?.available ? `Сервис подключения готов · 127.0.0.1:${state.extension.port || 17841}` : state.extension?.error || 'Подготовка сервиса подключения…';
  applyTheme();
}

function timeLabel(value) { const date = new Date(value); if (Number.isNaN(date.getTime())) return ''; const today = new Date().toDateString() === date.toDateString(); return today ? date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }); }
function jobProgress(job) {
  const pct = Math.round(percent(job.progress));
  switch (job.status) {
    case 'downloading': return { tone: 'run', bar: '', width: pct, text: [`${pct}%`, speedLabel(job.speed), job.eta ? (typeof job.eta === 'number' ? seconds(job.eta) : job.eta) : ''].filter(Boolean).join(' · ') };
    case 'merging': case 'processing': return { tone: 'merge', bar: 'merge', width: 100, text: 'склейка видео и звука' };
    case 'queued': return { tone: '', bar: 'pause', width: 0, text: 'в очереди' };
    case 'analyzing': case 'starting': return { tone: 'run', bar: 'indeterminate', width: 35, text: 'подготовка' };
    case 'paused': return { tone: '', bar: 'pause', width: pct, text: `${pct}% · пауза` };
    case 'completed': return { tone: 'ok', bar: 'ok', width: 100, text: job.filename ? job.filename.split(/[\\/]/).pop() : 'готово' };
    case 'error': return { tone: 'error', bar: 'error', width: pct, text: 'ошибка' };
    default: return { tone: '', bar: 'pause', width: pct, text: 'отменено' };
  }
}
// Rows are created once per download and then updated in place. Rebuilding
// them on every progress tick made hovered rows flicker and swallowed clicks
// (the button under the cursor was replaced between mousedown and mouseup).
function setText(node, value) { if (node.textContent !== value) node.textContent = value; }
function jobCard(job) {
  const row = el('article', 'job-row');
  const dot = el('span', 'dot'); const title = el('h3', 'job-title'); const sub = el('p', 'job-sub');
  const text = el('div'); text.append(title, sub);
  const name = el('div', 'job-name'); name.append(dot, text);
  const format = el('span', 'job-format');
  const bar = el('i'); const track = el('div', 'track'); track.append(bar);
  const progressText = el('span'); const progressCell = el('div', 'job-progress'); progressCell.append(track, progressText);
  const actions = el('div', 'job-actions'); const error = el('p', 'job-error'); error.hidden = true;
  row.append(name, format, progressCell, actions, error);
  row._refs = { dot, title, sub, format, bar, progressText, actions, error };
  updateJobCard(row, job);
  return row;
}
function jobActions(job) {
  const buttons = [];
  // Streams that need their page again get one clear action instead of a failing "continue".
  const reopen = job.pageUrl && (job.needsSource || job.errorCode === 'SOURCE_EXPIRED');
  if (reopen) buttons.push(buttonIcon('globe', 'Открыть источник', () => openSource(job)));
  if (job.status === 'completed') buttons.push(buttonIcon('play', 'Открыть видео', () => call('openFile', job.id)), buttonIcon('folder', 'Показать в папке', () => call('showFile', job.id)));
  else if (['paused', 'error', 'cancelled', 'canceled'].includes(job.status) && !job.needsSource) buttons.push(buttonIcon('play', job.status === 'paused' ? 'Продолжить' : 'Повторить загрузку', () => call('resumeDownload', job.id)));
  else if (['queued', 'downloading', 'analyzing', 'starting'].includes(job.status)) buttons.push(buttonIcon('pause', 'Приостановить', () => call('pauseDownload', job.id)));
  if (ACTIVE.has(job.status) || job.status === 'paused') buttons.push(buttonIcon('close', 'Отменить загрузку', () => call('cancelDownload', job.id), 'danger'));
  else buttons.push(buttonIcon('trash', 'Удалить из списка, сохранив файл', () => call('removeDownload', job.id), 'danger'));
  return buttons;
}
function updateJobCard(row, job) {
  const r = row._refs; const progress = jobProgress(job);
  const dotClass = 'dot ' + progress.tone; if (r.dot.className !== dotClass) r.dot.className = dotClass;
  setText(r.title, job.title || hostOf(job.url)); r.title.title = job.title || job.url || 'Видео';
  const sub = [hostOf(job.url)]; if (job.status === 'completed' && job.completedAt) sub.push(timeLabel(job.completedAt)); if (job.directory && job.status === 'completed') sub.push(job.directory);
  setText(r.sub, sub.filter(Boolean).join(' · '));
  const quality = job.audioOnly ? 'Аудио' : QUALITY_LABELS[job.quality] || (job.quality ? job.quality + 'p' : 'Лучшее');
  setText(r.format, [quality, bytes(job.totalBytes)].filter(Boolean).join(' · '));
  if (r.bar.className !== progress.bar) r.bar.className = progress.bar;
  const width = progress.width + '%'; if (r.bar.style.width !== width) r.bar.style.width = width;
  setText(r.progressText, progress.text); r.progressText.title = progress.text;
  // Buttons change only with the status, not with every progress update.
  const actionsKey = [job.status, Boolean(job.needsSource), job.errorCode || '', Boolean(job.pageUrl)].join('|');
  if (row.dataset.actions !== actionsKey) { row.dataset.actions = actionsKey; r.actions.replaceChildren(...jobActions(job)); }
  setText(r.error, job.error || ''); r.error.hidden = !job.error;
}
function recordingCard(recording) {
  const row = el('article', 'job-row'); const name = el('div', 'job-name'); const text = el('div');
  const title = el('h3', 'job-title', recording.title || 'Запись экрана'); title.title = recording.path || '';
  text.append(title, el('p', 'job-sub', ['Запись экрана', recording.date ? timeLabel(recording.date) : ''].filter(Boolean).join(' · ')));
  name.append(el('span', 'dot ' + (recording.status === 'partial' ? 'error' : 'ok')), text);
  const progressCell = el('div', 'job-progress'); const track = el('div', 'track'); const bar = el('i', recording.status === 'partial' ? 'error' : 'ok'); bar.style.width = '100%'; track.append(bar);
  const file = String(recording.path || '').split(/[\\/]/).pop(); const fileText = el('span', '', recording.status === 'partial' ? 'частично · ' + file : file); fileText.title = recording.path || ''; progressCell.append(track, fileText);
  const actions = el('div', 'job-actions'); actions.append(buttonIcon('play', 'Открыть запись', () => call('openRecording', recording.id)), buttonIcon('folder', 'Показать в папке', () => call('showRecording', recording.id)));
  row.append(name, el('span', 'job-format', ['WebM', bytes(recording.bytes)].filter(Boolean).join(' · ')), progressCell, actions); return row;
}
// Keeps one DOM node per key, updates it, and only moves nodes whose position changed.
function reconcile(container, items, extra = []) {
  const cache = container._nodes || (container._nodes = new Map());
  const wanted = [];
  const seen = new Set();
  for (const { key, create, update } of items) {
    let node = cache.get(key);
    if (node) update?.(node); else { node = create(); cache.set(key, node); }
    seen.add(key); wanted.push(node);
  }
  for (const [key, node] of cache) if (!seen.has(key)) { node.remove(); cache.delete(key); }
  wanted.push(...extra);
  wanted.forEach((node, index) => { if (container.children[index] !== node) container.insertBefore(node, container.children[index] || null); });
  while (container.children.length > wanted.length) container.lastElementChild.remove();
}
function summaryText(jobs) {
  const active = jobs.filter(job => ACTIVE.has(job.status));
  if (!active.length) { const paused = jobs.filter(job => job.status === 'paused').length; return paused ? `На паузе: ${paused}` : 'Нет активных загрузок'; }
  const speed = active.reduce((sum, job) => sum + (Number(job.speed) || 0), 0);
  const word = active.length === 1 ? 'активная' : active.length < 5 ? 'активные' : 'активных';
  return [`${active.length} ${word}`, speed ? `${bytes(speed)}/с` : ''].filter(Boolean).join(' · ');
}
function renderJobs() {
  const jobs = Array.isArray(state.jobs) ? state.jobs : [];
  const activeCount = jobs.filter(job => ACTIVE.has(job.status)).length;
  $('navCount').textContent = String(activeCount); $('navCount').hidden = activeCount === 0; $('downloadsSummary').textContent = summaryText(jobs);
  const queue = jobs.filter(job => job.status !== 'completed');
  const filtered = queue.filter(job => ui.filter === 'active' ? ACTIVE.has(job.status) : ui.filter === 'paused' ? job.status === 'paused' : true);
  $('queueCount').textContent = String(queue.length); $('queueEmpty').hidden = queue.length !== 0;
  const asItem = job => ({ key: job.id, create: () => jobCard(job), update: node => updateJobCard(node, job) });
  const empty = queue.length && !filtered.length ? [ui.emptyFilter || (ui.emptyFilter = el('div', 'empty-filter'))] : [];
  if (empty.length) setText(empty[0], ui.filter === 'paused' ? 'Нет загрузок на паузе' : 'Нет активных загрузок');
  reconcile($('jobsList'), filtered.map(asItem), empty);
  const history = jobs.filter(job => job.status === 'completed'); const recordings = Array.isArray(state.recordings) ? state.recordings : [];
  reconcile($('historyList'), [...history.map(asItem), ...recordings.map(recording => ({ key: 'rec:' + recording.id + ':' + recording.status + ':' + recording.bytes, create: () => recordingCard(recording) }))]);
  $('historyEmpty').hidden = history.length + recordings.length !== 0; $('historyCount').textContent = 'Сохранено: ' + (history.length + recordings.length);
}
const KIND_LABELS = { hls: 'Поток', dash: 'Поток', mss: 'Поток', video: 'Видео', audio: 'Звук' };
function mediaMeta(candidate) {
  return [seconds(candidate.duration), candidate.height ? 'до ' + candidate.height + 'p' : '', candidate.host || hostOf(candidate.url)].filter(Boolean).join(' · ');
}
async function downloadFound(candidate, quality = 'best', automatic = false) {
  const audioOnly = quality === 'audio';
  await call('downloadCandidate', { id: candidate.id, quality: audioOnly ? 'best' : quality, audioOnly });
  ui.downloadedIds.add(candidate.id);
  renderBrowser(true);
  toast(automatic ? 'Видео найдено и добавлено в загрузки' : 'Видео добавлено в загрузки');
}
async function openSource(job) {
  ui.browserReason = '';
  await openBrowser(job.pageUrl, { id: job.id, title: job.title, duration: job.duration, pageId: null, busy: false });
}
async function continueWith(candidate) {
  const job = ui.resumeJob;
  if (!job || job.busy || job.pageId !== state.browser?.pageId) return;
  job.busy = true;
  renderBrowser();
  try {
    await call('reattachCandidate', { jobId: job.id, candidateId: candidate.id, pageId: job.pageId });
    if (ui.resumeJob === job) ui.resumeJob = null;
    ui.downloadedIds.add(candidate.id); ui.resumedIds.add(candidate.id);
    toast('Загрузка «' + job.title + '» продолжена');
  } finally {
    job.busy = false;
    renderBrowser();
  }
}
function setMediaBar(stateName, title, meta, iconName) {
  $('mediaBar').dataset.state = stateName;
  $('mediaBarTitle').textContent = title; $('mediaBarMeta').textContent = meta;
  $('mediaBarIcon').replaceChildren(icon(iconName));
}
function renderBrowser(force = false) {
  const browser = state.browser || {};
  if (document.activeElement !== $('browserUrl')) $('browserUrl').value = browser.url && browser.url !== 'about:blank' ? browser.url : '';
  $('browserBack').disabled = !browser.canGoBack; $('browserForward').disabled = !browser.canGoForward;
  $('browserReload').classList.toggle('busy', Boolean(browser.loading));
  const resuming = ui.resumeJob;
  const sourceReady = resuming && resuming.pageId === browser.pageId && !browser.loading && !browser.error;
  const candidates = (state.candidates || []).filter(candidate => !resuming || (
    sourceReady && candidate.source === 'browser' && candidate.probeStatus === 'ready' && candidate.kind !== 'audio' && !candidate.ad
  ));
  const media = state.media || {};
  const best = candidates.find(candidate => candidate.id === media.best) || (resuming ? candidates[0] : null);
  const others = candidates.filter(candidate => candidate !== best);
  $('mediaDot').hidden = !best;
  const key = JSON.stringify([candidates, media, ui.browserReason, [...ui.downloadedIds], state.settings?.autoDownloadFound, resuming, browser.pageId, browser.loading, browser.error]);
  if (!force && key === ui.lastCandidates) return; ui.lastCandidates = key;

  // One card: hint, then checking, then found (or added). Everything else lives under "other options".
  const added = Boolean(best && ui.downloadedIds.has(best.id));
  if (resuming) {
    const original = ['Продолжить «' + resuming.title + '»', resuming.duration ? seconds(resuming.duration) : ''].filter(Boolean).join(' · ');
    let hint = 'Включите исходное видео, затем подтвердите найденный поток';
    if (browser.error) hint = browser.error;
    else if (resuming.pageId === null || browser.loading) hint = 'Открываю источник…';
    else if (resuming.pageId !== browser.pageId) hint = 'Страница изменилась. Откройте источник из очереди снова';
    else if (best) hint = 'Найдено: ' + [best.title, mediaMeta(best)].filter(Boolean).join(' · ');
    else if (media.probing) hint = 'Проверяю найденное видео…';
    setMediaBar('resume', original, hint, 'refresh');
  } else if (best) {
    const lowNote = media.confidence === 'low' ? ' · короткое видео' : '';
    if (added) setMediaBar('added', ui.resumedIds.has(best.id) ? 'Загрузка продолжена' : 'Видео добавлено в загрузки', best.title || browser.title || 'Видео', 'check');
    else setMediaBar('found', best.title || browser.title || 'Видео найдено', 'Видео найдено · ' + mediaMeta(best) + lowNote, 'play');
  } else if (media.probing) setMediaBar('probing', 'Проверяю найденное видео…', 'Отсеиваю рекламу и выбираю лучшее качество', 'radar');
  else if (candidates.length) setMediaBar('hint', 'Основное видео пока не найдено', 'Включите нужное видео. Если сначала идёт реклама, дождитесь её конца', 'play');
  else setMediaBar('hint', 'Включите видео на странице', ui.browserReason || 'PULL найдёт его сам и предложит скачать', 'play');
  $('mediaProbing').hidden = !media.probing || Boolean(best) || Boolean(resuming && !sourceReady);
  $('mediaDownload').hidden = !best || added || Boolean(resuming); $('mediaQuality').hidden = $('mediaDownload').hidden;
  $('mediaOpenDownloads').hidden = !added || Boolean(resuming);
  $('mediaResume').hidden = !resuming || !best; $('mediaResume').disabled = Boolean(resuming?.busy);
  $('mediaResume').onclick = resuming && best ? () => runAction(() => continueWith(best)) : null;
  $('cancelSource').hidden = !resuming; $('cancelSource').disabled = Boolean(resuming?.busy);
  $('mediaOthers').hidden = others.length === 0; $('mediaOthers').textContent = 'Другие варианты (' + others.length + ')';
  if (!others.length) $('mediaPanel').hidden = true;

  if (best && !added && !resuming && media.confidence === 'high' && state.settings?.autoDownloadFound && !ui.autoTried.has(best.id)) {
    ui.autoTried.add(best.id);
    runAction(() => downloadFound(best, state.settings?.quality || 'best', true));
  }

  $('candidateList').replaceChildren(...others.map(candidate => {
    const card = el('article', 'candidate-card'); const top = el('div', 'candidate-top');
    top.append(el('span', 'candidate-kind', KIND_LABELS[candidate.kind] || 'Видео'), el('span', 'candidate-host', mediaMeta(candidate) || candidate.host));
    const title = el('h3', 'candidate-title', candidate.title || 'Видео'); title.title = candidate.url || '';
    const notes = [candidate.ad ? 'похоже на рекламу' : '', candidate.short && !candidate.ad ? 'короткий ролик' : '', candidate.duplicate ? 'то же видео в другом качестве' : '', candidate.probeStatus === 'failed' ? 'не удалось проверить' : '', candidate.probeStatus === 'probing' ? 'проверяю…' : ''].filter(Boolean);
    const done = !resuming && ui.downloadedIds.has(candidate.id);
    const download = el('button', 'candidate-download'); download.append(icon(done ? 'check' : 'download'), document.createTextNode(resuming ? 'Продолжить этим видео' : done ? 'Добавлено' : 'Скачать'));
    download.disabled = done || Boolean(resuming?.busy);
    download.addEventListener('click', () => runAction(() => resuming ? continueWith(candidate) : downloadFound(candidate, state.settings?.quality || 'best'), download));
    card.append(top, title); if (notes.length) card.append(el('p', 'candidate-note', notes.join(' · '))); card.append(download); return card;
  }));
}
function applyState(next) { if (!next || typeof next !== 'object') return; state = { ...state, ...next, settings: { ...state.settings, ...(next.settings || {}) } }; renderSettings(); const jobsKey = JSON.stringify([state.jobs, state.recordings]); if (jobsKey !== ui.lastJobs) { ui.lastJobs = jobsKey; renderJobs(); } renderBrowser(); }

function showModal() { ui.modal = true; $('analysisOverlay').hidden = false; syncBrowserBounds(); $('closeAnalysis').focus(); }
function closeModal() { ui.modal = false; ui.analysisToken += 1; $('analysisOverlay').hidden = true; $('analyzeButton').disabled = false; syncBrowserBounds(); if (ui.route === 'downloads') $('videoUrl').focus(); }
function fillFormatOptions() {
  const formats = Array.isArray(ui.analysis?.formats) ? ui.analysis.formats : [];
  const select = $('formatSelect'); select.replaceChildren();
  const automatic = el('option', '', ui.audioOnly ? 'Лучшее доступное аудио' : 'Лучшее доступное качество'); automatic.value = ''; select.append(automatic);
  if (!ui.audioOnly) {
    for (const height of [2160, 1440, 1080, 720, 480]) { const option = el('option', '', `До ${height === 2160 ? '4K / 2160p' : `${height}p`}`); option.value = `quality:${height}`; select.append(option); }
  }
  const relevant = formats.filter(format => ui.audioOnly ? format.vcodec === 'none' || /audio|аудио/i.test(format.label || format.resolution || '') : format.vcodec !== 'none' && !/audio only/i.test(format.resolution || ''));
  if (relevant.length) {
    const group = el('optgroup'); group.label = 'Форматы источника';
    for (const format of relevant) { const size = bytes(format.filesize); const option = el('option', '', [format.label || format.resolution || format.id, size].filter(Boolean).join(' · ')); option.value = `format:${format.id}`; group.append(option); }
    select.append(group);
  }
  if (!ui.audioOnly && state.settings?.quality && state.settings.quality !== 'best') select.value = `quality:${state.settings.quality}`;
  $('formatVideo').classList.toggle('selected', !ui.audioOnly); $('formatAudio').classList.toggle('selected', ui.audioOnly);
  $('formatNote').textContent = ui.audioOnly ? 'Сохраняется только звуковая дорожка. Формат зависит от доступного источника.' : 'Раздельные дорожки видео и звука объединяются автоматически.';
}
const BROWSER_FALLBACK = new Set(['BROWSER_REQUIRED', 'AUTH_REQUIRED', 'INVALID_RESPONSE', 'TIMEOUT', 'DOWNLOAD_FAILED', 'OUTPUT_LIMIT']);
async function analyzeUrl(event) {
  event?.preventDefault();
  let url; try { url = cleanUrl($('videoUrl').value); } catch (error) { toast(errorMessage(error), true); return; }
  ui.analysisUrl = url; ui.analysis = null; ui.audioOnly = false; const token = ++ui.analysisToken;
  $('analysisLoading').hidden = false; $('analysisContent').hidden = true; $('analysisError').hidden = true; $('analyzeButton').disabled = true; showModal();
  try {
    const result = await call('analyze', url); if (token !== ui.analysisToken) return;
    if (result?.failed) {
      // Sites yt-dlp cannot read on its own open in the built-in browser,
      // where pressing Play is enough for PULL to catch the video.
      if (BROWSER_FALLBACK.has(result.code)) {
        ui.browserReason = result.code === 'AUTH_REQUIRED' ? 'Если сайт просит войти, войдите. Потом включите видео, PULL найдёт его сам' : 'По ссылке видео сразу не нашлось, поэтому страница открыта здесь. Включите видео, PULL найдёт его сам';
        $('videoUrl').value = ''; await openBrowser(url); return;
      }
      throw new Error(result.message);
    }
    ui.analysis = result; $('analysisLoading').hidden = true; $('analysisContent').hidden = false;
    $('videoTitle').textContent = result.title || hostOf(url); $('videoMeta').textContent = [hostOf(url), seconds(result.duration), result.isLive ? 'Прямой эфир' : ''].filter(Boolean).join(' · ');
    $('analysisThumbnail').replaceChildren(imageFor(result.thumbnail) || icon('play'));
    $('analysisDestination').textContent = state.settings.directory || 'Папка загрузок'; $('analysisDestination').title = state.settings.directory || '';
    fillFormatOptions(); $('confirmDownload').focus();
  } catch (error) {
    if (token !== ui.analysisToken) return; $('analysisLoading').hidden = true; $('analysisError').hidden = false; $('analysisErrorText').textContent = errorMessage(error);
  } finally { if (token === ui.analysisToken) $('analyzeButton').disabled = false; }
}
async function confirmDownload() {
  if (!ui.analysis) return;
  const selection = $('formatSelect').value;
  const request = { url: ui.analysisUrl, title: ui.analysis.title, audioOnly: ui.audioOnly };
  if (selection.startsWith('format:')) request.formatId = selection.slice(7);
  else request.quality = selection.startsWith('quality:') ? selection.slice(8) : 'best';
  await call('download', request); closeModal(); $('videoUrl').value = ''; navigate('downloads'); toast('Видео добавлено в очередь');
}
async function openBrowser(url, resumeJob = null) {
  ui.resumeJob = resumeJob;
  closeModal(); navigate('browser'); $('browserUrl').value = url; renderBrowser(true);
  let result;
  try { result = await call('openBrowser', url); } catch (error) {
    if (ui.resumeJob === resumeJob) { ui.resumeJob = null; renderBrowser(); }
    throw error;
  }
  if (resumeJob && ui.resumeJob === resumeJob) {
    const { opened, browser, media, candidates } = result;
    resumeJob.pageId = opened ? browser.pageId : -1;
    if ((state.browser?.pageId ?? -1) < browser.pageId) state = { ...state, browser, media, candidates };
    renderBrowser(true);
  }
  ui.lastBounds = ''; await syncBrowserBounds();
}
async function chooseFolder() { const result = await call('chooseFolder'); const directory = typeof result === 'string' ? result : result?.directory; if (directory) await saveSettings({ directory }); }

function renderCaptureSources() {
  $('captureSourcesEmpty').hidden = ui.captureSources.length > 0;
  $('captureSources').replaceChildren(...ui.captureSources.map(source => {
    const button = el('button', `capture-source${ui.selectedSource?.id === source.id ? ' selected' : ''}`); button.disabled = Boolean(isRecording());
    const image = imageFor(source.thumbnail); if (image) button.append(image); button.append(el('span', '', source.name));
    button.addEventListener('click', () => { ui.selectedSource = source; renderCaptureSources(); renderRecording(); }); return button;
  }));
}
async function refreshSources() {
  if (isRecording()) return;
  ui.captureSources = await call('getCaptureSources'); if (!Array.isArray(ui.captureSources)) ui.captureSources = [];
  if (ui.selectedSource && !ui.captureSources.some(source => source.id === ui.selectedSource.id)) ui.selectedSource = null;
  renderCaptureSources(); renderRecording();
  if (!ui.captureSources.length) $('captureSourcesEmpty').textContent = 'Не удалось найти открытые окна и экраны. Попробуй обновить список.';
}
function renderRecording() {
  const active = Boolean(isRecording()); const stopping = Boolean(ui.captureBusy);
  $('recordState').textContent = active ? 'Идёт запись' : stopping ? 'Сохранение…' : 'Готово к записи'; $('recordState').classList.toggle('is-recording', active);
  $('recordInfo').textContent = active ? 'Записывается экран и доступный системный звук' : ui.selectedSource?.name || 'Источник не выбран';
  $('startRecording').replaceChildren(icon(active ? 'stop' : 'record'), document.createTextNode(active ? 'Остановить и сохранить' : ui.selectedSource ? 'Начать запись' : 'Выбрать источник'));
  $('startRecording').classList.toggle('is-recording', active); $('startRecording').disabled = stopping;
  $('refreshSources').disabled = active || stopping;
}
async function beginCapture() {
  if (isRecording()) { ui.captureBusy = true; renderRecording(); ui.recorder.stop(); return; }
  if (!ui.selectedSource) { await refreshSources(); if (ui.captureSources.length === 1) { ui.selectedSource = ui.captureSources[0]; renderCaptureSources(); renderRecording(); } return; }
  ui.captureBusy = true; $('startRecording').disabled = true; ui.recordingError = null; ui.chunkWrites = Promise.resolve();
  try {
    await call('selectCaptureSource', ui.selectedSource.id);
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30, max: 60 } }, audio: true });
    ui.captureStream = stream;
    const mimeType = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find(type => MediaRecorder.isTypeSupported(type));
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType, videoBitsPerSecond: 8000000 } : undefined);
    const started = await call('startRecording', { name: ui.selectedSource.name }); ui.recordingId = started.id; ui.recorder = recorder;
    recorder.addEventListener('dataavailable', event => {
      if (!event.data.size) return;
      ui.chunkWrites = ui.chunkWrites.then(async () => { const data = await event.data.arrayBuffer(); await call('appendRecording', { id: started.id, data }); }).catch(error => { ui.recordingError = error; if (recorder.state !== 'inactive') recorder.stop(); });
    });
    recorder.addEventListener('error', event => { ui.recordingError = event.error || new Error('Ошибка записи экрана'); if (recorder.state !== 'inactive') recorder.stop(); });
    recorder.addEventListener('stop', () => finishCapture(started.id));
    stream.getVideoTracks().forEach(track => track.addEventListener('ended', () => { if (recorder.state !== 'inactive') recorder.stop(); }));
    recorder.start(1000); ui.recordingStarted = Date.now(); ui.captureBusy = false;
    $('recordResult').hidden = true; $('recordTime').textContent = '00:00';
    ui.recordingTimer = setInterval(() => { $('recordTime').textContent = seconds((Date.now() - ui.recordingStarted) / 1000).padStart(5, '0'); }, 500);
    renderCaptureSources(); renderRecording();
    if (ui.closeRequested) { ui.captureBusy = true; recorder.stop(); return; }
    if (!stream.getAudioTracks().length) toast('Запись началась без системного звука: источник не предоставил аудиодорожку');
  } catch (error) {
    ui.captureStream?.getTracks().forEach(track => track.stop()); ui.captureStream = null; ui.recorder = null;
    if (ui.recordingId) { try { await call('finishRecording', { id: ui.recordingId }); } catch { /* Empty recordings are removed by the recording manager. */ } }
    ui.recordingId = null; ui.captureBusy = false; renderRecording();
    if (ui.closeRequested) await call('confirmClose');
    throw error;
  }
}
function finishCapture(id) {
  if (ui.finishPromise) return ui.finishPromise;
  ui.finishPromise = finishCaptureWork(id).finally(async () => { ui.finishPromise = null; if (ui.closeRequested) await call('confirmClose'); });
  return ui.finishPromise;
}
async function finishCaptureWork(id) {
  ui.captureBusy = true; clearInterval(ui.recordingTimer); ui.captureStream?.getTracks().forEach(track => track.stop()); ui.captureStream = null; renderRecording();
  try {
    await ui.chunkWrites;
    const result = await call('finishRecording', { id }); ui.lastRecordingPath = result.path; ui.lastRecordingId = id;
    $('recordPath').textContent = result.path || 'Файл сохранён в папке загрузок'; $('recordResult').hidden = false;
    const resultPanel = $('recordResult'); resultPanel.querySelectorAll('.record-file-action').forEach(node => node.remove());
    if (typeof api?.openRecording === 'function') { const button = buttonIcon('play', 'Открыть запись', () => call('openRecording', id)); button.classList.add('record-file-action'); resultPanel.append(button); }
    if (typeof api?.showRecording === 'function') { const button = buttonIcon('folder', 'Показать запись в папке', () => call('showRecording', id)); button.classList.add('record-file-action'); resultPanel.append(button); }
    if (ui.recordingError) toast(`Запись завершилась с ошибкой: ${errorMessage(ui.recordingError)}. Сохранена доступная часть.`, true); else toast('Запись сохранена');
  } catch (error) { toast(`Не удалось сохранить запись: ${errorMessage(error)}`, true); }
  finally { ui.recorder = null; ui.recordingId = null; ui.captureBusy = false; renderCaptureSources(); renderRecording(); }
}
function beforeClose() {
  ui.closeRequested = true;
  if (isRecording()) { ui.captureBusy = true; renderRecording(); ui.recorder.stop(); return; }
  if (ui.finishPromise || ui.captureBusy) return;
  if (ui.recordingId) { finishCapture(ui.recordingId); return; }
  call('confirmClose').catch(error => toast(errorMessage(error), true));
}

function bindEvents() {
  document.querySelectorAll('[data-route]').forEach(button => button.addEventListener('click', () => navigate(button.dataset.route)));
  document.querySelector('.brand').addEventListener('click', event => { event.preventDefault(); navigate('downloads'); });
  $('analyzeForm').addEventListener('submit', analyzeUrl);
  $('pasteLink').addEventListener('click', () => runAction(async () => { const text = await navigator.clipboard.readText(); $('videoUrl').value = text.trim(); $('videoUrl').focus(); if (!text.trim()) toast('В буфере обмена пока нет текста'); }, $('pasteLink')));
  $('emptyOpenBrowser').addEventListener('click', () => { navigate('browser'); $('browserUrl').focus(); });
  $('queueFilters').querySelectorAll('[data-filter]').forEach(button => button.addEventListener('click', () => { ui.filter = button.dataset.filter; $('queueFilters').querySelectorAll('button').forEach(item => item.classList.toggle('selected', item === button)); renderJobs(); }));
  $('closeAnalysis').addEventListener('click', closeModal);
  $('analysisOverlay').addEventListener('click', event => { if (event.target === $('analysisOverlay')) closeModal(); });
  $('formatVideo').addEventListener('click', () => { ui.audioOnly = false; fillFormatOptions(); });
  $('formatAudio').addEventListener('click', () => { ui.audioOnly = true; fillFormatOptions(); });
  $('confirmDownload').addEventListener('click', () => runAction(confirmDownload, $('confirmDownload')));
  $('analysisOpenBrowser').addEventListener('click', () => runAction(() => openBrowser(ui.analysisUrl), $('analysisOpenBrowser')));
  $('browserForm').addEventListener('submit', event => { event.preventDefault(); ui.browserReason = ''; runAction(async () => { const url = cleanUrl($('browserUrl').value); await call('navigateBrowser', url); ui.lastBounds = ''; await syncBrowserBounds(); }); });
  $('browserBack').addEventListener('click', () => runAction(() => call('browserBack')));
  $('browserForward').addEventListener('click', () => runAction(() => call('browserForward')));
  $('browserReload').addEventListener('click', () => runAction(() => call('browserReload')));
  $('clearCandidates').addEventListener('click', () => runAction(() => call('clearCandidates')));
  $('mediaOthers').addEventListener('click', () => { $('mediaPanel').hidden = !$('mediaPanel').hidden; });
  $('closeOthers').addEventListener('click', () => { $('mediaPanel').hidden = true; });
  $('mediaDownload').addEventListener('click', () => { const best = (state.candidates || []).find(item => item.id === state.media?.best); if (best) runAction(() => downloadFound(best, $('mediaQuality').value), $('mediaDownload')); });
  $('cancelSource').addEventListener('click', () => { ui.resumeJob = null; renderBrowser(); });
  $('mediaOpenDownloads').addEventListener('click', () => navigate('downloads'));
  $('chooseFolder').addEventListener('click', () => runAction(chooseFolder, $('chooseFolder')));
  $('changeFolderInline').addEventListener('click', () => runAction(chooseFolder, $('changeFolderInline')));
  $('defaultQuality').addEventListener('change', () => runAction(() => saveSettings({ quality: $('defaultQuality').value })));
  $('concurrency').addEventListener('change', () => runAction(() => saveSettings({ concurrency: Number($('concurrency').value) })));
  document.querySelectorAll('[data-theme]').forEach(button => button.addEventListener('click', () => runAction(() => saveSettings({ theme: button.dataset.theme }))));
  $('quickTheme').addEventListener('click', () => runAction(() => saveSettings({ theme: resolvedTheme() === 'light' ? 'dark' : 'light' })));
  systemDark.addEventListener('change', applyTheme);
  for (const id of ['closeToTray', 'launchAtLogin', 'autoDownloadFound']) $(id).addEventListener('change', () => runAction(() => saveSettings({ [id]: $(id).checked })));
  if (api?.onAnalyze) api.onAnalyze(url => { closeModal(); navigate('downloads'); $('videoUrl').value = url; analyzeUrl(); });
  if (api?.onNotice) api.onNotice(text => toast(text));
  $('refreshSources').addEventListener('click', () => runAction(refreshSources, $('refreshSources')));
  $('startRecording').addEventListener('click', () => runAction(beginCapture));
  $('copyRecordPath').addEventListener('click', () => runAction(async () => { if (ui.lastRecordingPath) { await navigator.clipboard.writeText(ui.lastRecordingPath); toast('Путь скопирован'); } }));
  $('copyExtensionToken').addEventListener('click', () => runAction(async () => { if (state.extension?.token) { await navigator.clipboard.writeText(state.extension.token); toast('Код подключения скопирован'); } }));
  $('openExtensionFolder').addEventListener('click', () => runAction(() => call('openExtensionFolder')));
  $('checkUpdates').addEventListener('click', () => runAction(async () => { const result = await call('checkForUpdates'); if (result?.status === 'latest') toast('Установлена последняя версия'); }, $('checkUpdates')));
  for (const id of ['installUpdate', 'footerUpdate']) $(id).addEventListener('click', () => runAction(async () => {
    await call('installUpdate');
  }, $(id)).finally(renderUpdate));
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && ui.modal) closeModal();
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'l') { event.preventDefault(); if (ui.route === 'browser') $('browserUrl').focus(); else { navigate('downloads'); $('videoUrl').focus(); } }
    if (event.key === 'Tab' && ui.modal) { const focusables = [...$('analysisOverlay').querySelectorAll('button:not(:disabled),select,input')].filter(node => node.getClientRects().length); const first = focusables[0]; const last = focusables[focusables.length - 1]; if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); } }
  });
  window.addEventListener('resize', syncBrowserBounds); document.addEventListener('visibilitychange', syncBrowserBounds);
  new ResizeObserver(syncBrowserBounds).observe($('browserSlot'));
  if (api?.onBeforeClose) api.onBeforeClose(beforeClose);
}

mountIcons(); bindEvents(); renderJobs(); renderSettings(); renderBrowser();
if (api?.onState) api.onState(applyState);
call('getState').then(applyState).catch(error => { state.tools.error = errorMessage(error); renderSettings(); });
