'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const ACTIVE = new Set(['downloading', 'merging', 'analyzing']);
const SAFE_QUERY = new Set(['v', 'id', 'video_id', 'video']);
const HEADER_NAME = /^[a-z0-9!#$%&'*+.^_`|~-]+$/i;

class DownloadError extends Error {
  constructor(code, message) { super(message); this.name = 'DownloadError'; this.code = code; }
}

function validateUrl(input) {
  if (typeof input !== 'string' || input.length > 16384 || /[\u0000-\u001f\u007f]/.test(input)) {
    throw new DownloadError('INVALID_URL', 'Введите корректную ссылку HTTP или HTTPS.');
  }
  let url;
  try { url = new URL(input.trim()); } catch { throw new DownloadError('INVALID_URL', 'Введите полную ссылку на страницу или видеопоток.'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) {
    throw new DownloadError('INVALID_URL', 'Поддерживаются ссылки HTTP и HTTPS без логина и пароля в адресе.');
  }
  url.hash = '';
  return url.href;
}

function publicUrl(raw) {
  try {
    const url = new URL(raw);
    url.username = ''; url.password = ''; url.hash = '';
    for (const key of [...url.searchParams.keys()]) if (!SAFE_QUERY.has(key)) url.searchParams.delete(key);
    return url.href;
  } catch { return ''; }
}

// Query keys that typically carry signatures, expiring tokens or credentials.
const SENSITIVE_QUERY = /token|sig|auth|key|expire|^exp$|session|^sid$|hash|hmac|policy|credential|secret|pass|^acl$|hdnts|^x-amz-/i;

function hasSensitiveQuery(raw) {
  try { return [...new URL(raw).searchParams.keys()].some((key) => SENSITIVE_QUERY.test(key)); } catch { return true; }
}

function redact(text) {
  return String(text || '').replace(/https?:\/\/[^\s<>"']+/gi, (url) => publicUrl(url))
    .replace(/\b(?:authorization|cookie|set-cookie|token|password|secret|signature)\s*[:=]\s*[^\r\n]+/gi, '[данные авторизации скрыты]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(-1800);
}

function privateOptions(extra = {}) {
  const result = { headers: {} };
  if (!extra || typeof extra !== 'object') return result;
  for (const [key, value] of Object.entries(extra.headers || {}).slice(0, 32)) {
    if (!HEADER_NAME.test(key) || ['host', 'content-length', 'connection', 'proxy-authorization'].includes(key.toLowerCase())) continue;
    const text = String(value);
    if (text.length <= 16384 && !/[\r\n\0]/.test(text)) result.headers[key] = text;
  }
  if (typeof extra.cookieFile === 'string' && path.isAbsolute(extra.cookieFile) && fs.existsSync(extra.cookieFile)) {
    result.cookieFile = extra.cookieFile;
  }
  return result;
}

function describeError(message, code = 'DOWNLOAD_FAILED') {
  const safe = redact(message);
  if (/DRM|Widevine|FairPlay|PlayReady/i.test(safe)) return { code: 'DRM', message: 'Поток защищён DRM. Этот тип защиты не поддерживается.' };
  // Match HTTP status codes and yt-dlp's auth hints only in context: a bare
  // "403" inside an ID or file size, or any mention of cookies, is not an auth error.
  if (/HTTP Error 40[13]\b|\b40[13]\s+(?:Forbidden|Unauthorized)\b|\bForbidden\b|\bUnauthorized\b|login required|requires? (?:a )?log ?in|\b(?:sign|log) in to\b|use --cookies|cookies? (?:are |is )?(?:needed|required)|requires? authentication|authentication (?:is )?required/i.test(safe)) {
    return { code: 'AUTH_REQUIRED', message: 'Сайт требует актуальную сессию. Откройте его во встроенном браузере, войдите и запустите видео.' };
  }
  if (/Unsupported URL|no video formats|Unable to extract|No video could be found/i.test(safe)) {
    return { code: 'BROWSER_REQUIRED', message: 'Автоматический поиск не нашёл видео. Откройте страницу в браузере и нажмите Play.' };
  }
  return { code, message: safe || 'Не удалось скачать видео. Проверьте ссылку и подключение.' };
}

function formatSelection(job, formats = []) {
  if (job.formatId) {
    if (!/^[a-zA-Z0-9_.-]+(?:\+[a-zA-Z0-9_.-]+)*$/.test(job.formatId) || job.formatId.length > 300) {
      throw new DownloadError('INVALID_FORMAT', 'Некорректный идентификатор качества.');
    }
    if (job.audioOnly || job.formatId.includes('+')) return job.formatId;
    const selected = formats.find((format) => String(format.id || format.format_id) === job.formatId);
    if (selected?.acodec && selected.acodec !== 'none') return job.formatId;
    if (selected?.vcodec === 'none') return job.formatId;
    // For a video-only format merge the best audio; fall back to the selected
    // format when it already contains audio or the source is silent.
    return `${job.formatId}+bestaudio/${job.formatId}`;
  }
  if (job.audioOnly) return 'bestaudio/best';
  const height = Number.parseInt(String(job.quality || ''), 10);
  if (Number.isFinite(height) && height >= 144 && height <= 8640) {
    return `bestvideo*[height<=${height}]+bestaudio/best[height<=${height}]`;
  }
  return 'bestvideo*+bestaudio/best';
}

class DownloadManager {
  constructor({ toolsDir, dataDir, downloadDir, concurrency = 2, onChange = () => {}, spawnProcess = spawn, analysisTimeout = 90000 } = {}) {
    this.toolsDir = toolsDir;
    this.dataDir = path.resolve(dataDir || path.join(os.tmpdir(), 'pull-data'));
    this.downloadDir = path.resolve(downloadDir || path.join(os.homedir(), 'Downloads', 'PULL'));
    this.concurrency = Math.max(1, Math.min(5, Number(concurrency) || 2));
    this.onChange = onChange;
    this._spawn = spawnProcess;
    this.analysisTimeout = analysisTimeout;
    this.jobs = [];
    this.processes = new Map();
    this.analysisProcesses = new Set();
    this.cache = new Map();
    this._disposed = false;
    this._persistTimer = null;
    this._lastEmission = 0;
    fs.mkdirSync(this.dataDir, { recursive: true });
    fs.mkdirSync(this.downloadDir, { recursive: true });
    this.statePath = path.join(this.dataDir, 'downloads.json');
    this._load();
  }

  getTools() {
    // getState snapshots call this many times per second. Once all tools are
    // found the result is cached; while something is missing it is re-checked,
    // so tools installed during a session are picked up without a restart.
    if (this._tools?.ready) return this._tools;
    this._tools = this._findTools();
    return this._tools;
  }

  _findTools() {
    const roots = [this.toolsDir, process.env.PULL_TOOLS_DIR, process.resourcesPath && path.join(process.resourcesPath, 'tools'), path.resolve(__dirname, '..', 'tools')].filter(Boolean);
    const find = (name) => roots.map((root) => path.join(root, process.platform === 'win32' ? `${name}.exe` : name)).find((file) => fs.existsSync(file));
    const ytDlp = find('yt-dlp'), ffmpeg = find('ffmpeg'), ffprobe = find('ffprobe'), node = find('node');
    return { ready: Boolean(ytDlp && ffmpeg && ffprobe), ytDlp: ytDlp || null, ffmpeg: ffmpeg || null, ffprobe: ffprobe || null, node: node || null,
      error: ytDlp && ffmpeg && ffprobe ? null : 'Не найдены yt-dlp, FFmpeg или FFprobe. Запустите scripts/setup-tools.ps1.' };
  }

  getState() {
    return this.jobs.map((job) => ({ id: job.id, title: job.title, url: publicUrl(job.url), status: job.status, progress: job.progress,
      speed: job.speed || 0, eta: job.eta ?? null, filename: job.filename || null, error: job.error || null, errorCode: job.errorCode || null,
      thumbnail: job.thumbnail ? publicUrl(job.thumbnail) : null, quality: job.quality, audioOnly: Boolean(job.audioOnly), createdAt: job.createdAt,
      completedAt: job.completedAt || null, downloadedBytes: job.downloadedBytes || 0, totalBytes: job.totalBytes || 0,
      directory: job.directory, needsSource: Boolean(job.needsSource) }));
  }

  _load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
      this.jobs = (Array.isArray(parsed) ? parsed : []).slice(0, 500).filter((job) => /^[a-f0-9-]{36}$/.test(job.id)).map((job) => {
        const restored = { ...job, extra: {}, progress: Number(job.progress) || 0 };
        if (ACTIVE.has(job.status) || job.status === 'queued') restored.status = 'paused';
        if (job.requiresSession && !['completed', 'cancelled'].includes(restored.status)) {
          restored.needsSource = true;
          restored.status = 'paused';
          restored.error = 'Для продолжения откройте источник повторно: сессия браузера не хранится в истории.';
        }
        return restored;
      });
    } catch { this.jobs = []; }
  }

  _persist() {
    try {
      const jobs = this.jobs.map((job) => {
        const { extra, formats, ...safe } = job;
        // Session headers, cookie file paths and signed URLs are never written
        // to history. Ordinary page IDs remain resumable after restart.
        // Ordinary parameters (playlist position, timestamps, page IDs) are kept
        // so the job stays resumable; signed or tokenized URLs are stripped.
        safe.requiresSession = Boolean(job.requiresSession || extra?.cookieFile || Object.keys(extra?.headers || {}).length || hasSensitiveQuery(job.url));
        safe.url = safe.requiresSession ? publicUrl(job.url) : job.url;
        if (safe.thumbnail) safe.thumbnail = publicUrl(safe.thumbnail);
        return safe;
      });
      const temporary = `${this.statePath}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(jobs, null, 2), { mode: 0o600 });
      fs.renameSync(temporary, this.statePath);
    } catch { /* A full disk must not crash an active download. */ }
  }

  _changed(immediate = false) {
    clearTimeout(this._persistTimer);
    if (immediate) this._persist();
    else this._persistTimer = setTimeout(() => this._persist(), 800);
    const now = Date.now();
    if (immediate || now - this._lastEmission > 150) {
      this._lastEmission = now;
      try { this.onChange(this.getState()); } catch { /* UI callbacks cannot break the queue. */ }
    }
  }

  _baseArgs(extra = {}) {
    const tools = this.getTools();
    if (!tools.ytDlp) throw new DownloadError('TOOLS_MISSING', tools.error);
    const args = ['--ignore-config', '--no-plugin-dirs', '--no-playlist', '--no-colors', '--encoding', 'utf-8', '--socket-timeout', '25', '--retries', '5', '--fragment-retries', '5'];
    if (tools.ffmpeg) args.push('--ffmpeg-location', path.dirname(tools.ffmpeg));
    if (tools.node) args.push('--no-js-runtimes', '--js-runtimes', `node:${tools.node}`);
    for (const [key, value] of Object.entries(extra.headers || {})) args.push('--add-headers', `${key}:${value}`);
    if (extra.cookieFile) args.push('--cookies', extra.cookieFile);
    return { tools, args };
  }

  async analyze(rawUrl, extra = {}) {
    const url = validateUrl(rawUrl);
    const { tools, args } = this._baseArgs(privateOptions(extra));
    args.push('--dump-single-json', '--skip-download', '--no-warnings', '--', url);
    return new Promise((resolve, reject) => {
      let stdout = '', stderr = '', settled = false;
      let child;
      const finish = (error, value) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        this.analysisProcesses.delete(child);
        if (error) reject(error); else resolve(value);
      };
      let timer;
      try { child = this._spawn(tools.ytDlp, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
      catch (error) { finish(new DownloadError('SPAWN_FAILED', redact(error.message))); return; }
      this.analysisProcesses.add(child);
      timer = setTimeout(() => { this._stop(child); finish(new DownloadError('TIMEOUT', 'Сайт слишком долго отвечает. Попробуйте открыть видео во встроенном браузере.')); }, this.analysisTimeout);
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
        if (stdout.length > 32 * 1024 * 1024) { this._stop(child); finish(new DownloadError('OUTPUT_LIMIT', 'Сайт вернул слишком большой список данных.')); }
      });
      child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-32000); });
      child.on('error', (error) => finish(new DownloadError('SPAWN_FAILED', redact(error.message))));
      child.on('close', (code) => {
        if (settled) return;
        if (code !== 0) {
          const error = describeError(stderr);
          finish(new DownloadError(error.code, error.message)); return;
        }
        try {
          const info = JSON.parse(stdout.trim());
          if (info.has_drm) throw new DownloadError('DRM', 'Поток защищён DRM. Этот тип защиты не поддерживается.');
          const formats = (info.formats || (info.url ? [info] : [])).filter((format) => !format.has_drm && (format.vcodec !== 'none' || format.acodec !== 'none')).map((format) => {
            const resolution = format.height ? `${format.height}p` : format.vcodec === 'none' ? 'Аудио' : format.resolution || 'Исходное';
            return { id: String(format.format_id || 'best'), label: [resolution, format.fps > 30 ? `${format.fps} fps` : '', format.ext?.toUpperCase(), format.vcodec === 'none' && format.abr ? `${Math.round(format.abr)} kbps` : '', format.acodec === 'none' ? '+ аудио' : ''].filter(Boolean).join(' · '),
              ext: format.ext, resolution, height: format.height || 0, filesize: format.filesize || format.filesize_approx || null,
              vcodec: format.vcodec, acodec: format.acodec, fps: format.fps || null };
          }).reverse();
          const result = { title: String(info.title || new URL(url).hostname), thumbnail: info.thumbnail || null, duration: info.duration || null, formats, url: publicUrl(url), isLive: Boolean(info.is_live) };
          this.cache.set(url, result);
          if (this.cache.size > 100) this.cache.delete(this.cache.keys().next().value);
          finish(null, result);
        } catch (error) { finish(error instanceof DownloadError ? error : new DownloadError('INVALID_RESPONSE', 'Не удалось прочитать ответ сайта. Попробуйте режим браузера.')); }
      });
    });
  }

  add({ url: rawUrl, formatId, quality = 'best', audioOnly = false, title, extra = {}, thumbnail } = {}) {
    if (this._disposed) throw new DownloadError('DISPOSED', 'Приложение завершает работу.');
    const url = validateUrl(rawUrl);
    const cached = this.cache.get(url);
    const job = { id: crypto.randomUUID(), url, title: String(title || cached?.title || new URL(url).hostname).slice(0, 300),
      status: 'queued', progress: 0, speed: 0, eta: null, error: null, filename: null, quality,
      formatId: formatId ? String(formatId) : undefined, audioOnly: Boolean(audioOnly), extra: privateOptions(extra),
      formats: cached?.formats || [], thumbnail: thumbnail || cached?.thumbnail || null,
      directory: this.downloadDir, createdAt: new Date().toISOString(), downloadedBytes: 0, totalBytes: 0 };
    formatSelection(job, job.formats);
    this.jobs.unshift(job);
    this._changed(true);
    queueMicrotask(() => this._drain());
    return this.getState().find((item) => item.id === job.id);
  }

  setDirectory(directory) {
    if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new DownloadError('INVALID_DIRECTORY', 'Выберите абсолютный путь к папке загрузок.');
    fs.mkdirSync(directory, { recursive: true });
    fs.accessSync(directory, fs.constants.W_OK);
    this.downloadDir = path.resolve(directory);
    return this.downloadDir;
  }

  setConcurrency(value) {
    this.concurrency = Math.max(1, Math.min(5, Math.floor(Number(value)) || 2));
    this._drain(); return this.concurrency;
  }

  pause(id) {
    const job = this.jobs.find((item) => item.id === id);
    if (!job || !['queued', 'downloading', 'analyzing'].includes(job.status)) return false;
    job.status = 'paused'; job.speed = 0; job.eta = null;
    const active = this.processes.get(id);
    if (active) this._stop(active.child);
    this._changed(true); return true;
  }

  resume(id) {
    const job = this.jobs.find((item) => item.id === id);
    if (!job || !['paused', 'error', 'cancelled'].includes(job.status)) return false;
    if (job.needsSource) throw new DownloadError('SOURCE_EXPIRED', 'Повторно откройте источник в браузере и выберите поток: данные сессии не сохраняются между запусками.');
    job.status = 'queued'; job.error = null; job.errorCode = null;
    this._changed(true); this._drain(); return true;
  }

  cancel(id) {
    const job = this.jobs.find((item) => item.id === id);
    if (!job || job.status === 'completed') return false;
    job.status = 'cancelled'; job.speed = 0; job.eta = null;
    const active = this.processes.get(id);
    // A running process still holds its fragments; they are removed when it exits.
    if (active) this._stop(active.child); else this._cleanupParts(job);
    this._cleanupCookie(job);
    this._changed(true); this._drain(); return true;
  }

  remove(id) {
    const index = this.jobs.findIndex((item) => item.id === id);
    if (index < 0) return false;
    this.cancel(id);
    this.jobs.splice(index, 1); this._changed(true); return true;
  }

  _drain() {
    if (this._disposed) return;
    while (this.processes.size < this.concurrency) {
      const job = [...this.jobs].reverse().find((item) => item.status === 'queued' && !this.processes.has(item.id));
      if (!job) break;
      this._start(job);
    }
  }

  _start(job) {
    let child;
    try {
      const { tools, args } = this._baseArgs(job.extra);
      if (!tools.ready) throw new DownloadError('TOOLS_MISSING', tools.error);
      fs.mkdirSync(job.directory, { recursive: true });
      const parts = path.join(job.directory, '.pull-parts', job.id);
      fs.mkdirSync(parts, { recursive: true });
      args.push('--no-simulate', '--newline', '--progress', '--continue', '--part', '--no-overwrites', '--abort-on-error',
        '--concurrent-fragments', '4', '--windows-filenames', '--trim-filenames', '190',
        '--paths', `home:${job.directory}`, '--paths', `temp:${parts}`,
        '--output', '%(title).120B [%(id)s] [%(format_id)s].%(ext)s',
        '--format', formatSelection(job, job.formats), '--merge-output-format', 'mp4/mkv',
        '--progress-template', 'download:__PULL_PROGRESS__%(progress)j',
        '--progress-template', 'postprocess:__PULL_POST__%(progress.status)s',
        '--print', 'before_dl:__PULL_TITLE__%(title)j',
        '--print', 'after_move:__PULL_FILE__%(filepath)j');
      if (job.audioOnly) args.push('--extract-audio', '--audio-format', 'best');
      args.push('--', job.url);
      job.status = 'downloading'; job.error = null; job.errorCode = null;
      if (!fs.existsSync(tools.ytDlp)) { this._tools = null; throw new DownloadError('TOOLS_MISSING', 'yt-dlp не найден. Перезапустите PULL или запустите scripts/setup-tools.ps1.'); }
      child = this._spawn(tools.ytDlp, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const record = { child, stderr: '', warnings: '', stdoutPending: '', stderrPending: '', finalized: false };
      this.processes.set(job.id, record);
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      const read = (chunk, stream) => {
        const pendingKey = `${stream}Pending`;
        record[pendingKey] += chunk;
        const lines = record[pendingKey].split(/\r?\n|\r/);
        record[pendingKey] = lines.pop().slice(-65536);
        for (const line of lines) this._readLine(job, line, record);
      };
      child.stdout.on('data', (chunk) => read(chunk, 'stdout'));
      child.stderr.on('data', (chunk) => read(chunk, 'stderr'));
      const finish = (code, error) => {
        if (record.finalized) return;
        record.finalized = true;
        if (record.stdoutPending) this._readLine(job, record.stdoutPending, record);
        if (record.stderrPending) this._readLine(job, record.stderrPending, record);
        this.processes.delete(job.id);
        if (ACTIVE.has(job.status)) {
          if (code === 0 && job.filename && fs.existsSync(job.filename)) {
            job.status = 'completed'; job.progress = 100; job.completedAt = new Date().toISOString(); job.error = null;
            this._cleanupCookie(job);
          } else {
            const failure = describeError(error?.message || record.stderr || record.warnings || (code === 0 ? 'Загрузчик завершился, но итоговый файл не найден.' : `Загрузчик завершился с кодом ${code}.`));
            job.status = 'error'; job.error = failure.message; job.errorCode = failure.code;
          }
        }
        // Temporary fragments are kept only while the job can still be resumed.
        if (['completed', 'cancelled'].includes(job.status)) this._cleanupParts(job);
        job.speed = 0; job.eta = null;
        this._changed(true); this._drain();
      };
      child.on('error', (error) => finish(-1, error));
      child.on('close', (code) => finish(code));
      this._changed(true);
    } catch (error) {
      job.status = 'error'; job.error = redact(error.message); job.errorCode = error.code || 'DOWNLOAD_FAILED';
      this._changed(true);
    }
  }

  _readLine(job, line, record) {
    if (!ACTIVE.has(job.status)) return;
    if (line.startsWith('__PULL_PROGRESS__')) {
      try {
        const progress = JSON.parse(line.slice('__PULL_PROGRESS__'.length));
        job.status = 'downloading';
        const downloaded = Number(progress.downloaded_bytes) || 0;
        const total = Number(progress.total_bytes || progress.total_bytes_estimate) || 0;
        job.downloadedBytes = downloaded; job.totalBytes = total;
        job.progress = total ? Math.min(99.5, downloaded / total * 100) : Number.parseFloat(progress._percent_str) || job.progress;
        job.speed = Number(progress.speed) || 0; job.eta = Number.isFinite(progress.eta) ? progress.eta : null;
        this._changed();
      } catch { /* A truncated progress line does not affect the download. */ }
    } else if (line.startsWith('__PULL_TITLE__')) {
      try { job.title = String(JSON.parse(line.slice('__PULL_TITLE__'.length))).slice(0, 300); } catch { /* optional title */ }
    } else if (line.startsWith('__PULL_FILE__')) {
      try {
        const filename = path.resolve(JSON.parse(line.slice('__PULL_FILE__'.length)));
        const relative = path.relative(job.directory, filename);
        if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) job.filename = filename;
      } catch { /* Only yt-dlp's final JSON path is accepted. */ }
    } else if (line.startsWith('__PULL_POST__') || /^\[(Merger|ExtractAudio|VideoRemuxer|Fixup)/.test(line)) {
      job.status = 'merging'; job.speed = 0; job.eta = null; this._changed(true);
    } else if (/^\s*WARNING:/i.test(line)) {
      // Warnings are only a fallback explanation: they must not mask the real error.
      record.warnings = `${record.warnings}\n${redact(line)}`.slice(-3000);
    } else if (/ERROR:|error|failed/i.test(line)) {
      record.stderr = `${record.stderr}\n${redact(line)}`.slice(-6000);
    }
  }

  _stop(child) {
    if (!child || child.exitCode !== null && child.exitCode !== undefined) return;
    if (process.platform === 'win32' && child.pid) {
      // Terminate the process tree, including any active FFmpeg subprocess.
      const killer = this._spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/pid', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
      killer.on('error', () => { try { child.kill(); } catch {} });
    } else { try { child.kill('SIGTERM'); } catch {} }
  }

  _partsDir(job) {
    if (typeof job.directory !== 'string' || !/^[a-f0-9-]{36}$/.test(job.id)) return null;
    return path.join(job.directory, '.pull-parts', job.id);
  }

  _cleanupParts(job) {
    const parts = this._partsDir(job);
    if (!parts) return;
    const root = path.dirname(parts);
    // Asynchronous with retries: on Windows FFmpeg may release its handles a
    // moment after yt-dlp exits. The shared folder is removed only when empty.
    fs.promises.rm(parts, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
      .then(() => fs.promises.rmdir(root))
      .catch(() => {});
  }

  _cleanupCookie(job) {
    const cookieFile = job.extra?.cookieFile;
    if (!cookieFile) return;
    const relative = path.relative(this.dataDir, path.resolve(cookieFile));
    // Only ephemeral browser cookie files inside this application's data folder
    // may be removed; arbitrary caller-owned files are never deleted.
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
      try { fs.unlinkSync(cookieFile); } catch {}
      delete job.extra.cookieFile;
      if (job.status !== 'completed') job.needsSource = true;
    }
  }

  dispose() {
    this._disposed = true;
    clearTimeout(this._persistTimer);
    for (const job of this.jobs) {
      if (ACTIVE.has(job.status) || job.status === 'queued') { job.status = 'paused'; job.speed = 0; job.eta = null; }
    }
    for (const { child } of this.processes.values()) this._stop(child);
    for (const child of this.analysisProcesses) this._stop(child);
    this._persist();
  }
}

module.exports = { DownloadManager, DownloadError, _internals: { validateUrl, publicUrl, redact, formatSelection, privateOptions, describeError } };
