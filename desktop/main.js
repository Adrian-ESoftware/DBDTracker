import { config } from "dotenv";
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
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
import { createCommunityAuth, ensureAnonymousCommunitySession, linkRecoveryEmailDirect, uploadCommunitySubmission } from "./community.js";

function loadCommunityConfig() {
  try {
    const file = JSON.parse(readFileSync(join(import.meta.dirname, "community-config.json"), "utf8"));
    return {
      apiUrl: process.env.COMMUNITY_API_URL || file.apiUrl,
      supabaseUrl: process.env.COMMUNITY_SUPABASE_URL || file.supabaseUrl,
      publishableKey: process.env.COMMUNITY_SUPABASE_PUBLISHABLE_KEY || file.publishableKey
    };
  } catch {
    return {
      apiUrl: process.env.COMMUNITY_API_URL,
      supabaseUrl: process.env.COMMUNITY_SUPABASE_URL,
      publishableKey: process.env.COMMUNITY_SUPABASE_PUBLISHABLE_KEY
    };
  }
}

const communityConfig = loadCommunityConfig();

// ── Otimizações de memória e plataforma ──
if (process.platform === "win32") {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("disable-gpu");
  app.commandLine.appendSwitch("disable-gpu-compositing");
  app.commandLine.appendSwitch("disable-software-rasterizer");
  app.commandLine.appendSwitch("wm-window-animations-disabled");
}
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
try {
  app.commandLine.appendSwitch("disk-cache-dir", join(app.getPath("userData"), "cache"));
  app.commandLine.appendSwitch("gpu-disk-cache-dir", join(app.getPath("userData"), "gpu-cache"));
} catch {}

// Garante instancia unica: se ja existe uma rodando, foca ela e encerra esta
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

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
let communityAuth = null;
let communityState = { configured: false, enabled: false, syncing: false, email: null, pendingEmail: null, officialEmail: null, emailConfirmed: false, message: "Contribuição desativada." };
const mapOverlaysPath = join(import.meta.dirname, "map_overlays");
const mapCatalogPath = join(import.meta.dirname, "dbd-map-catalog.json");
let userConfig = {
  overlayCorner: "top-right",
  overlayOpacity: 70,
  overlaySize: 350,
  mapCheckEnabled: true,
  mapCheckLanguage: "pt-br",
  shortcutToggleOverlay: "CommandOrControl+Shift+F",
  shortcutToggleClicks: "CommandOrControl+Shift+X",
  shortcutCloseMap: "Backspace",
  alwaysOnTop: true,
  startWithSystem: false,
  startMinimized: false
};

function createCommunityStorage() {
  const sessionPath = join(app.getPath("userData"), "community-session.json");
  return {
    getItem(key) {
      try { return JSON.parse(readFileSync(sessionPath, "utf8"))[key] ?? null; } catch { return null; }
    },
    setItem(key, value) {
      let values = {};
      try { values = JSON.parse(readFileSync(sessionPath, "utf8")); } catch {}
      values[key] = value;
      writeFileSync(sessionPath, JSON.stringify(values), "utf8");
    },
    removeItem(key) {
      let values = {};
      try { values = JSON.parse(readFileSync(sessionPath, "utf8")); } catch {}
      delete values[key];
      writeFileSync(sessionPath, JSON.stringify(values), "utf8");
    }
  };
}

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

function registerGlobalShortcuts() {
  try {
    globalShortcut.unregisterAll();
  } catch {}

  const toggleKey = userConfig.shortcutToggleOverlay || "CommandOrControl+Shift+F";
  try {
    const ok = globalShortcut.register(toggleKey, () => {
      if (!window || window.isDestroyed()) return;
      if (clickThrough) {
        clickThrough = false;
        window.setIgnoreMouseEvents(false);
        window.show();
        window.webContents.send("scrape-status", "Controle do mouse restaurado.");
      } else {
        window.isVisible() ? window.hide() : window.show();
      }
    });
    if (!ok) console.warn(`[Main] Falha ao registrar atalho: ${toggleKey}`);
  } catch (err) {
    console.error(`[Main] Erro ao registrar atalho (${toggleKey}):`, err.message);
  }

  const clickKey = userConfig.shortcutToggleClicks || "CommandOrControl+Shift+X";
  try {
    const ok = globalShortcut.register(clickKey, () => {
      if (!window || window.isDestroyed()) return;
      clickThrough = !clickThrough;
      window.setIgnoreMouseEvents(clickThrough, { forward: true });
    });
    if (!ok) console.warn(`[Main] Falha ao registrar atalho: ${clickKey}`);
  } catch (err) {
    console.error(`[Main] Erro ao registrar atalho (${clickKey}):`, err.message);
  }

  if (mapOverlayWindow && !mapOverlayWindow.isDestroyed() && mapOverlayWindow.isVisible()) {
    registerMapCloseShortcut();
  }
}

