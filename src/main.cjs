const { app, BrowserWindow, ipcMain, dialog, shell, desktopCapturer, Menu } = require('electron');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { DownloadManager } = require('./download-manager.cjs');
const { BrowserManager } = require('./browser-manager.cjs');
const { RecordingManager } = require('./recording-manager.cjs');

if (process.env.PULL_DATA_DIR) app.setPath('userData', path.resolve(process.env.PULL_DATA_DIR));
const appRoot = path.resolve(__dirname, '..');
const rendererFile = path.join(__dirname, 'renderer', 'index.html');
const rendererURL = pathToFileURL(rendererFile).href;
const dataDir = app.getPath('userData');
const resourcesDir = app.isPackaged ? process.resourcesPath : appRoot;
const toolsDir = process.env.PULL_TOOLS_DIR || path.join(resourcesDir, 'tools');
const extensionPath = app.isPackaged ? path.join(dataDir, 'browser-extension') : path.join(resourcesDir, 'extension');
let mainWindow, downloader, browser, recordings, server, selectedSource, broadcastTimer;
let shuttingDown = false;
let extensionAvailable = false;
let extensionError = '';
let settings;
if (!app.requestSingleInstanceLock()) app.exit(0);
app.on('second-instance', () => { if (mainWindow && !mainWindow.isDestroyed()) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus(); } });

function readJSON(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function persistSettings() {
  const file = path.join(dataDir, 'settings.json');
  fs.writeFileSync(file + '.tmp', JSON.stringify(settings, null, 2));
  fs.renameSync(file + '.tmp', file);
}
function snapshot() {
  const tools = downloader?.getTools() || {};
  return {
    version: app.getVersion(),
    settings: { theme: settings.theme, directory: settings.directory, quality: settings.quality, concurrency: settings.concurrency },
    jobs: downloader?.getState() || [],
    ...(browser?.getState() || { candidates: [], browser: {} }),
    recordings: recordings?.getState() || [],
    tools: { ready: Boolean(tools.ready), ytDlp: Boolean(tools.ytDlp), ffmpeg: Boolean(tools.ffmpeg), error: tools.error || '' },
    extension: { port: 17841, token: settings.extensionToken, available: extensionAvailable, path: extensionPath, error: extensionError }
  };
}
function broadcast() {
  if (broadcastTimer || shuttingDown) return;
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('pull:state', snapshot());
  }, 100);
}
function assertLocal(event) {
  if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame || event.senderFrame.url !== rendererURL) throw new Error('Недоверенный источник команды.');
}
function handle(name, fn) {
  ipcMain.handle('pull:' + name, async (event, ...args) => { assertLocal(event); return fn(...args); });
}
function jobForFile(id) {
  const job = downloader.getState().find(item => item.id === id);
  if (!job || job.status !== 'completed' || !job.filename || !fs.existsSync(job.filename)) throw new Error('Файл не найден. Возможно, он был перемещён.');
  return job;
}
async function openLocal(file) { const error = await shell.openPath(file); if (error) throw new Error(error); }

