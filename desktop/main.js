import { config } from "dotenv";
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";

// Carrega .env do diretório da aplicação (funciona tanto em dev quanto no exe empacotado)
const envPath = join(import.meta.dirname, ".env");
if (existsSync(envPath)) {
  config({ path: envPath });
} else {
  config(); // fallback padrão
}
import { app, BrowserWindow, globalShortcut, ipcMain, dialog, Tray, Menu, nativeImage, screen } from "electron";
import { openDatabase } from "./database.js";
import { startServer } from "./server.js";
import { createBackgroundCollector } from "./background-collector.js";

// ── Otimizações de memória ──
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-gpu");
app.commandLine.appendSwitch("disable-gpu-compositing");
app.commandLine.appendSwitch("disable-software-rasterizer");
app.commandLine.appendSwitch("js-flags", "--max-old-space-size=64 --lite-mode");
app.commandLine.appendSwitch("disable-site-isolation-trials");
app.commandLine.appendSwitch("disable-features", "SpareRendererForSitePerProcess,TranslateUI,BlinkGenPropertyTrees");
// Reduz processos auxiliares e networking em background
app.commandLine.appendSwitch("renderer-process-limit", "1");
app.commandLine.appendSwitch("disable-background-networking");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-component-update");
app.commandLine.appendSwitch("disable-sync");
app.commandLine.appendSwitch("disable-translate");
app.commandLine.appendSwitch("disable-extensions");
app.commandLine.appendSwitch("disable-default-apps");
app.commandLine.appendSwitch("no-first-run");
app.commandLine.appendSwitch("disable-breakpad");
app.commandLine.appendSwitch("disable-domain-reliability");

// Garante instancia unica: se ja existe uma rodando, foca ela e encerra esta
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

// Desativa animações nativas de janela do Windows para evitar piscadas na transição show/hide
app.commandLine.appendSwitch("wm-window-animations-disabled");

// Quando uma segunda instancia tenta abrir, foca a janela existente
app.on("second-instance", () => {
  if (window) {
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }
});

app.on("browser-window-created", (event, newWindow) => {
  newWindow.webContents.setWindowOpenHandler(({ url }) => {
    console.log(`[Main] Interceptando popup: ${url}`);
    return {
      action: "allow",
      overrideBrowserWindowOptions: {
        width: 800,
        height: 700,
        center: true,
        parent: null,
        autoHideMenuBar: true,
        webPreferences: {
          partition: "persist:dbd-official",
          contextIsolation: true,
          spellcheck: false,
          enableWebSQL: false
        }
      }
    };
  });
});

let window;
let compact = true;
let clickThrough = false;
let server;
let collector;
let tray;
let isQuitting = false;
let mapCheckProcess = null;
let mapCheckBuffer = "";
let mapCheckStatus = { status: "initializing", monitor: null };
let mapOverlayWindow = null;
const mapOverlaysPath = join(import.meta.dirname, "map_overlays");
let userConfig = { overlayCorner: "top-right", overlayOpacity: 70, overlaySize: 350 };

function loadUserConfig() {
  try {
    const configPath = join(app.getPath("userData"), "config.json");
    if (existsSync(configPath)) {
      const loaded = JSON.parse(readFileSync(configPath, "utf-8"));
      userConfig = { ...userConfig, ...loaded };
    }
  } catch (err) {
    console.error("[Main] Error loading config:", err);
  }
}

function saveUserConfig() {
  try {
    const configPath = join(app.getPath("userData"), "config.json");
    writeFileSync(configPath, JSON.stringify(userConfig, null, 2), "utf-8");
  } catch (err) {
    console.error("[Main] Error saving config:", err);
  }
}

