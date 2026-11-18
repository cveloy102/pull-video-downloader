const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

// MediaRecorder writes WebM without a duration or seek index (Cues), so players
// cannot seek in it. A lossless FFmpeg stream copy adds both in seconds.
function remux(ffmpeg, file, { spawnProcess = spawn, timeout = 10 * 60 * 1000 } = {}) {
  const temporary = `${file}.remux.webm`;
  return new Promise((resolve) => {
    let child, timer, done = false;
    const finish = async (ok) => {
      if (done) return;
      done = true; clearTimeout(timer);
      try {
        if (ok && (await fsp.stat(temporary)).size > 0) { await fsp.rename(temporary, file); resolve(true); return; }
      } catch { /* fall through: keep the original recording */ }
      await fsp.unlink(temporary).catch(() => {});
      resolve(false);
    };
    try {
      child = spawnProcess(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', file, '-map', '0', '-c', 'copy', '-f', 'webm', temporary], { shell: false, windowsHide: true, stdio: 'ignore' });
    } catch { finish(false); return; }
    timer = setTimeout(() => { try { child.kill(); } catch {} finish(false); }, timeout);
    child.on('error', () => finish(false));
    child.on('close', (code) => finish(code === 0));
  });
}

class RecordingManager {
  constructor({ dataDir, onChange = () => {}, getFfmpeg = () => null, spawnProcess = spawn }) {
    this.dataDir = dataDir; this.onChange = onChange; this.active = new Map();
    this.getFfmpeg = getFfmpeg; this._spawn = spawnProcess;
    try { this.history = JSON.parse(fs.readFileSync(path.join(dataDir, 'recordings.json'), 'utf8')); if (!Array.isArray(this.history)) this.history = []; } catch { this.history = []; }
  }
  getState() { return this.history.map(item => ({ ...item })); }
  isActive() { return this.active.size > 0; }
  async start({ name, directory }) {
    if (this.isActive()) throw new Error('Запись уже идёт.');
    await fsp.mkdir(directory, { recursive: true });
    const id = crypto.randomUUID();
    const title = String(name || 'Запись').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim().slice(0, 80) || 'Запись';
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(directory, `${title} ${timestamp}.webm`);
    const handle = await fsp.open(file, 'wx');
    this.active.set(id, { id, title, path: file, handle, bytes: 0, chain: Promise.resolve() });
    return { id };
  }
  async append({ id, data } = {}) {
    const item = this.active.get(id);
    if (!item || item.finishing) throw new Error('Запись уже остановлена.');
    if (!(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data)) throw new Error('Некорректный фрагмент записи.');
    const buffer = data instanceof ArrayBuffer ? Buffer.from(data) : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    if (buffer.length > 32 * 1024 * 1024) throw new Error('Слишком большой фрагмент записи.');
    item.chain = item.chain.then(async () => {
      let offset = 0;
      while (offset < buffer.length) { const { bytesWritten } = await item.handle.write(buffer, offset, buffer.length - offset, null); if (!bytesWritten) throw new Error('Не удалось записать файл.'); offset += bytesWritten; }
      item.bytes += buffer.length;
    });
    await item.chain;
    return { bytes: item.bytes };
  }
  async finish(id) {
    const item = this.active.get(id);
    if (!item) { const existing = this.history.find(record => record.id === id); if (existing) return { path: existing.path }; throw new Error('Запись не найдена.'); }
    if (item.finishPromise) return item.finishPromise;
    item.finishing = true;
    item.finishPromise = (async () => {
      let failure;
      try { await item.chain; await item.handle.sync(); } catch (error) { failure = error; }
      await item.handle.close(); this.active.delete(id);
      if (!item.bytes) { await fsp.unlink(item.path).catch(() => {}); throw failure || new Error('Пустая запись: видео не поступило.'); }
      let bytes = item.bytes;
      let ffmpeg = null;
      try { ffmpeg = this.getFfmpeg(); } catch { /* recording stays as written */ }
      if (ffmpeg && await remux(ffmpeg, item.path, { spawnProcess: this._spawn })) {
        bytes = await fsp.stat(item.path).then((stat) => stat.size, () => bytes);
      }
      this.history.unshift({ id, title: item.title, path: item.path, bytes, date: new Date().toISOString(), status: failure ? 'partial' : 'completed' });
      this.history = this.history.slice(0, 100);
      await fsp.writeFile(path.join(this.dataDir, 'recordings.json'), JSON.stringify(this.history, null, 2)); this.onChange();
      if (failure) throw new Error('Сохранена только часть записи: ' + failure.message);
      return { path: item.path };
    })();
    return item.finishPromise;
  }
  getFile(id) { const item = this.history.find(record => record.id === id); if (!item || !fs.existsSync(item.path)) throw new Error('Запись не найдена.'); return item.path; }
  async dispose() { await Promise.allSettled([...this.active.keys()].map(id => this.finish(id))); }
}
module.exports = { RecordingManager, remux };
