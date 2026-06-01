const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("adiabaticHost", {
  getCoreToken: () => ipcRenderer.invoke("auth:getCoreToken"),
  getBridgeToken: () => ipcRenderer.invoke("auth:getBridgeToken"),
  getWorkspacePath: () => ipcRenderer.invoke("workspace:get"),
  chooseWorkspacePath: () => ipcRenderer.invoke("workspace:choose"),
  setWorkspacePath: (path) => ipcRenderer.invoke("workspace:set", path),
  createTerminal: () => ipcRenderer.invoke("terminal:create"),
  writeTerminal: (id, data) => ipcRenderer.send("terminal:input", { id, data }),
  resizeTerminal: (id, cols, rows) => ipcRenderer.send("terminal:resize", { id, cols, rows }),
  disposeTerminal: (id) => ipcRenderer.invoke("terminal:dispose", id),
  onTerminalData: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("terminal:data", listener);
    return () => ipcRenderer.removeListener("terminal:data", listener);
  },
  onTerminalExit: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("terminal:exit", listener);
    return () => ipcRenderer.removeListener("terminal:exit", listener);
  },
});
