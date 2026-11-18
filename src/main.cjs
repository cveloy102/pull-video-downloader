const electron = require('electron');
const { app, BrowserWindow, ipcMain, dialog, shell, desktopCapturer, Menu, nativeTheme, clipboard } = electron;
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { DownloadManager } = require('./download-manager.cjs');
const { BrowserManager } = require('./browser-manager.cjs');
const { RecordingManager } = require('./recording-manager.cjs');
const { createTray } = require('./tray.cjs');

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
let quitting = false;
let extensionAvailable = false;
let extensionError = '';
let settings, tray;
const startHidden = process.argv.includes('--hidden');
// One pixel shorter than the 36px title bar so its bottom border runs under the caption buttons.
const TITLEBAR_HEIGHT = 35;
if (!app.requestSingleInstanceLock()) app.exit(0);
app.on('second-instance', () => showWindow());

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show(); mainWindow.focus();
}
function isDark() { return settings.theme === 'dark' || (settings.theme === 'system' && nativeTheme.shouldUseDarkColors); }
// Window background and the native caption buttons follow the app theme.
function applyChrome() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const dark = isDark();
  mainWindow.setBackgroundColor(windowBackground());
  try { mainWindow.setTitleBarOverlay({ color: dark ? '#0f0f10' : '#fbfbfa', symbolColor: dark ? '#ededec' : '#111111', height: TITLEBAR_HEIGHT }); } catch { /* overlay unsupported */ }
}
// Autostart runs the real executable: for the portable build that is the
// launcher file, not the temporary unpacked copy.
function applyLoginItem() {
  if (!app.isPackaged) return;
  const exe = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
  try { app.setLoginItemSettings({ openAtLogin: Boolean(settings.launchAtLogin), path: exe, args: ['--hidden'] }); } catch { /* not available */ }
}
function requestQuit() {
  if (recordings?.isActive()) {
    showWindow();
    const choice = dialog.showMessageBoxSync(mainWindow, { type: 'question', buttons: ['Продолжить запись', 'Выйти и сохранить'], defaultId: 0, cancelId: 0, title: 'Идёт запись', message: 'Выйти из PULL и сохранить записанную часть?' });
    if (choice === 1) { quitting = true; mainWindow.webContents.send('pull:before-close'); }
    return;
  }
  quitting = true; app.quit();
}
async function downloadFromClipboard() {
  // readText may be synchronous or return a promise depending on the Electron version.
  const text = String((await clipboard.readText()) || '').trim();
  showWindow();
  if (/^https?:\/\/\S+$/i.test(text)) mainWindow.webContents.send('pull:analyze', text);
  else mainWindow.webContents.send('pull:notice', 'В буфере обмена нет ссылки');
}
function pauseAll() { for (const job of downloader.getState()) if (['queued', 'downloading', 'analyzing'].includes(job.status)) downloader.pause(job.id); }
function resumeAll() { for (const job of downloader.getState()) if (job.status === 'paused' && !job.needsSource) { try { downloader.resume(job.id); } catch { /* source expired */ } } }

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
    settings: { theme: settings.theme, directory: settings.directory, quality: settings.quality, concurrency: settings.concurrency, closeToTray: settings.closeToTray, launchAtLogin: settings.launchAtLogin },
    jobs: downloader?.getState() || [],
    ...(browser?.getState() || { candidates: [], browser: {} }),
    recordings: recordings?.getState() || [],
    tools: { ready: Boolean(tools.ready), ytDlp: Boolean(tools.ytDlp), ffmpeg: Boolean(tools.ffmpeg), error: tools.error || '' },
    extension: { port: 17841, token: settings.extensionToken, available: extensionAvailable, path: extensionPath, error: extensionError }
  };
}
// Matches --bg in renderer/styles.css so the window does not flash the other theme on start.
function windowBackground() { return isDark() ? '#0f0f10' : '#fbfbfa'; }
function broadcast() {
  tray?.update();
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
    if (['dark', 'light', 'system'].includes(patch.theme)) { settings.theme = patch.theme; applyChrome(); }
    if (typeof patch.closeToTray === 'boolean') settings.closeToTray = patch.closeToTray;
    if (typeof patch.launchAtLogin === 'boolean') { settings.launchAtLogin = patch.launchAtLogin; applyLoginItem(); }
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
    theme: ['dark','light','system'].includes(saved.theme) ? saved.theme : 'light',
    closeToTray: typeof saved.closeToTray === 'boolean' ? saved.closeToTray : true,
    launchAtLogin: saved.launchAtLogin === true,
    trayHintShown: saved.trayHintShown === true,
    directory: typeof saved.directory === 'string' && path.isAbsolute(saved.directory) ? saved.directory : path.join(app.getPath('videos'), 'PULL'),
    quality: ['best','4320','2160','1440','1080','720','480'].includes(saved.quality) ? saved.quality : 'best',
    concurrency: Math.max(1, Math.min(5, Number(saved.concurrency) || 2)),
    extensionToken: typeof saved.extensionToken === 'string' && /^[a-f0-9]{48}$/.test(saved.extensionToken) ? saved.extensionToken : crypto.randomBytes(24).toString('hex')
  };
  persistSettings();
  downloader = new DownloadManager({ toolsDir, dataDir, downloadDir: settings.directory, concurrency: settings.concurrency, onChange: broadcast });
  recordings = new RecordingManager({ dataDir, onChange: broadcast, getFfmpeg: () => downloader.getTools().ffmpeg });
  const dark = isDark();
  mainWindow = new BrowserWindow({ width: 1280, height: 850, minWidth: 940, minHeight: 660, title: 'PULL', icon: path.join(__dirname, 'assets', 'pull.ico'), backgroundColor: windowBackground(), show: false,
    // The app draws its own title bar; Windows keeps the native caption buttons (snap layouts included).
    titleBarStyle: 'hidden', titleBarOverlay: { color: dark ? '#0f0f10' : '#fbfbfa', symbolColor: dark ? '#ededec' : '#111111', height: TITLEBAR_HEIGHT },
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
  mainWindow.once('ready-to-show', () => { if (!startHidden) mainWindow.show(); });
  mainWindow.on('close', event => {
    if (quitting || shuttingDown) return;
    if (settings.closeToTray) {
      // Closing hides to the tray: downloads and recordings keep running.
      event.preventDefault(); mainWindow.hide();
      if (!settings.trayHintShown && electron.Notification.isSupported()) {
        settings.trayHintShown = true; persistSettings();
        new electron.Notification({ title: 'PULL работает в фоне', body: 'Загрузки продолжаются. Открыть или выйти можно через значок в трее.', icon: path.join(__dirname, 'assets', 'pull.png') }).show();
      }
      return;
    }
    if (recordings.isActive()) {
      const choice = dialog.showMessageBoxSync(mainWindow, { type: 'question', buttons: ['Продолжить запись', 'Закрыть и сохранить'], defaultId: 0, cancelId: 0, title: 'Идёт запись', message: 'Закрыть PULL и сохранить записанную часть?' });
      event.preventDefault();
      if (choice === 1) { quitting = true; mainWindow.webContents.send('pull:before-close'); }
    }
  });
  nativeTheme.on('updated', applyChrome);
  applyLoginItem();
  tray = createTray({ electron, iconDir: path.join(__dirname, 'assets'), getJobs: () => downloader.getState(), actions: {
    show: showWindow,
    toggle: () => { if (mainWindow.isVisible() && !mainWindow.isMinimized() && mainWindow.isFocused()) mainWindow.hide(); else showWindow(); },
    shouldNotify: () => !mainWindow.isVisible() || !mainWindow.isFocused(),
    showFile: id => { const job = downloader.getState().find(item => item.id === id); if (job?.filename && fs.existsSync(job.filename)) shell.showItemInFolder(job.filename); },
    setProgress: value => { if (!mainWindow.isDestroyed()) mainWindow.setProgressBar(value); },
    downloadFromClipboard, pauseAll, resumeAll,
    openFolder: () => { fs.mkdirSync(settings.directory, { recursive: true }); shell.openPath(settings.directory); },
    quit: requestQuit
  } });
  await mainWindow.loadFile(rendererFile);
  // Electron integration tests opt in via an explicit development-only environment flag.
  if (!app.isPackaged && process.env.PULL_TEST_MODULE) require(path.resolve(process.env.PULL_TEST_MODULE))({ app, mainWindow, downloader, browser, recordings, snapshot, requestQuit, downloadFromClipboard, pauseAll, resumeAll, getSettings: () => settings });
}).catch(error => { dialog.showErrorBox('PULL не удалось запустить', error.message); app.exit(1); });

app.on('window-all-closed', () => app.quit());
app.on('before-quit', event => {
  if (shuttingDown) return;
  event.preventDefault(); shuttingDown = true; quitting = true;
  clearTimeout(broadcastTimer);
  server?.close(); browser?.dispose(); tray?.destroy();
  Promise.allSettled([Promise.resolve(downloader?.dispose()), Promise.resolve(recordings?.dispose())]).then(() => app.quit());
});
