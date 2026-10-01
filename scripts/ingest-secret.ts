// Prints the per-tenant secret used to sign webhook reports from HR and learning systems.
//   KONTROL_INGEST_SECRET=... npm run ingest:secret -- tenant_acme
import { createHmac } from "node:crypto";

const master = process.env.KONTROL_INGEST_SECRET;
const tenant = process.argv[2];
if (!master || master.length < 32) { console.error("Set KONTROL_INGEST_SECRET to at least 32 characters."); process.exit(1); }
if (!tenant) { console.error("Usage: npm run ingest:secret -- <tenant id>"); process.exit(1); }
console.log(createHmac("sha256", master).update(`ingest:${tenant}`).digest("hex"));
