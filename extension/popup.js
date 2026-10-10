'use strict';
const $ = selector => document.querySelector(selector);
let currentTab;
let enabled = false;
let previousSnapshot = '';

function message(text, error = false) { $('#message').textContent = text; $('#message').classList.toggle('error', error); }
async function request(type, extra = {}) {
  const result = await chrome.runtime.sendMessage({ type, tabId: currentTab?.id, ...extra });
  if (!result?.ok) throw new Error(result?.error || 'Расширение не ответило. Откройте его ещё раз.');
  return result.value;
}

async function render() {
  const state = await request('status');
  enabled = state.enabled;
  $('#toggle').textContent = enabled ? 'Остановить' : 'Начать поиск';
  $('#toggle').classList.toggle('armed', enabled);
  $('#capture-hint').textContent = enabled ? 'Поиск включён. Нажми Play. Для новых запросов можно обновить страницу.' : 'Поиск работает только в выбранных тобой вкладках.';
  $('#count').textContent = state.candidates.length;
  $('#empty').hidden = Boolean(state.candidates.length);
  const snapshot = JSON.stringify(state.candidates);
  if (previousSnapshot === snapshot) return;
  previousSnapshot = snapshot;
  $('#streams').replaceChildren();
  for (const item of state.candidates) {
    const row = document.createElement('div'); row.className = 'stream';
    const kind = document.createElement('span'); kind.className = 'kind'; kind.textContent = item.kind.toUpperCase();
    const info = document.createElement('div'); info.className = 'stream-info';
    const title = document.createElement('p'); title.className = 'stream-name'; title.textContent = item.title; title.title = item.title;
    const url = document.createElement('p'); url.className = 'stream-url'; url.textContent = item.url; url.title = item.url;
    info.append(title, url);
    const button = document.createElement('button'); button.className = 'send'; button.textContent = item.sent ? 'Ещё раз' : 'Передать';
    button.addEventListener('click', async () => {
      button.disabled = true;
      try { await request('send', { id: item.id }); message('Поток в PULL. Выбери его в разделе «Браузер» и скачай.'); await render(); }
      catch (error) { message(error.message, true); }
      finally { button.disabled = false; }
    });
    row.append(kind, info, button); $('#streams').append(row);
  }
}

async function checkConnection() {
  try { await request('health'); $('#connection').textContent = 'PULL подключён'; $('#connection-dot').classList.add('connected'); return true; }
  catch (error) { $('#connection').textContent = 'Подключить PULL'; $('#connection-dot').classList.remove('connected'); throw error; }
}

$('#toggle').addEventListener('click', async () => {
  const button = $('#toggle'); button.disabled = true;
  try {
    if (!enabled) {
      // Call directly from the user gesture: Chromium requires it for permission prompts.
      const granted = await chrome.permissions.request({ origins: ['http://*/*', 'https://*/*'] });
      if (!granted) throw new Error('Для поиска нужно разрешить доступ к сайтам.');
      await request('start');
    } else await request('stop');
    message(''); await render();
  } catch (error) { message(error.message, true); }
  finally { button.disabled = false; }
});
$('#clear').addEventListener('click', async () => { try { await request('clear'); await render(); } catch (error) { message(error.message, true); } });
$('#save').addEventListener('click', async () => {
  const token = $('#token').value.trim();
  if (!/^[a-zA-Z0-9_-]{32,256}$/.test(token)) { message('Вставь полный ключ из настроек PULL.', true); return; }
  $('#save').disabled = true;
  try { await chrome.storage.local.set({ token }); await checkConnection(); $('#pairing').open = false; message('Готово. Расширение связано с PULL.'); }
  catch (error) { message(error.message, true); }
  finally { $('#save').disabled = false; }
});

(async () => {
  [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  $('#tab-title').textContent = currentTab?.title || 'Текущая вкладка';
  const { token } = await chrome.storage.local.get('token');
  $('#token').value = token || '';
  $('#pairing').open = !token;
  await render();
  if (token) checkConnection().catch(() => {});
  setInterval(() => render().catch(() => {}), 1200);
})().catch(error => message(error.message, true));
