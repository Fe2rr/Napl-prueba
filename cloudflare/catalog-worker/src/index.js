/*
 * NAPL — CATALOG CLOUDFLARE WORKER
 *
 * Serves games, ports and platforms from a dedicated D1 database
 * (completely separate from the votes/ratings Worker & DB).
 */

const CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function jsonResponse(data, status = 200, extraHeaders = {}) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            "Content-Type": "application/json; charset=utf-8",
            ...CORS_HEADERS,
            ...extraHeaders,
        },
    });
}

function mapPortRow(row) {
    return {
        portId: row.port_id || "",
        game: row.game_name || "",
        year: row.game_year || "",
        platform: row.platform || "",
        project: row.project || "",
        link: row.link || "",
        url: row.url || "",
        dataUrl: row.data_url || "",
        developer: row.developer || "",
        version: row.version || "",
        controller: row.controller_support || "",
        files: row.needs_files || "",
        works: row.works || "",
        lastUpdate: row.last_update || "",
        dateAdded: row.date_added || "",
        notes: row.notes || "",
    };
}

async function handleGetCatalog(env) {
    const [platformsResult, gamesResult, portsResult] = await Promise.all([
        env.DB.prepare(
            "SELECT name FROM platforms ORDER BY sort_order ASC, id ASC"
        ).all(),
        env.DB.prepare(
            `SELECT slug, name, year, genre, description, cover_url, launchbox_url
             FROM games
             ORDER BY name COLLATE NOCASE ASC`
        ).all(),
        env.DB.prepare(
            `SELECT p.*, g.name AS game_name, g.year AS game_year
             FROM ports p
             JOIN games g ON g.slug = p.game_slug
             ORDER BY p.sort_order ASC, p.id ASC`
        ).all(),
    ]);

    const gamesMap = new Map();

    for (const g of gamesResult.results || []) {
        gamesMap.set(g.slug, {
            slug: g.slug,
            name: g.name,
            year: g.year || "",
            genre: g.genre || "",
            description: g.description || "",
            coverUrl: g.cover_url || "",
            launchboxUrl: g.launchbox_url || "",
            platforms: [],
            ports: [],
        });
    }

    for (const p of portsResult.results || []) {
        const game = gamesMap.get(p.game_slug);
        if (!game) continue;

        if (p.platform && !game.platforms.includes(p.platform)) {
            game.platforms.push(p.platform);
        }

        game.ports.push(mapPortRow(p));
    }

    const platforms = (platformsResult.results || []).map((r) => r.name);
    const games = Array.from(gamesMap.values());

    return jsonResponse(
        {
            success: true,
            platforms,
            games,
        },
        200,
        {
            "Cache-Control": "public, max-age=120, s-maxage=300",
        }
    );
}

async function handleGetGame(slug, env) {
    const cleanSlug = decodeURIComponent(slug || "").trim().toLowerCase();
    if (!cleanSlug) {
        return jsonResponse({ success: false, error: "Missing game slug." }, 400);
    }

    const gameRow = await env.DB.prepare(
        `SELECT slug, name, year, genre, description, cover_url, launchbox_url
         FROM games WHERE slug = ?`
    )
        .bind(cleanSlug)
        .first();

    if (!gameRow) {
        return jsonResponse({ success: false, error: "Game not found." }, 404);
    }

    const portsResult = await env.DB.prepare(
        `SELECT p.*, g.name AS game_name, g.year AS game_year
         FROM ports p
         JOIN games g ON g.slug = p.game_slug
         WHERE p.game_slug = ?
         ORDER BY p.sort_order ASC, p.id ASC`
    )
        .bind(cleanSlug)
        .all();

    const platforms = [];
    const ports = [];

    for (const p of portsResult.results || []) {
        if (p.platform && !platforms.includes(p.platform)) {
            platforms.push(p.platform);
        }
        ports.push(mapPortRow(p));
    }

    return jsonResponse(
        {
            success: true,
            game: {
                slug: gameRow.slug,
                name: gameRow.name,
                year: gameRow.year || "",
                genre: gameRow.genre || "",
                description: gameRow.description || "",
                coverUrl: gameRow.cover_url || "",
                launchboxUrl: gameRow.launchbox_url || "",
                platforms,
                ports,
            },
        },
        200,
        {
            "Cache-Control": "public, max-age=120, s-maxage=300",
        }
    );
}

