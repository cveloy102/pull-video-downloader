'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const MAX_CANDIDATES = 80;
const MAX_REQUESTS = 800;
const FILTER = { urls: ['http://*/*', 'https://*/*'] };

function validateUrl(value) {
  if (typeof value !== 'string' || value.length > 32768) throw new Error('Некорректный адрес.');
  const url = new URL(value.trim());
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Поддерживаются только адреса HTTP и HTTPS без логина в адресе.');
  }
  return url.href;
}

function getHeader(headers, name) {
  const entry = Object.entries(headers || {}).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return entry ? (Array.isArray(entry[1]) ? entry[1].join('; ') : String(entry[1])) : '';
}

function replayHeaders(headers) {
  // Cookies are placed in a domain-scoped jar, never a global Cookie header.
  // Range / transport headers must not turn a complete download into one fragment.
  const accepted = new Set(['user-agent', 'referer', 'origin', 'authorization', 'accept', 'accept-language']);
  const clean = {};
  for (const [name, raw] of Object.entries(headers || {})) {
    const value = Array.isArray(raw) ? raw.join('; ') : String(raw);
    const lower = name.toLowerCase();
    if ((accepted.has(lower) || /^x-[a-z0-9-]+$/.test(lower)) && value.length <= 16384 && !/[\r\n\0]/.test(value)) {
      if (!['x-forwarded-for', 'x-pull-token', 'x-real-ip'].includes(lower)) clean[name] = value;
    }
  }
  return clean;
}

function classifyMedia(rawUrl, rawMime = '', headers = {}) {
  let url;
  try { url = new URL(validateUrl(rawUrl)); } catch { return null; }
  const mime = String(rawMime || getHeader(headers, 'content-type')).toLowerCase().split(';')[0].trim();
  const pathname = url.pathname.toLowerCase();
  if (/\.m3u8$/.test(pathname) || ['application/vnd.apple.mpegurl', 'application/x-mpegurl', 'audio/mpegurl', 'audio/x-mpegurl'].includes(mime)) {
    return { kind: 'hls', mimeType: mime || 'application/vnd.apple.mpegurl' };
  }
  if (/\.mpd$/.test(pathname) || mime === 'application/dash+xml') return { kind: 'dash', mimeType: mime || 'application/dash+xml' };
  if (/\.ism(?:c)?\/manifest(?:\([^)]*\))?$/.test(pathname) || mime === 'application/vnd.ms-sstr+xml') return { kind: 'mss', mimeType: mime || 'application/vnd.ms-sstr+xml' };
  // Adaptive media chunks are not standalone videos; the manifest is the useful item.
  if (/\.(?:m4s|ts|cmfv|cmfa|aac|vtt|srt)$/.test(pathname) || /(?:^|\/)(?:init|segment|seg|chunk|frag)(?:[-_\d.]|$)/i.test(pathname)) return null;
  const size = Number(getHeader(headers, 'content-length'));
  if (size > 0 && size < 1024 && !getHeader(headers, 'content-range')) return null;
  if (mime.startsWith('video/') || /\.(?:mp4|webm|mov|mkv|m4v|avi|flv|ogv)$/.test(pathname)) {
    return { kind: 'video', mimeType: mime || 'video/mp4' };
  }
  if (['audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/webm', 'audio/flac'].includes(mime) || /\.(?:mp3|m4a|ogg|opus|flac)$/.test(pathname)) {
    return { kind: 'audio', mimeType: mime || 'audio/mpeg' };
  }
  return null;
}

function displayUrl(raw) {
  try {
    const url = new URL(raw);
    return `${url.origin}${url.pathname}${url.search ? '?…' : ''}`;
  } catch { return ''; }
}

function sniffManifest(body) {
  if (typeof body !== 'string' || body.length > 262144) return null;
  const prefix = body.replace(/^\uFEFF/, '').trimStart().slice(0, 4096);
  if (prefix.startsWith('#EXTM3U')) return 'application/vnd.apple.mpegurl';
  if (/<(?:[a-zA-Z_][\w.-]*:)?MPD(?:\s|>)/.test(prefix)) return 'application/dash+xml';
  if (/<SmoothStreamingMedia(?:\s|>)/.test(prefix)) return 'application/vnd.ms-sstr+xml';
  return null;
}

