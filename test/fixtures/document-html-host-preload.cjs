const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("electronAPI", {
  chatWorkPanel: { documentHtml: { preview: (request) => ipcRenderer.invoke("test:html-preview", request) } },
});