async function handleGetDevices(env) {
    const result = await env.DEVICES_DB.prepare(
        "SELECT id, name FROM devices ORDER BY name COLLATE NOCASE ASC"
    ).all();

    return jsonResponse(
        { success: true, devices: result.results || [] },
        200,
        { "Cache-Control": "public, max-age=3600, s-maxage=86400" }
    );
}

async function handleGetCompatibility(url, env) {
    const portIdsParam = url.searchParams.get("port_ids") || "";
    const portIds = portIdsParam
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 50);

    if (portIds.length === 0) {
        return jsonResponse({ success: true, compatibility: {} });
    }

    const placeholders = portIds.map(() => "?").join(",");
    const rows = await env.DEVICES_DB.prepare(
        `SELECT r.port_id, r.works, r.updated_at, d.id AS device_id, d.name AS device_name
         FROM compatibility_reports r
         JOIN devices d ON d.id = r.device_id
         WHERE r.port_id IN (${placeholders})
         ORDER BY r.updated_at DESC, r.id DESC`
    )
        .bind(...portIds)
        .all();

    const compatibility = {};
    for (const id of portIds) {
        compatibility[id] = { yes: 0, no: 0, reports: [] };
    }

    for (const row of rows.results || []) {
        const entry = compatibility[row.port_id];
        if (!entry) continue;
        const works = Number(row.works) === 1;
        if (works) entry.yes += 1;
        else entry.no += 1;

        if (entry.reports.length < 30) {
            entry.reports.push({
                deviceId: row.device_id,
                deviceName: row.device_name,
                works,
                updatedAt: row.updated_at,
            });
        }
    }

    return jsonResponse({ success: true, compatibility });
}

async function handlePostCompatibility(request, env) {
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") {
        return jsonResponse({ success: false, error: "Invalid JSON body." }, 400);
    }

    const portId = String(body.port_id || "").trim();
    const deviceId = String(body.device_id || "").trim();
    const token = String(body.token || "").trim();
    const works = body.works === true || body.works === 1 ? 1 : body.works === false || body.works === 0 ? 0 : null;

    if (!portId || !deviceId || !token || works === null) {
        return jsonResponse(
            { success: false, error: "port_id, device_id, token, and works (boolean) are required." },
            400
        );
    }

    // Strict validation: device_id must exist in the official devices table
    const device = await env.DEVICES_DB.prepare(
        "SELECT id, name FROM devices WHERE id = ?"
    )
        .bind(deviceId)
        .first();

    if (!device) {
        return jsonResponse(
            { success: false, error: "Invalid device_id. Please select a device from the list." },
            400
        );
    }

    // Hash token before storing
    const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(token)
    );
    const tokenHash = Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");

    await env.DEVICES_DB.prepare(
        `INSERT INTO compatibility_reports (port_id, token_hash, device_id, works, updated_at)
         VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(port_id, token_hash, device_id)
         DO UPDATE SET works = excluded.works, updated_at = CURRENT_TIMESTAMP`
    )
        .bind(portId, tokenHash, device.id, works)
        .run();

    return jsonResponse({
        success: true,
        report: {
            portId,
            deviceId: device.id,
            deviceName: device.name,
            works: works === 1,
        },
    });
}