function registerMapCloseShortcut() {
  const closeKey = userConfig.shortcutCloseMap || "Backspace";
  try {
    globalShortcut.register(closeKey, () => {
      if (mapOverlayWindow && !mapOverlayWindow.isDestroyed()) {
        mapOverlayWindow.close();
      }
    });
  } catch (err) {
    console.warn(`[Main] Falha ao registrar atalho (${closeKey}):`, err.message);
  }
}

function unregisterMapCloseShortcut() {
  const closeKey = userConfig.shortcutCloseMap || "Backspace";
  try {
    globalShortcut.unregister(closeKey);
  } catch (err) {}
}

const isMinimizedArg = process.argv.includes("--minimized");

function applyStartWithSystem(enabled, startMinimized) {
  if (process.platform === "win32" || process.platform === "darwin") {
    try {
      app.setLoginItemSettings({
        openAtLogin: !!enabled,
        openAsHidden: !!startMinimized
      });
    } catch (err) {
      console.warn("[Main] Falha ao configurar app.setLoginItemSettings:", err.message);
    }
  } else if (process.platform === "linux") {
    try {
      const autostartDir = process.env.XDG_CONFIG_HOME
        ? join(process.env.XDG_CONFIG_HOME, "autostart")
        : join(app.getPath("home"), ".config", "autostart");
      const desktopFile = join(autostartDir, "dbd-tracker.desktop");

      if (enabled) {
        if (!existsSync(autostartDir)) {
          mkdirSync(autostartDir, { recursive: true });
        }
        const execPath = process.env.APPIMAGE || process.execPath;
        const iconPath = join(import.meta.dirname, "tray_icons", "Icon.png");
        const args = startMinimized ? " --minimized" : "";
        const content = [
          "[Desktop Entry]",
          "Type=Application",
          "Name=DBD Tracker",
          "Comment=Dead by Daylight Match Tracker Overlay",
          `Exec="${execPath}"${args}`,
          `Icon=${iconPath}`,
          "Terminal=false",
          "Categories=Game;Utility;",
          "X-GNOME-Autostart-enabled=true"
        ].join("\n") + "\n";

        writeFileSync(desktopFile, content, "utf-8");
        console.log("[Main] Autostart no Linux configurado em:", desktopFile);
      } else {
        if (existsSync(desktopFile)) {
          unlinkSync(desktopFile);
          console.log("[Main] Autostart no Linux removido:", desktopFile);
        }
      }
    } catch (err) {
      console.warn("[Main] Falha ao configurar autostart no Linux:", err.message);
    }
  }
}

