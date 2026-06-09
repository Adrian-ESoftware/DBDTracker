import "dotenv/config";
import { app, BrowserWindow, globalShortcut, ipcMain, dialog, Tray, Menu, nativeImage } from "electron";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { openDatabase } from "./database.js";
import { startServer } from "./server.js";
import { createBackgroundCollector } from "./background-collector.js";

// ── Otimizações de memória ──
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-gpu");
app.commandLine.appendSwitch("disable-gpu-compositing");
app.commandLine.appendSwitch("disable-software-rasterizer");
app.commandLine.appendSwitch("js-flags", "--max-old-space-size=128");
app.commandLine.appendSwitch("disable-site-isolation-trials");
app.commandLine.appendSwitch("disable-features", "SpareRendererForSitePerProcess");

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
          contextIsolation: true
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

function createWindow() {
  window = new BrowserWindow({
    width: 480, height: 620, minWidth: 420, minHeight: 480,
    frame: false, transparent: true, alwaysOnTop: true, resizable: true,
    skipTaskbar: false, show: false, backgroundColor: "#00000000",
    icon: join(import.meta.dirname, "tray_icons", "Icon.png"),
    webPreferences: { preload: join(import.meta.dirname, "preload.cjs"), contextIsolation: true }
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

app.whenReady().then(() => {
  // Redireciona caches do Chromium para o userData (seguro chamar apos ready)
  app.commandLine.appendSwitch("disk-cache-dir", join(app.getPath("userData"), "cache"));
  app.commandLine.appendSwitch("gpu-disk-cache-dir", join(app.getPath("userData"), "gpu-cache"));

  const db = openDatabase(join(app.getPath("userData"), "dbd_tracker.sqlite3"));

  // Carrega o e-mail do último usuário ativo do config.json
  try {
    const configPath = join(app.getPath("userData"), "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    if (config.userEmail) {
      db.userEmail = config.userEmail;
      console.log(`[Main] Inicializando banco de dados com e-mail: ${db.userEmail}`);
    }
  } catch (err) {
    // Silenciosamente ignora se o arquivo não existir ou for inválido
  }

  server = startServer(db);
  createWindow();
  createTray();
  collector = createBackgroundCollector(db, state => {
    if (window && !window.isDestroyed()) {
      window.webContents.send("collector-status", state);
    }
  });
  collector.start();
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
ipcMain.handle("show-login", () => collector.showLogin());
ipcMain.handle("finish-login", () => collector.finishLogin());
ipcMain.handle("collect-now", () => collector.collect());
ipcMain.handle("clear-login", () => collector.clearLogin());
ipcMain.handle("collector-status", () => collector.getState());
ipcMain.handle("toggle-size", () => {
  compact = !compact;
  window.setSize(compact ? 480 : 1180, compact ? 620 : 760, true);
  return compact;
});
app.on("before-quit", () => {
  isQuitting = true;
  collector?.stop();
});
app.on("will-quit", () => { globalShortcut.unregisterAll(); collector?.stop(); server?.close(); });
app.on("window-all-closed", () => app.quit());
