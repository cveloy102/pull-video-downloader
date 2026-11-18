'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { DownloadManager, _internals } = require('../src/download-manager.cjs');

const tick = () => new Promise((resolve) => setImmediate(resolve));

function fixture(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pull-engine-test-'));
  const toolsDir = path.join(root, 'tools'), dataDir = path.join(root, 'data'), downloadDir = path.join(root, 'downloads');
  fs.mkdirSync(toolsDir, { recursive: true });
  for (const name of ['yt-dlp', 'ffmpeg', 'ffprobe', 'node']) fs.writeFileSync(path.join(toolsDir, name + (process.platform === 'win32' ? '.exe' : '')), 'test');
  const children = [];
  const spawnProcess = (executable, args, spawnOptions) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = null;
    child.executable = executable; child.args = args; child.options = spawnOptions;
    child.kill = () => { setImmediate(() => child.emit('close', null)); };
    children.push(child); return child;
  };
  const manager = new DownloadManager({ toolsDir, dataDir, downloadDir, spawnProcess, ...options });
  return { manager, root, children, dataDir, downloadDir, cleanup() { manager.dispose(); fs.rmSync(root, { recursive: true, force: true }); } };
}

test('URLs and format IDs cannot inject downloader options', () => {
  for (const invalid of ['file:///C:/secret', 'javascript:alert(1)', '--exec calc', 'https://u:p@example.com/', 'https://x.test/\n--exec calc']) {
    assert.throws(() => _internals.validateUrl(invalid), { code: 'INVALID_URL' });
  }
  assert.equal(_internals.validateUrl(' https://example.com/watch?v=123 '), 'https://example.com/watch?v=123');
  assert.throws(() => _internals.formatSelection({ formatId: '137;--exec' }), { code: 'INVALID_FORMAT' });
  assert.equal(_internals.formatSelection({ formatId: '137' }, [{ id: '137', vcodec: 'avc1', acodec: 'none' }]), '137+bestaudio/137');
  assert.equal(_internals.formatSelection({ formatId: '18' }, [{ id: '18', vcodec: 'avc1', acodec: 'aac' }]), '18');
  assert.equal(_internals.formatSelection({ quality: '720p' }), 'bestvideo*[height<=720]+bestaudio/best[height<=720]');
});

test('queue enforces concurrency and finishes only with a real final output', async () => {
  const f = fixture({ concurrency: 2 });
  try {
    const first = f.manager.add({ url: 'https://example.com/one' });
    f.manager.add({ url: 'https://example.com/two' });
    f.manager.add({ url: 'https://example.com/three' });
    await tick();
    assert.equal(f.children.length, 2);
    assert.equal(f.manager.getState().filter((job) => job.status === 'queued').length, 1);
    assert.equal(f.children[0].options.shell, false);
    assert.deepEqual(f.children[0].args.slice(-2), ['--', 'https://example.com/one']);
    const finalFile = path.join(f.downloadDir, 'final.mp4'); fs.writeFileSync(finalFile, 'video');
    f.children[0].stdout.write('__PULL_PROGRESS__{"downloaded_bytes":50,"total_bytes":100,"speed":25,"eta":2}\n');
    assert.equal(f.manager.getState().find((job) => job.id === first.id).progress, 50);
    f.children[0].stdout.write(`__PULL_FILE__${JSON.stringify(finalFile)}\n`);
    f.children[0].emit('close', 0);
    assert.equal(f.manager.getState().find((job) => job.id === first.id).status, 'completed');
    assert.equal(f.children.length, 3);
    f.children[1].emit('close', 0);
    assert.equal(f.manager.getState().find((job) => job.url.endsWith('/two')).status, 'error');
  } finally { f.cleanup(); }
});

