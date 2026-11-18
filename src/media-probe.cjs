'use strict';

// Measures a caught media URL (duration, best height, number of qualities)
// with FFprobe, using the same headers and cookies the page used.

const { spawn } = require('node:child_process');

function parseProbe(json) {
  const data = typeof json === 'string' ? JSON.parse(json) : json;
  const duration = Number.parseFloat(data?.format?.duration);
  const heights = [...new Set((data?.streams || []).filter((s) => s.codec_type === 'video' && Number(s.height) > 0).map((s) => Number(s.height)))];
  const hasAudio = (data?.streams || []).some((s) => s.codec_type === 'audio');
  return {
    status: 'ready',
    duration: Number.isFinite(duration) && duration > 0 ? Math.round(duration * 10) / 10 : null,
    height: heights.length ? Math.max(...heights) : 0,
    variants: heights.length,
    audio: hasAudio
  };
}

function createProber({ getFfprobe, spawnProcess = spawn, concurrency = 2, timeout = 20000 } = {}) {
  const queue = [];
  const running = new Set();
  let disposed = false;

  function pump() {
    while (!disposed && running.size < concurrency && queue.length) {
      const task = queue.shift();
      run(task);
    }
  }

  function run({ url, headers, resolve }) {
    const ffprobe = getFfprobe();
    if (!ffprobe) { resolve({ status: 'failed' }); return; }
    const userAgent = Object.entries(headers || {}).find(([name]) => name.toLowerCase() === 'user-agent')?.[1];
    const rest = Object.entries(headers || {}).filter(([name]) => name.toLowerCase() !== 'user-agent').map(([name, value]) => `${name}: ${value}\r\n`).join('');
    const args = ['-v', 'error', '-hide_banner', '-print_format', 'json', '-show_entries', 'format=duration:stream=codec_type,height', '-rw_timeout', String(timeout * 1000)];
    if (userAgent) args.push('-user_agent', userAgent);
    if (rest) args.push('-headers', rest);
    args.push('-i', url);
    let child; let out = ''; let done = false;
    const finish = (result) => {
      if (done) return;
      done = true; clearTimeout(timer); running.delete(child); resolve(result); pump();
    };
    try { child = spawnProcess(ffprobe, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }); }
    catch { done = true; resolve({ status: 'failed' }); pump(); return; }
    running.add(child);
    const timer = setTimeout(() => { try { child.kill(); } catch {} finish({ status: 'failed' }); }, timeout);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { out += chunk; if (out.length > 1024 * 1024) { try { child.kill(); } catch {} finish({ status: 'failed' }); } });
    child.on('error', () => finish({ status: 'failed' }));
    child.on('close', (code) => {
      if (code !== 0) { finish({ status: 'failed' }); return; }
      try { finish(parseProbe(out)); } catch { finish({ status: 'failed' }); }
    });
  }

  return {
    probe(url, headers = {}) {
      if (disposed) return Promise.resolve({ status: 'failed' });
      return new Promise((resolve) => { queue.push({ url, headers, resolve }); pump(); });
    },
    dispose() {
      disposed = true;
      for (const task of queue.splice(0)) task.resolve({ status: 'failed' });
      for (const child of running) { try { child.kill(); } catch {} }
      running.clear();
    }
  };
}

module.exports = { createProber, parseProbe };