async function handleGetPopular(url, env) {
    const period = (url.searchParams.get("period") || url.searchParams.get("popular") || "week")
        .trim()
        .toLowerCase();

    let rows;
    if (period === "alltime") {
        rows = await env.DB.prepare(
            `SELECT game_slug AS slug, COALESCE(NULLIF(game_name, ''), game_slug) AS game, visits
             FROM game_visit_totals
             WHERE visits > 0
             ORDER BY visits DESC, game_slug ASC
             LIMIT 100`
        ).all();
    } else {
        const modifier = period === "month" ? "-30 days" : "-7 days";
        rows = await env.DB.prepare(
            `SELECT game_slug AS slug,
                    COALESCE(MAX(NULLIF(game_name, '')), game_slug) AS game,
                    COUNT(*) AS visits
             FROM game_visits
             WHERE visited_at >= datetime('now', ?)
             GROUP BY game_slug
             ORDER BY visits DESC, game_slug ASC
             LIMIT 100`
        )
            .bind(modifier)
            .all();
    }

    return jsonResponse(
        {
            success: true,
            period,
            games: (rows.results || []).map((r) => ({
                game: r.game,
                slug: r.slug,
                visits: Number(r.visits) || 0,
            })),
        },
        200,
        {
            "Cache-Control": "public, max-age=30, s-maxage=60",
        }
    );
}

async function handleRecordVisit(request, url, env) {
    let rawGame = url.searchParams.get("game") || "";
    let rawName = url.searchParams.get("name") || "";

    if (request.method === "POST") {
        const body = await request.json().catch(() => null);
        if (body && typeof body === "object") {
            rawGame = String(body.slug || body.game || rawGame);
            rawName = String(body.name || body.game || rawName);
        }
    }

    const slug = decodeURIComponent(String(rawGame || ""))
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, "-")
        .replace(/^-+|-+$/g, "");

    if (!slug) {
        return jsonResponse({ success: false, error: "Missing game slug." }, 400);
    }

    const gameName = String(rawName || slug).trim().slice(0, 180);

    await env.DB.batch([
        env.DB.prepare(
            `INSERT INTO game_visits (game_slug, game_name, visited_at)
             VALUES (?, ?, CURRENT_TIMESTAMP)`
        ).bind(slug, gameName),
        env.DB.prepare(
            `INSERT INTO game_visit_totals (game_slug, game_name, visits, updated_at)
             VALUES (?, ?, 1, CURRENT_TIMESTAMP)
             ON CONFLICT(game_slug) DO UPDATE SET
               visits = game_visit_totals.visits + 1,
               game_name = COALESCE(NULLIF(excluded.game_name, ''), game_visit_totals.game_name),
               updated_at = CURRENT_TIMESTAMP`
        ).bind(slug, gameName),
    ]);

    return jsonResponse({ success: true, slug });
}

async function handleReportLink(request, env) {
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") {
        return jsonResponse({ success: false, error: "Invalid JSON body." }, 400);
    }

    const portId = String(body.port_id || "").trim();
    const token = String(body.token || "").trim();
    const reason = String(body.reason || "").trim().slice(0, 120);
    const reportUrl = String(body.url || "").trim().slice(0, 500);

    if (!portId || !token || !reason) {
        return jsonResponse(
            { success: false, error: "port_id, token, and reason are required." },
            400
        );
    }

    const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(token)
    );
    const tokenHash = Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");

    await env.DB.prepare(
        `INSERT INTO link_reports (port_id, token_hash, reason, url, updated_at)
         VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(port_id, token_hash)
         DO UPDATE SET reason = excluded.reason, url = excluded.url, updated_at = CURRENT_TIMESTAMP`
    )
        .bind(portId, tokenHash, reason, reportUrl)
        .run();

    if (env.DISCORD_WEBHOOK_URL) {
        const payload = {
            embeds: [
                {
                    title: "NAPL — Broken Link Report",
                    color: 15158332,
                    fields: [
                        { name: "Port ID", value: portId, inline: true },
                        { name: "Reason", value: reason, inline: true },
                        { name: "URL", value: reportUrl || "N/A", inline: false },
                    ],
                    timestamp: new Date().toISOString(),
                },
            ],
        };

        fetch(env.DISCORD_WEBHOOK_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        }).catch((err) => console.error("Discord webhook error:", err));
    }

    return jsonResponse({ success: true, portId, reason });
}

