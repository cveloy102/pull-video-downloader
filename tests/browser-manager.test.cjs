'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { BrowserManager, classifyMedia, validateUrl, displayUrl, replayHeaders, cookieMatchesHost, cookieJar, sniffManifest } = require('../src/browser-manager.cjs');

test('detects signed manifests, extensionless XHR media and avoids adaptive fragments', () => {
  assert.equal(classifyMedia('https://cdn.example/stream.m3u8?signature=x').kind, 'hls');
  assert.equal(classifyMedia('https://cdn.example/get?id=123', 'application/dash+xml; charset=UTF-8').kind, 'dash');
  assert.equal(classifyMedia('https://cdn.example/playback', 'video/webm').kind, 'video');
  assert.equal(classifyMedia('https://cdn.example/stream.ism/Manifest?sig=abc').kind, 'mss');
  assert.equal(classifyMedia('https://cdn.example/segment-23.mp4', 'video/mp4'), null);
  assert.equal(classifyMedia('https://cdn.example/43.m4s', 'video/mp4'), null);
  assert.equal(classifyMedia('https://cdn.example/pixel.mp4', 'video/mp4', { 'Content-Length': ['512'] }), null);
  assert.equal(classifyMedia('https://cdn.example/video.mp4', 'video/mp4', { 'Content-Length': ['2'], 'Content-Range': ['bytes 0-1/900000'] }).kind, 'video');
});

test('bounded manifest sniffing identifies mislabeled HLS, DASH and MSS only', () => {
  assert.equal(sniffManifest('\uFEFF#EXTM3U\n#EXT-X-VERSION:3\n'), 'application/vnd.apple.mpegurl');
  assert.equal(sniffManifest('<?xml version="1.0"?><MPD xmlns="urn:mpeg:dash:schema:mpd:2011">'), 'application/dash+xml');
  assert.equal(sniffManifest('<SmoothStreamingMedia MajorVersion="2">'), 'application/vnd.ms-sstr+xml');
  assert.equal(sniffManifest('ordinary application data'), null);
  assert.equal(sniffManifest('#EXTM3U' + 'x'.repeat(262144)), null);
});

test('rejects privileged URLs and URL credentials; redacts query without modifying source', () => {
  for (const url of ['file:///C:/secret', 'javascript:alert(1)', 'data:text/html,test', 'https://user:password@site.example/']) assert.throws(() => validateUrl(url));
  const url = 'https://cdn.example/movie.mp4?token=secret&signature=abc';
  assert.equal(validateUrl(url), url);
  assert.equal(displayUrl(url), 'https://cdn.example/movie.mp4?…');
});

test('replay headers omit global cookies, byte ranges and malformed values', () => {
  assert.deepEqual(replayHeaders({ Authorization: 'Bearer good', Referer: 'https://site.example/', Cookie: 'session=secret', Range: 'bytes=0-10', Host: 'evil.example', 'X-Token': 'test', 'X-Bad': 'first\r\nsecond', 'X-Pull-Token': 'local-secret' }), { Authorization: 'Bearer good', Referer: 'https://site.example/', 'X-Token': 'test' });
});

