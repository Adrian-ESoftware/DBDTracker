import dotenv from "dotenv";
import { openDatabase } from "./database.js";

dotenv.config();

async function main() {
  const realDb = openDatabase("force_supabase");
  if (realDb.type === "supabase") {
    const { data: snapshots } = await realDb.client
      .from("source_snapshots")
      .select("raw_json, source_url, captured_at")
      .ilike("source_url", "%/players/me%")
      .order("captured_at", { ascending: false })
      .limit(3);
    console.log("Snapshots count for /players/me:", snapshots?.length);
    snapshots?.forEach((snap, idx) => {
      console.log(`Snapshot #${idx} [${snap.captured_at}] URL: ${snap.source_url}`);
      console.log("Keys:", Object.keys(snap.raw_json || {}));
      console.log("Content:", JSON.stringify(snap.raw_json, null, 2));
    });
  }
}

main().catch(console.error);
