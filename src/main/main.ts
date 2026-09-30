import { app, BrowserWindow, ipcMain, Notification, screen, session, shell } from 'electron';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';

// ---------------------------------------------------------------- paths
const DIST_RENDERER = path.join(__dirname, '..', 'renderer');

// ---------------------------------------------------------------- settings
type SoundName = 'chime' | 'ding' | 'glass';

type AppSettings = {
  studyMinutes: number;
  breakMinutes: number;
  cycles: number;
  videoUrl: string;
  theme: 'dark' | 'light';
  sound: SoundName;
  volume: number;
  windowBounds?: { width: number; height: number; x: number; y: number };
  miniBounds?: { width: number; height: number; x: number; y: number };
  miniOpen?: boolean;
};

const DEFAULTS: AppSettings = {
  studyMinutes: 50,
  breakMinutes: 10,
  cycles: 4,
  videoUrl: '',
  theme: 'dark',
  sound: 'chime',
  volume: 0.6,
};

const clampInt = (value: unknown, min: number, max: number, fallback: number): number => {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

const settingsPath = (): string => {
  const dir = app.getPath('userData');
  fs.mkdirSync(dir, { recursive: true });

  // Migração: app renomeado de "pomodoro-estudo" (PomoEstudo) para "pomodoro".
  const legacyPath = path.join(path.dirname(dir), 'pomodoro-estudo', 'settings.json');
  const newPath = path.join(dir, 'settings.json');
  try {
    if (!fs.existsSync(newPath) && fs.existsSync(legacyPath)) {
      fs.copyFileSync(legacyPath, newPath);
    }
  } catch {
    // migração é best-effort
  }

  return newPath;
};

let cachedSettings: AppSettings | null = null;

function loadSettings(): AppSettings {
  if (cachedSettings) return cachedSettings;
  let parsed: Partial<AppSettings> = {};
  try {
    parsed = JSON.parse(fs.readFileSync(settingsPath(), 'utf-8')) as Partial<AppSettings>;
  } catch {
    parsed = {};
  }
  cachedSettings = {
    studyMinutes: clampInt(parsed.studyMinutes, 1, 180, DEFAULTS.studyMinutes),
    breakMinutes: clampInt(parsed.breakMinutes, 1, 60, DEFAULTS.breakMinutes),
    cycles: clampInt(parsed.cycles, 1, 20, DEFAULTS.cycles),
    videoUrl: typeof parsed.videoUrl === 'string' ? parsed.videoUrl : DEFAULTS.videoUrl,
    theme: parsed.theme === 'light' ? 'light' : 'dark',
    sound: (['chime', 'ding', 'glass'] as const).includes(parsed.sound as SoundName)
      ? (parsed.sound as SoundName)
      : DEFAULTS.sound,
    volume: Math.min(1, Math.max(0, Number(parsed.volume) || DEFAULTS.volume)),
    windowBounds: parsed.windowBounds,
    miniBounds: parsed.miniBounds,
    miniOpen: parsed.miniOpen === true,
  };
  return cachedSettings;
}

function saveSettings(settings: AppSettings): void {
  cachedSettings = settings;
  try {
    fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2), 'utf-8');
  } catch (err) {
    console.error('Falha ao salvar configurações:', err);
  }
}

// ---------------------------------------------------------------- asset server
/**
 * O player do YouTube exige que a página incorporadora tenha uma origem HTTP
 * válida (páginas file:// têm origem opaca e recebem o erro 153 do embed).
 * Servimos os assets do renderer por http://localhost (loopback, sem firewall),
 * o que dá uma origem HTTP real ao app sem quebrar o IPC/preload.
 */
const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

function startAssetServer(dir: string, preferredPort: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let urlPath: string;
      try {
        urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
      } catch {
        res.writeHead(400).end();
        return;
      }
      const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
      const filePath = path.normalize(path.join(dir, rel));
      if (!filePath.startsWith(dir)) {
        res.writeHead(403).end();
        return;
      }
      fs.readFile(filePath, (err, data) => {
        if (err) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
          return;
        }
        const ext = path.extname(filePath).toLowerCase();
        res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] ?? 'application/octet-stream' });
        res.end(data);
      });
    });
    // Tenta a porta fixa primeiro (origem estável preserva o localStorage entre
    // execuções); se estiver ocupada, avança para as próximas.
    // Host 'localhost' (e não 127.0.0.1): o player do YouTube valida a origem do
    // incorporador e rejeita IPs de loopback crus (erro 152), mas aceita
    // http://localhost:<porta>.
    let port = preferredPort;
    const maxPort = preferredPort + 20;
    const tryListen = (): void => {
      server.listen(port, 'localhost', () => {
        resolve(`http://localhost:${port}`);
      });
    };
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE' && port < maxPort) {
        port += 1;
        tryListen();
      } else {
        reject(err);
      }
    });
    assetServer = server;
    tryListen();
  });
}

