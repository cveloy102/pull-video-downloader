'use strict';

const API = 'http://127.0.0.1:17841';
const LIMIT = 60;
const pending = new Map();
let tabs = {};
const ready = chrome.storage.session.get('captureTabs').then(result => { tabs = result.captureTabs || {}; });
const persist = () => chrome.storage.session.set({ captureTabs: tabs });
const header = (headers, name) => (headers || []).find(item => item.name.toLowerCase() === name)?.value || '';

function detect(urlString, mimeType, responseHeaders) {
  let url;
  try { url = new URL(urlString); } catch { return null; }
  if (!['http:', 'https:'].includes(url.protocol)) return null;
  const path = url.pathname.toLowerCase();
  const mime = mimeType.toLowerCase().split(';')[0].trim();
  if (/\.m3u8$/.test(path) || ['application/vnd.apple.mpegurl', 'application/x-mpegurl', 'audio/mpegurl', 'audio/x-mpegurl'].includes(mime)) return 'hls';
  if (/\.mpd$/.test(path) || mime === 'application/dash+xml') return 'dash';
  if (/\.ism(?:c)?\/manifest(?:\([^)]*\))?$/.test(path) || mime === 'application/vnd.ms-sstr+xml') return 'mss';
  if (/\.(m4s|ts|cmfv|cmfa|aac|vtt|srt)$/.test(path) || /(?:^|\/)(?:init|segment|seg|chunk|frag)(?:[-_\d.]|$)/.test(path)) return null;
  const size = Number(header(responseHeaders, 'content-length'));
  if (size > 0 && size < 1024 && !header(responseHeaders, 'content-range')) return null;
  if (mime.startsWith('video/') || /\.(mp4|webm|mov|mkv|m4v|avi|flv|ogv)$/.test(path)) return 'video';
  if (['audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/webm', 'audio/flac'].includes(mime) || /\.(mp3|m4a|ogg|opus|flac)$/.test(path)) return 'audio';
  return null;
}

function safeHeaders(list) {
  const result = {};
  const accepted = new Set(['user-agent', 'referer', 'origin', 'authorization', 'cookie', 'accept', 'accept-language']);
  for (const item of list || []) {
    const name = item.name.toLowerCase();
    if ((accepted.has(name) || /^x-[a-z0-9-]+$/.test(name)) && typeof item.value === 'string' && item.value.length <= 16384 && !/[\r\n\0]/.test(item.value)) {
      if (!['x-forwarded-for', 'x-pull-token', 'x-real-ip'].includes(name)) result[item.name] = item.value;
    }
  }
  return result;
}

async function badge(tabId) {
  const state = tabs[tabId];
  try {
    await chrome.action.setBadgeBackgroundColor({ tabId, color: '#b4f06c' });
    await chrome.action.setBadgeText({ tabId, text: state?.enabled ? (state.candidates.length ? String(state.candidates.length) : 'ON') : '' });
  } catch {}
}

function publicState(state) {
  return {
    enabled: Boolean(state?.enabled),
    candidates: (state?.candidates || []).map(({ id, url: raw, kind, title, sent }) => {
      const url = new URL(raw);
      return { id, url: `${url.host}${url.pathname}${url.search ? '?…' : ''}`, host: url.host, kind, title, sent: Boolean(sent) };
    })
  };
}

chrome.webRequest.onBeforeSendHeaders.addListener(details => {
  void ready.then(() => {
    if (!tabs[details.tabId]?.enabled || details.method !== 'GET') return;
    if (pending.size >= 800) pending.delete(pending.keys().next().value);
    pending.set(details.requestId, { tabId: details.tabId, headers: safeHeaders(details.requestHeaders) });
  });
}, { urls: ['http://*/*', 'https://*/*'] }, ['requestHeaders', 'extraHeaders']);