function loadMapCheckCatalog() {
  if (!existsSync(mapCatalogPath)) {
    throw new Error(`Catálogo de mapas não encontrado: ${mapCatalogPath}`);
  }

  const catalogText = readFileSync(mapCatalogPath, "utf-8");
  const catalog = JSON.parse(catalogText);
  if (!catalog || !Array.isArray(catalog.maps) || catalog.maps.length === 0) {
    throw new Error("Catálogo de mapas vazio ou inválido");
  }

  return JSON.stringify(catalog);
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
  const alwaysOnTopLevel = process.platform === "win32" || process.platform === "darwin" ? "screen-saver" : "floating";
  window.setAlwaysOnTop(userConfig.alwaysOnTop !== false, alwaysOnTopLevel);
  window.loadFile(join(import.meta.dirname, "overlay.html"));
  window.once("ready-to-show", () => {
    if (!userConfig.startMinimized && !isMinimizedArg) {
      window.show();
    }
  });

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

function stopMapCheck() {
  if (mapCheckProcess) {
    console.log("[Main] Stopping map-check process...");
    mapCheckProcess.removeAllListeners("close");
    mapCheckProcess.kill();
    mapCheckProcess = null;
  }
  mapCheckStatus = { status: "disabled", monitor: null };
  if (window && !window.isDestroyed()) {
    window.webContents.send("map-check-event", { type: "disabled" });
  }
}

function startMapCheck() {
  if (userConfig.mapCheckEnabled === false) {
    console.log("[Main] Map check is disabled in config.");
    mapCheckStatus = { status: "disabled", monitor: null };
    if (window && !window.isDestroyed()) {
      window.webContents.send("map-check-event", { type: "disabled" });
    }
    return;
  }

  if (mapCheckProcess) {
    return;
  }

  const exeName = process.platform === "win32" ? "map-check.exe" : "map-check";
  let mapCheckPath = app.isPackaged
    ? join(process.resourcesPath, "map-check", exeName)
    : join(import.meta.dirname, "..", "map-check", "target", "electron", exeName);

  if (!existsSync(mapCheckPath)) {
    const altName = process.platform === "win32" ? "map-check" : "map-check.exe";
    const altPath = app.isPackaged
      ? join(process.resourcesPath, "map-check", altName)
      : join(import.meta.dirname, "..", "map-check", "target", "electron", altName);
    if (existsSync(altPath)) {
      mapCheckPath = altPath;
    }
  }

  if (!existsSync(mapCheckPath)) {
    console.warn(`[Main] map-check executable not found at: ${mapCheckPath}`);
    mapCheckStatus = { status: "error", error: "Executável não encontrado" };
    return;
  }

  let mapCatalogJson;
  try {
    mapCatalogJson = loadMapCheckCatalog();
  } catch (err) {
    console.error("[Main] map-check catalog error:", err);
    mapCheckStatus = { status: "error", error: err.message };
    if (window && !window.isDestroyed()) {
      window.webContents.send("map-check-event", { type: "map_catalog_error", error: err.message });
    }
    return;
  }

  const mapCheckLanguage = userConfig.mapCheckLanguage || "pt-br";
  const mapCheckArgs = ["--json", "--lang", mapCheckLanguage, "--maps-json", mapCatalogJson];
  console.log(`[Main] Spawning map-check from: ${mapCheckPath}`);
  try {
    mapCheckProcess = spawn(mapCheckPath, mapCheckArgs, {
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
      if (mapCheckStatus.status !== "error") {
        mapCheckStatus = { status: "error", error: `Processo encerrado (${code})` };
      }
    });
  } catch (err) {
    console.error("[Main] Error starting map-check child process:", err);
    mapCheckStatus = { status: "error", error: err.message };
  }
}

function handleMapCheckEvent(event) {
  if (event.type === "ready") {
    mapCheckStatus = { status: "ready", monitor: event.monitor, catalog: event.map_catalog };
  } else if (event.type === "listener_error" || event.type === "capture_error" || event.type === "ocr_error" || event.type === "map_catalog_error") {
    mapCheckStatus = { ...mapCheckStatus, status: "error", error: event.error };
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

  const alwaysOnTopLevel = process.platform === "win32" || process.platform === "darwin" ? "screen-saver" : "floating";
  mapOverlayWindow.setAlwaysOnTop(true, alwaysOnTopLevel);
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
      registerMapCloseShortcut();
    }
  });

  mapOverlayWindow.on("closed", () => {
    unregisterMapCloseShortcut();
  });
}

function setOverlayWindowOpacity() {
  if (!mapOverlayWindow || mapOverlayWindow.isDestroyed()) return;
  const userOpacity = (userConfig.overlayOpacity || 70) / 100;
  mapOverlayWindow.webContents.executeJavaScript(`
    (() => {
      const img = document.querySelector('img');
      if (img) img.style.opacity = '${userOpacity}';
    })()
  `).catch(() => {});
}

