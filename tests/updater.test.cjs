const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createUpdater } = require('../src/updater.cjs');

test('a missing channel file is reported once and a later successful check clears it', async (t) => {
  const autoUpdater = new EventEmitter();
  const statuses = [];
  const updater = createUpdater({ app: { isPackaged: true }, feedUrl: '', updater: autoUpdater, onChange: () => statuses.push(updater.getState().status) });
  t.after(() => updater.dispose());
  autoUpdater.checkForUpdates = async () => {
    autoUpdater.emit('checking-for-update');
    const error = Object.assign(new Error('Cannot find latest.yml'), { code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' });
    autoUpdater.emit('error', error);
    throw error;
  };
  assert.equal((await updater.check()).status, 'unavailable');
  assert.deepEqual(statuses, ['checking', 'unavailable']);

  autoUpdater.checkForUpdates = async () => {
    autoUpdater.emit('checking-for-update');
    autoUpdater.emit('update-not-available');
  };
  assert.equal((await updater.check()).status, 'latest');
});

test('download, network and malformed metadata errors remain errors', async (t) => {
  const autoUpdater = new EventEmitter();
  const updater = createUpdater({ app: { isPackaged: true }, feedUrl: '', updater: autoUpdater });
  t.after(() => updater.dispose());
  for (const [error, expected] of [
    [new Error('HTTP 404: PULL-Setup.exe'), /Не удалось/],
    [new Error('ECONNREFUSED'), /Нет связи/],
    [new Error('Cannot parse latest.yml'), /Не удалось/]
  ]) {
    autoUpdater.checkForUpdates = async () => { autoUpdater.emit('checking-for-update'); throw error; };
    const state = await updater.check();
    assert.equal(state.status, 'error');
    assert.match(state.error, expected);
  }
});

test('update opens its progress window before quitting and confirms only the new version', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pull-update-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const target = '1.2.1';
  const app = version => ({ isPackaged: true, getVersion: () => version });
  const source = new EventEmitter();
  const actions = [];
  source.quitAndInstall = (silent, relaunch) => actions.push(['quit', silent, relaunch]);
  const settings = { dataDir, feedUrl: '' };
  const original = createUpdater({
    ...settings, app: app('1.2.0'), updater: source,
    openInstallWindow: async (_exe, file, version) => {
      assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).version, target);
      actions.push(['show', version]);
    }
  });
  t.after(() => original.dispose());
  source.emit('update-downloaded', { version: target });
  assert.deepEqual(await Promise.all([original.install(), original.install()]), [true, false]);
  assert.equal(source.autoInstallOnAppQuit, false);
  assert.deepEqual(actions, [['show', target], ['quit', true, true]]);
  assert.equal(original.getState().status, 'installing');
  const restartedOld = createUpdater({ ...settings, app: app('1.2.0'), updater: new EventEmitter() });
  t.after(() => restartedOld.dispose());
  restartedOld.confirmStarted();
  assert.equal(restartedOld.getState().appliedVersion, '');
  assert.equal(fs.existsSync(path.join(dataDir, 'update-pending.json')), true);
  const restartedNew = createUpdater({ ...settings, app: app(target), updater: new EventEmitter() });
  t.after(() => restartedNew.dispose());
  restartedNew.confirmStarted();
  assert.equal(restartedNew.getState().appliedVersion, target);
  assert.equal(fs.existsSync(path.join(dataDir, 'update-pending.json')), false);
});

test('a failed progress window keeps the app open and the update retryable', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pull-update-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const source = new EventEmitter();
  source.quitAndInstall = () => assert.fail('The app must stay open');
  const manager = createUpdater({
    app: { isPackaged: true }, dataDir, feedUrl: '', updater: source,
    openInstallWindow: async () => { throw new Error('Window failed'); }
  });
  t.after(() => manager.dispose());
  source.emit('update-downloaded', { version: '1.2.1' });
  await assert.rejects(manager.install(), /Window failed/);
  assert.equal(manager.getState().status, 'ready');
  assert.equal(fs.existsSync(path.join(dataDir, 'update-pending.json')), false);
});
