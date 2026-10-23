import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compareVersions,
   selectReleaseAsset,
  buildWindowsUpdateScript,
  resolveTargetExecutablePath,
  createAutoUpdater
} from "./updater.js";

test("compareVersions compara versões semver corretamente", () => {
  assert.equal(compareVersions("1.2.3", "1.2.2"), 1);
  assert.equal(compareVersions("v1.10.0", "v1.2.9"), 1);
  assert.equal(compareVersions("1.2.2", "v1.2.2"), 0);
  assert.equal(compareVersions("1.2.1", "1.2.2"), -1);
});

test("selectReleaseAsset escolhe o .exe no Windows e .AppImage no Linux", () => {
  const assets = [
    { name: "DBD-Tracker-Overlay-1.2.3.AppImage", browser_download_url: "https://example.com/app.AppImage", size: 100 },
    { name: "DBD-Tracker-Overlay-1.2.3.exe.blockmap", browser_download_url: "https://example.com/app.blockmap", size: 10 },
    { name: "DBD-Tracker-Overlay-1.2.3.exe", browser_download_url: "https://example.com/app.exe", size: 200 }
  ];

  const winAsset = selectReleaseAsset(assets, "win32");
  assert.equal(winAsset?.name, "DBD-Tracker-Overlay-1.2.3.exe");

  const linuxAsset = selectReleaseAsset(assets, "linux");
  assert.equal(linuxAsset?.name, "DBD-Tracker-Overlay-1.2.3.AppImage");
});

test("resolveTargetExecutablePath detecta PORTABLE_EXECUTABLE_FILE no Windows", () => {
  const target = resolveTargetExecutablePath({
    platform: "win32",
    env: { PORTABLE_EXECUTABLE_FILE: "C:\\Games\\DBD-Tracker-Overlay-1.2.2.exe" },
    execPath: "C:\\Temp\\app\\DBD Tracker Overlay.exe",
    isPackaged: true
  });
  assert.equal(target, "C:\\Games\\DBD-Tracker-Overlay-1.2.2.exe");
});

test("createAutoUpdater baixa nova versão do GitHub Releases e gera script de substituição no Windows", async () => {
  const tempUserData = mkdtempSync(join(tmpdir(), "dbd-updater-test-"));
  const binaryPayload = Buffer.from("MZ-fake-windows-portable-binary-content");
  const states = [];
  const spawned = [];
  let quitCalled = false;

  const mockFetch = async url => {
    if (String(url).includes("/releases/latest")) {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            tag_name: "v1.3.0",
            html_url: "https://github.com/Adrian-ESoftware/DBDTracker/releases/tag/v1.3.0",
            assets: [
              {
                name: "DBD-Tracker-Overlay-1.3.0.exe",
                browser_download_url: "https://github.com/Adrian-ESoftware/DBDTracker/releases/download/v1.3.0/DBD-Tracker-Overlay-1.3.0.exe",
                size: binaryPayload.length
              }
            ]
          };
        }
      };
    }

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(binaryPayload);
        controller.close();
      }
    });

    return {
      ok: true,
      status: 200,
      headers: new Map([["content-length", String(binaryPayload.length)]]),
      body: stream
    };
  };

  const mockSpawn = (cmd, args, opts) => {
    spawned.push({ cmd, args, opts });
    return { unref() {} };
  };

  const updater = createAutoUpdater({
    currentVersion: "1.2.2",
    userDataPath: tempUserData,
    platform: "win32",
    env: { PORTABLE_EXECUTABLE_FILE: "C:\\Users\\Player\\Desktop\\DBD-Tracker-Overlay.exe" },
    isPackaged: true,
    fetchImpl: mockFetch,
    spawnImpl: mockSpawn,
    onStatusChange: s => states.push(s.status),
    onQuitAndInstall: () => { quitCalled = true; }
  });

  const finalState = await updater.checkForUpdates({ autoDownload: true });
  assert.equal(finalState.status, "downloaded");
  assert.equal(finalState.latestVersion, "1.3.0");
  assert.equal(finalState.progress, 100);
  assert.ok(existsSync(finalState.downloadedFilePath));
  assert.ok(states.includes("checking"));
  assert.ok(states.includes("downloading"));
  assert.ok(states.includes("downloaded"));

  const installResult = updater.installUpdateNow();
  assert.equal(installResult.installed, true);
  assert.equal(quitCalled, true);
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].cmd, "cmd.exe");

  const scriptPath = join(tempUserData, "updates", "apply-update.cmd");
  assert.ok(existsSync(scriptPath));
  const scriptContent = readFileSync(scriptPath, "utf8");
  assert.ok(scriptContent.includes("C:\\Users\\Player\\Desktop\\DBD-Tracker-Overlay.exe"));
  assert.ok(scriptContent.includes("copy /B /Y"));
});
