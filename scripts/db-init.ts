// Applies db/schema.sql to DATABASE_URL (idempotent). Waits for the container to accept connections.
// Run: npm run db:up && npm run db:init

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../backend/config.ts";
import { createPool } from "../backend/postgis.ts";

const cfg = loadConfig();
if (!cfg.databaseUrl) {
  console.error("DATABASE_URL is not set (see .env.example).");
  process.exit(1);
}
const pool = createPool(cfg.databaseUrl);
for (let i = 1; ; i++) {
  try {
    await pool.query("SELECT 1");
    break;
  } catch (e) {
    if (i >= 30) throw e;
    await new Promise((r) => setTimeout(r, 2000));
  }
}
await pool.query(readFileSync(join(cfg.root, "db", "schema.sql"), "utf8"));
const v = await pool.query("SELECT postgis_full_version() AS v");
console.log(`schema applied. ${String(v.rows[0].v).split(" ").slice(0, 2).join(" ")}`);
await pool.end();
