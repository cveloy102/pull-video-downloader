const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');

class RecordingManager {
  constructor({ dataDir, onChange = () => {} }) {
    this.dataDir = dataDir; this.onChange = onChange; this.active = new Map();
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
      this.history.unshift({ id, title: item.title, path: item.path, bytes: item.bytes, date: new Date().toISOString(), status: failure ? 'partial' : 'completed' });
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
module.exports = { RecordingManager };
