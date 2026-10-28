import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export const DEFAULT_GITHUB_REPO = "Adrian-ESoftware/DBDTracker";

export function normalizeVersion(version) {
  return String(version || "")
    .trim()
    .replace(/^v/i, "")
    .split("-")[0];
}

export function compareVersions(v1, v2) {
  const a = normalizeVersion(v1).split(".").map(n => Number.parseInt(n, 10) || 0);
  const b = normalizeVersion(v2).split(".").map(n => Number.parseInt(n, 10) || 0);
  const len = Math.max(a.length, b.length, 3);
  for (let i = 0; i < len; i++) {
    const diff = (a[i] || 0) - (b[i] || 0);
    if (diff > 0) return 1;
    if (diff < 0) return -1;
  }
  return 0;
}

export function selectReleaseAsset(assets = [], platform = process.platform) {
  if (!Array.isArray(assets) || assets.length === 0) return null;

  if (platform === "win32") {
    const exeAssets = assets.filter(
      a => a && typeof a.name === "string" && a.name.toLowerCase().endsWith(".exe") && !a.name.toLowerCase().endsWith(".blockmap")
    );
    return (
      exeAssets.find(a => a.name.toLowerCase().includes("dbd-tracker-overlay")) ||
      exeAssets[0] ||
      null
    );
  }

  if (platform === "linux") {
    const appImageAssets = assets.filter(
      a => a && typeof a.name === "string" && a.name.toLowerCase().endsWith(".appimage")
    );
    return (
      appImageAssets.find(a => a.name.toLowerCase().includes("dbd-tracker-overlay")) ||
      appImageAssets[0] ||
      null
    );
  }

  return null;
}

export function buildWindowsUpdateScript(sourceExePath, targetExePath, relaunch = true) {
  const relaunchLine = relaunch ? `    start "" "%DST%"\r\n` : "";
  return [
    "@echo off",
    "chcp 65001 >nul",
    `set "SRC=${sourceExePath}"`,
    `set "DST=${targetExePath}"`,
    "ping 127.0.0.1 -n 2 >nul",
    "for /L %%i in (1,1,45) do (",
    '  copy /B /Y "%SRC%" "%DST%" >nul 2>&1',
    "  if not errorlevel 1 (",
    '    del /F /Q "%SRC%" >nul 2>&1',
    relaunchLine + '    del /F /Q "%~f0" >nul 2>&1',
    "    exit /b 0",
    "  )",
    "  ping 127.0.0.1 -n 2 >nul",
    ")",
    "exit /b 1",
    ""
  ].join("\r\n");
}

