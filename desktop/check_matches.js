import dotenv from "dotenv";
import { openDatabase, matches } from "./database.js";

dotenv.config();

async function main() {
  const db = openDatabase("force_supabase");
  if (db.type === "supabase") {
    // Let's set db.userEmail to null first to see all matches in the database
    db.userEmail = null;
    const allMatches = await matches(db, 20);
    console.log(`Total matches retrieved: ${allMatches.length}`);
    allMatches.forEach((m, idx) => {
      console.log(`Match #${idx}: ID=${m.id}, played_at=${m.played_at}, user_email=${m.user_email}`);
    });
  } else {
    console.log("Not configured for Supabase");
  }
}

main().catch(console.error);