function createWindow() {
  window = new BrowserWindow({
    width: 480, height: 620, minWidth: 420, minHeight: 480,
    frame: false, transparent: true, alwaysOnTop: true, resizable: true,
    skipTaskbar: false, show: false, backgroundColor: "#00000000",
    icon: join(import.meta.dirname, "tray_icons", "Icon.png"),
    webPreferences: {
      preload: join(import.meta.dirname, "preload.cjs"),
      contextIsolation: true,
      spellcheck: false,
      enableWebSQL: false,
      v8CacheOptions: "none"
    }
  });
  window.setAlwaysOnTop(true, "screen-saver");
  window.loadFile(join(import.meta.dirname, "overlay.html"));
  window.once("ready-to-show", () => window.show());

  // Intercepta o fechamento da janela para apenas ocultar
  window.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      window.hide();
    }
  });
}

function createTray() {
  const iconPath = join(import.meta.dirname, "tray_icons", "Icon.png");
  const icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  const contextMenu = Menu.buildFromTemplate([
    { label: "Abrir DBD Tracker", click: () => { window.show(); window.focus(); } },
    { type: "separator" },
    { label: "Sair", click: () => { isQuitting = true; app.quit(); } }
  ]);
  tray.setToolTip("DBD Tracker Overlay");
  tray.setContextMenu(contextMenu);
  tray.on("click", () => {
    window.isVisible() ? window.hide() : (window.show(), window.focus());
  });
}

function startMapCheck() {
  const exeName = "map-check.exe";
  const mapCheckPath = app.isPackaged
    ? join(process.resourcesPath, "map-check", exeName)
    : join(import.meta.dirname, "..", "map-check", "target", "electron", exeName);

  if (!existsSync(mapCheckPath)) {
    console.warn(`[Main] map-check executable not found at: ${mapCheckPath}`);
    mapCheckStatus = { status: "error", error: "Executável não encontrado" };
    return;
  }

  console.log(`[Main] Spawning map-check from: ${mapCheckPath}`);
  try {
    mapCheckProcess = spawn(mapCheckPath, ["--json"], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    mapCheckProcess.stdout.setEncoding("utf8");
    mapCheckProcess.stdout.on("data", chunk => {
      mapCheckBuffer += chunk;
      const lines = mapCheckBuffer.split(/\r?\n/);
      mapCheckBuffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          handleMapCheckEvent(event);
        } catch (error) {
          console.warn("[Main] Invalid map-check event JSON:", line, error);
        }
      }
    });

    mapCheckProcess.stderr.on("data", data => {
      console.warn(`[Main] map-check stderr: ${data.toString()}`);
    });

    mapCheckProcess.on("error", err => {
      console.error("[Main] Failed to start map-check process:", err);
      mapCheckStatus = { status: "error", error: err.message };
      if (window && !window.isDestroyed()) {
        window.webContents.send("map-check-event", { type: "capture_error", error: err.message });
      }
    });

    mapCheckProcess.on("close", code => {
      console.log(`[Main] map-check process exited with code ${code}`);
      mapCheckProcess = null;
      mapCheckStatus = { status: "error", error: `Processo encerrado (${code})` };
    });
  } catch (err) {
    console.error("[Main] Error starting map-check child process:", err);
    mapCheckStatus = { status: "error", error: err.message };
  }
}

function handleMapCheckEvent(event) {
  if (event.type === "ready") {
    mapCheckStatus = { status: "ready", monitor: event.monitor };
  } else if (event.type === "listener_error" || event.type === "capture_error" || event.type === "ocr_error") {
    mapCheckStatus.error = event.error;
  } else if (event.type === "map_detected" && event.map) {
    const imgFileName = event.map.replace(/ /g, "_") + ".png";
    const filePath = join(mapOverlaysPath, imgFileName);
    if (existsSync(filePath)) {
      console.log(`[Main] Mapa detectado e imagem encontrada! Abrindo overlay para: ${event.map}`);
      createMapOverlayWindow(event.map);
    } else {
      console.log(`[Main] Nenhuma imagem de overlay encontrada para o mapa: ${event.map} (esperado: ${filePath})`);
    }
  }
  if (window && !window.isDestroyed()) {
    window.webContents.send("map-check-event", event);
  }
}