test('explicit audio format is passed to yt-dlp and remains subject to validation', async () => {
  const f = fixture();
  try {
    assert.throws(() => f.manager.add({ url: 'https://example.com/music', audioOnly: true, formatId: '140;--exec' }), { code: 'INVALID_FORMAT' });
    f.manager.add({ url: 'https://example.com/music', audioOnly: true, formatId: '140' });
    await tick();
    const args = f.children[0].args;
    assert.equal(args[args.indexOf('--format') + 1], '140');
    assert.ok(args.includes('--extract-audio'));
    assert.equal(args[args.indexOf('--audio-format') + 1], 'best');
  } finally { f.cleanup(); }
});

test('pause and immediate resume wait for the old process to exit', async () => {
  const f = fixture({ concurrency: 1 });
  try {
    const job = f.manager.add({ url: 'https://example.com/video' }); await tick();
    assert.equal(f.manager.pause(job.id), true);
    assert.equal(f.manager.resume(job.id), true);
    assert.equal(f.children.length, 1);
    await tick();
    assert.equal(f.children.length, 2);
    assert.equal(f.manager.getState()[0].status, 'downloading');
    assert.ok(f.children[1].args.includes('--continue'));
  } finally { f.cleanup(); }
});

test('analysis returns supported formats and fails on nonzero exit', async () => {
  const f = fixture();
  try {
    const promise = f.manager.analyze('https://example.com/video');
    f.children[0].stdout.write(JSON.stringify({ title: 'Video', duration: 12, formats: [{ format_id: '137', height: 1080, ext: 'mp4', vcodec: 'avc1', acodec: 'none' }, { format_id: 'drm', has_drm: true }] }));
    f.children[0].emit('close', 0);
    const result = await promise;
    assert.equal(result.title, 'Video'); assert.equal(result.formats.length, 1); assert.equal(result.formats[0].resolution, '1080p');
    const failed = f.manager.analyze('https://example.com/private');
    f.children[1].stderr.write('ERROR: 403 Forbidden https://example.com/private?token=secret');
    f.children[1].emit('close', 1);
    await assert.rejects(failed, { code: 'AUTH_REQUIRED' });
  } finally { f.cleanup(); }
});

test('analysis timeout terminates the subprocess and returns a structured error', async () => {
  const f = fixture({ analysisTimeout: 10 });
  try { await assert.rejects(f.manager.analyze('https://example.com/slow'), { code: 'TIMEOUT' }); }
  finally { f.cleanup(); }
});

test('history and UI never expose session headers, cookie paths or signed queries', async () => {
  const f = fixture();
  try {
    const cookieFile = path.join(f.dataDir, 'capture.cookies.txt'); fs.writeFileSync(cookieFile, 'cookie_secret');
    const job = f.manager.add({ url: 'https://example.com/stream.m3u8?token=url_secret', extra: { headers: { Authorization: 'Bearer header_secret', Cookie: 'sid=cookie_secret' }, cookieFile } });
    f.manager.pause(job.id);
    const state = JSON.stringify(f.manager.getState());
    const history = fs.readFileSync(path.join(f.dataDir, 'downloads.json'), 'utf8');
    for (const secret of ['url_secret', 'header_secret', 'cookie_secret', 'capture.cookies.txt']) {
      assert.ok(!state.includes(secret)); assert.ok(!history.includes(secret));
    }
    assert.ok(fs.existsSync(cookieFile), 'pause preserves cookies for resume');
    f.manager.cancel(job.id);
    assert.ok(!fs.existsSync(cookieFile), 'cancel removes only our temporary cookies');
    assert.throws(() => f.manager.resume(job.id), { code: 'SOURCE_EXPIRED' });
  } finally { f.cleanup(); }
});

test('download failures are not marked complete and retain resume state', async () => {
  const f = fixture();
  try {
    const job = f.manager.add({ url: 'https://example.com/video' }); await tick();
    f.children[0].stderr.write('ERROR: network failed for https://cdn.example.com/video?token=do_not_expose\n');
    f.children[0].emit('close', 1);
    const failed = f.manager.getState()[0];
    assert.equal(failed.status, 'error'); assert.ok(!failed.error.includes('do_not_expose'));
    assert.equal(f.manager.resume(job.id), true); assert.equal(f.children.length, 2);
    assert.ok(fs.existsSync(path.join(f.downloadDir, '.pull-parts', job.id)));
  } finally { f.cleanup(); }
});