test('cookie domain boundaries and Netscape format keep secrets scoped', () => {
  assert.equal(cookieMatchesHost({ domain: '.example.com', hostOnly: false }, 'cdn.example.com'), true);
  assert.equal(cookieMatchesHost({ domain: '.example.com', hostOnly: false }, 'notexample.com'), false);
  assert.equal(cookieMatchesHost({ domain: 'example.com', hostOnly: true }, 'cdn.example.com'), false);
  const jar = cookieJar([{ domain: '.example.com', hostOnly: false, name: 'session', value: 'abc', httpOnly: true, secure: true, path: '/' }, { domain: 'unrelated.com', name: 'secret', value: 'no' }], 'cdn.example.com');
  assert.match(jar, /#HttpOnly_\.example\.com\tTRUE\t\/\tTRUE\t0\tsession\tabc/);
  assert.doesNotMatch(jar, /unrelated|secret/);
});

test('external candidates keep signed URL and credentials private until selected', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pull-browser-test-'));
  const browser = new BrowserManager({ window: null, dataDir });
  const url = 'https://cdn.example/get/video.mp4?token=original';
  try {
    const result = browser.addExternalCandidate({ url, title: 'Video', headers: { Cookie: 'sid=123', Authorization: 'Bearer auth', Range: 'bytes=0-50' } });
    browser.addExternalCandidate({ url, title: 'Video', headers: { Cookie: 'sid=123' } });
    assert.equal(browser.getState().candidates.length, 1);
    assert.doesNotMatch(JSON.stringify(browser.getState()), /original|Bearer|sid=123/);
    const resolved = await browser.resolveCandidate(result.id);
    assert.equal(resolved.url, url);
    assert.equal(resolved.extra.headers.Authorization, 'Bearer auth');
    assert.equal(resolved.extra.headers.Cookie, undefined);
    assert.equal(resolved.extra.headers.Range, undefined);
    assert.match(await fs.readFile(resolved.extra.cookieFile, 'utf8'), /cdn\.example\tFALSE\t\/\tTRUE\t0\tsid\t123/);
  } finally {
    browser.dispose();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test('CDP fallback captures mislabeled manifest only after a bounded completed response', async () => {
  const browser = new BrowserManager({ window: null, dataDir: os.tmpdir() });
  const wc = new EventEmitter();
  wc.id = 17;
  wc.isDestroyed = () => false;
  wc.getTitle = () => 'Player';
  wc.debugger = new EventEmitter();
  wc.debugger.attach = () => {};
  const commands = [];
  wc.debugger.sendCommand = async (method, options) => {
    commands.push({ method, options });
    if (method === 'Network.getResponseBody') return { body: '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100000\nvideo.m3u8', base64Encoded: false };
    return {};
  };
  browser._attachNetworkObserver(wc);
  const event = (method, params) => wc.debugger.emit('message', {}, method, params);
  event('Network.requestWillBeSent', { requestId: 'r1', type: 'Fetch', request: { url: 'https://cdn.example/api?token=keep', method: 'GET', headers: { Authorization: 'Bearer sample' } } });
  event('Network.responseReceived', { requestId: 'r1', type: 'Fetch', response: { url: 'https://cdn.example/api?token=keep', mimeType: 'text/plain', status: 200, headers: { 'content-length': '80' } } });
  assert.equal(browser.getState().candidates.length, 0);
  event('Network.loadingFinished', { requestId: 'r1', encodedDataLength: 80 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(browser.getState().candidates[0].kind, 'hls');
  assert.equal(browser.getState().candidates[0].url, 'https://cdn.example/api?…');
  event('Network.requestWillBeSent', { requestId: 'r2', type: 'Fetch', request: { url: 'https://cdn.example/huge', method: 'GET', headers: {} } });
  event('Network.responseReceived', { requestId: 'r2', type: 'Fetch', response: { url: 'https://cdn.example/huge', mimeType: 'application/octet-stream', status: 200, headers: {} } });
  event('Network.loadingFinished', { requestId: 'r2', encodedDataLength: 500000 });
  assert.equal(commands.filter(command => command.method === 'Network.getResponseBody').length, 1);
  assert.equal(browser.cdpRequests.size, 0);
  browser.dispose();
});

test('OAuth popups preserve sandbox and isolated session; privileged navigation is blocked', () => {
  const browser = new BrowserManager({ window: {}, dataDir: os.tmpdir() });
  browser.session = { marker: 'isolated-session' };
  const wc = new EventEmitter();
  wc.setWindowOpenHandler = handler => { wc.windowHandler = handler; };
  browser._guardContents(wc);
  const result = wc.windowHandler({ url: 'https://login.example/oauth' });
  assert.equal(result.action, 'allow');
  assert.equal(result.overrideBrowserWindowOptions.webPreferences.session, browser.session);
  assert.equal(result.overrideBrowserWindowOptions.webPreferences.sandbox, true);
  assert.equal(result.overrideBrowserWindowOptions.webPreferences.contextIsolation, true);
  assert.equal(result.overrideBrowserWindowOptions.webPreferences.nodeIntegration, false);
  assert.equal(wc.windowHandler({ url: 'file:///C:/secret' }).action, 'deny');
  assert.equal(wc.windowHandler({ url: 'about:blank' }).action, 'allow');
  let prevented = false;
  wc.emit('will-frame-navigate', { url: 'file:///C:/secret', preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  prevented = false;
  wc.emit('will-frame-navigate', { url: 'blob:https://site.example/player', preventDefault() { prevented = true; } });
  assert.equal(prevented, false);
});

test('cookie jars left by a previous run are removed on start', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pull-browser-stale-'));
  const stale = path.join(root, 'capture-cookies', 'old.txt');
  await fs.mkdir(path.dirname(stale), { recursive: true });
  await fs.writeFile(stale, 'secret');
  new BrowserManager({ window: null, dataDir: root });
  await assert.rejects(fs.access(stale));
  await fs.rm(root, { recursive: true, force: true });
});

test('caught media is measured once and the main video is marked as best', async () => {
  const calls = [];
  const probe = async (url, headers) => { calls.push({ url, headers }); return url.includes('ad') ? { status: 'ready', duration: 12, height: 720 } : { status: 'ready', duration: 1800, height: 1080, variants: 3 }; };
  const browser = new BrowserManager({ window: null, dataDir: null, probe });
  browser.addExternalCandidate({ url: 'https://ads.example.net/ad.mp4', title: 'Ad', mimeType: 'video/mp4' });
  browser.addExternalCandidate({ url: 'https://cdn.example.com/master.m3u8', title: 'Фильм', mimeType: 'application/vnd.apple.mpegurl', headers: { Cookie: 'sid=1', Referer: 'https://example.com/' } });
  browser.addExternalCandidate({ url: 'https://cdn.example.com/master.m3u8', title: 'Фильм', mimeType: 'application/vnd.apple.mpegurl' });
  assert.equal(browser.getState().media.probing, true);
  await new Promise((resolve) => setImmediate(resolve));
  const state = browser.getState();
  assert.equal(calls.length, 2, 'repeat sightings are not measured again');
  assert.equal(calls[1].headers.Cookie, 'sid=1');
  assert.equal(state.media.confidence, 'high');
  const best = state.candidates.find((item) => item.best);
  assert.equal(best.kind, 'hls'); assert.equal(best.duration, 1800); assert.equal(best.height, 1080);
  assert.equal(state.candidates.find((item) => item.ad).host, 'ads.example.net');
  browser.beginPageNavigation();
  assert.equal(browser.getState().candidates.length, 0);
});

test('resume only resolves captures belonging to the current page', async () => {
  const browser = new BrowserManager({ window: null, dataDir: null });
  const oldPage = browser.getState().browser.pageId;
  const input = { url: 'https://cdn.example/video.mp4', source: 'browser' };
  const id = browser._addCandidate(input);
  browser.beginPageNavigation();
  browser._addCandidate(input);
  await assert.rejects(browser.resolveCandidate(id, { pageId: oldPage }), /Страница изменилась/);

  const pageId = browser.getState().browser.pageId;
  assert.equal((await browser.resolveCandidate(id, { pageId })).url, input.url);
  const external = browser.addExternalCandidate({ url: 'https://cdn.example/other.mp4' });
  await assert.rejects(browser.resolveCandidate(external.id, { pageId }), /Страница изменилась/);

  let releaseCookies;
  browser.session = { cookies: { get: () => new Promise(resolve => { releaseCookies = resolve; }) } };
  const resolving = browser.resolveCandidate(id, { pageId });
  browser.beginPageNavigation();
  releaseCookies([]);
  await assert.rejects(resolving, /Страница изменилась/);
});

test('a measurement that fails once is retried before the stream is given up', async () => {
  let calls = 0;
  const probe = async () => (++calls === 1 ? { status: 'failed' } : { status: 'ready', duration: 600, height: 720 });
  const browser = new BrowserManager({ window: null, dataDir: null, probe });
  browser.retryDelay = 5;
  browser.addExternalCandidate({ url: 'https://cdn.example.com/slow.m3u8', title: 'Видео', mimeType: 'application/vnd.apple.mpegurl' });
  await new Promise((resolve) => setTimeout(resolve, 30));
  const state = browser.getState();
  assert.equal(calls, 2);
  assert.equal(state.candidates[0].probeStatus, 'ready');
  assert.ok(state.media.best, 'the stream is offered after the retry');
});
