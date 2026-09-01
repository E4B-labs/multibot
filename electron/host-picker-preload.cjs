// Preload for the host-picker window. Same pattern as electron/preload.cjs:
// contextIsolation stays on, the renderer only ever sees this narrow
// surface, never Node or ipcRenderer itself.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("hostPicker", {
  list: () => ipcRenderer.invoke("hosts:list"),
  addRemote: (host) => ipcRenderer.invoke("hosts:add-remote", host),
  remove: (id) => ipcRenderer.invoke("hosts:remove", id),
  useLocal: () => ipcRenderer.invoke("hosts:use-local"),
  useHost: (id) => ipcRenderer.invoke("hosts:use-host", id),
  /** Seam — rejects until server/firebase-auth.ts exposes a loopback-capable
   * login route (see electron/oauth-loopback.mjs). */
  beginBrowserLogin: (url) => ipcRenderer.invoke("hosts:begin-browser-login", url),
});