chrome.webRequest.onResponseStarted.addListener(details => {
  void ready.then(async () => {
    const state = tabs[details.tabId];
    if (!state?.enabled || details.method !== 'GET' || details.statusCode < 200 || details.statusCode >= 300) return;
    const mimeType = header(details.responseHeaders, 'content-type');
    const kind = detect(details.url, mimeType, details.responseHeaders);
    if (!kind) return;
    let item = state.candidates.find(candidate => candidate.url === details.url);
    const headers = pending.get(details.requestId)?.headers || {};
    if (item) { item.headers = { ...item.headers, ...headers }; await persist(); return; }
    let title = state.title;
    try { title = (await chrome.tabs.get(details.tabId)).title || title; } catch {}
    if (state.candidates.length >= LIMIT) state.candidates.shift();
    item = { id: crypto.randomUUID(), url: details.url, title: title || new URL(details.url).hostname, kind, mimeType, headers, sent: false };
    state.candidates.push(item);
    await persist();
    await badge(details.tabId);
  }).catch(() => {});
}, { urls: ['http://*/*', 'https://*/*'] }, ['responseHeaders', 'extraHeaders']);

for (const event of [chrome.webRequest.onCompleted, chrome.webRequest.onErrorOccurred]) {
  event.addListener(details => { pending.delete(details.requestId); }, { urls: ['http://*/*', 'https://*/*'] });
}

chrome.tabs.onRemoved.addListener(tabId => {
  void ready.then(async () => {
    delete tabs[tabId];
    for (const [id, item] of pending) if (item.tabId === tabId) pending.delete(id);
    await persist();
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  void ready.then(async () => {
    if (!tabs[tabId]) return;
    if (changeInfo.title) tabs[tabId].title = changeInfo.title;
    // A started tab remains armed while the user opens the player or logs in.
    // Streams remain available until explicitly cleared or capture is stopped.
    if (changeInfo.url) tabs[tabId].url = changeInfo.url;
    await persist();
  });
});

async function appRequest(path, body) {
  const { token } = await chrome.storage.local.get('token');
  if (!token || !/^[a-zA-Z0-9_-]{32,256}$/.test(token)) throw new Error('Вставьте ключ подключения из настроек PULL.');
  let response;
  try {
    response = await fetch(`${API}${path}`, { method: body ? 'POST' : 'GET', headers: { 'X-Pull-Token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(6000) });
  } catch { throw new Error('PULL не отвечает. Запустите приложение и включите подключение расширения.'); }
  if (!response.ok) {
    if ([401, 403].includes(response.status)) throw new Error('Ключ не подошёл. Скопируйте актуальный ключ из PULL.');
    throw new Error(`PULL вернул ошибку ${response.status}.`);
  }
  return response.json();
}

async function handle(message) {
  await ready;
  const tabId = Number(message.tabId);
  if (message.type === 'status') return publicState(tabs[tabId]);
  if (message.type === 'health') { await appRequest('/health'); return { connected: true }; }
  if (message.type === 'start') {
    if (!Number.isInteger(tabId) || tabId < 0) throw new Error('Откройте вкладку с видео.');
    const tab = await chrome.tabs.get(tabId);
    if (!/^https?:\/\//i.test(tab.url || '')) throw new Error('Откройте сайт с видео в обычной вкладке.');
    if (!(await chrome.permissions.contains({ origins: ['http://*/*', 'https://*/*'] }))) throw new Error('Разрешите доступ к сайтам, чтобы видеть медиапотоки.');
    tabs[tabId] = { enabled: true, title: tab.title || '', url: tab.url, candidates: tabs[tabId]?.candidates || [] };
    await persist(); await badge(tabId); return publicState(tabs[tabId]);
  }
  if (message.type === 'stop') {
    delete tabs[tabId];
    for (const [id, item] of pending) if (item.tabId === tabId) pending.delete(id);
    await persist(); await badge(tabId); return publicState(null);
  }
  if (message.type === 'clear') {
    if (tabs[tabId]) tabs[tabId].candidates = [];
    await persist(); await badge(tabId); return publicState(tabs[tabId]);
  }
  if (message.type === 'send') {
    const item = tabs[tabId]?.candidates.find(candidate => candidate.id === message.id);
    if (!item) throw new Error('Поток больше недоступен. Запустите видео ещё раз.');
    await appRequest('/candidate', { url: item.url, title: item.title, mimeType: item.mimeType, headers: item.headers });
    item.sent = true;
    await persist();
    return { sent: true };
  }
  throw new Error('Неизвестная команда.');
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || sender.tab) return false;
  handle(message).then(value => respond({ ok: true, value }), error => respond({ ok: false, error: error.message || 'Не удалось выполнить действие.' }));
  return true;
});
