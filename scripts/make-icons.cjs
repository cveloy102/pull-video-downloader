'use strict';
// Renders the PULL mark to PNG/ICO with Electron's own Chromium.
// Usage: node_modules/electron/dist/electron.exe scripts/make-icons.cjs
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const assets = path.join(__dirname, '..', 'src', 'assets');

// Ink square with a white "pull down" arrow onto a shelf; the active tray
// variant adds a blue dot (the same blue as running downloads in the UI).
function markSvg(size, { dot = false } = {}) {
  const stroke = size <= 20 ? 2.9 : size <= 32 ? 2.5 : size <= 64 ? 2.1 : 1.75;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24">
    <rect x="0.5" y="0.5" width="23" height="23" rx="6" fill="#111111"/>
    <rect x="0.5" y="0.5" width="23" height="23" rx="6" fill="none" stroke="#2c2c2c" stroke-width="${size <= 32 ? 0 : 0.35}"/>
    <path d="M12 5.5v9.2M7.8 10.6 12 14.8l4.2-4.2M7 18.5h10" fill="none" stroke="#ffffff" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round"/>
    ${dot ? '<circle cx="19.2" cy="4.8" r="4.4" fill="#2f6fef" stroke="#111111" stroke-width="1.4"/>' : ''}
  </svg>`;
}

async function render(win, svg, size) {
  const html = `<html><body style="margin:0;background:transparent">${svg}</body></html>`;
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  win.setContentSize(size, size);
  await new Promise((r) => setTimeout(r, 120));
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
  return image.resize({ width: size, height: size, quality: 'best' }).toPNG();
}

// ICO container with embedded PNG frames (supported since Windows Vista).
function ico(frames) {
  const header = Buffer.alloc(6); header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(frames.length, 4);
  const entries = []; const blobs = []; let offset = 6 + 16 * frames.length;
  for (const { size, png } of frames) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0); e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6); e.writeUInt32LE(png.length, 8); e.writeUInt32LE(offset, 12);
    offset += png.length; entries.push(e); blobs.push(png);
  }
  return Buffer.concat([header, ...entries, ...blobs]);
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, transparent: true, frame: false, useContentSize: true, width: 256, height: 256, webPreferences: { offscreen: true } });
  const frames = [];
  for (const size of [16, 20, 24, 32, 40, 48, 64, 128, 256]) frames.push({ size, png: await render(win, markSvg(size), size) });
  fs.writeFileSync(path.join(assets, 'pull.ico'), ico(frames));
  fs.writeFileSync(path.join(assets, 'pull.png'), await render(win, markSvg(512), 512));
  fs.writeFileSync(path.join(assets, 'tray.png'), await render(win, markSvg(16), 16));
  fs.writeFileSync(path.join(assets, 'tray@2x.png'), await render(win, markSvg(32), 32));
  fs.writeFileSync(path.join(assets, 'tray-active.png'), await render(win, markSvg(16, { dot: true }), 16));
  fs.writeFileSync(path.join(assets, 'tray-active@2x.png'), await render(win, markSvg(32, { dot: true }), 32));
  console.log('Icons written to', assets);
  app.quit();
});
