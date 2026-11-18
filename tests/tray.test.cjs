'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { summarize, transitions, formatSpeed } = require('../src/tray.cjs');

test('tray summary counts active and paused jobs and averages progress', () => {
  const summary = summarize([
    { id: 'a', status: 'downloading', progress: 50, speed: 2 * 1024 * 1024 },
    { id: 'b', status: 'merging', progress: 100 },
    { id: 'c', status: 'queued', progress: 0 },
    { id: 'd', status: 'paused', progress: 10 },
    { id: 'e', status: 'paused', needsSource: true },
    { id: 'f', status: 'completed', progress: 100 }
  ]);
  assert.equal(summary.active, 3);
  assert.equal(summary.paused, 1, 'jobs that need the source again cannot be resumed from the tray');
  assert.equal(summary.progress, 0.75);
  assert.equal(summary.line, 'Загрузки: 3 · 2.0 МБ/с');
  assert.match(summary.tooltip, /75%$/);
});

test('idle summary hides taskbar progress', () => {
  assert.deepEqual(summarize([]).progress, -1);
  assert.equal(summarize([{ id: 'x', status: 'paused' }]).line, 'На паузе: 1');
  assert.equal(formatSpeed(0), '');
});

test('transitions report only jobs that just finished or failed', () => {
  const seen = new Map();
  assert.deepEqual(transitions(seen, [{ id: '1', status: 'completed' }, { id: '2', status: 'downloading' }]), [], 'first sighting is not a transition');
  const changed = transitions(seen, [{ id: '1', status: 'completed' }, { id: '2', status: 'completed' }, { id: '3', status: 'error' }]);
  assert.deepEqual(changed.map((job) => job.id), ['2']);
  transitions(seen, [{ id: '2', status: 'completed' }]);
  assert.equal(seen.has('1'), false, 'removed jobs are forgotten');
});