function registerIPC() {
  handle('getState', snapshot);
  handle('analyze', url => downloader.analyze(url));
  handle('download', input => {
    if (!input || typeof input !== 'object') throw new Error('Не указана ссылка.');
    return downloader.add({ url: input.url, formatId: input.formatId, quality: input.quality || settings.quality, audioOnly: Boolean(input.audioOnly), title: input.title });
  });
  handle('pauseDownload', id => downloader.pause(id));
  handle('resumeDownload', id => downloader.resume(id));
  handle('cancelDownload', id => downloader.cancel(id));
  handle('removeDownload', id => downloader.remove(id));
  handle('openFile', id => openLocal(jobForFile(id).filename));
  handle('showFile', id => { shell.showItemInFolder(jobForFile(id).filename); });
  handle('chooseFolder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, { title: 'Куда сохранять видео', defaultPath: settings.directory, properties: ['openDirectory', 'createDirectory'] });
    if (!result.canceled && result.filePaths[0]) {
      settings.directory = result.filePaths[0]; downloader.setDirectory(settings.directory); persistSettings(); broadcast();
    }
    return settings.directory;
  });
  handle('updateSettings', patch => {
    if (!patch || typeof patch !== 'object') throw new Error('Некорректные настройки.');
    if (['dark', 'light', 'system'].includes(patch.theme)) settings.theme = patch.theme;
    if (['best', '4320', '2160', '1440', '1080', '720', '480'].includes(String(patch.quality))) settings.quality = String(patch.quality);
    if (patch.concurrency !== undefined) { settings.concurrency = Math.max(1, Math.min(5, Math.round(Number(patch.concurrency) || 2))); downloader.setConcurrency(settings.concurrency); }
    persistSettings(); broadcast(); return snapshot().settings;
  });
  handle('openBrowser', url => browser.open(url));
  handle('navigateBrowser', url => browser.navigate(url));
  handle('browserBack', () => browser.back());
  handle('browserForward', () => browser.forward());
  handle('browserReload', () => browser.reload());
  handle('setBrowserBounds', bounds => browser.setBounds(bounds));
  handle('clearCandidates', () => browser.clearCandidates());
  handle('downloadCandidate', async input => {
    if (!input || typeof input.id !== 'string') throw new Error('Не выбрано видео.');
    const candidate = await browser.resolveCandidate(input.id);
    return downloader.add({ ...candidate, quality: input.quality || settings.quality, audioOnly: Boolean(input.audioOnly) });
  });
  handle('getCaptureSources', async () => {
    const sources = await desktopCapturer.getSources({ types: ['window', 'screen'], thumbnailSize: { width: 280, height: 158 }, fetchWindowIcons: false });
    return sources.map(source => ({ id: source.id, name: source.name, thumbnail: source.thumbnail.toDataURL() }));
  });
  handle('selectCaptureSource', async id => {
    const sources = await desktopCapturer.getSources({ types: ['window', 'screen'], thumbnailSize: { width: 0, height: 0 } });
    if (!sources.some(source => source.id === id)) throw new Error('Окно уже закрыто. Обнови список.');
    selectedSource = { id, expires: Date.now() + 60000 }; return true;
  });
  handle('startRecording', options => recordings.start({ name: options?.name, directory: settings.directory }));
  handle('appendRecording', input => recordings.append(input));
  handle('finishRecording', input => recordings.finish(input?.id));
  handle('openRecording', id => openLocal(recordings.getFile(id)));
  handle('showRecording', id => { shell.showItemInFolder(recordings.getFile(id)); });
  handle('openExtensionFolder', () => openLocal(extensionPath));
  handle('confirmClose', async () => {
    if (recordings.isActive()) await recordings.dispose();
    mainWindow.close();
  });
}

function startExtensionBridge() {
  server = http.createServer((req, res) => {
    const origin = req.headers.origin;
    if (origin && !/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) { res.writeHead(403).end(); return; }
    if (origin) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Pull-Token'); res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Private-Network', 'true'); res.writeHead(204).end(); return;
    }
    const supplied = Buffer.from(String(req.headers['x-pull-token'] || ''));
    const expected = Buffer.from(settings.extensionToken);
    if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) { res.writeHead(401).end('Pairing required'); return; }
    if (req.method === 'GET' && req.url === '/health') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ app: 'PULL', version: app.getVersion() })); return; }
    if (req.method !== 'POST' || req.url !== '/candidate') { res.writeHead(404).end(); return; }
    let size = 0; const chunks = [];
    req.on('data', chunk => { size += chunk.length; if (size > 262144) { res.writeHead(413).end(); req.destroy(); } else chunks.push(chunk); });
    req.on('end', async () => {
      try {
        const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        await browser.addExternalCandidate(input);
        res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true }));
        broadcast();
      } catch { if (!res.headersSent) res.writeHead(400); res.end('Invalid media candidate'); }
    });
  });
  server.requestTimeout = 10000;
  server.on('error', err => { extensionAvailable = false; extensionError = err.code === 'EADDRINUSE' ? 'Порт 17841 занят. Закрой другую копию PULL.' : 'Не удалось подключить расширение.'; broadcast(); });
  server.listen(17841, '127.0.0.1', () => { extensionAvailable = true; broadcast(); });
}

