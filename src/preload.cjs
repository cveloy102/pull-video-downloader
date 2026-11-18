const { contextBridge, ipcRenderer } = require('electron');
const methods = ['checkForUpdates','installUpdate','getState','analyze','download','pauseDownload','resumeDownload','cancelDownload','removeDownload','openFile','showFile','chooseFolder','updateSettings','openBrowser','navigateBrowser','browserBack','browserForward','browserReload','setBrowserBounds','clearCandidates','downloadCandidate','reattachCandidate','getCaptureSources','selectCaptureSource','startRecording','appendRecording','finishRecording','openRecording','showRecording','openExtensionFolder','confirmClose'];
const api = Object.fromEntries(methods.map(name => [name, (...args) => ipcRenderer.invoke('pull:' + name, ...args)]));
api.onState = callback => {
  if (typeof callback !== 'function') throw new TypeError('callback required');
  const listener = (_event, state) => callback(state);
  ipcRenderer.on('pull:state', listener);
  return () => ipcRenderer.removeListener('pull:state', listener);
};
api.onBeforeClose = callback => {
  if (typeof callback !== 'function') throw new TypeError('callback required');
  const listener = () => callback();
  ipcRenderer.on('pull:before-close', listener);
  return () => ipcRenderer.removeListener('pull:before-close', listener);
};
// Tray actions: "download link from clipboard" and short notices.
for (const [name, channel] of [['onAnalyze', 'pull:analyze'], ['onNotice', 'pull:notice']]) {
  api[name] = callback => {
    if (typeof callback !== 'function') throw new TypeError('callback required');
    const listener = (_event, text) => callback(String(text || ''));
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  };
}
contextBridge.exposeInMainWorld('pull', Object.freeze(api));