function cookieMatchesHost(cookie, host) {
  const domain = String(cookie.domain || '').replace(/^\./, '').toLowerCase();
  if (!domain) return false;
  return host.toLowerCase() === domain || (!cookie.hostOnly && host.toLowerCase().endsWith(`.${domain}`));
}

function cookieJar(cookies, host) {
  const safe = value => String(value ?? '').replace(/[\r\n\t\0]/g, '');
  return '# Netscape HTTP Cookie File\n# Temporary PULL download cookies\n' + cookies.filter(cookie => cookieMatchesHost(cookie, host)).map(cookie => {
    const domain = safe(cookie.domain);
    const prefix = cookie.httpOnly ? '#HttpOnly_' : '';
    return [prefix + domain, !cookie.hostOnly && domain.startsWith('.') ? 'TRUE' : 'FALSE', safe(cookie.path || '/'), cookie.secure ? 'TRUE' : 'FALSE', Math.floor(cookie.expirationDate || 0), safe(cookie.name), safe(cookie.value)].join('\t');
  }).join('\n') + '\n';
}

class BrowserManager {
  constructor({ window, dataDir, onChange = () => {} }) {
    this.window = window;
    this.dataDir = dataDir;
    this.onChange = onChange;
    this.view = null;
    this.session = null;
    this.candidates = new Map();
    this.requests = new Map();
    this.remoteContents = new Map();
    this.popupWindows = new Set();
    this.cdpRequests = new Map();
    this.sniffCount = 0;
    this.cookieFiles = new Set();
    this.bounds = { x: 0, y: 0, width: 0, height: 0, visible: false };
    this.browser = { url: '', title: '', loading: false, canGoBack: false, canGoForward: false, error: '' };
    this.disposed = false;
  }

  getState() {
    return {
      browser: { ...this.browser },
      candidates: [...this.candidates.values()].map(({ id, title, url, host, kind, mimeType, source }) => ({ id, title, url: displayUrl(url), host, kind, mimeType, source }))
    };
  }

  _emit() {
    if (!this.disposed) this.onChange(this.getState());
  }

  _updateBrowser() {
    const wc = this.view?.webContents;
    if (!wc || wc.isDestroyed()) return;
    this.browser = { ...this.browser, url: wc.getURL(), title: wc.getTitle(), loading: wc.isLoading(), canGoBack: wc.navigationHistory.canGoBack(), canGoForward: wc.navigationHistory.canGoForward() };
    this._emit();
  }

