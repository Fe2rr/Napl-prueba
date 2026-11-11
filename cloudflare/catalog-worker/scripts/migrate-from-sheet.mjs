/*
 * NAPL — GOOGLE SHEETS CSV -> D1 SEED.SQL MIGRATION SCRIPT
 *
 * Usage:
 *   node scripts/migrate-from-sheet.mjs
 *   (or pass a local CSV path: node scripts/migrate-from-sheet.mjs ./sheet.csv)
 *
 * Outputs:
 *   ./seed.sql  (ready to execute with `wrangler d1 execute napl-catalog-db --remote --file=./seed.sql`)
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_SHEET_URL =
    "https://docs.google.com/spreadsheets/d/1CO7dH7mbj9sl67g4e94wczHESp0NAsOa7_chKKii9OA/export?format=csv";

function normalizeHeader(value) {
    return String(value || "")
        .replace(/^\uFEFF/, "")
        .trim()
        .toUpperCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "");
}

function normalizeText(value) {
    return String(value || "")
        .trim()
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "");
}

function createSlug(name) {
    return normalizeText(name)
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
}

function parseCSV(csv) {
    const rows = [];
    let row = [];
    let field = "";
    let insideQuotes = false;

    for (let i = 0; i < csv.length; i++) {
        const char = csv[i];

        if (char === '"') {
            if (insideQuotes && csv[i + 1] === '"') {
                field += '"';
                i++;
            } else {
                insideQuotes = !insideQuotes;
            }
            continue;
        }

        if (char === "," && !insideQuotes) {
            row.push(field);
            field = "";
            continue;
        }

        if ((char === "\n" || char === "\r") && !insideQuotes) {
            if (char === "\r" && csv[i + 1] === "\n") {
                i++;
            }
            row.push(field);
            field = "";
            if (row.some((v) => v.trim() !== "")) {
                rows.push(row);
            }
            row = [];
            continue;
        }

        field += char;
    }

    if (field.length > 0 || row.length > 0) {
        row.push(field);
        if (row.some((v) => v.trim() !== "")) {
            rows.push(row);
        }
    }

    if (rows.length === 0) return [];

    const headers = rows.shift().map(normalizeHeader);

    return rows.map((values) => {
        const obj = {};
        headers.forEach((header, idx) => {
            if (header) {
                obj[header] = String(values[idx] || "").trim();
            }
        });
        return obj;
    });
}

function getColumn(row, aliases) {
    for (const alias of aliases) {
        const key = normalizeHeader(alias);
        if (Object.prototype.hasOwnProperty.call(row, key)) {
            return String(row[key] || "").trim();
        }
    }
    return "";
}

function sqlString(value) {
    return `'${String(value ?? "").replace(/'/g, "''")}'`;
}

async function loadCsvText(localFilePath) {
    if (localFilePath) {
        return await fs.readFile(path.resolve(localFilePath), "utf-8");
    }

    const res = await fetch(DEFAULT_SHEET_URL);
    if (!res.ok) {
        throw new Error(`Failed to fetch Google Sheet CSV: HTTP ${res.status}`);
    }
    return await res.text();
}

async function main() {
    const localCsvArg = process.argv[2];
    console.log(
        localCsvArg
            ? `Reading CSV from ${localCsvArg}...`
            : "Downloading Google Sheet CSV..."
    );

    const csv = await loadCsvText(localCsvArg);
    const rows = parseCSV(csv);

    if (!rows.length) {
        throw new Error("No rows found in CSV.");
    }

    // 1. Capture platform order of first appearance
    const platformsMap = new Map();
    for (const row of rows) {
        const platform = getColumn(row, [
            "PLATFORM",
            "PLATAFORM",
            "PLATAFORMA",
        ]);
        if (!platform) continue;
        const key = normalizeText(platform);
        if (key === "multi-game apps" || key === "multi game apps") continue;
        if (!platformsMap.has(key)) {
            platformsMap.set(key, platform);
        }
    }

    // 2. Group games and ports with carry-forward for GAME & YEAR
    const gamesMap = new Map();
    const portsList = [];
    const developersMap = new Map();
    const categoriesMap = new Map();
    const gameCategoryEntries = new Set();
    const portDeveloperEntries = new Set();

    let currentGame = "";
    let currentYear = "";

    for (const row of rows) {
        const gameValue = getColumn(row, [
            "GAME",
            "GAME NAME",
            "NAME",
            "JUEGO",
        ]);
        const yearValue = getColumn(row, ["YEAR", "ANO", "AÑO"]);

        if (gameValue) currentGame = gameValue;
        if (yearValue) currentYear = yearValue;

        if (!currentGame) continue;
        const slug = createSlug(currentGame);
        if (!slug) continue;

        const platform = getColumn(row, [
            "PLATFORM",
            "PLATAFORM",
            "PLATAFORMA",
        ]);
        const project = getColumn(row, ["PROJECT", "PROYECTO"]);
        const rawPortId = getColumn(row, ["PORTS_ID", "PORT ID", "PORT_ID"]);
        const normalizedPortId = /^unofficial-port(?:-\d+)?$/i.test(rawPortId)
            ? `${slug}-${rawPortId.toLowerCase()}`
            : rawPortId;
        const portId = normalizedPortId || `${slug}-port-${portsList.length + 1}`;
        const link = getColumn(row, ["LINK", "PROJECT LINK", "ENLACE"]);
        const url = getColumn(row, ["URL", "PORT URL", "PORT LINK"]);
        const dataUrl = getColumn(row, [
            "DATA URL",
            "DATA LINK",
            "GAME FILES URL",
        ]);
        const developer = getColumn(row, [
            "DEVELOPER",
            "DEVELOPER/PUBLISHER",
            "DESARROLLADOR",
        ]);
        const version = getColumn(row, ["VERSION", "VERSIÓN"]);
        const controller = getColumn(row, [
            "CONTROLLER SUPPORT",
            "CONTROLLER",
            "GAMEPAD",
            "MANDO",
        ]);
        const files = getColumn(row, [
            "NEEDS GAME FILES?",
            "NEEDS GAME FILES",
            "GAME FILES",
            "NECESITA ARCHIVOS",
        ]);
        const works = getColumn(row, ["WORKS?", "WORKS", "FUNCIONA"]);
        const lastUpdate = getColumn(row, [
            "LAST UPDATE",
            "LAST UPDATED",
            "ÚLTIMA ACTUALIZACIÓN",
        ]);
        const dateAdded = getColumn(row, ["DATE ADDED"]);
        const notes = getColumn(row, ["NOTES", "NOTE", "NOTAS"]);
        const coverUrl = getColumn(row, [
            "COVER_URL",
            "COVER URL",
            "COVER",
            "COVER IMAGE",
            "IMAGE URL",
            "PORTADA",
        ]);
        const genre = getColumn(row, ["GENRE", "GÉNERO", "GENERO"]);
        const description = getColumn(row, [
            "DESCRIPTION",
            "DESCRIPCIÓN",
            "DESCRIPCION",
        ]);
        const launchboxUrl = getColumn(row, ["LAUNCHBOX_URL", "LAUNCHBOX URL"]);

        const hasPortData = [
            project,
            link,
            url,
            dataUrl,
            developer,
            version,
            controller,
            files,
            works,
            lastUpdate,
            dateAdded,
            notes,
        ].some((v) => String(v || "").trim() !== "");

        if (!hasPortData) continue;

        if (!gamesMap.has(slug)) {
            gamesMap.set(slug, {
                slug,
                name: currentGame,
                year: currentYear,
                genre,
                description,
                coverUrl,
                launchboxUrl,
            });
        } else {
            const existing = gamesMap.get(slug);
            if (!existing.year && currentYear) existing.year = currentYear;
            if (!existing.genre && genre) existing.genre = genre;
            if (!existing.description && description)
                existing.description = description;
            if (!existing.coverUrl && coverUrl) existing.coverUrl = coverUrl;
            if (!existing.launchboxUrl && launchboxUrl)
                existing.launchboxUrl = launchboxUrl;
        }

        if (genre) {
            const categorySlug = createSlug(genre);
            if (categorySlug) {
                categoriesMap.set(categorySlug, genre);
                gameCategoryEntries.add(`${slug}| ${categorySlug}`.replace("| ", "|"));
            }
        }

        if (developer) {
            const developerSlug = createSlug(developer);
            if (developerSlug) {
                developersMap.set(developerSlug, developer);
                portDeveloperEntries.add(`${slug}|${portId}|${developerSlug}`);
            }
        }

        portsList.push({
            portId,
            gameSlug: slug,
            platform,
            project,
            link,
            url,
            developer,
            version,
            lastUpdate,
            dateAdded,
            needsFiles: files,
            dataUrl,
            notes,
            works,
            controllerSupport: controller,
            sortOrder: portsList.length,
        });
    }

    // 3. Build seed.sql
    const lines = [
        "-- Generated by migrate-from-sheet.mjs",
        "-- Idempotent upserts: existing catalog rows are updated, never wholesale deleted.",
        "PRAGMA foreign_keys = ON;",
        "BEGIN TRANSACTION;",
        "",
    ];

    let platformOrder = 0;
    for (const platform of platformsMap.values()) {
        lines.push(
            `INSERT INTO platforms (name, sort_order) VALUES (${sqlString(
                platform
            )}, ${platformOrder++}) ON CONFLICT(name) DO UPDATE SET sort_order = excluded.sort_order;`
        );
    }
    lines.push("");

    for (const game of gamesMap.values()) {
        lines.push(
            `INSERT INTO games (slug, name, year, genre, description, cover_url, launchbox_url) VALUES (${sqlString(
                game.slug
            )}, ${sqlString(game.name)}, ${sqlString(game.year)}, ${sqlString(
                game.genre
            )}, ${sqlString(game.description)}, ${sqlString(
                game.coverUrl
            )}, ${sqlString(game.launchboxUrl)}) ON CONFLICT(slug) DO UPDATE SET
                name = excluded.name, year = excluded.year, genre = excluded.genre,
                description = excluded.description, cover_url = excluded.cover_url,
                launchbox_url = excluded.launchbox_url, updated_at = CURRENT_TIMESTAMP;`
        );
    }
    lines.push("");

    for (const [slug, name] of developersMap) {
        lines.push(
            `INSERT INTO developers (name, slug) VALUES (${sqlString(name)}, ${sqlString(slug)})
             ON CONFLICT(name) DO UPDATE SET slug = excluded.slug;`
        );
    }
    lines.push("");

    for (const [slug, name] of categoriesMap) {
        lines.push(
            `INSERT INTO categories (name, slug) VALUES (${sqlString(name)}, ${sqlString(slug)})
             ON CONFLICT(name) DO UPDATE SET slug = excluded.slug;`
        );
    }
    lines.push("");

    for (const port of portsList) {
        lines.push(
            `INSERT INTO ports (port_id, game_slug, platform, project, link, url, developer, version, last_update, date_added, needs_files, data_url, notes, works, controller_support, sort_order) VALUES (${sqlString(
                port.portId
            )}, ${sqlString(port.gameSlug)}, ${sqlString(
                port.platform
            )}, ${sqlString(port.project)}, ${sqlString(
                port.link
            )}, ${sqlString(port.url)}, ${sqlString(
                port.developer
            )}, ${sqlString(port.version)}, ${sqlString(
                port.lastUpdate
            )}, ${sqlString(port.dateAdded)}, ${sqlString(
                port.needsFiles
            )}, ${sqlString(port.dataUrl)}, ${sqlString(
                port.notes
            )}, ${sqlString(port.works)}, ${sqlString(
                port.controllerSupport
            )}, ${port.sortOrder})
             ON CONFLICT(game_slug, port_id) DO UPDATE SET
                platform = excluded.platform, project = excluded.project,
                link = excluded.link, url = excluded.url, developer = excluded.developer,
                version = excluded.version, last_update = excluded.last_update,
                date_added = excluded.date_added, needs_files = excluded.needs_files,
                data_url = excluded.data_url, notes = excluded.notes, works = excluded.works,
                controller_support = excluded.controller_support, sort_order = excluded.sort_order;`
        );
    }
    lines.push("");

    for (const entry of portDeveloperEntries) {
        const [gameSlug, portId, developerSlug] = entry.split("|");
        lines.push(
            `INSERT INTO port_developers (game_slug, port_id, developer_id)
             SELECT ${sqlString(gameSlug)}, ${sqlString(portId)}, id
             FROM developers WHERE slug = ${sqlString(developerSlug)}
             ON CONFLICT(game_slug, port_id, developer_id) DO NOTHING;`
        );
    }

    for (const entry of gameCategoryEntries) {
        const [gameSlug, categorySlug] = entry.split("|");
        lines.push(
            `INSERT INTO game_categories (game_slug, category_id)
             SELECT ${sqlString(gameSlug)}, id
             FROM categories WHERE slug = ${sqlString(categorySlug)}
             ON CONFLICT(game_slug, category_id) DO NOTHING;`
        );
    }

    lines.push("COMMIT;");

    const outPath = path.join(__dirname, "..", "seed.sql");
    await fs.writeFile(outPath, lines.join("\n"), "utf-8");

    console.log(
        `Done! Generated ${outPath} with ${platformsMap.size} platforms, ${gamesMap.size} games, and ${portsList.length} ports.`
    );
}

main().catch((err) => {
    console.error("Migration failed:", err);
    process.exit(1);
});
