// One-off migration script: adds "title" column to Ticket table
// Run with: node scripts/apply-title-migration.js
require("dotenv").config();
const { Client } = require("pg");

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  console.log("Connected to database.");

  const result = await client.query(
    `ALTER TABLE "Ticket" ADD COLUMN IF NOT EXISTS "title" TEXT;`
  );
  console.log("Migration applied:", result.command);

  await client.end();
}

main().catch((err) => {
  console.error("Migration failed:", err.message);
  process.exit(1);
});
