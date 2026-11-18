'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { rankCandidates, looksLikeAd, titleMatch } = require('../src/media-ranking.cjs');

const c = (id, url, kind, probe, title = 'Интерстеллар разбор науки') => ({ id, url, host: new URL(url).hostname, kind, title, probe });

test('main video wins over ads, previews and lower-quality copies', () => {
  const ranking = rankCandidates([
    c('ad', 'https://ads.example.net/preroll.mp4', 'video', { status: 'ready', duration: 15, height: 720 }, 'Реклама'),
    c('preview', 'https://cdn.example.com/preview.mp4', 'video', { status: 'ready', duration: 8, height: 360 }),
    c('variant', 'https://cdn.example.com/720/index.m3u8', 'hls', { status: 'ready', duration: 2472, height: 720, variants: 1 }),
    c('master', 'https://cdn.example.com/master.m3u8', 'hls', { status: 'ready', duration: 2472.4, height: 1080, variants: 3 })
  ], 'Интерстеллар: разбор науки за 40 минут');
  assert.equal(ranking.best, 'master');
  assert.equal(ranking.confidence, 'high');
  assert.equal(ranking.probing, false);
  const others = Object.fromEntries(ranking.others.map((o) => [o.id, o]));
  assert.equal(others.variant.duplicate, true);
  assert.equal(others.ad.ad, true);
  assert.equal(others.preview.short, true);
});

test('nothing is chosen while candidates are still being measured', () => {
  const ranking = rankCandidates([c('a', 'https://cdn.example.com/v.m3u8', 'hls', { status: 'probing' })]);
  assert.equal(ranking.best, null);
  assert.equal(ranking.probing, true);
  assert.equal(ranking.confidence, 'none');
});

test('a short clip can be chosen but only with low confidence', () => {
  const ranking = rankCandidates([c('clip', 'https://cdn.example.com/clip.mp4', 'video', { status: 'ready', duration: 20, height: 1080 })]);
  assert.equal(ranking.best, 'clip');
  assert.equal(ranking.confidence, 'low');
});

test('ads, audio-only and unreadable streams are never the main video', () => {
  const ranking = rankCandidates([
    c('ad', 'https://pubads.g.doubleclick.net/x.mp4', 'video', { status: 'ready', duration: 600, height: 1080 }),
    c('audio', 'https://cdn.example.com/a.m4a', 'audio', { status: 'ready', duration: 600 }),
    c('bad', 'https://cdn.example.com/v.mp4', 'video', { status: 'failed' })
  ]);
  assert.equal(ranking.best, null);
  assert.equal(ranking.others.length, 3);
});

test('ad detection and title matching', () => {
  assert.equal(looksLikeAd({ url: 'https://an.yandex.ru/vast/1' }), true);
  assert.equal(looksLikeAd({ url: 'https://cdn.example.com/video/advanced-course.mp4' }), false);
  assert.equal(looksLikeAd({ url: 'https://cdn.example.com/preroll/1.mp4' }), true);
  assert.equal(titleMatch({ title: 'Лекция 7 нейросети' }, 'Лекция 7. Нейросети и трансформеры'), 2 / 3, 'short words like "7" and "и" are ignored');
});

test('FFprobe output is reduced to duration, best height and quality count', () => {
  const { parseProbe } = require('../src/media-probe.cjs');
  const result = parseProbe({ format: { duration: '2472.413' }, streams: [{ codec_type: 'video', height: 360 }, { codec_type: 'video', height: 1080 }, { codec_type: 'video', height: 720 }, { codec_type: 'audio' }] });
  assert.deepEqual(result, { status: 'ready', duration: 2472.4, height: 1080, variants: 3, audio: true });
  assert.equal(parseProbe({ format: {}, streams: [] }).duration, null);
});
