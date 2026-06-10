const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("dbd", {
  apiBase: "http://127.0.0.1:8765/api",
  hide: () => ipcRenderer.send("hide-overlay"),
  toggleSize: () => ipcRenderer.invoke("toggle-size"),
  showLogin: () => ipcRenderer.invoke("show-login"),
  finishLogin: () => ipcRenderer.invoke("finish-login"),
  collectNow: () => ipcRenderer.invoke("collect-now"),
  clearLogin: () => ipcRenderer.invoke("clear-login"),
  collectorStatus: () => ipcRenderer.invoke("collector-status"),
  onStatus: callback => ipcRenderer.on("collector-status", (_, value) => callback(value)),
  mapCheckStatus: () => ipcRenderer.invoke("map-check-status"),
  onMapCheckEvent: callback => ipcRenderer.on("map-check-event", (_, value) => callback(value)),
  getOverlaySettings: () => ipcRenderer.invoke("get-overlay-settings"),
  saveOverlaySettings: settings => ipcRenderer.invoke("save-overlay-settings", settings)
});