function positionOverlayWindow() {
  if (!mapOverlayWindow || mapOverlayWindow.isDestroyed()) return;

  const targetSize = userConfig.overlaySize || 350;
  const [currentW, currentH] = mapOverlayWindow.getSize();
  if (currentW !== targetSize || currentH !== targetSize) {
    mapOverlayWindow.setSize(targetSize, targetSize);
  }

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
  loadUserConfig();

  communityAuth = createCommunityAuth({
    url: communityConfig.supabaseUrl,
    publishableKey: communityConfig.publishableKey && !communityConfig.publishableKey.startsWith("COLE_AQUI")
      ? communityConfig.publishableKey : null,
    storage: createCommunityStorage()
  });
  communityState.configured = !!communityAuth;
  communityState.enabled = !!userConfig.communityOptIn;
  communityState.officialEmail = userConfig.userEmail || null;
  communityState.pendingEmail = userConfig.communityPendingEmail || null;
  if (communityAuth) {
    communityAuth.auth.onAuthStateChange((_event, session) => {
      const user = session?.user;
      communityState.email = user?.email ?? communityState.pendingEmail ?? null;
      communityState.emailConfirmed = !!user?.email_confirmed_at;
      if (user?.email && user.email === communityState.pendingEmail) {
        communityState.pendingEmail = null;
        userConfig.communityPendingEmail = null;
        saveUserConfig();
      }
      if (window && !window.isDestroyed()) window.webContents.send("community-status", communityState);
    });
  }

  const db = openDatabase(join(app.getPath("userData"), "dbd_tracker.sqlite3"));
  console.log(`[Main] Banco de dados local: ${db.type}. O banco comunitário é acessado exclusivamente pela API segura.`);

  if (userConfig.userEmail) {
    db.userEmail = userConfig.userEmail;
    console.log("[Main] Identidade oficial carregada para uso local; ela não é enviada ao banco comunitário.");
  }

  // Mostra a janela o mais rápido possível
  createWindow();
  createTray();

  // Adia operações pesadas para após a janela aparecer (startup mais rápido)
  const startServices = () => {
    if (server) return;
    server = startServer(db, 8765, mapOverlaysPath);
    collector = createBackgroundCollector(db, state => {
      if (window && !window.isDestroyed()) {
        window.webContents.send("collector-status", state);
      }
    }, async newMatches => {
      if (!userConfig.communityOptIn || !communityAuth) return;
      try {
        communityState.syncing = true;
        communityState.message = "Enviando dados anônimos...";
        const session = await ensureAnonymousCommunitySession(communityAuth);
        await uploadCommunitySubmission({
          apiUrl: communityConfig.apiUrl,
          accessToken: session.access_token,
          matches: newMatches
        });
        communityState.message = `${newMatches.length} partida(s) sincronizada(s).`;
      } catch (error) {
        communityState.message = error.message.startsWith("Falha na sincronização")
          ? error.message
          : `Falha na sincronização: ${error.message}`;
      } finally {
        communityState.syncing = false;
        if (window && !window.isDestroyed()) window.webContents.send("community-status", communityState);
      }
    });
    // Inicia o coletor 2s após a janela aparecer para não travar a UI
    setTimeout(() => collector.start(), 2000);
    // Inicia o detector de mapas
    setTimeout(() => startMapCheck(), 1000);
  };

  window.once("show", startServices);
  if (userConfig.startMinimized || isMinimizedArg) {
    setTimeout(startServices, 1000);
  }

  if (userConfig.startWithSystem) {
    applyStartWithSystem(true, userConfig.startMinimized);
  }

  registerGlobalShortcuts();
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
ipcMain.handle("community-status", async () => {
  loadUserConfig();
  communityState.officialEmail = userConfig.userEmail || null;
  if (communityAuth) {
    const { data } = await communityAuth.auth.getSession();
    const user = data.session?.user;
    communityState.email = user?.email ?? communityState.pendingEmail ?? null;
    communityState.emailConfirmed = !!user?.email_confirmed_at;
  }
  return communityState;
});
ipcMain.handle("community-stats", async () => {
  if (!communityAuth) throw new Error("Community Supabase is not configured");
  const [charactersRes, mapsRes, killersRes, perksRes] = await Promise.all([
    communityAuth.from("public_character_stats").select("role, character_id, match_count"),
    communityAuth.from("public_map_stats").select("role, map_id, match_count"),
    communityAuth.from("public_killer_stats").select("killer_id, match_count, average_kills"),
    communityAuth.from("public_perk_stats").select("role, perk_id, usage_count")
  ]);
  for (const result of [charactersRes, mapsRes, killersRes, perksRes]) {
    if (result.error) throw result.error;
  }
  const aggregate = (rows, key, countKey = "match_count") => {
    const groups = new Map();
    for (const row of rows || []) {
      const value = row[key];
      if (!value) continue;
      groups.set(value, (groups.get(value) || 0) + Number(row[countKey] || 0));
    }
    const total = [...groups.values()].reduce((sum, value) => sum + value, 0);
    return [...groups].map(([value, count]) => ({ value, count, pct: total ? Math.round(count * 1000 / total) / 10 : 0 }))
      .sort((a, b) => b.count - a.count);
  };
  const characterRows = charactersRes.data || [];
  const mapRows = mapsRes.data || [];
  const perkRows = perksRes.data || [];
  return {
    characters: {
      survivor: aggregate(characterRows.filter(row => row.role === "survivor"), "character_id"),
      killer: aggregate(characterRows.filter(row => row.role === "killer"), "character_id")
    },
    maps: aggregate(mapRows, "map_id"),
    killers: (killersRes.data || []).filter(row => row.killer_id).map(row => ({
      killer: row.killer_id, count: Number(row.match_count || 0), average_kills: row.average_kills
    })).sort((a, b) => b.count - a.count),
    perks: {
      survivor: aggregate(perkRows.filter(row => row.role === "survivor"), "perk_id", "usage_count"),
      killer: aggregate(perkRows.filter(row => row.role === "killer"), "perk_id", "usage_count")
    }
  };
});
ipcMain.handle("set-community-opt-in", async (_, enabled) => {
  if (enabled) {
    if (!communityAuth) throw new Error("Community Supabase is not configured");
    await ensureAnonymousCommunitySession(communityAuth);
  }
  userConfig.communityOptIn = !!enabled;
  communityState.enabled = !!enabled;
  communityState.message = enabled ? "Contribuição anônima ativada." : "Contribuição desativada.";
  saveUserConfig();
  return communityState;
});
ipcMain.handle("link-community-email", async (_, email) => {
  if (!communityAuth) throw new Error("Community Supabase is not configured");
  const requestedEmail = String(email || "").trim();
  if (!requestedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(requestedEmail)) {
    throw new Error("Informe um e-mail válido.");
  }
  communityState.pendingEmail = requestedEmail;
  communityState.email = requestedEmail;
  communityState.emailConfirmed = false;
  communityState.message = "Enviando confirmação para o e-mail informado...";
  if (window && !window.isDestroyed()) window.webContents.send("community-status", communityState);
  try {
    await ensureAnonymousCommunitySession(communityAuth);
    const session = await communityAuth.auth.getSession();
    const linked = await linkRecoveryEmailDirect({
      apiUrl: communityConfig.apiUrl,
      accessToken: session.data.session?.access_token,
      email: requestedEmail
    });
    communityState.email = linked.email ?? requestedEmail;
    communityState.emailConfirmed = !!linked.email_confirmed;
    userConfig.communityPendingEmail = communityState.email;
    saveUserConfig();
    communityState.message = "E-mail vinculado. Verifique sua caixa de entrada para confirmar a recuperação.";
    return communityState;
  } catch (error) {
    communityState.pendingEmail = null;
    communityState.email = null;
    communityState.message = `Não foi possível vincular o e-mail: ${error.message}`;
    throw error;
  }
});
ipcMain.handle("show-map-preview", () => {
  createMapOverlayWindow("DVARKA DEEPWOOD - TOBA LANDING");
  return true;
});
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
  const oldEnabled = userConfig.mapCheckEnabled !== false;
  const oldLanguage = userConfig.mapCheckLanguage || "pt-br";
  const oldAlwaysOnTop = userConfig.alwaysOnTop !== false;
  const oldStartWithSystem = !!userConfig.startWithSystem;

  userConfig = { ...userConfig, ...settings };
  saveUserConfig();

  // Re-registra atalhos globais se algum atalho foi alterado
  if (
    settings.shortcutToggleOverlay !== undefined ||
    settings.shortcutToggleClicks !== undefined ||
    settings.shortcutCloseMap !== undefined
  ) {
    registerGlobalShortcuts();
  }

  // Atualiza Always on Top
  if (settings.alwaysOnTop !== undefined && settings.alwaysOnTop !== oldAlwaysOnTop && window && !window.isDestroyed()) {
    const alwaysOnTopLevel = process.platform === "win32" || process.platform === "darwin" ? "screen-saver" : "floating";
    window.setAlwaysOnTop(!!userConfig.alwaysOnTop, alwaysOnTopLevel);
  }

  // Atualiza Inicialização com Sistema
  if (settings.startWithSystem !== undefined && settings.startWithSystem !== oldStartWithSystem) {
    applyStartWithSystem(userConfig.startWithSystem, userConfig.startMinimized);
  }

  if (mapOverlayWindow && !mapOverlayWindow.isDestroyed()) {
    positionOverlayWindow();
    setOverlayWindowOpacity();
  }
  const newEnabled = userConfig.mapCheckEnabled !== false;
  if (oldEnabled !== newEnabled) {
    if (newEnabled) {
      startMapCheck();
    } else {
      stopMapCheck();
    }
  }
  const newLanguage = userConfig.mapCheckLanguage || "pt-br";
  if (oldEnabled && newEnabled && oldLanguage !== newLanguage) {
    stopMapCheck();
    startMapCheck();
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