function createMapOverlayWindow(mapName) {
  if (mapOverlayWindow && !mapOverlayWindow.isDestroyed()) {
    mapOverlayWindow.destroy();
  }

  const overlayWidth = userConfig.overlaySize || 350;
  const overlayHeight = userConfig.overlaySize || 350;
  const userOpacity = (userConfig.overlayOpacity || 70) / 100;

  mapOverlayWindow = new BrowserWindow({
    width: overlayWidth,
    height: overlayHeight,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    show: false,
    backgroundColor: "#00000000",
    webPreferences: {
      contextIsolation: true,
      enableWebSQL: false
    }
  });

  mapOverlayWindow.setAlwaysOnTop(true, "screen-saver");
  mapOverlayWindow.setIgnoreMouseEvents(true);

  positionOverlayWindow();

  const imageFileName = encodeURIComponent(mapName.replace(/ /g, "_") + ".png");
  const imageUrl = `http://127.0.0.1:8765/api/map-overlays/${imageFileName}`;
  
  const htmlContent = `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body {
          margin: 0;
          padding: 0;
          width: 100vw;
          height: 100vh;
          overflow: hidden;
          display: flex;
          align-items: center;
          justify-content: center;
          background: transparent;
          user-select: none;
          -webkit-user-select: none;
        }
        img {
          max-width: 100%;
          max-height: 100%;
          object-fit: contain;
          opacity: ${userOpacity};
          animation: fadeIn 0.4s cubic-bezier(0.16, 1, 0.3, 1) forwards;
        }
        @keyframes fadeIn {
          from { opacity: 0; transform: scale(0.95); }
          to { opacity: ${userOpacity}; transform: scale(1); }
        }
      </style>
    </head>
    <body>
      <img src="${imageUrl}" onerror="window.close()" />
    </body>
    </html>
  `;

  mapOverlayWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(htmlContent)}`);

  mapOverlayWindow.once("ready-to-show", () => {
    if (mapOverlayWindow && !mapOverlayWindow.isDestroyed()) {
      mapOverlayWindow.showInactive();
      try {
        globalShortcut.register("Backspace", () => {
          if (mapOverlayWindow && !mapOverlayWindow.isDestroyed()) {
            mapOverlayWindow.close();
          }
        });
      } catch (err) {
        console.warn("[Main] Failed to register Backspace shortcut:", err);
      }
    }
  });

  mapOverlayWindow.on("closed", () => {
    try {
      globalShortcut.unregister("Backspace");
    } catch (err) {}
  });
}

function positionOverlayWindow() {
  if (!mapOverlayWindow || mapOverlayWindow.isDestroyed()) return;

  const display = screen.getPrimaryDisplay();
  const { x, y, width: scrWidth, height: scrHeight } = display.workArea;
  const [overlayWidth, overlayHeight] = mapOverlayWindow.getSize();

  let posX = x + scrWidth - overlayWidth - 20;
  let posY = y + 20; // Default: Top-Right

  const corner = userConfig.overlayCorner || "top-right";
  if (corner === "top-left") {
    posX = x + 20;
    posY = y + 20;
  } else if (corner === "bottom-left") {
    posX = x + 20;
    posY = y + scrHeight - overlayHeight - 20;
  } else if (corner === "bottom-right") {
    posX = x + scrWidth - overlayWidth - 20;
    posY = y + scrHeight - overlayHeight - 20;
  } else if (corner === "top-right") {
    posX = x + scrWidth - overlayWidth - 20;
    posY = y + 20;
  }

  mapOverlayWindow.setPosition(posX, posY);
}

app.whenReady().then(() => {
  // Redireciona caches do Chromium para o userData (seguro chamar apos ready)
  app.commandLine.appendSwitch("disk-cache-dir", join(app.getPath("userData"), "cache"));
  app.commandLine.appendSwitch("gpu-disk-cache-dir", join(app.getPath("userData"), "gpu-cache"));

  loadUserConfig();

  const db = openDatabase(join(app.getPath("userData"), "dbd_tracker.sqlite3"));
  console.log(`[Main] Banco de dados: ${db.type} | SUPABASE_URL: ${process.env.SUPABASE_URL ? "configurado" : "NÃO ENCONTRADO"}`);

  if (userConfig.userEmail) {
    db.userEmail = userConfig.userEmail;
    console.log(`[Main] Inicializando banco de dados com e-mail: ${db.userEmail}`);
  }

  // Mostra a janela o mais rápido possível
  createWindow();
  createTray();

  // Adia operações pesadas para após a janela aparecer (startup mais rápido)
  window.once("show", () => {
    server = startServer(db, 8765, mapOverlaysPath);
    collector = createBackgroundCollector(db, state => {
      if (window && !window.isDestroyed()) {
        window.webContents.send("collector-status", state);
      }
    });
    // Inicia o coletor 2s após a janela aparecer para não travar a UI
    setTimeout(() => collector.start(), 2000);
    // Inicia o detector de mapas
    setTimeout(() => startMapCheck(), 1000);
  });
  globalShortcut.register("CommandOrControl+Shift+F", () => {
    if (clickThrough) {
      clickThrough = false;
      window.setIgnoreMouseEvents(false);
      window.show();
      window.webContents.send("scrape-status", "Controle do mouse restaurado.");
    } else {
      window.isVisible() ? window.hide() : window.show();
    }
  });
  globalShortcut.register("CommandOrControl+Shift+X", () => {
    clickThrough = !clickThrough;
    window.setIgnoreMouseEvents(clickThrough, { forward: true });
  });
});

ipcMain.on("hide-overlay", () => window.hide());
ipcMain.handle("toggle-clicks", () => {
  clickThrough = !clickThrough;
  window.setIgnoreMouseEvents(clickThrough, { forward: true });
  return clickThrough;
});
ipcMain.handle("show-login", () => collector?.showLogin());
ipcMain.handle("finish-login", () => collector?.finishLogin());
ipcMain.handle("collect-now", () => collector?.collect());
ipcMain.handle("clear-login", () => collector?.clearLogin());
ipcMain.handle("collector-status", () => collector ? collector.getState() : { message: "Iniciando coletor...", loggedIn: false, collecting: false });
ipcMain.handle("toggle-size", () => {
  compact = !compact;
  window.setSize(compact ? 480 : 1180, compact ? 620 : 760, true);
  return compact;
});
ipcMain.handle("map-check-status", () => {
  return {
    ...mapCheckStatus,
    active: !!mapCheckProcess
  };
});
ipcMain.handle("get-overlay-settings", () => {
  loadUserConfig();
  return {
    ...userConfig,
    overlaysPath: mapOverlaysPath
  };
});
ipcMain.handle("save-overlay-settings", (_, settings) => {
  loadUserConfig();
  userConfig = { ...userConfig, ...settings };
  saveUserConfig();
  if (mapOverlayWindow && !mapOverlayWindow.isDestroyed()) {
    positionOverlayWindow();
  }
  return {
    ...userConfig,
    overlaysPath: mapOverlaysPath
  };
});
app.on("before-quit", () => {
  isQuitting = true;
  collector?.stop();
  if (mapCheckProcess && !mapCheckProcess.killed) {
    mapCheckProcess.kill();
  }
  if (mapOverlayWindow && !mapOverlayWindow.isDestroyed()) {
    mapOverlayWindow.destroy();
  }
});
app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  collector?.stop();
  server?.close();
  if (mapCheckProcess && !mapCheckProcess.killed) {
    mapCheckProcess.kill();
  }
  if (mapOverlayWindow && !mapOverlayWindow.isDestroyed()) {
    mapOverlayWindow.destroy();
  }
});
app.on("window-all-closed", () => app.quit());
