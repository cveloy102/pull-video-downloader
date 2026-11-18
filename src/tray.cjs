'use strict';

// Tray icon, menu, taskbar progress and finish notifications. Kept apart from
// main.cjs so the summary logic can be unit-tested without Electron.

const ACTIVE = new Set(['queued', 'analyzing', 'downloading', 'merging']);

function formatSpeed(bytesPerSecond) {
  const n = Number(bytesPerSecond) || 0;
  if (n <= 0) return '';
  const units = ['Б/с', 'КБ/с', 'МБ/с', 'ГБ/с'];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), 3);
  return `${(n / 1024 ** i).toFixed(i < 2 ? 0 : 1)} ${units[i]}`;
}

function summarize(jobs = []) {
  const active = jobs.filter((job) => ACTIVE.has(job.status));
  const downloading = jobs.filter((job) => job.status === 'downloading');
  const paused = jobs.filter((job) => job.status === 'paused' && !job.needsSource);
  const speed = downloading.reduce((sum, job) => sum + (Number(job.speed) || 0), 0);
  // Taskbar progress: mean of jobs that report a percentage; -1 hides the bar.
  const measurable = active.filter((job) => job.status === 'downloading' || job.status === 'merging');
  const progress = measurable.length ? measurable.reduce((sum, job) => sum + (job.status === 'merging' ? 100 : Number(job.progress) || 0), 0) / measurable.length / 100 : -1;
  let line = 'Нет активных загрузок';
  if (active.length) line = [`Загрузки: ${active.length}`, formatSpeed(speed)].filter(Boolean).join(' · ');
  else if (paused.length) line = `На паузе: ${paused.length}`;
  const tooltip = active.length && progress >= 0 ? `PULL · ${line} · ${Math.round(progress * 100)}%` : `PULL · ${line}`;
  return { active: active.length, paused: paused.length, speed, progress, line, tooltip };
}

// Returns jobs that just finished or failed since the previous call.
function transitions(previous, jobs) {
  const finished = [];
  for (const job of jobs) {
    const before = previous.get(job.id);
    if (before && before !== job.status && ['completed', 'error'].includes(job.status)) finished.push(job);
    previous.set(job.id, job.status);
  }
  for (const id of [...previous.keys()]) if (!jobs.some((job) => job.id === id)) previous.delete(id);
  return finished;
}

function createTray({ electron, iconDir, getJobs, actions }) {
  const { Tray, Menu, nativeImage, Notification } = electron;
  const path = require('node:path');
  const icons = {
    idle: nativeImage.createFromPath(path.join(iconDir, 'tray.png')),
    active: nativeImage.createFromPath(path.join(iconDir, 'tray-active.png'))
  };
  const tray = new Tray(icons.idle);
  const statuses = new Map(getJobs().map((job) => [job.id, job.status]));
  let lastKey = '';
  let timer = null;

  function build() {
    timer = null;
    if (tray.isDestroyed()) return;
    const jobs = getJobs();
    const summary = summarize(jobs);
    for (const job of transitions(statuses, jobs)) {
      if (!actions.shouldNotify() || !Notification.isSupported()) continue;
      const done = job.status === 'completed';
      const note = new Notification({ title: done ? 'Видео скачано' : 'Загрузка не удалась', body: job.title || 'PULL', icon: path.join(iconDir, 'pull.png'), silent: !done });
      note.on('click', () => { actions.show(); if (done) actions.showFile(job.id); });
      note.show();
    }
    actions.setProgress(summary.progress);
    const key = JSON.stringify([summary.line, summary.active, summary.paused, Math.round(summary.progress * 100)]);
    if (key === lastKey) return;
    lastKey = key;
    tray.setImage(summary.active ? icons.active : icons.idle);
    tray.setToolTip(summary.tooltip);
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Открыть PULL', click: actions.show },
      { type: 'separator' },
      { label: summary.line, enabled: false },
      { label: 'Скачать ссылку из буфера', click: actions.downloadFromClipboard },
      { label: 'Приостановить все', enabled: summary.active > 0, click: actions.pauseAll },
      { label: 'Продолжить все', enabled: summary.paused > 0, click: actions.resumeAll },
      { label: 'Открыть папку загрузок', click: actions.openFolder },
      { type: 'separator' },
      { label: 'Выйти из PULL', click: actions.quit }
    ]));
  }

  tray.on('click', actions.toggle);
  build();
  return {
    update() { if (!timer) timer = setTimeout(build, 400); },
    destroy() { clearTimeout(timer); if (!tray.isDestroyed()) tray.destroy(); }
  };
}

module.exports = { createTray, summarize, transitions, formatSpeed };