  _ensureView() {
    if (this.disposed) throw new Error('Браузер закрыт.');
    if (this.view) return this.view;
    const { WebContentsView, session } = require('electron');
    this.session = session.fromPartition('persist:pull-browser', { cache: true });
    this.session.setPermissionRequestHandler((_wc, permission, callback) => callback(['fullscreen'].includes(permission)));
    this.session.setPermissionCheckHandler((_wc, permission) => ['fullscreen'].includes(permission));
    this.view = new WebContentsView({ webPreferences: { session: this.session, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, allowRunningInsecureContent: false, navigateOnDragDrop: false, spellcheck: false } });
    this.view.setBackgroundColor('#101211');
    this.window.contentView.addChildView(this.view);
    this.setBounds(this.bounds);
    const wc = this.view.webContents;
    this.remoteContents.set(wc.id, wc);
    const isOurs = details => !details.webContentsId || this.remoteContents.has(details.webContentsId);
    this.session.webRequest.onSendHeaders(FILTER, details => {
      if (!isOurs(details) || details.method !== 'GET') return;
      if (this.requests.size >= MAX_REQUESTS) this.requests.delete(this.requests.keys().next().value);
      this.requests.set(details.id, { url: details.url, headers: details.requestHeaders, referrer: details.referrer });
    });
    this.session.webRequest.onResponseStarted(FILTER, details => {
      if (!isOurs(details) || details.method !== 'GET' || details.statusCode < 200 || details.statusCode >= 300) return;
      const meta = this.requests.get(details.id) || {};
      const source = this.remoteContents.get(details.webContentsId) || wc;
      this._addCandidate({ url: details.url, title: source.getTitle(), mimeType: getHeader(details.responseHeaders, 'content-type'), responseHeaders: details.responseHeaders, headers: meta.headers, referrer: meta.referrer, source: 'browser' });
    });
    this.session.webRequest.onCompleted(FILTER, details => this.requests.delete(details.id));
    this.session.webRequest.onErrorOccurred(FILTER, details => this.requests.delete(details.id));
    this.downloadHandler = (event, item) => {
      this._addCandidate({ url: item.getURL(), title: item.getFilename() || wc.getTitle(), mimeType: item.getMimeType(), source: 'browser' });
      event.preventDefault();
    };
    this.session.on('will-download', this.downloadHandler);
    this._guardContents(wc);
    for (const event of ['did-start-loading', 'did-stop-loading', 'did-navigate', 'did-navigate-in-page', 'page-title-updated']) wc.on(event, () => this._updateBrowser());
    wc.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
      if (isMainFrame && code !== -3) { this.browser.error = `Не удалось открыть страницу (${description}).`; this._updateBrowser(); }
    });
    wc.on('render-process-gone', () => { this.browser.error = 'Страница остановлена. Нажмите «Обновить».'; this.browser.loading = false; this._emit(); });
    this._attachNetworkObserver(wc);
    return this.view;
  }

  _guardContents(wc) {
    const navigationGuard = (event, url) => {
      const destination = typeof url === 'string' ? url : event.url;
      // Empty same-origin popup documents and blob/srcdoc player frames do not
      // gain filesystem, IPC or Node access. Privileged protocols stay blocked.
      if (['about:blank', 'about:srcdoc'].includes(destination) || /^blob:https?:\/\//.test(destination)) return;
      try { validateUrl(destination); } catch { event.preventDefault(); }
    };
    wc.on('will-navigate', navigationGuard);
    wc.on('will-redirect', navigationGuard);
    wc.on('will-frame-navigate', navigationGuard);
    wc.on('will-attach-webview', event => event.preventDefault());
    wc.setWindowOpenHandler(({ url }) => {
      if (this.disposed || this.popupWindows.size >= 4) return { action: 'deny' };
      try { if (url !== 'about:blank') validateUrl(url); } catch { return { action: 'deny' }; }
      // Native opener semantics are retained for OAuth/login callback windows.
      return { action: 'allow', overrideBrowserWindowOptions: {
        parent: this.window, width: 1000, height: 760, minWidth: 480, minHeight: 400, show: true, autoHideMenuBar: true, title: 'PULL — окно сайта',
        webPreferences: { session: this.session, sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, webSecurity: true, allowRunningInsecureContent: false, navigateOnDragDrop: false, webviewTag: false }
      } };
    });
    wc.on('did-create-window', child => {
      const childContents = child.webContents;
      this.popupWindows.add(child);
      this.remoteContents.set(childContents.id, childContents);
      child.removeMenu();
      this._guardContents(childContents);
      this._attachNetworkObserver(childContents);
      const updateTitle = () => {
        try { child.setTitle(`${new URL(childContents.getURL()).hostname || 'Окно сайта'} — PULL`); } catch { child.setTitle('Окно сайта — PULL'); }
      };
      childContents.on('page-title-updated', event => { event.preventDefault(); updateTitle(); });
      childContents.on('did-navigate', updateTitle);
      const id = childContents.id;
      child.on('closed', () => { this.popupWindows.delete(child); this.remoteContents.delete(id); });
    });
  }

  _attachNetworkObserver(wc) {
    // CDP supplements webRequest for cached/extensionless manifests. It observes
    // only this embedded browser; no debugging port or external browser attach.
    const debuggerApi = wc.debugger;
    try { debuggerApi.attach('1.3'); } catch { return; }
    debuggerApi.on('message', (_event, method, params) => {
      const requestKey = `${wc.id}:${params.requestId}`;
      if (method === 'Network.requestWillBeSent') {
        if (this.cdpRequests.size >= 400) this.cdpRequests.delete(this.cdpRequests.keys().next().value);
        this.cdpRequests.set(requestKey, { url: params.request.url, method: params.request.method, headers: params.request.headers, type: params.type });
      } else if (method === 'Network.requestWillBeSentExtraInfo') {
        const entry = this.cdpRequests.get(requestKey);
        if (entry) entry.headers = { ...entry.headers, ...params.headers };
      } else if (method === 'Network.responseReceived') {
        const entry = this.cdpRequests.get(requestKey);
        if (!entry || entry.method !== 'GET' || params.response.status < 200 || params.response.status >= 300) return;
        const response = params.response;
        entry.url = response.url;
        entry.mime = response.mimeType;
        this._addCandidate({ url: response.url, title: wc.getTitle(), mimeType: response.mimeType, headers: entry.headers, responseHeaders: response.headers, source: 'browser' });
        const length = Number(getHeader(response.headers, 'content-length'));
        const mime = String(response.mimeType).toLowerCase();
        entry.sniff = this.sniffCount < 80 && ['XHR', 'Fetch', 'Other'].includes(params.type) && ['text/plain', 'application/octet-stream', 'application/xml', 'text/xml', ''].includes(mime) && (!length || length <= 262144);
      } else if (method === 'Network.loadingFinished') {
        const entry = this.cdpRequests.get(requestKey);
        this.cdpRequests.delete(requestKey);
        if (!entry?.sniff || params.encodedDataLength > 262144 || this.sniffCount >= 80) return;
        this.sniffCount++;
        void debuggerApi.sendCommand('Network.getResponseBody', { requestId: params.requestId }).then(result => {
          if (this.disposed || wc.isDestroyed() || result.body.length > 350000) return;
          const body = result.base64Encoded ? Buffer.from(result.body, 'base64').toString('utf8') : result.body;
          const mimeType = sniffManifest(body);
          if (mimeType) this._addCandidate({ url: entry.url, title: wc.getTitle(), mimeType, headers: entry.headers, source: 'browser' });
        }).catch(() => {});
      } else if (method === 'Network.loadingFailed') this.cdpRequests.delete(requestKey);
    });
    void debuggerApi.sendCommand('Network.enable', { maxTotalBufferSize: 2097152, maxResourceBufferSize: 262144 }).catch(() => {});
    wc.on('did-start-navigation', (event, _url, isInPlace, isMainFrame) => { if ((event.isMainFrame ?? isMainFrame) && !(event.isSameDocument ?? isInPlace)) this.sniffCount = 0; });
  }

  async open(url) { return this.navigate(url); }

  async navigate(rawUrl) {
    const url = validateUrl(rawUrl);
    const view = this._ensureView();
    this.browser.error = '';
    this.browser.url = url;
    this.browser.loading = true;
    this._emit();
    try { await view.webContents.loadURL(url); } catch (error) {
      if (error.code !== 'ERR_ABORTED') { this.browser.error = 'Не удалось открыть страницу. Проверьте адрес и подключение.'; this.browser.loading = false; this._emit(); }
    }
    return this.getState();
  }

  back() { const wc = this.view?.webContents; if (wc && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack(); return this.getState(); }
  forward() { const wc = this.view?.webContents; if (wc && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward(); return this.getState(); }
  reload() { if (this.view) { this.browser.error = ''; this.view.webContents.reload(); } return this.getState(); }

  setBounds({ x = 0, y = 0, width = 0, height = 0, visible = false } = {}) {
    const number = value => Number.isFinite(value) ? Math.max(0, Math.min(20000, Math.round(value))) : 0;
    this.bounds = { x: number(x), y: number(y), width: number(width), height: number(height), visible: Boolean(visible) };
    if (this.view) {
      const { visible: show, ...rectangle } = this.bounds;
      this.view.setBounds(rectangle);
      this.view.setVisible(show && rectangle.width > 0 && rectangle.height > 0);
    }
    return this.getState();
  }

  clearCandidates() { this.candidates.clear(); this._emit(); return this.getState(); }

  _addCandidate(input) {
    let url;
    try { url = validateUrl(input.url); } catch { return null; }
    const detected = classifyMedia(url, input.mimeType, input.responseHeaders);
    if (!detected) return null;
    const id = crypto.createHash('sha256').update(url).digest('hex').slice(0, 24);
    const previous = this.candidates.get(id);
    const headers = { ...(previous?.headers || {}), ...(input.headers || {}) };
    if (input.referrer && !getHeader(headers, 'referer')) headers.Referer = input.referrer;
    const candidate = { id, url, host: new URL(url).hostname, title: String(input.title || this.browser.title || new URL(url).pathname.split('/').pop() || 'Видеопоток').slice(0, 300), ...detected, headers, source: input.source || 'browser' };
    if (!previous && this.candidates.size >= MAX_CANDIDATES) this.candidates.delete(this.candidates.keys().next().value);
    this.candidates.set(id, candidate);
    this._emit();
    return id;
  }

  addExternalCandidate(input) {
    if (!input || typeof input !== 'object') throw new Error('Некорректный поток.');
    const url = validateUrl(input.url);
    const rawHeaders = input.headers && typeof input.headers === 'object' && !Array.isArray(input.headers) ? input.headers : {};
    const headers = replayHeaders(rawHeaders);
    const cookie = getHeader(rawHeaders, 'cookie');
    if (cookie && cookie.length <= 32768 && !/[\r\n\0]/.test(cookie)) headers.Cookie = cookie;
    const id = this._addCandidate({ url, title: input.title, mimeType: String(input.mimeType || '').slice(0, 200), headers, source: 'extension' });
    if (!id) throw new Error('Этот адрес не похож на поддерживаемый медиапоток.');
    return { id, ...this.getState() };
  }

  async resolveCandidate(id) {
    const candidate = this.candidates.get(id);
    if (!candidate) throw new Error('Поток больше недоступен. Найдите его повторно.');
    const headers = replayHeaders(candidate.headers);
    const host = candidate.host;
    let cookies = [];
    if (candidate.source === 'browser' && this.session) cookies = (await this.session.cookies.get({})).filter(cookie => cookieMatchesHost(cookie, host));
    // External captures contain only cookies sent in this exact media request.
    const observed = getHeader(candidate.headers, 'cookie');
    if (observed) {
      for (const pair of observed.split(';')) {
        const equals = pair.indexOf('=');
        if (equals <= 0) continue;
        const name = pair.slice(0, equals).trim();
        if (!cookies.some(cookie => cookie.name === name)) cookies.push({ domain: host, hostOnly: true, path: '/', secure: candidate.url.startsWith('https:'), name, value: pair.slice(equals + 1).trim() });
      }
    }
    let cookieFile;
    if (cookies.length) {
      const directory = path.join(this.dataDir, 'capture-cookies');
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      cookieFile = path.join(directory, `${crypto.randomUUID()}.txt`);
      await fs.writeFile(cookieFile, cookieJar(cookies, host), { mode: 0o600, flag: 'wx' });
      this.cookieFiles.add(cookieFile);
    }
    return { url: candidate.url, title: candidate.title, extra: { headers, ...(cookieFile ? { cookieFile } : {}) } };
  }

  dispose() {
    this.disposed = true;
    if (this.session) {
      for (const event of ['onSendHeaders', 'onResponseStarted', 'onCompleted', 'onErrorOccurred']) this.session.webRequest[event](null);
      if (this.downloadHandler) this.session.removeListener('will-download', this.downloadHandler);
    }
    for (const child of this.popupWindows) if (!child.isDestroyed()) child.destroy();
    this.popupWindows.clear();
    this.remoteContents.clear();
    if (this.view) {
      if (!this.window.isDestroyed()) this.window.contentView.removeChildView(this.view);
      if (!this.view.webContents.isDestroyed()) this.view.webContents.close();
    }
    this.requests.clear();
    this.cdpRequests.clear();
    this.candidates.clear();
    for (const file of this.cookieFiles) fs.unlink(file).catch(() => {});
    this.cookieFiles.clear();
    this.view = null;
  }
}

module.exports = { BrowserManager, validateUrl, classifyMedia, replayHeaders, displayUrl, cookieMatchesHost, cookieJar, sniffManifest };