// ---------------------------------------------------------------- window
let mainWindow: BrowserWindow | null = null;
let baseUrl = ''; // ex.: http://localhost:54321 (definido no whenReady)
let assetServer: http.Server | null = null; // guardado p/ fechar no encerramento

function createWindow(): void {
  const settings = loadSettings();
  const bounds = settings.windowBounds;
  // Janela compacta: bounds muito largos (do layout antigo) são ignorados.
  const hasValidBounds =
    !!bounds &&
    Number.isFinite(bounds.x) &&
    Number.isFinite(bounds.y) &&
    bounds.width >= 360 &&
    bounds.width <= 720 &&
    bounds.height >= 560 &&
    bounds.height <= 1000;

  mainWindow = new BrowserWindow({
    width: hasValidBounds ? bounds!.width : 460,
    height: hasValidBounds ? bounds!.height : 720,
    x: hasValidBounds ? bounds!.x : undefined,
    y: hasValidBounds ? bounds!.y : undefined,
    frame: false,
    resizable: false, // janela compacta de tamanho fixo
    maximizable: false,
    backgroundColor: '#0f1117',
    show: false,
    icon: path.join(DIST_RENDERER, 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());

  // Save bounds on move/resize (debounced) and on close.
  let boundsTimer: NodeJS.Timeout | null = null;
  const queueSaveBounds = (): void => {
    if (boundsTimer) clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      const s = loadSettings();
      s.windowBounds = mainWindow.getBounds();
      saveSettings(s);
    }, 600);
  };
  mainWindow.on('resize', queueSaveBounds);
  mainWindow.on('move', queueSaveBounds);
  mainWindow.on('close', () => {
    if (boundsTimer) clearTimeout(boundsTimer);
    if (mainWindow && !mainWindow.isDestroyed()) {
      const s = loadSettings();
      s.windowBounds = mainWindow.getBounds();
      s.miniOpen = !!(miniWindow && !miniWindow.isDestroyed());
      saveSettings(s);
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    // Fechar a janela principal encerra o app (fecha o mini também).
    if (miniWindow && !miniWindow.isDestroyed()) miniWindow.close();
  });

  // Open external links (e.g., YouTube copyright pages) in the real browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  // Não deixa a janela principal navegar para fora do app.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(baseUrl + '/') && url !== baseUrl + '/' && url !== baseUrl) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });

  void mainWindow.loadURL(`${baseUrl}/`);
}

// ---------------------------------------------------------------- IPC
ipcMain.handle('settings:get', () => loadSettings());

ipcMain.handle('settings:set', (_event, partial: Partial<AppSettings>) => {
  const current = loadSettings();
  const next: AppSettings = {
    ...current,
    ...partial,
    studyMinutes: clampInt(partial.studyMinutes ?? current.studyMinutes, 1, 180, current.studyMinutes),
    breakMinutes: clampInt(partial.breakMinutes ?? current.breakMinutes, 1, 60, current.breakMinutes),
    cycles: clampInt(partial.cycles ?? current.cycles, 1, 20, current.cycles),
    volume: Math.min(1, Math.max(0, Number(partial.volume ?? current.volume))),
  };
  saveSettings(next);
  return next;
});

ipcMain.on('window:minimize', () => mainWindow?.minimize());
ipcMain.on('window:maximize', () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.on('window:close', () => mainWindow?.close());

ipcMain.on('notify', (_event, payload: { body: string }) => {
  if (!Notification.isSupported()) return;
  const notification = new Notification({
    title: 'Pomodoro',
    body: payload.body,
    silent: true, // the renderer plays its own sound with volume control
  });
  notification.show();
});

// ---------------------------------------------------------------- mini timer (PIP)
type MiniState = {
  phase: string;
  endAt: number;
  remainingMs: number;
  currentCycle: number;
  totalCycles: number;
};

let miniWindow: BrowserWindow | null = null;
let lastMiniState: MiniState = {
  phase: 'IDLE',
  endAt: 0,
  remainingMs: 0,
  currentCycle: 1,
  totalCycles: 4,
};

const MINI_DEFAULT_W = 200;
const MINI_DEFAULT_H = 132;

function createMiniWindow(): void {
  if (miniWindow && !miniWindow.isDestroyed()) {
    miniWindow.show();
    miniWindow.focus();
    return;
  }

  const saved = loadSettings().miniBounds;
  const wa = screen.getPrimaryDisplay().workAreaSize;
  const width = saved?.width ?? MINI_DEFAULT_W;
  const height = saved?.height ?? MINI_DEFAULT_H;
  const x = saved && Number.isFinite(saved.x) ? saved.x : wa.width - width - 24;
  const y = saved && Number.isFinite(saved.y) ? saved.y : wa.height - height - 24;

  miniWindow = new BrowserWindow({
    width,
    height,
    x,
    y,
    minWidth: 150,
    minHeight: 100,
    frame: false,
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    backgroundColor: '#10131b',
    show: false,
    icon: path.join(DIST_RENDERER, 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  miniWindow.setAlwaysOnTop(true, 'screen-saver'); // fica acima até de fullscreen

  miniWindow.once('ready-to-show', () => {
    miniWindow?.show();
    pushMiniState(lastMiniState);
  });

  let boundsTimer: NodeJS.Timeout | null = null;
  const queueSaveBounds = (): void => {
    if (boundsTimer) clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => {
      if (miniWindow && !miniWindow.isDestroyed()) {
        const s = loadSettings();
        s.miniBounds = miniWindow.getBounds();
        saveSettings(s);
      }
    }, 600);
  };
  miniWindow.on('move', queueSaveBounds);
  miniWindow.on('resize', queueSaveBounds);
  miniWindow.on('closed', () => {
    miniWindow = null;
  });

  miniWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  void miniWindow.loadURL(`${baseUrl}/mini.html`);
}

function closeMiniWindow(): void {
  if (miniWindow && !miniWindow.isDestroyed()) miniWindow.close();
  // Sincroniza o botão 📌 e a preferência no renderer principal.
  mainWindow?.webContents.send('pomo:mini-closed');
}

function pushMiniState(state: MiniState): void {
  lastMiniState = state;
  if (miniWindow && !miniWindow.isDestroyed()) {
    miniWindow.webContents.send('mini:state', state);
  }
}

ipcMain.on('mini:toggle', () => {
  if (miniWindow && !miniWindow.isDestroyed()) closeMiniWindow();
  else createMiniWindow();
});
ipcMain.on('mini:push-state', (_event, state: MiniState) => pushMiniState(state));
ipcMain.on('mini:control', (_event, action: string) => {
  if (action === 'close') {
    closeMiniWindow();
  } else if (action === 'show-main') {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  } else if (action === 'pause-toggle' || action === 'reset') {
    // Comandos do mini são encaminhados ao renderer principal (fonte da verdade).
    mainWindow?.webContents.send('pomo:mini-control', action);
  }
});

// ---------------------------------------------------------------- youtube referer fix
/**
 * O player incorporado do YouTube exige um header HTTP Referer válido.
 * Páginas carregadas de file:// têm origem opaca e não enviam Referer (erro 153).
 * Servir o app por http://localhost resolve a origem, MAS o Referer
 * "http://localhost:<porta>" também dispara bloqueio (erro 152) em algumas
 * respostas do YouTube — medido em testes: reescrever para youtube.com falha,
 * enquanto o Referer real de localhost é aceito.
 *
 * Portanto: só garantimos que exista um Referer (caso file:// ou requisições
 * soltas sem origem); preservamos o valor real do Chromium caso contrário.
 */
function installYouTubeRefererFix(): void {
  const filter = {
    urls: [
      'https://www.youtube.com/*',
      'https://www.youtube-nocookie.com/*',
      'https://*.ytimg.com/*',
      'https://*.googlevideo.com/*',
    ],
  };
  session.defaultSession.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
    const headers = { ...details.requestHeaders };
    const hasReferer = Object.keys(headers).some((k) => k.toLowerCase() === 'referer');
    if (!hasReferer) {
      headers['Referer'] = 'https://www.youtube.com/';
    }
    callback({ requestHeaders: headers });
  });
}

// ---------------------------------------------------------------- app lifecycle
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    installYouTubeRefererFix();
    try {
      baseUrl = await startAssetServer(DIST_RENDERER, 50817);
    } catch (err) {
      console.error('Falha ao iniciar servidor de assets:', err);
      app.quit();
      return;
    }
    createWindow();
    // Reabre o mini timer se estava aberto quando o app foi fechado.
    if (loadSettings().miniOpen === true) {
      setTimeout(() => createMiniWindow(), 400);
    }
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    app.quit(); // Windows behavior: quit even without macOS-style override
  });

  app.on('before-quit', () => {
    // Garante encerramento limpo: o socket keep-alive do servidor de assets
    // (navegadores mantêm conexões HTTP persistentes com o renderer)
    // pode deixar o processo do Electron vivo no Gerenciador de Tarefas.
    assetServer?.closeAllConnections();
    assetServer?.close(() => {
      /* best-effort */
    });
  });
}
