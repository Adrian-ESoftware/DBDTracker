const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("dbd", {
  apiBase: "http://127.0.0.1:8765/api",
  hide: () => ipcRenderer.send("hide-overlay"),
  toggleSize: () => ipcRenderer.invoke("toggle-size"),
  showLogin: () => ipcRenderer.invoke("show-login"),
  finishLogin: () => ipcRenderer.invoke("finish-login"),
  collectNow: () => ipcRenderer.invoke("collect-now"),
  collectorStatus: () => ipcRenderer.invoke("collector-status"),
  onStatus: callback => ipcRenderer.on("collector-status", (_, value) => callback(value))
});
