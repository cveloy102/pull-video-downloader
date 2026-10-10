const { contextBridge, ipcRenderer } = require('electron');
const methods = ['getState','analyze','download','pauseDownload','resumeDownload','cancelDownload','removeDownload','openFile','showFile','chooseFolder','updateSettings','openBrowser','navigateBrowser','browserBack','browserForward','browserReload','setBrowserBounds','clearCandidates','downloadCandidate','getCaptureSources','selectCaptureSource','startRecording','appendRecording','finishRecording','openRecording','showRecording','openExtensionFolder','confirmClose'];
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
contextBridge.exposeInMainWorld('pull', Object.freeze(api));
