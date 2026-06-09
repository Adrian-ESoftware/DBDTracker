import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const userDataPath = join(homedir(), "AppData", "Roaming", "dbd-tracker-overlay");
console.log("UserData path:", userDataPath);
try {
  const files = readdirSync(userDataPath);
  console.log("Files:", files);
} catch (e) {
  console.log("Error reading dir:", e.message);
}

const configPath = join(userDataPath, "config.json");
try {
  const content = readFileSync(configPath, "utf-8");
  console.log("Config content:", content);
} catch (e) {
  console.log("No config.json found or error:", e.message);
}