test('auth errors are recognized only in context', () => {
  assert.equal(_internals.describeError('ERROR: HTTP Error 403: Forbidden').code, 'AUTH_REQUIRED');
  assert.equal(_internals.describeError('ERROR: [youtube] abc: Sign in to confirm you are not a bot. Use --cookies-from-browser or --cookies').code, 'AUTH_REQUIRED');
  assert.notEqual(_internals.describeError('ERROR: unable to download video 14031 fragment').code, 'AUTH_REQUIRED');
  assert.notEqual(_internals.describeError('ERROR: Unable to write file: extracting cookies failed? no').code, 'AUTH_REQUIRED');
});

test('warnings do not replace the real download error', async () => {
  const f = fixture();
  try {
    f.manager.add({ url: 'https://example.com/video' }); await tick();
    f.children[0].stderr.write('WARNING: [generic] Falling back on generic information extractor; cookies may help\n');
    f.children[0].stderr.write('ERROR: Unable to download webpage: connection reset\n');
    f.children[0].emit('close', 1);
    const failed = f.manager.getState()[0];
    assert.equal(failed.errorCode, 'DOWNLOAD_FAILED');
    assert.match(failed.error, /connection reset/);
  } finally { f.cleanup(); }
});

test('temporary fragments are removed after completion and cancel, kept after errors', async () => {
  const f = fixture({ concurrency: 1 });
  const waitGone = async (dir) => { for (let i = 0; i < 50 && fs.existsSync(dir); i++) await new Promise((r) => setTimeout(r, 20)); };
  try {
    const done = f.manager.add({ url: 'https://example.com/done' }); await tick();
    const doneParts = path.join(f.downloadDir, '.pull-parts', done.id);
    fs.writeFileSync(path.join(doneParts, 'chunk.part'), 'x');
    const finalFile = path.join(f.downloadDir, 'done.mp4'); fs.writeFileSync(finalFile, 'video');
    f.children[0].stdout.write(`__PULL_FILE__${JSON.stringify(finalFile)}\n`);
    f.children[0].emit('close', 0);
    await waitGone(doneParts);
    assert.ok(!fs.existsSync(doneParts), 'completed job leaves no fragments');
    assert.ok(fs.existsSync(finalFile), 'final file is untouched');

    const paused = f.manager.add({ url: 'https://example.com/paused' }); await tick();
    const pausedParts = path.join(f.downloadDir, '.pull-parts', paused.id);
    f.manager.pause(paused.id); f.children[1].emit('close', null);
    assert.ok(fs.existsSync(pausedParts), 'paused job keeps fragments for resume');
    f.manager.cancel(paused.id);
    await waitGone(pausedParts);
    assert.ok(!fs.existsSync(pausedParts), 'cancel removes fragments');
  } finally { f.cleanup(); }
});

test('history keeps ordinary query parameters so jobs stay resumable', async () => {
  const f = fixture();
  try {
    f.manager.add({ url: 'https://example.com/watch?v=abc&list=PL1&t=30' });
    f.manager.add({ url: 'https://cdn.example.com/v.mp4?Expires=1&Signature=s3cret' });
    const history = JSON.parse(fs.readFileSync(path.join(f.dataDir, 'downloads.json'), 'utf8'));
    const plain = history.find((job) => job.url.includes('watch'));
    const signed = history.find((job) => job.url.includes('cdn'));
    assert.equal(plain.url, 'https://example.com/watch?v=abc&list=PL1&t=30');
    assert.equal(plain.requiresSession, false);
    assert.equal(signed.requiresSession, true);
    assert.ok(!signed.url.includes('s3cret'));
  } finally { f.cleanup(); }
});