app.whenReady().then(async () => {
  fs.mkdirSync(dataDir, { recursive: true });
  if (app.isPackaged) fs.cpSync(path.join(resourcesDir, 'extension'), extensionPath, { recursive: true });
  const saved = readJSON(path.join(dataDir, 'settings.json'), {});
  settings = {
    theme: ['dark','light','system'].includes(saved.theme) ? saved.theme : 'dark',
    directory: typeof saved.directory === 'string' && path.isAbsolute(saved.directory) ? saved.directory : path.join(app.getPath('videos'), 'PULL'),
    quality: ['best','4320','2160','1440','1080','720','480'].includes(saved.quality) ? saved.quality : 'best',
    concurrency: Math.max(1, Math.min(5, Number(saved.concurrency) || 2)),
    extensionToken: typeof saved.extensionToken === 'string' && /^[a-f0-9]{48}$/.test(saved.extensionToken) ? saved.extensionToken : crypto.randomBytes(24).toString('hex')
  };
  persistSettings();
  downloader = new DownloadManager({ toolsDir, dataDir, downloadDir: settings.directory, concurrency: settings.concurrency, onChange: broadcast });
  recordings = new RecordingManager({ dataDir, onChange: broadcast });
  mainWindow = new BrowserWindow({ width: 1280, height: 850, minWidth: 940, minHeight: 660, title: 'PULL', icon: path.join(__dirname, 'assets', 'pull.ico'), backgroundColor: '#111312', show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, spellcheck: false }
  });
  Menu.setApplicationMenu(null);
  browser = new BrowserManager({ window: mainWindow, dataDir, onChange: broadcast });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', event => event.preventDefault());
  const uiSession = mainWindow.webContents.session;
  const localPermissions = ['media','display-capture','clipboard-read','clipboard-sanitized-write','clipboard-write'];
  uiSession.setPermissionRequestHandler((wc, permission, callback) => callback(wc === mainWindow.webContents && localPermissions.includes(permission)));
  uiSession.setPermissionCheckHandler((wc, permission) => wc === mainWindow.webContents && localPermissions.includes(permission));
  uiSession.setDisplayMediaRequestHandler(async (request, callback) => {
    const selection = selectedSource; selectedSource = null;
    if (request.frame !== mainWindow.webContents.mainFrame || request.frame.url !== rendererURL || !selection || selection.expires < Date.now()) { callback({}); return; }
    try {
      const sources = await desktopCapturer.getSources({ types: ['window','screen'], thumbnailSize: { width: 0, height: 0 } });
      const source = sources.find(item => item.id === selection.id);
      callback(source ? { video: source, audio: 'loopback' } : {});
    } catch { callback({}); }
  });
  registerIPC(); startExtensionBridge();
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('close', event => {
    if (!shuttingDown && recordings.isActive()) {
      const choice = dialog.showMessageBoxSync(mainWindow, { type: 'question', buttons: ['Продолжить запись', 'Закрыть и сохранить'], defaultId: 0, cancelId: 0, title: 'Идёт запись', message: 'Закрыть PULL и сохранить записанную часть?' });
      event.preventDefault();
      if (choice === 1) mainWindow.webContents.send('pull:before-close');
    }
  });
  await mainWindow.loadFile(rendererFile);
  // Electron integration tests opt in via an explicit development-only environment flag.
  if (!app.isPackaged && process.env.PULL_TEST_MODULE) require(path.resolve(process.env.PULL_TEST_MODULE))({ app, mainWindow, downloader, browser, recordings, snapshot });
}).catch(error => { dialog.showErrorBox('PULL не удалось запустить', error.message); app.exit(1); });

app.on('window-all-closed', () => app.quit());
app.on('before-quit', event => {
  if (shuttingDown) return;
  event.preventDefault(); shuttingDown = true;
  clearTimeout(broadcastTimer);
  server?.close(); browser?.dispose();
  Promise.allSettled([Promise.resolve(downloader?.dispose()), Promise.resolve(recordings?.dispose())]).then(() => app.quit());
});
