const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("adiabaticHost", {
  getWorkspacePath: () => ipcRenderer.invoke("workspace:get"),
  chooseWorkspacePath: () => ipcRenderer.invoke("workspace:choose"),
  setWorkspacePath: (path) => ipcRenderer.invoke("workspace:set", path),
});