async function handleHealth(env) {
    const [catalogCounts, deviceCounts] = await Promise.all([
        env.DB.prepare(
            "SELECT (SELECT COUNT(*) FROM games) AS games, (SELECT COUNT(*) FROM ports) AS ports, (SELECT COUNT(*) FROM developers) AS developers, (SELECT COUNT(*) FROM categories) AS categories"
        ).first(),
        env.DEVICES_DB.prepare(
            "SELECT (SELECT COUNT(*) FROM devices) AS devices, (SELECT COUNT(*) FROM compatibility_reports) AS compatibility_reports"
        ).first(),
    ]);

    return jsonResponse({
        success: true,
        status: "ok",
        counts: {
            ...(catalogCounts || { games: 0, ports: 0, developers: 0, categories: 0 }),
            ...(deviceCounts || { devices: 0, compatibility_reports: 0 }),
        },
    });
}


// -----------------------------------------------------------------------------
// Protected one-time migration from the published Google Sheets CSV.
// Configure IMPORT_SECRET as a Worker secret before using POST /admin/import-sheet.
// -----------------------------------------------------------------------------

const SHEET_CSV_URL = "https://docs.google.com/spreadsheets/d/1CO7dH7mbj9sl67g4e94wczHESp0NAsOa7_chKKii9OA/export?format=csv";

