'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');

// In-app updates from GitHub releases (electron-updater). The installer build
// publishes latest.yml next to PULL-Setup-*.exe; the app checks it, downloads
// the new installer in the background and installs it on restart.

const CHECK_EVERY = 6 * 60 * 60 * 1000;
const INSTALL_TIMEOUT = 4 * 60 * 1000;

function readPending(file) {
  if (!file) return null;
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return typeof value?.version === 'string' && Number.isFinite(value.startedAt) ? value : null;
  } catch { return null; }
}

async function showInstallWindow(executable, marker, version) {
  if (!executable || !marker) throw new Error('Не удалось открыть окно обновления.');
  const helper = path.join(path.dirname(marker), 'PULL-UpdateWindow.exe');
  const visible = marker + '.visible';
  fs.rmSync(visible, { force: true });
  fs.copyFileSync(executable, helper);
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(helper, ['--update-window', marker, version, visible], { detached: true, stdio: 'ignore' });
      child.once('error', reject);
      child.once('spawn', () => { child.unref(); resolve(); });
    });
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(visible) && Date.now() < deadline) await delay(50);
    if (!fs.existsSync(visible)) throw new Error('Окно установки обновления не открылось.');
  } finally {
    fs.rmSync(visible, { force: true });
  }
}

function createUpdater({
  app, dataDir, progressExecutable, onChange = () => {}, beforeInstall = () => {},
  feedUrl = process.env.PULL_UPDATE_URL, log = () => {}, updater, openInstallWindow = showInstallWindow
}) {
  const state = { status: app.isPackaged ? 'idle' : 'disabled', version: '', percent: 0, error: '', checkedAt: null, appliedVersion: '' };
  const set = (patch) => { Object.assign(state, patch); onChange(); };
  if (!app.isPackaged) return { getState: () => ({ ...state }), check: async () => state, install: () => false, confirmStarted() {}, dispose() {} };

  const marker = dataDir && path.join(dataDir, 'update-pending.json');
  const runningVersion = app.getVersion?.();
  const pending = readPending(marker);
  function clearPending() {
    if (!marker) return;
    try { fs.unlinkSync(marker); } catch (error) { if (error.code !== 'ENOENT') log(error.message); }
  }
  const autoUpdater = updater ?? require('electron-updater').autoUpdater;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowDowngrade = false;
  autoUpdater.logger = { info: log, warn: log, error: log, debug: () => {} };
  // Testing hook: a local folder served over HTTP with latest.yml and an installer.
  if (feedUrl) autoUpdater.setFeedURL({ provider: 'generic', url: feedUrl });

  autoUpdater.on('checking-for-update', () => set({ status: 'checking', error: '' }));
  autoUpdater.on('update-available', (info) => set({ status: 'downloading', version: info.version, percent: 0 }));
  autoUpdater.on('update-not-available', () => set({ status: 'latest', checkedAt: new Date().toISOString() }));
  autoUpdater.on('download-progress', (p) => set({ status: 'downloading', percent: Math.round(p.percent || 0) }));
  autoUpdater.on('update-downloaded', (info) => set({ status: 'ready', version: info.version, percent: 100 }));
  function reportError(error) {
    if (state.status === 'installing') {
      clearPending();
      set({ status: 'ready', error: 'Не удалось запустить установку обновления. Попробуйте ещё раз.' });
      return;
    }
    const missingChannel = error?.code === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND';
    const status = missingChannel ? 'unavailable' : 'error';
    const message = missingChannel ? '' : friendly(error);
    // electron-updater can emit an error and reject the same check.
    if (state.status !== status || state.error !== message) {
      set({ status, error: message, checkedAt: new Date().toISOString() });
    }
  }
  autoUpdater.on('error', reportError);

  let checking = null;
  async function check() {
    if (['ready', 'downloading', 'installing'].includes(state.status)) return { ...state };
    if (!checking) checking = autoUpdater.checkForUpdates().catch(reportError).finally(() => { checking = null; });
    await checking;
    return { ...state };
  }
  const first = setTimeout(check, 15000);
  const timer = setInterval(check, CHECK_EVERY);

  return {
    getState: () => ({ ...state }),
    check,
    async install() {
      if (state.status !== 'ready') return false;
      await beforeInstall();
      if (state.status !== 'ready') return false;
      const version = state.version;
      set({ status: 'installing', error: '' });
      try {
        if (!marker || !version) throw new Error('Не удалось подготовить обновление.');
        fs.writeFileSync(marker, JSON.stringify({ version, startedAt: Date.now() }));
        await openInstallWindow(progressExecutable, marker, version);
        autoUpdater.quitAndInstall(true, true);
        return state.status === 'installing';
      } catch (error) {
        clearPending();
        set({ status: 'ready' });
        throw error;
      }
    },
    confirmStarted() {
      if (!pending) return;
      if (pending.version === runningVersion && !state.appliedVersion) {
        clearPending();
        set({ appliedVersion: runningVersion });
      } else if (Date.now() - pending.startedAt > INSTALL_TIMEOUT) {
        clearPending();
      }
    },
    dispose() { clearTimeout(first); clearInterval(timer); }
  };
}

function friendly(error) {
  const text = String(error?.message || error || '');
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|net::|ERR_INTERNET|ERR_NAME/i.test(text)) return 'Нет связи с GitHub. Проверю позже.';
  return 'Не удалось проверить обновления.';
}

module.exports = { createUpdater, friendly };
