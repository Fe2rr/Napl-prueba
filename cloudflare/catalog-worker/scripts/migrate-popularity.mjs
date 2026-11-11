/*
 * NAPL — GOOGLE APPS SCRIPT POPULARITY -> D1 POPULARITY-SEED.SQL
 *
 * Fetches existing all-time visit counts from the legacy Apps Script
 * endpoint and generates ./popularity-seed.sql for Cloudflare D1.
 *
 * Usage:
 *   node scripts/migrate-popularity.mjs
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const POPULAR_SCRIPT_URL =
    "https://script.google.com/macros/s/AKfycbxio6DGpBJRkYdceeFVXk3gSOFcBe5KZJtHU8F2j66DDYx_G_az01p7rnsuCq0KPHY/exec";

function createSlug(name) {
    return String(name || "")
        .trim()
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
}

function sqlString(value) {
    return `'${String(value ?? "").replace(/'/g, "''")}'`;
}

async function fetchJson(url) {
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) {
        throw new Error(`HTTP ${res.status} fetching ${url}`);
    }
    return res.json();
}

async function main() {
    console.log("Fetching all-time popularity from Google Apps Script...");
    const data = await fetchJson(`${POPULAR_SCRIPT_URL}?popular=alltime`);

    if (!data?.success || !Array.isArray(data.games)) {
        throw new Error("Invalid popularity response from Apps Script.");
    }

    const lines = [
        "-- NAPL Popularity Seed (migrated from Google Apps Script)",
        "",
    ];

    let count = 0;
    for (const item of data.games) {
        const gameName = String(item.game || "").trim();
        const slug = createSlug(gameName);
        const visits = Math.max(0, Math.floor(Number(item.visits) || 0));
        if (!slug || visits <= 0) continue;

        lines.push(
            `INSERT INTO game_visit_totals (game_slug, game_name, visits, updated_at) VALUES (${sqlString(slug)}, ${sqlString(gameName)}, ${visits}, CURRENT_TIMESTAMP) ON CONFLICT(game_slug) DO UPDATE SET visits = MAX(game_visit_totals.visits, excluded.visits), game_name = excluded.game_name;`
        );
        count++;
    }

    const outPath = path.resolve(__dirname, "..", "popularity-seed.sql");
    await fs.writeFile(outPath, lines.join("\n") + "\n", "utf8");
    console.log(`Generated ${outPath} with ${count} game visit totals.`);
}

main().catch((err) => {
    console.error("Popularity migration failed:", err);
    process.exit(1);
});
