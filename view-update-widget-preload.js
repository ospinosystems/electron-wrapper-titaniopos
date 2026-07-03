const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('widget', {
  onState: (cb) => ipcRenderer.on('view-widget:state', (_e, state) => cb(state)),
  restartNow: () => ipcRenderer.send('view-widget:restart-now'),
});
