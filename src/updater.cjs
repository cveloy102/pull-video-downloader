'use strict';

// In-app updates from GitHub releases (electron-updater). The installer build
// publishes latest.yml next to PULL-Setup-*.exe; the app checks it, downloads
// the new installer in the background and installs it on restart.

const CHECK_EVERY = 6 * 60 * 60 * 1000;

function createUpdater({ app, onChange = () => {}, beforeInstall = () => {}, feedUrl = process.env.PULL_UPDATE_URL, log = () => {} }) {
  const state = { status: app.isPackaged ? 'idle' : 'disabled', version: '', percent: 0, error: '', checkedAt: null };
  const set = (patch) => { Object.assign(state, patch); onChange(); };
  if (!app.isPackaged) return { getState: () => ({ ...state }), check: async () => state, install: () => false, dispose() {} };

  const { autoUpdater } = require('electron-updater');
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowDowngrade = false;
  autoUpdater.logger = { info: log, warn: log, error: log, debug: () => {} };
  // Testing hook: a local folder served over HTTP with latest.yml and an installer.
  if (feedUrl) autoUpdater.setFeedURL({ provider: 'generic', url: feedUrl });

  autoUpdater.on('checking-for-update', () => set({ status: 'checking', error: '' }));
  autoUpdater.on('update-available', (info) => set({ status: 'downloading', version: info.version, percent: 0 }));
  autoUpdater.on('update-not-available', () => set({ status: 'latest', checkedAt: new Date().toISOString() }));
  autoUpdater.on('download-progress', (p) => set({ status: 'downloading', percent: Math.round(p.percent || 0) }));
  autoUpdater.on('update-downloaded', (info) => set({ status: 'ready', version: info.version, percent: 100 }));
  // No latest.yml in the newest release simply means there is nothing to install yet.
  autoUpdater.on('error', (error) => set(/\b404\b/.test(String(error?.message)) ? { status: 'latest', checkedAt: new Date().toISOString() } : { status: 'error', error: friendly(error) }));

  let checking = null;
  async function check() {
    if (state.status === 'ready' || state.status === 'downloading') return { ...state };
    if (!checking) checking = autoUpdater.checkForUpdates().catch((error) => set({ status: 'error', error: friendly(error) })).finally(() => { checking = null; });
    await checking;
    return { ...state };
  }
  const first = setTimeout(check, 15000);
  const timer = setInterval(check, CHECK_EVERY);

  return {
    getState: () => ({ ...state }),
    check,
    install() {
      if (state.status !== 'ready') return false;
      beforeInstall();
      // Silent install, then start PULL again.
      setImmediate(() => autoUpdater.quitAndInstall(true, true));
      return true;
    },
    dispose() { clearTimeout(first); clearInterval(timer); }
  };
}

function friendly(error) {
  const text = String(error?.message || error || '');
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|net::|ERR_INTERNET|ERR_NAME/i.test(text)) return 'Нет связи с GitHub. Проверю позже.';
  if (/404|latest\.yml/i.test(text)) return 'Обновлений пока нет.';
  return 'Не удалось проверить обновления.';
}

module.exports = { createUpdater, friendly };