export function buildWindowsVbsScript(sourceExePath, targetExePath, relaunch = true) {
  const escapedSrc = sourceExePath.replace(/"/g, '""');
  const escapedDst = targetExePath.replace(/"/g, '""');
  const relaunchCode = relaunch ? `sh.Run Chr(34) & "${escapedDst}" & Chr(34), 1, False` : "";
  return [
    'Set fso = CreateObject("Scripting.FileSystemObject")',
    'Set sh = CreateObject("WScript.Shell")',
    `src = "${escapedSrc}"`,
    `dst = "${escapedDst}"`,
    "WScript.Sleep 1500",
    "success = False",
    "For i = 1 To 45",
    "  On Error Resume Next",
    "  Err.Clear",
    "  fso.CopyFile src, dst, True",
    "  If Err.Number = 0 Then",
    "    success = True",
    "    On Error GoTo 0",
    "    Exit For",
    "  End If",
    "  On Error GoTo 0",
    "  WScript.Sleep 1000",
    "Next",
    "If success Then",
    "  On Error Resume Next",
    "  fso.DeleteFile src, True",
    relaunchCode ? `  ${relaunchCode}` : "",
    "  fso.DeleteFile WScript.ScriptFullName, True",
    "  WScript.Quit 0",
    "End If",
    "WScript.Quit 1",
    ""
  ].filter(line => line !== "").join("\r\n");
}

export function buildLinuxUpdateScript(sourceAppImagePath, targetAppImagePath, relaunch = true) {
  const escapedSrc = sourceAppImagePath.replace(/'/g, "'\\''");
  const escapedDst = targetAppImagePath.replace(/'/g, "'\\''");
  const relaunchLine = relaunch ? `"$DST" >/dev/null 2>&1 &\n` : "";
  return [
    "#!/bin/sh",
    `SRC='${escapedSrc}'`,
    `DST='${escapedDst}'`,
    "sleep 1",
    'cp -f "$SRC" "$DST" && chmod +x "$DST" && rm -f "$SRC"',
    relaunchLine + 'rm -f "$0"',
    "exit 0",
    ""
  ].join("\n");
}

export function resolveTargetExecutablePath({
  platform = process.platform,
  env = process.env,
  execPath = process.execPath,
  isPackaged = false
} = {}) {
  if (platform === "win32") {
    if (env.PORTABLE_EXECUTABLE_FILE) {
      return env.PORTABLE_EXECUTABLE_FILE;
    }
    if (isPackaged && execPath && execPath.toLowerCase().endsWith(".exe")) {
      return execPath;
    }
    return null;
  }

  if (platform === "linux") {
    if (env.APPIMAGE) {
      return env.APPIMAGE;
    }
    return null;
  }

  return null;
}

export function createAutoUpdater({
  currentVersion,
  userDataPath,
  repo = DEFAULT_GITHUB_REPO,
  platform = process.platform,
  env = process.env,
  execPath = process.execPath,
  isPackaged = false,
  fetchImpl = globalThis.fetch,
  spawnImpl = spawn,
  onStatusChange = () => {},
  onQuitAndInstall = () => {},
  onOpenExternal = () => {}
}) {
  const updatesDir = join(userDataPath, "updates");
  const targetExePath = resolveTargetExecutablePath({ platform, env, execPath, isPackaged });
  const canAutoInstall = Boolean(targetExePath);

  let state = {
    status: "idle",
    currentVersion: normalizeVersion(currentVersion),
    latestVersion: null,
    releaseUrl: `https://github.com/${repo}/releases/latest`,
    assetName: null,
    progress: 0,
    downloadedBytes: 0,
    totalBytes: 0,
    downloadedFilePath: null,
    canAutoInstall,
    message: `Versão atual: v${normalizeVersion(currentVersion)}`,
    error: null
  };

  let activeCheckPromise = null;
  let periodicTimer = null;
  let updateApplied = false;

  function emit(patch = {}) {
    state = { ...state, ...patch };
    try {
      onStatusChange({ ...state });
    } catch {}
    return { ...state };
  }

  function cleanOldUpdates(keepFileName) {
    try {
      if (!existsSync(updatesDir)) return;
      for (const entry of readdirSync(updatesDir)) {
        if (entry === keepFileName || entry === "apply-update.cmd" || entry === "apply-update.sh") continue;
        try {
          unlinkSync(join(updatesDir, entry));
        } catch {}
      }
    } catch {}
  }

  async function downloadAsset(asset, latestVersion) {
    mkdirSync(updatesDir, { recursive: true });
    const ext = platform === "win32" ? ".exe" : ".AppImage";
    const finalFileName = `DBD-Tracker-Overlay-update-${latestVersion}${ext}`;
    const finalPath = join(updatesDir, finalFileName);
    const partPath = `${finalPath}.part`;

    cleanOldUpdates(finalFileName);

    if (existsSync(finalPath)) {
      try {
        const st = statSync(finalPath);
        if (!asset.size || st.size === asset.size) {
          return emit({
            status: "downloaded",
            progress: 100,
            downloadedBytes: st.size,
            totalBytes: asset.size || st.size,
            downloadedFilePath: finalPath,
            message: `Atualização v${latestVersion} pronta para instalar!`
          });
        }
      } catch {}
    }

    emit({
      status: "downloading",
      progress: 0,
      downloadedBytes: 0,
      totalBytes: asset.size || 0,
      message: `Baixando atualização v${latestVersion} (0%)...`,
      error: null
    });

    const response = await fetchImpl(asset.browser_download_url, {
      headers: {
        "User-Agent": `DBD-Tracker-Overlay/${state.currentVersion}`
      }
    });

    if (!response.ok || !response.body) {
      throw new Error(`Falha no download da atualização (HTTP ${response.status})`);
    }

    const totalBytes = Number(response.headers?.get?.("content-length")) || asset.size || 0;
    let downloadedBytes = 0;
    let lastEmitAt = 0;

    if (existsSync(partPath)) {
      try { unlinkSync(partPath); } catch {}
    }

    const fileStream = createWriteStream(partPath);
    const reader = Readable.fromWeb(response.body);

    reader.on("data", chunk => {
      downloadedBytes += chunk.length;
      const now = Date.now();
      if (now - lastEmitAt >= 150 || (totalBytes > 0 && downloadedBytes >= totalBytes)) {
        lastEmitAt = now;
        const progress = totalBytes > 0 ? Math.min(99, Math.round((downloadedBytes / totalBytes) * 100)) : 0;
        emit({
          status: "downloading",
          progress,
          downloadedBytes,
          totalBytes,
          message: `Baixando atualização v${latestVersion} (${progress}%)...`
        });
      }
    });

    await pipeline(reader, fileStream);

    if (asset.size && asset.size > 0) {
      const actualSize = statSync(partPath).size;
      if (actualSize !== asset.size) {
        try { unlinkSync(partPath); } catch {}
        throw new Error(`Arquivo de atualização incompleto (${actualSize}/${asset.size} bytes)`);
      }
    }

    renameSync(partPath, finalPath);
    if (platform === "linux") {
      try { chmodSync(finalPath, 0o755); } catch {}
    }

    return emit({
      status: "downloaded",
      progress: 100,
      downloadedBytes: totalBytes || statSync(finalPath).size,
      totalBytes: totalBytes || statSync(finalPath).size,
      downloadedFilePath: finalPath,
      message: `Atualização v${latestVersion} pronta para instalar!`
    });
  }

  async function checkForUpdates({ autoDownload = true } = {}) {
    if (activeCheckPromise) return activeCheckPromise;

    activeCheckPromise = (async () => {
      try {
        emit({
          status: "checking",
          error: null,
          message: "Verificando atualizações no GitHub..."
        });

        const apiUrl = `https://api.github.com/repos/${repo}/releases/latest`;
        const response = await fetchImpl(apiUrl, {
          headers: {
            Accept: "application/vnd.github+json",
            "User-Agent": `DBD-Tracker-Overlay/${state.currentVersion}`
          }
        });

        if (!response.ok) {
          throw new Error(`GitHub Releases retornou HTTP ${response.status}`);
        }

        const release = await response.json();
        const latestVersion = normalizeVersion(release.tag_name || release.name || "");
        const releaseUrl = release.html_url || `https://github.com/${repo}/releases/latest`;

        if (!latestVersion || compareVersions(latestVersion, state.currentVersion) <= 0) {
          return emit({
            status: "up-to-date",
            latestVersion: latestVersion || state.currentVersion,
            releaseUrl,
            progress: 0,
            error: null,
            message: `Você está na versão mais recente (v${state.currentVersion}).`
          });
        }

        const asset = selectReleaseAsset(release.assets || [], platform);
        if (!asset || !asset.browser_download_url) {
          return emit({
            status: "available",
            latestVersion,
            releaseUrl,
            canAutoInstall: false,
            message: `Nova versão v${latestVersion} disponível no GitHub.`
          });
        }

        emit({
          status: "available",
          latestVersion,
          releaseUrl,
          assetName: asset.name,
          totalBytes: asset.size || 0,
          message: `Nova versão v${latestVersion} encontrada!`
        });

        if (autoDownload && canAutoInstall) {
          return await downloadAsset(asset, latestVersion);
        }

        return { ...state };
      } catch (error) {
        return emit({
          status: "error",
          error: error.message,
          message: `Erro ao verificar atualização: ${error.message}`
        });
      } finally {
        activeCheckPromise = null;
      }
    })();

    return activeCheckPromise;
  }

  function spawnUpdaterScript({ relaunch = true } = {}) {
    if (updateApplied) return true;
    if (state.status !== "downloaded" || !state.downloadedFilePath || !existsSync(state.downloadedFilePath)) {
      return false;
    }
    if (!targetExePath) {
      return false;
    }

    mkdirSync(updatesDir, { recursive: true });

    if (platform === "win32") {
      const vbsPath = join(updatesDir, "apply-update.vbs");
      const cmdPath = join(updatesDir, "apply-update.cmd");
      const vbsContent = buildWindowsVbsScript(state.downloadedFilePath, targetExePath, relaunch);
      const cmdContent = buildWindowsUpdateScript(state.downloadedFilePath, targetExePath, relaunch);
      writeFileSync(vbsPath, vbsContent, "utf8");
      writeFileSync(cmdPath, cmdContent, "utf8");

      let child;
      try {
        child = spawnImpl("wscript.exe", ["//B", "//Nologo", vbsPath], {
          detached: true,
          stdio: "ignore",
          windowsHide: true
        });
      } catch {
        child = spawnImpl("cmd.exe", ["/d", "/s", "/c", `"${cmdPath}"`], {
          detached: true,
          stdio: "ignore",
          windowsHide: true,
          windowsVerbatimArguments: true
        });
      }
      child.unref?.();
      updateApplied = true;
      return true;
    }

    if (platform === "linux") {
      const scriptPath = join(updatesDir, "apply-update.sh");
      const scriptContent = buildLinuxUpdateScript(state.downloadedFilePath, targetExePath, relaunch);
      writeFileSync(scriptPath, scriptContent, "utf8");
      try { chmodSync(scriptPath, 0o755); } catch {}
      const child = spawnImpl("/bin/sh", [scriptPath], {
        detached: true,
        stdio: "ignore"
      });
      child.unref?.();
      updateApplied = true;
      return true;
    }

    return false;
  }

  function installUpdateNow() {
    if (state.status === "downloaded" && canAutoInstall) {
      const ok = spawnUpdaterScript({ relaunch: true });
      if (ok) {
        onQuitAndInstall();
        return { installed: true, mode: "auto" };
      }
    }

    if (state.releaseUrl) {
      onOpenExternal(state.releaseUrl);
      return { installed: false, mode: "external", url: state.releaseUrl };
    }

    return { installed: false, mode: "none" };
  }

  function applyUpdateOnQuit() {
    if (state.status === "downloaded" && canAutoInstall && !updateApplied) {
      return spawnUpdaterScript({ relaunch: false });
    }
    return false;
  }

  function startPeriodicChecks(intervalMs = 2 * 60 * 60 * 1000) {
    stopPeriodicChecks();
    periodicTimer = setInterval(() => {
      if (state.status !== "downloading" && state.status !== "downloaded") {
        checkForUpdates({ autoDownload: true }).catch(() => {});
      }
    }, intervalMs);
    periodicTimer.unref?.();
  }

  function stopPeriodicChecks() {
    if (periodicTimer) {
      clearInterval(periodicTimer);
      periodicTimer = null;
    }
  }

  function getState() {
    return { ...state };
  }

  return {
    getState,
    checkForUpdates,
    installUpdateNow,
    applyUpdateOnQuit,
    startPeriodicChecks,
    stopPeriodicChecks
  };
}
