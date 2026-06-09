import { app, BrowserWindow } from "electron";
import { join } from "node:path";

// Force app name and userData to match production app so we use the same cookies
app.name = "dbd-tracker-overlay";
app.setPath("userData", "C:\\Users\\Usuario\\AppData\\Roaming\\dbd-tracker-overlay");
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    webPreferences: {
      partition: "persist:dbd-official",
      contextIsolation: true
    }
  });

  try {
    console.log("Loading stats page with production cookies...");
    await win.loadURL("https://stats.deadbydaylight.com/");
    console.log("Page loaded. Waiting 5 seconds...");
    await new Promise(resolve => setTimeout(resolve, 5000));

    const currentUrl = win.webContents.getURL();
    console.log("Current URL:", currentUrl);

    const bodyText = await win.webContents.executeJavaScript("document.body.innerText");
    console.log("Body text sample (first 1000 chars):");
    console.log(bodyText.slice(0, 1000));

    console.log("Inspecting elements containing 'Survivor' or 'Killer'...");
    const elementsInfo = await win.webContents.executeJavaScript(`(() => {
      const results = [];
      const all = document.body.getElementsByTagName("*");
      for (const el of all) {
        const text = (el.textContent || "").trim();
        if (text === "Survivor" || text === "Killer") {
          results.push({
            tagName: el.tagName,
            id: el.id,
            className: el.className,
            text: text,
            role: el.getAttribute("role"),
            type: el.getAttribute("type"),
            outerHTML: el.outerHTML.slice(0, 300)
          });
        }
      }
      return results;
    })()`);

    console.log("Found elements:");
    console.log(JSON.stringify(elementsInfo, null, 2));

  } catch (err) {
    console.error("Error:", err);
  } finally {
    win.destroy();
    app.quit();
  }
});
