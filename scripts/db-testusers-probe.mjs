// Temp DB-state probe: counts known placeholder test accounts vs real users.
// Usage: node scripts/db-testusers-probe.mjs   (reads DATABASE_URL from .env.local)
import { Pool } from "pg";
import { config } from "dotenv";

config({ path: ".env.local", override: true });

const PLACEHOLDER_IDS = [
    "11111111-1111-1111-1111-111111111111",
    "12121212-1212-1212-1212-121212121212",
    "22222222-2222-2222-2222-222222222222",
    "33333333-3333-3333-3333-333333333333",
    "44444444-4444-4444-4444-444444444444",
    "55555555-5555-5555-5555-555555555555",
    "66666666-6666-6666-6666-666666666666",
    "77777777-7777-7777-7777-777777777777",
    "88888888-8888-8888-8888-888888888888",
    "99999999-9999-9999-9999-999999999999",
];

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
});

const ids = await pool.query(
    `SELECT count(*)::int AS n FROM users WHERE id = ANY($1)`,
    [PLACEHOLDER_IDS]
);
const emails = await pool.query(
    `SELECT count(*)::int AS n FROM users WHERE email LIKE '%.test'`
);
const total = await pool.query(`SELECT count(*)::int AS n FROM users`);

console.log("PLACEHOLDER_IDS:", ids.rows[0].n);
console.log("DOT_TEST_EMAILS:", emails.rows[0].n);
console.log("TOTAL_USERS:", total.rows[0].n);

if (ids.rows[0].n > 0 || emails.rows[0].n > 0) {
    const detail = await pool.query(
        `SELECT id, email FROM users
         WHERE id = ANY($1) OR email LIKE '%.test'
         ORDER BY id`,
        [PLACEHOLDER_IDS]
    );
    console.log("REMAINING TEST ACCOUNTS:");
    for (const row of detail.rows) console.log(` - ${row.id}  ${row.email}`);
}

await pool.end();