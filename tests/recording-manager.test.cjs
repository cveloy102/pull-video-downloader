const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { RecordingManager } = require('../src/recording-manager.cjs');

test('recording chunks are ordered even when IPC writes overlap, and history survives restart', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pull-recording-'));
  const manager = new RecordingManager({ dataDir: root });
  const { id } = await manager.start({ directory: root, name: '../unsafe:name' });
  const chunks = Array.from({ length: 12 }, (_, i) => new Uint8Array(65536).fill(i));
  await Promise.all(chunks.map(data => manager.append({ id, data })));
  const result = await manager.finish(id);
  assert.equal(path.dirname(result.path), root);
  assert.deepEqual(await fs.readFile(result.path), Buffer.concat(chunks.map(data => Buffer.from(data))));
  const restored = new RecordingManager({ dataDir: root });
  assert.equal(restored.getState().length, 1);
  assert.equal(restored.getFile(id), result.path);
  await fs.rm(root, { recursive: true, force: true });
});

test('empty captures fail instead of reporting a successful file', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pull-recording-'));
  const manager = new RecordingManager({ dataDir: root });
  const { id } = await manager.start({ directory: root });
  await assert.rejects(manager.start({ directory: root }), /уже/);
  await assert.rejects(manager.finish(id), /Пустая/);
  assert.equal(manager.getState().length, 0);
  assert.equal(manager.isActive(), false);
  await fs.rm(root, { recursive: true, force: true });
});

test('unrecognized recordings and oversized chunks cannot write arbitrary files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pull-recording-'));
  const manager = new RecordingManager({ dataDir: root });
  const { id } = await manager.start({ directory: root });
  await assert.rejects(manager.append({ id: '../file', data: new Uint8Array(1) }), /остановлена/);
  await assert.rejects(manager.append({ id, data: new Uint8Array(32 * 1024 * 1024 + 1) }), /большой/);
  await manager.dispose();
  await fs.rm(root, { recursive: true, force: true });
});