function importNormalizeHeader(value) {
    return String(value || "").replace(/^\uFEFF/, "").trim().toUpperCase()
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}
function importNormalizeText(value) {
    return String(value || "").trim().toLowerCase()
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}
function importSlug(value) {
    return importNormalizeText(value).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
function importParseCSV(csv) {
    const rows = [];
    let row = [], field = "", quoted = false;
    for (let i = 0; i < csv.length; i++) {
        const ch = csv[i];
        if (ch === '"') {
            if (quoted && csv[i + 1] === '"') { field += '"'; i++; }
            else quoted = !quoted;
        } else if (ch === "," && !quoted) {
            row.push(field); field = "";
        } else if ((ch === "\n" || ch === "\r") && !quoted) {
            if (ch === "\r" && csv[i + 1] === "\n") i++;
            row.push(field); field = "";
            if (row.some((v) => v.trim() !== "")) rows.push(row);
            row = [];
        } else field += ch;
    }
    if (field.length || row.length) {
        row.push(field);
        if (row.some((v) => v.trim() !== "")) rows.push(row);
    }
    if (!rows.length) return [];
    const headers = rows.shift().map(importNormalizeHeader);
    return rows.map((values) => {
        const obj = {};
        headers.forEach((header, index) => { if (header) obj[header] = String(values[index] || "").trim(); });
        return obj;
    });
}
function importColumn(row, aliases) {
    for (const alias of aliases) {
        const key = importNormalizeHeader(alias);
        if (Object.prototype.hasOwnProperty.call(row, key)) return String(row[key] || "").trim();
    }
    return "";
}
async function importBatch(db, statements) {
    for (let i = 0; i < statements.length; i += 50) {
        await db.batch(statements.slice(i, i + 50));
    }
}
async function handleImportSheet(request, env) {
    if (!env.IMPORT_SECRET) return jsonResponse({ success: false, error: "Import secret is not configured." }, 503);
    const authorization = request.headers.get("Authorization") || "";
    const supplied = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
    if (!supplied || supplied !== env.IMPORT_SECRET) {
        return jsonResponse({ success: false, error: "Unauthorized." }, 401);
    }

    const response = await fetch(SHEET_CSV_URL, {
        headers: { "Accept": "text/csv,text/plain;q=0.9,*/*;q=0.8" },
        cf: { cacheTtl: 0, cacheEverything: false }
    });
    if (!response.ok) {
        return jsonResponse({ success: false, error: "Could not download the published Google Sheets CSV.", upstreamStatus: response.status }, 502);
    }
    const csv = await response.text();
    if (!csv || csv.length < 20) return jsonResponse({ success: false, error: "The published CSV is empty or invalid." }, 502);

    const rows = importParseCSV(csv);
    if (!rows.length || !Object.prototype.hasOwnProperty.call(rows[0], "GAME")) {
        return jsonResponse({ success: false, error: "CSV headers could not be recognized." }, 422);
    }

    const platforms = new Map(), games = new Map(), developers = new Map(), categories = new Map();
    const ports = [], portDeveloperKeys = new Set(), gameCategoryKeys = new Set();
    let currentGame = "", currentYear = "";

    for (const row of rows) {
        const gameValue = importColumn(row, ["GAME", "GAME NAME", "NAME", "JUEGO"]);
        const yearValue = importColumn(row, ["YEAR", "ANO", "AÑO"]);
        if (gameValue) currentGame = gameValue;
        if (yearValue) currentYear = yearValue;
        if (!currentGame) continue;

        const gameSlug = importSlug(currentGame);
        if (!gameSlug) continue;
        const platform = importColumn(row, ["PLATFORM", "PLATAFORM", "PLATAFORMA"]);
        const platformKey = importNormalizeText(platform);
        if (platform && platformKey !== "multi-game apps" && platformKey !== "multi game apps" && !platforms.has(platformKey)) {
            platforms.set(platformKey, platform);
        }

        const rawPortId = importColumn(row, ["PORTS_ID", "PORT ID", "PORT_ID"]);
        const portId = /^unofficial-port(?:-\d+)?$/i.test(rawPortId)
            ? gameSlug + "-" + rawPortId.toLowerCase()
            : (rawPortId || gameSlug + "-port-" + (ports.length + 1));

        const port = {
            portId, gameSlug, platform,
            project: importColumn(row, ["PROJECT", "PROYECTO"]),
            link: importColumn(row, ["LINK", "PROJECT LINK", "ENLACE"]),
            url: importColumn(row, ["URL", "PORT URL", "PORT LINK"]),
            developer: importColumn(row, ["DEVELOPER", "DEVELOPER/PUBLISHER", "DESARROLLADOR"]),
            version: importColumn(row, ["VERSION", "VERSIÓN"]),
            lastUpdate: importColumn(row, ["LAST UPDATE", "LAST UPDATED", "ÚLTIMA ACTUALIZACIÓN"]),
            dateAdded: importColumn(row, ["DATE ADDED"]),
            needsFiles: importColumn(row, ["NEEDS GAME FILES?", "NEEDS GAME FILES", "GAME FILES", "NECESITA ARCHIVOS"]),
            dataUrl: importColumn(row, ["DATA URL", "DATA LINK", "GAME FILES URL"]),
            notes: importColumn(row, ["NOTES", "NOTE", "NOTAS"]),
            works: importColumn(row, ["WORKS?", "WORKS", "FUNCIONA"]),
            controllerSupport: importColumn(row, ["CONTROLLER SUPPORT", "CONTROLLER", "GAMEPAD", "MANDO"]),
            sortOrder: ports.length
        };

        const genre = importColumn(row, ["GENRE", "GÉNERO", "GENERO"]);
        const description = importColumn(row, ["DESCRIPTION", "DESCRIPCIÓN", "DESCRIPCION"]);
        const coverUrl = importColumn(row, ["COVER_URL", "COVER URL", "COVER", "COVER IMAGE", "IMAGE URL", "PORTADA"]);
        const launchboxUrl = importColumn(row, ["LAUNCHBOX_URL", "LAUNCHBOX URL"]);
        const hasPortData = [
            platform, port.project, port.link, port.url, port.dataUrl, port.developer,
            port.version, port.controllerSupport, port.needsFiles, port.works,
            port.lastUpdate, port.dateAdded, port.notes
        ].some((v) => String(v || "").trim() !== "");
        if (!hasPortData) continue;

        if (!games.has(gameSlug)) {
            games.set(gameSlug, { slug: gameSlug, name: currentGame, year: currentYear, genre, description, coverUrl, launchboxUrl });
        } else {
            const g = games.get(gameSlug);
            if (!g.year && currentYear) g.year = currentYear;
            if (!g.genre && genre) g.genre = genre;
            if (!g.description && description) g.description = description;
            if (!g.coverUrl && coverUrl) g.coverUrl = coverUrl;
            if (!g.launchboxUrl && launchboxUrl) g.launchboxUrl = launchboxUrl;
        }

        if (genre) {
            const slug = importSlug(genre);
            if (slug) { categories.set(slug, genre); gameCategoryKeys.add(gameSlug + "|" + slug); }
        }
        if (port.developer) {
            const slug = importSlug(port.developer);
            if (slug) { developers.set(slug, port.developer); portDeveloperKeys.add(gameSlug + "|" + portId + "|" + slug); }
        }
        ports.push(port);
    }

    if (!games.size || !ports.length) {
        return jsonResponse({ success: false, error: "No game or port records were found in the CSV." }, 422);
    }

    const platformSql = Array.from(platforms.values()).map((name, i) =>
        env.DB.prepare("INSERT INTO platforms (name, sort_order) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET sort_order = excluded.sort_order").bind(name, i)
    );
    const gameSql = Array.from(games.values()).map((g) =>
        env.DB.prepare("INSERT INTO games (slug, name, year, genre, description, cover_url, launchbox_url) VALUES (?, ?, ?, ?, ?, ?, ?) " +
            "ON CONFLICT(slug) DO UPDATE SET name = excluded.name, " +
            "year = CASE WHEN excluded.year <> '' THEN excluded.year ELSE games.year END, " +
            "genre = CASE WHEN excluded.genre <> '' THEN excluded.genre ELSE games.genre END, " +
            "description = CASE WHEN excluded.description <> '' THEN excluded.description ELSE games.description END, " +
            "cover_url = CASE WHEN excluded.cover_url <> '' THEN excluded.cover_url ELSE games.cover_url END, " +
            "launchbox_url = CASE WHEN excluded.launchbox_url <> '' THEN excluded.launchbox_url ELSE games.launchbox_url END, updated_at = CURRENT_TIMESTAMP"
        ).bind(g.slug, g.name, g.year, g.genre, g.description, g.coverUrl, g.launchboxUrl)
    );
    const developerSql = Array.from(developers.entries()).map(([slug, name]) =>
        env.DB.prepare("INSERT INTO developers (name, slug) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET slug = excluded.slug").bind(name, slug)
    );
    const categorySql = Array.from(categories.entries()).map(([slug, name]) =>
        env.DB.prepare("INSERT INTO categories (name, slug) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET slug = excluded.slug").bind(name, slug)
    );
    const portSql = ports.map((p) =>
        env.DB.prepare("INSERT INTO ports (port_id, game_slug, platform, project, link, url, developer, version, last_update, date_added, needs_files, data_url, notes, works, controller_support, sort_order) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
            "ON CONFLICT(game_slug, port_id) DO UPDATE SET platform = excluded.platform, project = excluded.project, link = excluded.link, url = excluded.url, developer = excluded.developer, version = excluded.version, last_update = excluded.last_update, date_added = excluded.date_added, needs_files = excluded.needs_files, data_url = excluded.data_url, notes = excluded.notes, works = excluded.works, controller_support = excluded.controller_support, sort_order = excluded.sort_order"
        ).bind(p.portId, p.gameSlug, p.platform, p.project, p.link, p.url, p.developer, p.version, p.lastUpdate, p.dateAdded, p.needsFiles, p.dataUrl, p.notes, p.works, p.controllerSupport, p.sortOrder)
    );
    const portDeveloperSql = Array.from(portDeveloperKeys).map((entry) => {
        const [gameSlug, portId, devSlug] = entry.split("|");
        return env.DB.prepare("INSERT INTO port_developers (game_slug, port_id, developer_id) SELECT ?, ?, id FROM developers WHERE slug = ? ON CONFLICT(game_slug, port_id, developer_id) DO NOTHING").bind(gameSlug, portId, devSlug);
    });
    const gameCategorySql = Array.from(gameCategoryKeys).map((entry) => {
        const [gameSlug, categorySlug] = entry.split("|");
        return env.DB.prepare("INSERT INTO game_categories (game_slug, category_id) SELECT ?, id FROM categories WHERE slug = ? ON CONFLICT(game_slug, category_id) DO NOTHING").bind(gameSlug, categorySlug);
    });

    await importBatch(env.DB, platformSql);
    await importBatch(env.DB, gameSql);
    await importBatch(env.DB, developerSql);
    await importBatch(env.DB, categorySql);
    await importBatch(env.DB, portSql);
    await importBatch(env.DB, portDeveloperSql);
    await importBatch(env.DB, gameCategorySql);

    return jsonResponse({
        success: true,
        message: "Google Sheets catalog imported into D1.",
        imported: {
            csvRows: rows.length, platforms: platforms.size, games: games.size, ports: ports.length,
            developers: developers.size, categories: categories.size,
            portDeveloperRelations: portDeveloperKeys.size, gameCategoryRelations: gameCategoryKeys.size
        }
    });
}


function handleImportPage() {
    const html = `<!doctype html>
<html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>NAPL — Importar catálogo</title>
<body style="font:16px system-ui;max-width:520px;margin:40px auto;padding:0 18px;background:#101810;color:#eef5ee">
<h2>Importar catálogo NAPL</h2>
<p>Ingresá el valor de IMPORT_SECRET. Se enviará únicamente en el encabezado de autorización; no se guarda en esta página.</p>
<form id="f">
<input id="secret" type="password" autocomplete="off" required placeholder="IMPORT_SECRET" style="box-sizing:border-box;width:100%;padding:12px;margin:8px 0;background:#202d20;color:white;border:1px solid #607060;border-radius:6px">
<button style="padding:12px 18px">Ejecutar importación</button>
</form><pre id="result" style="white-space:pre-wrap;overflow-wrap:anywhere"></pre>
<script>
document.getElementById("f").addEventListener("submit", async function(e) {
 e.preventDefault();
 const secret = document.getElementById("secret").value;
 const out = document.getElementById("result");
 out.textContent = "Importando…";
 try {
  const response = await fetch("/admin/import-sheet", {method:"POST",headers:{Authorization:"Bearer " + secret}});
  const data = await response.json();
  out.textContent = JSON.stringify(data, null, 2);
 } catch (err) { out.textContent = "Error de conexión: " + err.message; }
});
</script></body></html>`;
    return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

export default {
    async fetch(request, env) {
        if (request.method === "OPTIONS") {
            return new Response(null, { status: 204, headers: CORS_HEADERS });
        }

        const url = new URL(request.url);
        const path = url.pathname.replace(/\/+$/, "") || "/";

        try {
            if (request.method === "GET" && path === "/admin/import") {
                return handleImportPage();
            }

            if (request.method === "POST" && path === "/admin/import-sheet") {
                return await handleImportSheet(request, env);
            }

            if (request.method === "GET" && path === "/health") {
                return await handleHealth(env);
            }

            if (request.method === "GET" && path === "/catalog") {
                return await handleGetCatalog(env);
            }

            if (request.method === "GET" && path.startsWith("/games/")) {
                const slug = path.slice("/games/".length);
                return await handleGetGame(slug, env);
            }

            if (request.method === "GET" && path === "/devices") {
                return await handleGetDevices(env);
            }

            if (request.method === "GET" && path === "/popular") {
                return await handleGetPopular(url, env);
            }

            if ((request.method === "POST" || request.method === "GET") && path === "/visit") {
                return await handleRecordVisit(request, url, env);
            }

            if (request.method === "GET" && path === "/compatibility") {
                return await handleGetCompatibility(url, env);
            }

            if (request.method === "POST" && path === "/compatibility") {
                return await handlePostCompatibility(request, env);
            }

            if (request.method === "POST" && path === "/report-link") {
                return await handleReportLink(request, env);
            }

            return jsonResponse({ success: false, error: "Not found." }, 404);
        } catch (error) {
            console.error("Catalog Worker error:", error);
            return jsonResponse(
                { success: false, error: "Internal server error." },
                500
            );
        }
    },
};
