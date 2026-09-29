import { contextBridge, ipcRenderer } from 'electron';

const api = {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (partial: Record<string, unknown>) => ipcRenderer.invoke('settings:set', partial),
  minimize: () => ipcRenderer.send('window:minimize'),
  maximize: () => ipcRenderer.send('window:maximize'),
  close: () => ipcRenderer.send('window:close'),
  notify: (body: string) => ipcRenderer.send('notify', { body }),

  // --- mini timer (PIP) ---
  toggleMini: () => ipcRenderer.send('mini:toggle'),
  miniPushState: (state: unknown) => ipcRenderer.send('mini:push-state', state),
  miniOnState: (cb: (state: any) => void) => {
    ipcRenderer.on('mini:state', (_e, state) => cb(state));
  },
  miniControl: (action: 'pause-toggle' | 'reset' | 'close' | 'show-main') =>
    ipcRenderer.send('mini:control', action),
  onMiniControl: (cb: (action: string) => void) => {
    ipcRenderer.on('pomo:mini-control', (_e, action) => cb(action));
  },
  onMiniClosed: (cb: () => void) => {
    ipcRenderer.on('pomo:mini-closed', () => cb());
  },
};

contextBridge.exposeInMainWorld('pomo', api);

export type PomoApi = typeof api;
