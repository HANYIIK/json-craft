const { contextBridge, ipcRenderer, webUtils } = require("electron");

const systemLocale = process.argv.includes("--json-craft-system-locale=zh-CN")
  ? "zh-CN"
  : "en";

contextBridge.exposeInMainWorld("desktop", {
  platform: process.platform,
  systemLocale,
  getPathForFile: (file) => webUtils.getPathForFile(file),
  workspace: {
    load: () => ipcRenderer.invoke("json-craft:workspace:load"),
    read: (id) => ipcRenderer.invoke("json-craft:workspace:read", id),
    create: (record) =>
      ipcRenderer.invoke("json-craft:workspace:create", record),
    update: (id, changes) =>
      ipcRenderer.invoke("json-craft:workspace:update", id, changes),
    remove: (id) => ipcRenderer.invoke("json-craft:workspace:remove", id),
    rename: (id, name) =>
      ipcRenderer.invoke("json-craft:workspace:rename", id, name),
    updateSettings: (patch) =>
      ipcRenderer.invoke("json-craft:workspace:updateSettings", patch),
    chooseDirectory: (kind) =>
      ipcRenderer.invoke("json-craft:workspace:chooseDirectory", kind),
    setActive: (id) => ipcRenderer.invoke("json-craft:workspace:setActive", id),
    requestClose: () => ipcRenderer.invoke("json-craft:workspace:requestClose"),
  },
  openFiles: () => ipcRenderer.invoke("json-craft:open-files"),
  importDroppedFiles: (paths) =>
    ipcRenderer.invoke("json-craft:import-dropped-files", paths),
  saveFile: (file) => ipcRenderer.invoke("json-craft:save", file),
  copyText: (text) => ipcRenderer.invoke("json-craft:copy", text),
  ready: () => ipcRenderer.invoke("json-craft:ready"),
  onOpenFiles: (listener) => {
    const handler = (_event, files) => listener(files);
    ipcRenderer.on("json-craft:files-opened", handler);
    return () => ipcRenderer.removeListener("json-craft:files-opened", handler);
  },
  onMenuAction: (listener) => {
    const handler = (_event, action) => {
      if (["new", "format", "export"].includes(action)) listener(action);
    };
    ipcRenderer.on("json-craft:menu-action", handler);
    return () => ipcRenderer.removeListener("json-craft:menu-action", handler);
  },
});
