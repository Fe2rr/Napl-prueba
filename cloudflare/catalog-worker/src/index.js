import { readSheetRows, updateSheetCells, buildCatalogFromSheet, sheetColumnName, writeSheetValues, deleteSheetRow } from "./sheets.js";

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
    if (env.CATALOG_KV) {
        const cached = await env.CATALOG_KV.get("catalog:v1");
        if (cached) {
            try {
                return jsonResponse(JSON.parse(cached), 200, {
                    "Cache-Control": "public, max-age=60, s-maxage=300"
                });
            } catch (error) {
                console.error("Invalid catalog cache; falling back to D1:", error);
            }
        }
    }

    // Transitional fallback until the Sheets catalog has been synchronized to KV.
    const [platformsResult, gamesResult, portsResult] = await Promise.all([
        env.DB.prepare("SELECT name FROM platforms ORDER BY sort_order ASC, id ASC").all(),
        env.DB.prepare("SELECT slug, name, year, genre, description, cover_url, launchbox_url FROM games ORDER BY name COLLATE NOCASE ASC").all(),
        env.DB.prepare("SELECT p.*, g.name AS game_name, g.year AS game_year FROM ports p JOIN games g ON g.slug = p.game_slug ORDER BY p.sort_order ASC, p.id ASC").all()
    ]);
    const gamesMap = new Map();
    for (const g of gamesResult.results || []) {
        gamesMap.set(g.slug, {
            slug: g.slug, name: g.name, year: g.year || "", genre: g.genre || "",
            description: g.description || "", coverUrl: g.cover_url || "",
            launchboxUrl: g.launchbox_url || "", platforms: [], ports: []
        });
    }
    for (const p of portsResult.results || []) {
        const game = gamesMap.get(p.game_slug);
        if (!game) continue;
        if (p.platform && !game.platforms.includes(p.platform)) game.platforms.push(p.platform);
        game.ports.push(mapPortRow(p));
    }
    return jsonResponse({
        success: true,
        platforms: (platformsResult.results || []).map((r) => r.name),
        games: Array.from(gamesMap.values())
    }, 200, { "Cache-Control": "public, max-age=60, s-maxage=300" });
}

async function handleSyncCatalogCache(request, env) {
    const denied = requireAdmin(request, env);
    if (denied) return denied;
    if (!env.CATALOG_KV) {
        return jsonResponse({ success: false, error: "CATALOG_KV is not bound. Create a KV namespace and bind it to this Worker as CATALOG_KV." }, 503);
    }
    const sheet = await readSheetRows(env);
    const catalog = buildCatalogFromSheet(sheet);
    if (!catalog.games.length) {
        return jsonResponse({ success: false, error: "The Sheet did not produce any games; the existing cache was left unchanged." }, 422);
    }
    const updatedAt = new Date().toISOString();
    await env.CATALOG_KV.put("catalog:v1", JSON.stringify({ ...catalog, updatedAt }));
    return jsonResponse({
        success: true,
        games: catalog.games.length,
        ports: catalog.games.reduce((total, game) => total + game.ports.length, 0),
        platforms: catalog.platforms.length,
        updatedAt
    }, 200, { "Cache-Control": "no-store" });
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
        "SELECT id, name, manufacturer, model, cpu FROM devices ORDER BY name COLLATE NOCASE ASC"
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
    const requestedPeriod = (url.searchParams.get("period") || url.searchParams.get("popular") || "week")
        .trim().toLowerCase();
    const period = ["week", "month", "alltime"].includes(requestedPeriod) ? requestedPeriod : "week";

    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS game_visit_settings (
        setting_key TEXT PRIMARY KEY,
        setting_value TEXT NOT NULL
    )`).run();

    // Establish one shared starting point for the new Week and Month counters.
    // This key is intentionally separate from any older reset setting.
    await env.DB.prepare(
        `INSERT OR IGNORE INTO game_visit_settings (setting_key, setting_value)
         VALUES ('periods_start_at', CURRENT_TIMESTAMP)`
    ).run();

    let rows;
    if (period === "alltime") {
        // Preserve the historical total and add every new D1 event exactly once.
        // game_visit_totals is intentionally excluded because it contains old seed values.
        rows = await env.DB.prepare(
            `SELECT slug, MAX(game) AS game, SUM(visits) AS visits
             FROM (
                 SELECT l.game_slug AS slug,
                        COALESCE(NULLIF(g.name, ''), NULLIF(l.game_name, ''), l.game_slug) AS game,
                        l.visits AS visits
                 FROM game_visit_legacy_totals l
                 LEFT JOIN games g ON g.slug = l.game_slug
                 UNION ALL
                 SELECT v.game_slug AS slug,
                        COALESCE(MAX(NULLIF(g.name, '')), MAX(NULLIF(v.game_name, '')), v.game_slug) AS game,
                        COUNT(*) AS visits
                 FROM game_visits v
                 LEFT JOIN games g ON g.slug = v.game_slug
                 GROUP BY v.game_slug
             )
             GROUP BY slug
             HAVING SUM(visits) > 0
             ORDER BY visits DESC, slug ASC
             LIMIT 100`
        ).all();
    } else {
        // Week and Month both start at the first request after this version is deployed.
        // They count only visits recorded since that shared baseline.
        const window = period === "month" ? "-30 days" : "-7 days";
        rows = await env.DB.prepare(
            `SELECT v.game_slug AS slug,
                    COALESCE(MAX(NULLIF(g.name, '')), MAX(NULLIF(v.game_name, '')), v.game_slug) AS game,
                    COUNT(*) AS visits
             FROM game_visits v
             LEFT JOIN games g ON g.slug = v.game_slug
             WHERE v.visited_at >= (
                 SELECT setting_value
                 FROM game_visit_settings
                 WHERE setting_key = 'periods_start_at'
             )
               AND v.visited_at >= datetime('now', ?)
             GROUP BY v.game_slug
             ORDER BY visits DESC, v.game_slug ASC
             LIMIT 100`
        ).bind(window).all();
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
        { "Cache-Control": "public, max-age=30, s-maxage=60" }
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
    if (!env.DISCORD_WEBHOOK_URL) {
        return jsonResponse({ success: false, error: "Discord webhook is not configured." }, 503);
    }

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") {
        return jsonResponse({ success: false, error: "Invalid JSON body." }, 400);
    }

    const portId = String(body.port_id || "").trim().slice(0, 120);
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

    let discordResponse;
    try {
        discordResponse = await fetch(env.DISCORD_WEBHOOK_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });
    } catch (error) {
        console.error("Discord webhook network error:", error);
        return jsonResponse({ success: false, error: "Could not reach Discord. Please try again." }, 502);
    }

    if (!discordResponse.ok) {
        console.error("Discord webhook returned HTTP", discordResponse.status);
        return jsonResponse({ success: false, error: "Discord rejected the report.", discordStatus: discordResponse.status }, 502);
    }

    await env.DB.prepare(
        `INSERT INTO link_reports (port_id, token_hash, reason, url, updated_at)
         VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(port_id, token_hash)
         DO UPDATE SET reason = excluded.reason, url = excluded.url, updated_at = CURRENT_TIMESTAMP`
    )
        .bind(portId, tokenHash, reason, reportUrl)
        .run();

    return jsonResponse({ success: true, portId, reason });
}

function normalizeGitHubRepo(value) {
    const match = String(value || '').trim().match(/^https?:\/\/(?:www\.)?github\.com\/([^/?#]+)\/([^/?#]+)/i);
    if (!match) return null;
    const owner = match[1];
    const repo = match[2].replace(/\.git$/i, '');
    const blockedOwners = ['settings','search','login','logout','signup','explore','marketplace','topics','orgs','users','collections','sponsors','notifications','new'];
    const blockedRepos = /^(issues|pulls|projects|actions|releases|tags|branches|wiki|tree|blob|commit|commits)$/i;
    if (!owner || !repo || blockedOwners.includes(owner.toLowerCase()) || blockedRepos.test(repo)) return null;
    return { owner, repo, key: owner.toLowerCase() + '/' + repo.toLowerCase() };
}

function githubApiUrl(info, suffix = '') {
    return 'https://api.github.com/repos/' + encodeURIComponent(info.owner) + '/' + encodeURIComponent(info.repo) + suffix;
}

function formatGitHubDate(value) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '';
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Montevideo',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hourCycle: 'h23'
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map((item) => [item.type, item.value]));
    return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}:${values.second}`;
}

async function githubRequest(url, token) {
    return fetch(url, {
        headers: {
            Authorization: 'Bearer ' + token,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'NAPL-Catalog-Worker'
        },
        cf: { cacheTtl: 0, cacheEverything: false }
    });
}

async function githubResponseDetail(response) {
    const rateRemaining = response.headers.get('x-ratelimit-remaining');
    const rateReset = response.headers.get('x-ratelimit-reset');
    const retryAfter = response.headers.get('retry-after');
    let message = '';
    try {
        const body = await response.clone().json();
        message = String(body.message || body.error || '').slice(0, 240);
    } catch (_) {}
    return [
        message,
        rateRemaining !== null ? 'rate_remaining=' + rateRemaining : '',
        rateReset ? 'rate_reset=' + rateReset : '',
        retryAfter ? 'retry_after=' + retryAfter : ''
    ].filter(Boolean).join('; ') || 'No response details';
}

async function resolveGitHubVersion(info, token) {
    let releaseResponse;
    try {
        releaseResponse = await githubRequest(githubApiUrl(info, '/releases/latest'), token);
    } catch (error) {
        return { key: info.key, error: 'release_network_error', detail: String(error?.message || error).slice(0, 240) };
    }

    if (releaseResponse.status === 200) {
        try {
            const release = await releaseResponse.json();
            const version = String(release.tag_name || release.name || '').trim();
            if (version) return { key: info.key, version, date: release.published_at || release.created_at || '', source: 'Release' };
        } catch (error) {
            return { key: info.key, error: 'invalid_release_json', detail: String(error?.message || error).slice(0, 240) };
        }
    } else if (releaseResponse.status !== 404) {
        return { key: info.key, error: 'release_http_' + releaseResponse.status, detail: await githubResponseDetail(releaseResponse) };
    }

    let tagsResponse;
    try {
        tagsResponse = await githubRequest(githubApiUrl(info, '/tags?per_page=1'), token);
    } catch (error) {
        return { key: info.key, error: 'tags_network_error', detail: String(error?.message || error).slice(0, 240) };
    }
    if (!tagsResponse.ok) {
        return { key: info.key, error: 'tags_http_' + tagsResponse.status, detail: await githubResponseDetail(tagsResponse) };
    }

    let tags;
    try { tags = await tagsResponse.json(); } catch (error) {
        return { key: info.key, error: 'invalid_tags_json', detail: String(error?.message || error).slice(0, 240) };
    }
    if (!Array.isArray(tags) || !tags.length) return { key: info.key, error: 'no_release_or_tag' };
    const version = String(tags[0]?.name || '').trim();
    if (!version) return { key: info.key, error: 'empty_tag' };

    let pushedAt = '';
    try {
        const repositoryResponse = await githubRequest(githubApiUrl(info), token);
        if (repositoryResponse.ok) {
            const repository = await repositoryResponse.json();
            pushedAt = repository.pushed_at || '';
        }
    } catch (_) {}
    return { key: info.key, version, date: pushedAt, source: 'Tag' };
}

async function updateGitHubVersions(env, offset = 0) {
    if (!env.GITHUB_TOKEN) throw new Error("GITHUB_TOKEN secret is not configured.");
    const sheet = await readSheetRows(env);
    const urlIndex = sheet.headerMap.get("URL");
    const versionIndex = sheet.headerMap.get("VERSION");
    const dateIndex = sheet.headerMap.get("LAST UPDATE");
    if (urlIndex === undefined || versionIndex === undefined || dateIndex === undefined) {
        throw new Error("The Sheet must contain URL, VERSION and LAST UPDATE columns.");
    }

    const repoMap = new Map();
    for (const item of sheet.rows) {
        const info = normalizeGitHubRepo(item.values[urlIndex]);
        if (info && !repoMap.has(info.key)) repoMap.set(info.key, info);
    }
    const repos = Array.from(repoMap.values());
    const totalRepositories = repos.length;
    const startOffset = Math.max(0, Math.min(totalRepositories, Number.parseInt(offset, 10) || 0));
    const batchSize = 12;
    const batch = repos.slice(startOffset, startOffset + batchSize);
    const resolved = await Promise.all(batch.map((info) => resolveGitHubVersion(info, env.GITHUB_TOKEN)));
    const results = new Map();
    const errors = [];
    let withoutVersion = 0;
    for (const item of resolved) {
        if (item.version) results.set(item.key, item);
        else if (item.error === "no_release_or_tag") withoutVersion++;
        else if (item.error) errors.push({ repository: item.key, error: item.error, detail: item.detail || "" });
    }

    const batchKeys = new Set(batch.map((info) => info.key));
    const updates = [];
    let updatedRows = 0;
    let versionRows = 0;
    let dateRows = 0;
    for (const item of sheet.rows) {
        const info = normalizeGitHubRepo(item.values[urlIndex]);
        if (!info || !batchKeys.has(info.key)) continue;
        const result = results.get(info.key);
        if (!result?.version) continue;

        updates.push({
            rowNumber: item.rowNumber,
            column: sheetColumnName(versionIndex),
            value: String(result.version)
        });
        versionRows++;
        if (result.date) {
            const formattedDate = formatGitHubDate(result.date);
            if (formattedDate) {
                updates.push({
                    rowNumber: item.rowNumber,
                    column: sheetColumnName(dateIndex),
                    value: formattedDate
                });
                dateRows++;
            }
        }
        updatedRows++;
    }

    if (updates.length) await updateSheetCells(env, updates);
    const nextOffset = startOffset + batch.length;
    return {
        success: true,
        uniqueRepositories: totalRepositories,
        processedRepositories: batch.length,
        nextOffset,
        complete: nextOffset >= totalRepositories,
        repositoriesWithVersion: results.size,
        withoutVersion,
        updatedRows,
        versionRows,
        dateRows,
        errors
    };
}

async function handleUpdateGitHubVersions(request, env) {
    const denied = requireAdmin(request, env);
    if (denied) return denied;
    if (!env.GITHUB_TOKEN) return jsonResponse({ success: false, error: 'GITHUB_TOKEN secret is not configured.' }, 503);
    let body = {};
    try { body = await request.json(); } catch (_) {}
    const offset = Math.max(0, Number.parseInt(body.offset, 10) || 0);
    const result = await updateGitHubVersions(env, offset);
    if (result.complete && env.CATALOG_KV) {
        await refreshCatalogCache(env);
    }
    return jsonResponse(result, 200, { 'Cache-Control': 'no-store' });
}

async function updateDevelopers(env) {
    const sheet = await readSheetRows(env);
    const urlIndex = sheet.headerMap.get("URL");
    const developerIndex = sheet.headerMap.get("DEVELOPER");
    if (urlIndex === undefined || developerIndex === undefined) {
        throw new Error("The Sheet must contain URL and DEVELOPER columns.");
    }

    const updates = [];
    const developers = new Set();
    for (const item of sheet.rows) {
        const existing = String(item.values[developerIndex] || "").trim();
        if (existing) continue;
        const info = normalizeGitHubRepo(item.values[urlIndex]);
        if (!info) continue;
        updates.push({
            rowNumber: item.rowNumber,
            column: sheetColumnName(developerIndex),
            value: info.owner
        });
        developers.add(info.owner.toLowerCase());
    }
    if (updates.length) await updateSheetCells(env, updates);
    return {
        success: true,
        scannedRows: sheet.rows.length,
        updatedRows: updates.length,
        uniqueDevelopers: developers.size
    };
}

async function handleUpdateDevelopers(request, env) {
    const denied = requireAdmin(request, env);
    if (denied) return denied;
    const result = await updateDevelopers(env);
    return jsonResponse(result, 200, { "Cache-Control": "no-store" });
}

function limpiarEntidadesLB(texto) {
    return String(texto || "")
        .replace(/&amp;/gi, "&")
        .replace(/&quot;/gi, '"')
        .replace(/&#39;|&apos;/gi, "'")
        .replace(/&nbsp;/gi, " ")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/&#(\d+);/g, (_, n) => {
            const code = Number(n);
            return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
        })
        .replace(/&#x([0-9a-f]+);/gi, (_, n) => {
            const code = parseInt(n, 16);
            return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
        });
}

function limpiarHTMLLB(texto) {
    return limpiarEntidadesLB(
        String(texto || "")
            .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
            .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
            .replace(/<br\s*\/?\s*>/gi, " ")
            .replace(/<\/(?:p|div|li|span)>/gi, " ")
            .replace(/<[^>]+>/g, " ")
    ).replace(/\s+/g, " ").trim();
}

function buscarCampoHTMLLB(html, etiquetas) {
    for (const etiqueta of etiquetas) {
        const escaped = etiqueta;

        const patterns = [
            new RegExp("<[^>]*>\\s*" + escaped + "\\s*:?\\s*</[^>]+>\\s*<[^>]*>([\\s\\S]*?)</[^>]+>", "i"),
            new RegExp(escaped + "\\s*:\\s*([^<\\r\\n]+)", "i")
        ];
        for (const pattern of patterns) {
            const match = html.match(pattern);
            if (match?.[1]) {
                const value = limpiarHTMLLB(match[1]);
                if (value) return value;
            }
        }
    }
    return "";
}

function extraerOverviewLB(html) {
    const heading = /<h[1-6][^>]*>\s*Overview\s*<\/h[1-6]>/i.exec(html);
    if (!heading) return "";
    const start = heading.index + heading[0].length;
    const rest = html.slice(start);
    const nextHeading = /<h[1-6][^>]*>[\s\S]*?<\/h[1-6]>/i.exec(rest);
    const section = nextHeading ? rest.slice(0, nextHeading.index) : rest.slice(0, 12000);
    const paragraphs = [];
    const paragraphRegex = /<p\b[^>]*>([\s\S]*?)<\/p>/gi;
    let match;
    while ((match = paragraphRegex.exec(section)) !== null) {
        const value = limpiarHTMLLB(match[1]);
        if (value) paragraphs.push(value);
    }
    return paragraphs.length ? paragraphs.join("|||") : limpiarHTMLLB(section).slice(0, 3000);
}

function obtenerAtributoLB(tag, name) {
    const escaped = name;

    const match = tag.match(new RegExp("\\b" + escaped + "\\s*=\\s*[\"']([^\"']*)[\"']", "i"));
    return match ? limpiarEntidadesLB(match[1]) : "";
}

function esURLImagenLB(value) {
    const url = String(value || "").trim();
    return /^https?:\/\/[^"'<>\s]+\.(?:jpg|jpeg|png|webp)(?:[?#][^"'<>\s]*)?$/i.test(url);
}

function extraerPortadaFrontalLB(html) {
    const images = html.match(/<img\b[^>]*>/gi) || [];
    for (const tag of images) {
        const identity = [
            obtenerAtributoLB(tag, "alt"),
            obtenerAtributoLB(tag, "title"),
            obtenerAtributoLB(tag, "data-title")
        ].join(" ");
        if (/Box\s*-\s*Front/i.test(identity)) {
            const url = obtenerAtributoLB(tag, "src") || obtenerAtributoLB(tag, "data-src");
            if (esURLImagenLB(url)) return url;
        }
    }

    const index = html.search(/Box\s*-\s*Front/i);
    if (index >= 0) {
        const fragment = html.slice(Math.max(0, index - 2500), Math.min(html.length, index + 2500));
        const nearbyImages = fragment.match(/<img\b[^>]*>/gi) || [];
        for (let i = nearbyImages.length - 1; i >= 0; i--) {
            const tag = nearbyImages[i];
            const identity = [
                obtenerAtributoLB(tag, "alt"),
                obtenerAtributoLB(tag, "title"),
                obtenerAtributoLB(tag, "data-title")
            ].join(" ");
            if (/Box\s*-\s*(Back|3D|Spine)/i.test(identity)) continue;
            const url = obtenerAtributoLB(tag, "src") || obtenerAtributoLB(tag, "data-src");
            if (esURLImagenLB(url)) return url;
        }
    }
    return "";
}

function extraerMetadataLaunchBox(html) {
    const releaseDate = buscarCampoHTMLLB(html, ["Release Date", "Release Year", "Year"]);
    const yearMatch = releaseDate.match(/\b(?:19|20)\d{2}\b/);
    return {
        year: yearMatch ? yearMatch[0] : "",
        genre: buscarCampoHTMLLB(html, ["Genre", "Genres"]),
        description: extraerOverviewLB(html),
        cover: extraerPortadaFrontalLB(html)
    };
}

async function obtenerMetadataLaunchBox(url) {
    const response = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; NAPL/1.0)", "Accept": "text/html" },
        cf: { cacheTtl: 0, cacheEverything: false }
    });
    if (!response.ok) return { error: "http_" + response.status };
    const html = await response.text();
    if (html.length > 3_000_000) return { error: "html_too_large" };
    return { metadata: extraerMetadataLaunchBox(html) };
}

async function updateLaunchBoxData(env) {
    const result = await env.DB.prepare(
        `SELECT slug, launchbox_url, year, genre, description, cover_url
         FROM games
         WHERE launchbox_url IS NOT NULL AND TRIM(launchbox_url) <> ''
         ORDER BY name COLLATE NOCASE ASC`
    ).all();

    const unique = new Map();
    for (const row of result.results || []) {
        const url = String(row.launchbox_url || "").trim();
        if (!/^https?:\/\/gamesdb\.launchbox-app\.com\/games\/details\//i.test(url)) continue;
        const needsData = !String(row.year || "").trim() ||
            !String(row.genre || "").trim() ||
            !String(row.description || "").trim() ||
            !String(row.cover_url || "").trim();
        if (needsData && !unique.has(url)) unique.set(url, row);
    }

    const candidates = Array.from(unique.entries());
    const errors = [];
    let updatedGames = 0;
    let filledFields = 0;
    const concurrency = 5;

    for (let offset = 0; offset < candidates.length; offset += concurrency) {
        const batch = candidates.slice(offset, offset + concurrency);
        const fetched = await Promise.all(batch.map(async ([url, row]) => {
            try {
                return { url, row, ...(await obtenerMetadataLaunchBox(url)) };
            } catch (error) {
                return { url, row, error: String(error?.message || error).slice(0, 180) };
            }
        }));

        const statements = [];
        for (const item of fetched) {
            if (item.error || !item.metadata) {
                errors.push({ slug: item.row.slug, error: item.error || "empty_response" });
                continue;
            }
            const m = item.metadata;
            const values = [m.year || null, m.genre || null, m.description || null, m.cover || null];
            if (!values.some(Boolean)) {
                errors.push({ slug: item.row.slug, error: "no_metadata_found" });
                continue;
            }

            statements.push(env.DB.prepare(
                `UPDATE games SET
                    year = CASE WHEN TRIM(COALESCE(year, '')) = '' AND ? IS NOT NULL THEN ? ELSE year END,
                    genre = CASE WHEN TRIM(COALESCE(genre, '')) = '' AND ? IS NOT NULL THEN ? ELSE genre END,
                    description = CASE WHEN TRIM(COALESCE(description, '')) = '' AND ? IS NOT NULL THEN ? ELSE description END,
                    cover_url = CASE WHEN TRIM(COALESCE(cover_url, '')) = '' AND ? IS NOT NULL THEN ? ELSE cover_url END
                 WHERE slug = ?`
            ).bind(
                values[0], values[0], values[1], values[1],
                values[2], values[2], values[3], values[3], item.row.slug
            ));
            filledFields += values.filter(Boolean).length;
            updatedGames++;
        }
        if (statements.length) await env.DB.batch(statements);
        if (offset + concurrency < candidates.length) {
            await new Promise(resolve => setTimeout(resolve, 1500));
        }
    }

    return {
        success: true,
        candidates: candidates.length,
        updatedGames,
        filledFields,
        errors
    };
}

async function handleUpdateLaunchBoxData(request, env) {
    const denied = requireAdmin(request, env);
    if (denied) return denied;
    const result = await updateLaunchBoxData(env);
    return jsonResponse(result, 200, { "Cache-Control": "no-store" });
}

function identificarEnlaceSteam(url) {
    const value = String(url || "").trim().toLowerCase();
    if (/(^|\/\/)(store\.)?steampowered\.com\//i.test(value) ||
        /(^|\/\/)steamcommunity\.com\//i.test(value)) return "steam";
    if (/(^|\/\/)(www\.)?gamesdb\.launchbox-app\.com\//i.test(value) ||
        /(^|\/\/)(www\.)?launchbox-app\.com\//i.test(value) ||
        /(^|\/\/)(www\.)?launchbox\.com\//i.test(value)) return "launchbox";
    return "unknown";
}

function extraerSteamAppId(url) {
    const match = String(url || "").trim().match(/store\.steampowered\.com\/app\/(\d+)/i);
    return match ? match[1] : "";
}

function decodificarHTMLSteam(text) {
    return String(text || "")
        .replace(/&amp;/gi, "&")
        .replace(/&nbsp;/gi, " ")
        .replace(/&quot;/gi, '"')
        .replace(/&#39;|&apos;/gi, "'")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/&#(\d+);/g, (_, code) => {
            const n = Number(code);
            return n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
        })
        .replace(/&#x([0-9a-f]+);/gi, (_, code) => {
            const n = parseInt(code, 16);
            return n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
        });
}

function limpiarDescripcionSteam(text) {
    if (!text) return "";
    let html = String(text)
        .replace(/<br\s*\/?\s*>/gi, "\n")
        .replace(/<\/p\s*>/gi, "\n\n")
        .replace(/<p\b[^>]*>/gi, "")
        .replace(/<li\b[^>]*>/gi, "\n")
        .replace(/<\/li\s*>/gi, "\n")
        .replace(/<[^>]+>/g, " ");
    html = decodificarHTMLSteam(html)
        .replace(/\r\n?/g, "\n")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n[ \t]+/g, "\n")
        .replace(/[ \t]{2,}/g, " ")
        .trim();
    const paragraphs = html.split(/\n\s*\n/)
        .map(p => p.replace(/\s*\n\s*/g, " ").trim())
        .filter(Boolean);
    return paragraphs.length > 1 ? paragraphs.join("|||") : html.replace(/\s*\n\s*/g, " ").trim();
}

async function obtenerMetadatosSteam(appId) {
    const url = "https://store.steampowered.com/api/appdetails/?appids=" +
        encodeURIComponent(appId) + "&l=english&cc=us";
    const response = await fetch(url, {
        method: "GET",
        headers: { "Accept": "application/json", "User-Agent": "Mozilla/5.0 (compatible; NAPL/1.0)" },
        cf: { cacheTtl: 21600, cacheEverything: true }
    });
    if (!response.ok) return { error: "steam_http_" + response.status };
    const payload = await response.json();
    const entry = payload && payload[String(appId)];
    if (!entry || !entry.success || !entry.data || entry.data.type !== "game") {
        return { notFound: true };
    }

    const game = entry.data;
    const releaseDate = String(game.release_date?.date || "");
    const yearMatch = releaseDate.match(/\b(?:19|20)\d{2}\b/);
    const genre = Array.isArray(game.genres)
        ? game.genres.map(item => item?.description || "").filter(Boolean).join(", ")
        : "";
    const description = limpiarDescripcionSteam(game.about_the_game || game.short_description || "");

    return {
        metadata: {
            year: yearMatch ? yearMatch[0] : "",
            genre,
            cover: "https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/" + appId + "/library_600x900.jpg",
            description
        }
    };
}

async function updateSteamGameData(env) {
    const result = await env.DB.prepare(
        `SELECT slug, name, launchbox_url, year, genre, description, cover_url
         FROM games
         WHERE launchbox_url IS NOT NULL AND TRIM(launchbox_url) <> ''
         ORDER BY name COLLATE NOCASE ASC`
    ).all();

    const unique = new Map();
    let launchBoxLinks = 0;
    let invalidLinks = 0;
    for (const row of result.results || []) {
        const url = String(row.launchbox_url || "").trim();
        const source = identificarEnlaceSteam(url);
        if (source === "launchbox") {
            launchBoxLinks++;
            continue;
        }
        if (source !== "steam") {
            invalidLinks++;
            continue;
        }
        const appId = extraerSteamAppId(url);
        if (!appId) {
            invalidLinks++;
            continue;
        }
        const needsData = !String(row.year || "").trim() ||
            !String(row.genre || "").trim() ||
            !String(row.cover_url || "").trim() ||
            !String(row.description || "").trim();
        if (needsData && !unique.has(appId)) unique.set(appId, row);
    }

    const candidates = Array.from(unique.entries());
    const errors = [];
    let completedGames = 0;
    let failedGames = 0;
    let filledFields = 0;
    const concurrency = 5;

    for (let offset = 0; offset < candidates.length; offset += concurrency) {
        const batch = candidates.slice(offset, offset + concurrency);
        const fetched = await Promise.all(batch.map(async ([appId, row]) => {
            try {
                return { appId, row, ...(await obtenerMetadatosSteam(appId)) };
            } catch (error) {
                return { appId, row, error: String(error?.message || error).slice(0, 180) };
            }
        }));

        const statements = [];
        for (const item of fetched) {
            if (item.error || item.notFound || !item.metadata) {
                failedGames++;
                errors.push({
                    appId: item.appId,
                    game: item.row.name,
                    error: item.error || (item.notFound ? "steam_game_not_found_or_not_a_game" : "empty_response")
                });
                continue;
            }
            const m = item.metadata;
            const values = [m.year || null, m.genre || null, m.cover || null, m.description || null];
            if (!values.some(Boolean)) {
                failedGames++;
                errors.push({ appId: item.appId, game: item.row.name, error: "no_metadata_found" });
                continue;
            }

            statements.push(env.DB.prepare(
                `UPDATE games SET
                    year = CASE WHEN TRIM(COALESCE(year, '')) = '' AND ? IS NOT NULL THEN ? ELSE year END,
                    genre = CASE WHEN TRIM(COALESCE(genre, '')) = '' AND ? IS NOT NULL THEN ? ELSE genre END,
                    cover_url = CASE WHEN TRIM(COALESCE(cover_url, '')) = '' AND ? IS NOT NULL THEN ? ELSE cover_url END,
                    description = CASE WHEN TRIM(COALESCE(description, '')) = '' AND ? IS NOT NULL THEN ? ELSE description END
                 WHERE slug = ?`
            ).bind(
                values[0], values[0], values[1], values[1],
                values[2], values[2], values[3], values[3], item.row.slug
            ));
            completedGames++;
            filledFields += values.filter(Boolean).length;
        }
        if (statements.length) await env.DB.batch(statements);
        if (offset + concurrency < candidates.length) {
            await new Promise(resolve => setTimeout(resolve, 600));
        }
    }

    return {
        success: true,
        scannedGames: (result.results || []).length,
        steamCandidates: candidates.length,
        launchBoxLinksSkipped: launchBoxLinks,
        unrecognizedLinks: invalidLinks,
        completedGames,
        failedGames,
        filledFields,
        errors
    };
}

async function handleUpdateSteamGameData(request, env) {
    const denied = requireAdmin(request, env);
    if (denied) return denied;
    const result = await updateSteamGameData(env);
    return jsonResponse(result, 200, { "Cache-Control": "no-store" });
}
async function registerMissingPortDates(env) {
    const result = await env.DB.prepare(
        "UPDATE ports " +
        "SET date_added = strftime('%Y-%m-%d %H:%M:%S', 'now', '-3 hours') " +
        "WHERE TRIM(COALESCE(date_added, '')) = '' " +
        "AND (TRIM(COALESCE(port_id, '')) <> '' OR TRIM(COALESCE(game_slug, '')) <> '' OR " +
        "TRIM(COALESCE(platform, '')) <> '' OR TRIM(COALESCE(project, '')) <> '' OR " +
        "TRIM(COALESCE(link, '')) <> '' OR TRIM(COALESCE(url, '')) <> '' OR " +
        "TRIM(COALESCE(developer, '')) <> '' OR TRIM(COALESCE(version, '')) <> '' OR " +
        "TRIM(COALESCE(last_update, '')) <> '' OR TRIM(COALESCE(needs_files, '')) <> '' OR " +
        "TRIM(COALESCE(data_url, '')) <> '' OR TRIM(COALESCE(notes, '')) <> '')"
    ).run();
    return Number(result.meta?.changes) || 0;
}

async function handleRegisterMissingPortDates(request, env) {
    const denied = requireAdmin(request, env);
    if (denied) return denied;
    const updated = await registerMissingPortDates(env);
    return jsonResponse({
        success: true, updated,
        message: updated ? "Missing DATE ADDED values were registered." : "No ports needed a DATE ADDED value."
    });
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
// Protected catalog administration (games and ports).
// Uses the existing IMPORT_SECRET; no public write endpoints are exposed.
// -----------------------------------------------------------------------------

function isAdminAuthorized(request, env) {
    if (!env.IMPORT_SECRET) return false;
    const authorization = request.headers.get("Authorization") || "";
    const supplied = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
    return Boolean(supplied && supplied === env.IMPORT_SECRET);
}

function requireAdmin(request, env) {
    if (!env.IMPORT_SECRET) return jsonResponse({ success: false, error: "Admin secret is not configured." }, 503);
    if (!isAdminAuthorized(request, env)) return jsonResponse({ success: false, error: "Unauthorized." }, 401);
    return null;
}

async function handleAdminListPorts(request, env) {
    const denied = requireAdmin(request, env);
    if (denied) return denied;
    const sheet = await readSheetRows(env);
    const slugify = (value) => importSlug(value);
    const gamesMap = new Map();
    const ports = [];
    let currentGame = "";
    let currentYear = "";
    const portIds = new Set();

    for (const item of sheet.rows) {
        const row = item.object;
        const read = (...names) => {
            for (const name of names) {
                const value = row[importNormalizeHeader(name)];
                if (value !== undefined && String(value).trim() !== "") return String(value).trim();
            }
            return "";
        };
        if (read("GAME", "GAME NAME", "NAME", "JUEGO")) currentGame = read("GAME", "GAME NAME", "NAME", "JUEGO");
        if (read("YEAR", "ANO", "AÑO")) currentYear = read("YEAR", "ANO", "AÑO");
        if (!currentGame) continue;
        const gameSlug = slugify(currentGame);
        if (!gameSlug) continue;

        const genre = read("GENRE", "GÉNERO", "GENERO");
        const description = read("DESCRIPTION", "DESCRIPCIÓN", "DESCRIPCION");
        const coverUrl = read("COVER_URL", "COVER URL", "COVER", "PORTADA");
        const launchboxUrl = read("LAUNCHBOX_URL", "LAUNCHBOX URL");
        if (!gamesMap.has(gameSlug)) {
            gamesMap.set(gameSlug, {
                slug: gameSlug, name: currentGame, year: currentYear, genre, description,
                cover_url: coverUrl, launchbox_url: launchboxUrl, visits: 0
            });
        }
        const portId = read("PORTS_ID", "PORT ID", "PORT_ID") || gameSlug + "-row-" + item.rowNumber;
        const uniqueKey = gameSlug + "|" + portId;
        if (portIds.has(uniqueKey)) {
            return jsonResponse({ success: false, error: "Duplicate PORTS_ID detected for " + currentGame + ". Resolve duplicate IDs before editing the catalog." }, 409);
        }
        portIds.add(uniqueKey);
        const hasData = ["PLATFORM","PROJECT","LINK","URL","DEVELOPER","VERSION","LAST UPDATE","DATE ADDED","NEEDS GAME FILES?","DATA URL","NOTES","WORKS?","CONTROLLER SUPPORT"]
            .some((key) => read(key));
        if (!hasData) continue;
        ports.push({
            rowNumber: item.rowNumber,
            gameSlug, gameName: currentGame, year: currentYear, genre, description,
            coverUrl, launchboxUrl, visits: 0,
            portId, platform: read("PLATFORM"), project: read("PROJECT"), link: read("LINK"),
            url: read("URL"), developer: read("DEVELOPER"), version: read("VERSION"),
            lastUpdate: read("LAST UPDATE"), dateAdded: read("DATE ADDED"),
            needsFiles: read("NEEDS GAME FILES?", "NEEDS GAME FILES"),
            dataUrl: read("DATA URL"), notes: read("NOTES"),
            inputMethods: read("CONTROLLER SUPPORT", "CONTROLLER", "GAMEPAD")
        });
    }

    // Visits remain in D1 and are only loaded for the protected admin screen.
    try {
        const [legacy, recent] = await Promise.all([
            env.DB.prepare("SELECT game_slug, visits FROM game_visit_legacy_totals").all(),
            env.DB.prepare("SELECT game_slug, COUNT(*) AS visits FROM game_visits GROUP BY game_slug").all()
        ]);
        const totals = new Map();
        for (const row of legacy.results || []) totals.set(row.game_slug, (totals.get(row.game_slug) || 0) + Number(row.visits || 0));
        for (const row of recent.results || []) totals.set(row.game_slug, (totals.get(row.game_slug) || 0) + Number(row.visits || 0));
        for (const game of gamesMap.values()) game.visits = totals.get(game.slug) || 0;
        for (const port of ports) port.visits = totals.get(port.gameSlug) || 0;
    } catch (error) {
        console.warn("Admin visit totals could not be loaded:", error);
    }

    const platforms = [];
    const seenPlatforms = new Set();
    for (const port of ports) {
        const key = port.platform.toLowerCase();
        if (port.platform && !seenPlatforms.has(key)) {
            seenPlatforms.add(key);
            if (!["multi-game apps", "multi game apps"].includes(key)) platforms.push(port.platform);
        }
    }
    return jsonResponse({
        success: true,
        games: Array.from(gamesMap.values()),
        platforms,
        ports
    }, 200, { "Cache-Control": "no-store" });
}



async function handleAdminSavePort(request, env) {
    const denied = requireAdmin(request, env);
    if (denied) return denied;
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") return jsonResponse({ success: false, error: "Invalid JSON body." }, 400);

    const clean = (value, max = 2000) => String(value ?? "").trim().slice(0, max);
    const gameName = clean(body.gameName, 180);
    const requestedGameSlug = clean(body.gameSlug, 180);
    const gameSlug = requestedGameSlug === "__new__" ? importSlug(gameName) : requestedGameSlug;
    const portId = clean(body.portId, 120);
    const originalPortId = clean(body.originalPortId, 120);
    const platform = clean(body.platform, 100);
    if (!gameName || !gameSlug || !portId || !platform) {
        return jsonResponse({ success: false, error: "Game name, game and platform are required." }, 400);
    }

    const sheet = await readSheetRows(env);
    const headers = sheet.headers;
    const indexOf = (...aliases) => {
        for (const alias of aliases) {
            const index = sheet.headerMap.get(importNormalizeHeader(alias));
            if (index !== undefined) return index;
        }
        return -1;
    };
    const required = ["GAME","PORTS_ID","PLATFORM","PROJECT","LINK","URL","DEVELOPER","VERSION","LAST UPDATE"];
    const missing = required.filter((key) => indexOf(key) < 0);
    if (missing.length) return jsonResponse({ success: false, error: "Missing Sheet columns: " + missing.join(", ") }, 422);

    const set = (values, aliases, value) => {
        const index = indexOf(...aliases);
        if (index >= 0) values[index] = String(value ?? "");
    };
    let currentGame = "";
    let target = null;
    let firstGameRow = null;
    const groupRows = [];
    for (const item of sheet.rows) {
        const gameCell = String(item.values[indexOf("GAME")] || "").trim();
        if (gameCell) currentGame = gameCell;
        if (importSlug(currentGame) === gameSlug) {
            groupRows.push(item);
            if (!firstGameRow) firstGameRow = item;
            const rowPortId = String(item.values[indexOf("PORTS_ID")] || "").trim();
            if (rowPortId === (originalPortId || portId)) target = item;
        }
    }
    if (originalPortId && !target) {
        return jsonResponse({ success: false, error: "Port not found in Google Sheets. Reload the list." }, 409);
    }

    const makeValues = (source = []) => {
        const values = [...source];
        while (values.length < headers.length) values.push("");
        return values.slice(0, headers.length);
    };
    const now = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().slice(0, 19).replace("T", " ");
    const lastUpdate = clean(body.lastUpdate, 100);
    const dateAdded = clean(body.dateAdded, 100) || now;
    const gameValues = makeValues(firstGameRow?.values || []);
    set(gameValues, ["GAME"], gameName);
    set(gameValues, ["YEAR"], clean(body.year, 20));
    set(gameValues, ["GENRE"], clean(body.genre, 120));
    set(gameValues, ["DESCRIPTION"], clean(body.description, 4000));
    set(gameValues, ["COVER_URL","COVER URL"], clean(body.coverUrl, 1000));
    set(gameValues, ["LAUNCHBOX_URL","LAUNCHBOX URL"], clean(body.launchboxUrl, 1000));

    const portValues = makeValues(target?.values || []);
    set(portValues, ["GAME"], gameName);
    set(portValues, ["YEAR"], clean(body.year, 20));
    set(portValues, ["GENRE"], clean(body.genre, 120));
    set(portValues, ["DESCRIPTION"], clean(body.description, 4000));
    set(portValues, ["COVER_URL","COVER URL"], clean(body.coverUrl, 1000));
    set(portValues, ["LAUNCHBOX_URL","LAUNCHBOX URL"], clean(body.launchboxUrl, 1000));
    set(portValues, ["PORTS_ID"], portId);
    set(portValues, ["PLATFORM"], platform);
    set(portValues, ["PROJECT"], clean(body.project, 300));
    set(portValues, ["LINK"], clean(body.link, 1000));
    set(portValues, ["URL"], clean(body.url, 1000));
    set(portValues, ["DEVELOPER"], clean(body.developer, 180));
    set(portValues, ["VERSION"], clean(body.version, 100));
    set(portValues, ["LAST UPDATE"], lastUpdate);
    set(portValues, ["DATE ADDED"], dateAdded);
    set(portValues, ["NEEDS GAME FILES?","NEEDS GAME FILES"], clean(body.needsFiles, 100));
    set(portValues, ["DATA URL"], clean(body.dataUrl, 1000));
    set(portValues, ["NOTES"], clean(body.notes, 2000));
    set(portValues, ["CONTROLLER SUPPORT"], clean(body.inputMethods, 100));

    const { tabName } = sheet;
    const endColumn = sheetColumnName(headers.length - 1);
    const quotedTab = "'" + tabName.replace(/'/g, "''") + "'";
    if (target) {
        const updates = [];
        const firstValues = makeValues(firstGameRow.values);
        if (firstGameRow.rowNumber === target.rowNumber) {
            const merged = makeValues(portValues);
            set(merged, ["GAME"], gameName);
            set(merged, ["YEAR"], clean(body.year, 20));
            set(merged, ["GENRE"], clean(body.genre, 120));
            set(merged, ["DESCRIPTION"], clean(body.description, 4000));
            set(merged, ["COVER_URL","COVER URL"], clean(body.coverUrl, 1000));
            set(merged, ["LAUNCHBOX_URL","LAUNCHBOX URL"], clean(body.launchboxUrl, 1000));
            await writeSheetValues(env, quotedTab + "!A" + target.rowNumber + ":" + endColumn + target.rowNumber, [merged]);
        } else {
            await writeSheetValues(env, quotedTab + "!A" + firstGameRow.rowNumber + ":" + endColumn + firstGameRow.rowNumber, [gameValues]);
            await writeSheetValues(env, quotedTab + "!A" + target.rowNumber + ":" + endColumn + target.rowNumber, [portValues]);
        }
    } else {
        if (groupRows.length) {
            await writeSheetValues(env, quotedTab + "!A" + firstGameRow.rowNumber + ":" + endColumn + firstGameRow.rowNumber, [gameValues]);
        }
        set(portValues, ["GAME"], gameName);
        await writeSheetValues(env, quotedTab + "!A:Z", [portValues], { append: true });
    }

    // Keep the public cache in sync immediately when KV is configured.
    if (env.CATALOG_KV) {
        const refreshed = await readSheetRows(env);
        const catalog = buildCatalogFromSheet(refreshed);
        await env.CATALOG_KV.put("catalog:v1", JSON.stringify({ ...catalog, updatedAt: new Date().toISOString() }));
    }
    return jsonResponse({ success: true, gameSlug, portId });
}



async function handleAdminDeletePort(request, env) {
    const denied = requireAdmin(request, env);
    if (denied) return denied;
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") return jsonResponse({ success: false, error: "Invalid JSON body." }, 400);

    const gameSlug = String(body.gameSlug || "").trim().slice(0, 180);
    const portId = String(body.portId || "").trim().slice(0, 120);
    if (!gameSlug || !portId) return jsonResponse({ success: false, error: "gameSlug and portId are required." }, 400);

    const sheet = await readSheetRows(env);
    const gameIndex = sheet.headerMap.get("GAME");
    const portIndex = sheet.headerMap.get("PORTS_ID");
    let currentGame = "";
    const target = sheet.rows.find((item) => {
        const name = String(item.values[gameIndex] || "").trim();
        if (name) currentGame = name;
        return importSlug(currentGame) === gameSlug &&
            String(item.values[portIndex] || "").trim() === portId;
    });
    if (!target) return jsonResponse({ success: false, error: "Port not found in Google Sheets. Reload the catalog." }, 404);

    await deleteSheetRow(env, target.rowNumber);
    if (env.CATALOG_KV) {
        const refreshed = await readSheetRows(env);
        const catalog = buildCatalogFromSheet(refreshed);
        await env.CATALOG_KV.put("catalog:v1", JSON.stringify({ ...catalog, updatedAt: new Date().toISOString() }));
    }
    return jsonResponse({ success: true, gameSlug, portId, gameDeleted: false });
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


async function handleImportVisits(request, env) {
    if (!env.IMPORT_SECRET) return jsonResponse({ success: false, error: "Import secret is not configured." }, 503);
    const authorization = request.headers.get("Authorization") || "";
    const supplied = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
    if (!supplied || supplied !== env.IMPORT_SECRET) return jsonResponse({ success: false, error: "Unauthorized." }, 401);

    const response = await fetch(SHEET_CSV_URL, {
        headers: { "Accept": "text/csv,text/plain;q=0.9,*/*;q=0.8" },
        cf: { cacheTtl: 0, cacheEverything: false }
    });
    if (!response.ok) return jsonResponse({ success: false, error: "Could not download the published Google Sheets CSV.", upstreamStatus: response.status }, 502);
    const csv = await response.text();
    const rows = importParseCSV(csv);
    if (!rows.length || !Object.prototype.hasOwnProperty.call(rows[0], "GAME") ||
        !Object.prototype.hasOwnProperty.call(rows[0], "VISITAS")) {
        return jsonResponse({ success: false, error: "CSV must contain GAME and VISITAS columns." }, 422);
    }

    const totals = new Map();
    for (const row of rows) {
        const gameName = importColumn(row, ["GAME", "GAME NAME", "NAME", "JUEGO"]);
        if (!gameName) continue;
        const slug = importSlug(gameName);
        const rawVisits = importColumn(row, ["VISITAS"]);
        const visits = Number.parseInt(rawVisits.replace(/[^0-9-]/g, ""), 10);
        if (!slug || !Number.isSafeInteger(visits) || visits < 0) continue;
        totals.set(slug, { slug, gameName, visits });
    }

    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS game_visit_legacy_totals (
        game_slug TEXT PRIMARY KEY,
        game_name TEXT NOT NULL DEFAULT '',
        visits INTEGER NOT NULL DEFAULT 0,
        imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`).run();

    const statements = Array.from(totals.values()).map((item) =>
        env.DB.prepare(`INSERT INTO game_visit_legacy_totals (game_slug, game_name, visits)
            VALUES (?, ?, ?)
            ON CONFLICT(game_slug) DO UPDATE SET
                game_name = excluded.game_name,
                visits = excluded.visits,
                imported_at = CURRENT_TIMESTAMP`)
            .bind(item.slug, item.gameName, item.visits)
    );
    await importBatch(env.DB, statements);

    return jsonResponse({
        success: true,
        message: "Legacy visit totals imported. Re-running is safe; existing legacy values are replaced, not added.",
        importedGames: totals.size,
        totalLegacyVisits: Array.from(totals.values()).reduce((sum, item) => sum + item.visits, 0)
    });
}

async function handleImportDailyVisits(request, env) {
    const denied = requireAdmin(request, env);
    if (denied) return denied;

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        return jsonResponse({ success: false, error: "El archivo debe ser un objeto JSON por fecha." }, 400);
    }

    const history = body.history && typeof body.history === "object" ? body.history : body;
    const entries = [];
    const datePattern = /^\\d{4}-\\d{2}-\\d{2}$/;

    for (const [date, games] of Object.entries(history)) {
        if (!datePattern.test(date) || !games || typeof games !== "object" || Array.isArray(games)) {
            return jsonResponse({ success: false, error: "Formato inválido en la fecha: " + date }, 422);
        }
        const parsedDate = new Date(date + "T12:00:00Z");
        if (Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== date) {
            return jsonResponse({ success: false, error: "Fecha inválida: " + date }, 422);
        }
        for (const [rawSlug, rawVisits] of Object.entries(games)) {
            const slug = String(rawSlug || "").trim().toLowerCase();
            const visits = Number(rawVisits);
            if (!slug || !/^[a-z0-9-]+$/.test(slug) || !Number.isSafeInteger(visits) || visits < 0) {
                return jsonResponse({ success: false, error: "Registro inválido para " + date + " / " + rawSlug }, 422);
            }
            entries.push({ date, slug, visits });
        }
    }

    if (!entries.length) {
        return jsonResponse({ success: false, error: "No se encontraron registros para importar." }, 422);
    }
    if (entries.length > 50000) {
        return jsonResponse({ success: false, error: "El archivo supera el máximo de 50.000 registros." }, 413);
    }

    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS game_visit_daily_totals (
        game_slug TEXT NOT NULL,
        game_name TEXT NOT NULL DEFAULT '',
        visit_date TEXT NOT NULL,
        visits INTEGER NOT NULL DEFAULT 0,
        imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (game_slug, visit_date)
    )`).run();
    await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_daily_visits_date ON game_visit_daily_totals(visit_date)").run();
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS game_visit_settings (
        setting_key TEXT PRIMARY KEY,
        setting_value TEXT NOT NULL
    )`).run();
    // The first successful history import establishes the fresh Week baseline.
    // Re-importing the same JSON does not reset the Week counter.
    await env.DB.prepare(`INSERT OR IGNORE INTO game_visit_settings (setting_key, setting_value)
        VALUES ('week_reset_at', CURRENT_TIMESTAMP)`).run();

    const statements = entries.map((item) =>
        env.DB.prepare(`INSERT INTO game_visit_daily_totals (game_slug, game_name, visit_date, visits)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(game_slug, visit_date) DO UPDATE SET
                visits = excluded.visits,
                imported_at = CURRENT_TIMESTAMP`)
            .bind(item.slug, item.slug, item.date, item.visits)
    );
    for (let i = 0; i < statements.length; i += 50) {
        await env.DB.batch(statements.slice(i, i + 50));
    }

    const bounds = await env.DB.prepare(
        "SELECT MIN(visit_date) AS first_date, MAX(visit_date) AS last_date, COUNT(*) AS records FROM game_visit_daily_totals"
    ).first();

    return jsonResponse({
        success: true,
        importedRecords: entries.length,
        importedDays: Object.keys(history).length,
        firstDate: bounds?.first_date || null,
        lastDate: bounds?.last_date || null,
        totalStoredRecords: Number(bounds?.records) || 0,
        message: "Historial diario importado. Repetir la importación actualiza los mismos días sin sumar duplicados."
    });
}

function handleImportDailyVisitsPage() {
    const html = `<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>NAPL — Importar historial diario</title>
<body style="font:16px system-ui;max-width:560px;margin:40px auto;padding:0 18px;background:#101810;color:#eef5ee">
<h2>Importar historial diario</h2>
<p>Seleccioná el archivo <b>NAPL-visitas-ultimos-30-dias.json</b> exportado desde Apps Script. La importación reemplaza los valores de cada juego y fecha; no los suma si se repite.</p>
<form id="f">
<input id="secret" type="password" autocomplete="off" required placeholder="IMPORT_SECRET" style="box-sizing:border-box;width:100%;padding:12px;margin:8px 0;background:#202d20;color:white;border:1px solid #607060;border-radius:6px">
<input id="file" type="file" accept=".json,application/json" required style="display:block;margin:14px 0">
<button style="padding:12px 18px">Importar historial</button></form>
<pre id="result" style="white-space:pre-wrap;overflow-wrap:anywhere"></pre>
<script>
document.getElementById("f").addEventListener("submit",async e=>{
 e.preventDefault();const out=document.getElementById("result");const file=document.getElementById("file").files[0];
 if(!file){out.textContent="Seleccioná el archivo JSON.";return;}
 out.textContent="Leyendo e importando "+file.name+"…";
 try{
  const raw=await file.text();const parsed=JSON.parse(raw);
  const r=await fetch("/admin/import-daily-visits",{method:"POST",headers:{"Authorization":"Bearer "+document.getElementById("secret").value,"Content-Type":"application/json"},body:JSON.stringify(parsed)});
  const data=await r.json();out.textContent=JSON.stringify(data,null,2);
 }catch(err){out.textContent="Error: "+err.message;}
});
</script></body></html>`;
    return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

function handleImportVisitsPage() {
    const html = `<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>NAPL — Recuperar visitas</title><body style="font:16px system-ui;max-width:520px;margin:40px auto;padding:0 18px;background:#101810;color:#eef5ee">
<h2>Recuperar visitas históricas</h2><p>Importa los valores de la columna VISITAS del Google Sheet a la tabla histórica de Cloudflare. No modifica las visitas nuevas ni crea fechas ficticias.</p>
<form id="f"><input id="secret" type="password" autocomplete="off" required placeholder="IMPORT_SECRET" style="box-sizing:border-box;width:100%;padding:12px;margin:8px 0;background:#202d20;color:white;border:1px solid #607060;border-radius:6px">
<button style="padding:12px 18px">Importar VISITAS</button></form><pre id="result" style="white-space:pre-wrap;overflow-wrap:anywhere"></pre>
<script>document.getElementById("f").addEventListener("submit",async e=>{e.preventDefault();const out=document.getElementById("result");out.textContent="Importando…";try{const r=await fetch("/admin/import-visits",{method:"POST",headers:{Authorization:"Bearer "+document.getElementById("secret").value}});out.textContent=JSON.stringify(await r.json(),null,2)}catch(err){out.textContent="Error: "+err.message}});</script></body></html>`;
    return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}



const ANDROID_DEVICE_CATALOG_URL = "https://hossain-khan.github.io/android-device-catalog-parser/catalog-data/android-devices-catalog.min.json";

// Consolas portátiles Android que pueden no figurar en el catálogo de Google Play.
// No se asigna un procesador si la fuente no lo proporciona.
const ANDROID_HANDHELD_DEVICES = [
    "AYN Thor", "AYN Thor Lite", "AYN Odin 2", "AYN Odin 2 Mini",
    "AYN Odin 2 Portal", "AYN Odin 3", "AYN Odin 3 Portal",
    "Retroid Pocket 5", "Retroid Pocket 6", "Retroid Pocket Mini",
    "Retroid Pocket Mini V2", "Retroid Pocket Flip 2", "Retroid Pocket Duo",
    "Retroid Pocket Nova",
    "AYANEO Pocket EVO", "AYANEO Pocket S2", "AYANEO Pocket ACE",
    "AYANEO Pocket DS", "AYANEO Pocket DMG", "AYANEO Pocket MICRO 2",
    "AYANEO Pocket S 2K", "AYANEO Pocket S 1K",
    "KONKR Pocket FIT (8 Elite)", "KONKR Pocket FIT (G3 Gen 3)",
    "MANGMI AIR Y Pro (8 GB)", "MANGMI Pocket Max",
    "Anbernic RG353V", "Anbernic RG353M", "Anbernic RG353P",
    "Anbernic RG552", "Anbernic RG DS", "Anbernic RG505",
    "Anbernic RG556", "Anbernic RG Cube", "Anbernic RG405V",
    "Anbernic RG405M", "Anbernic RG406V", "Anbernic RG406H",
    "Anbernic RG557",
    "Powkiddy X18S", "Powkiddy X28", "Powkiddy RGB10 Max 3 Pro",
    "GPD XP", "GPD XP Plus", "Logitech G Cloud", "Abxylute One",
    "KT-R1", "Pimax Portal", "ZPG A1 Unicorn", "MOQI i7S", "TJD T80"
];

function normalizeDevicePart(value) {
    return String(value || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
        .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function normalizeProcessorName(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";

    // Alias comercial conocido del catálogo de origen.
    // QTI SM6225 corresponde al Qualcomm Snapdragon 680.
    if (/\bSM6225\b/i.test(raw)) return "Snapdragon 680";

    // Evita mostrar Qualcomm como prefijo redundante.
    return raw.replace(/^Qualcomm\s+/i, "").trim();
}

function deviceSlug(value) {
    return normalizeDevicePart(value).replace(/\s+/g, "-").slice(0, 140);
}

function hashDeviceKey(value) {
    let hash = 2166136261;
    for (let i = 0; i < value.length; i++) {
        hash ^= value.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
}

function handheldManufacturer(name) {
    if (name.startsWith("KT-R1")) return "KT";
    if (name.startsWith("TJD ")) return "TJD";
    const prefixes = ["AYANEO", "Anbernic", "Powkiddy", "Retroid", "Logitech", "Abxylute", "KONKR", "MANGMI", "Pimax", "ZPG", "MOQI", "GPD", "AYN"];
    const lower = name.toLowerCase();
    return prefixes.find((prefix) => lower.startsWith(prefix.toLowerCase())) || "Other";
}

async function loadAndNormalizeDevices() {
    const response = await fetch(ANDROID_DEVICE_CATALOG_URL, {
        headers: { "Accept": "application/json" },
        cf: { cacheTtl: 3600, cacheEverything: false }
    });
    if (!response.ok) throw new Error("No se pudo descargar el catálogo de dispositivos (HTTP " + response.status + ").");

    const source = await response.json();
    if (!Array.isArray(source)) throw new Error("El catálogo de origen no tiene el formato esperado (array).");

    const devices = new Map();
    const formFactorCounts = { Phone: 0, Tablet: 0 };
    let missingCpu = 0;
    let matchingRecords = 0;
    let invalidRecords = 0;

    for (const item of source) {
        const formFactor = String(item?.formFactor || "").trim();
        if (formFactor !== "Phone" && formFactor !== "Tablet") continue;
        matchingRecords++;
        formFactorCounts[formFactor]++;

        const manufacturer = String(item?.manufacturer || "").trim();
        const model = String(item?.modelName || item?.device || "").trim();
        const sourceCpu = String(item?.processorName || "").trim();
        const cpu = normalizeProcessorName(sourceCpu);
        if (!manufacturer || !model) {
            invalidRecords++;
            continue;
        }
        if (!cpu) missingCpu++;

        const key = [manufacturer, model, cpu].map(normalizeDevicePart).join("|");
        const displayName = model + (cpu ? " (" + cpu + ")" : "");
        const id = "catalog:" + deviceSlug(manufacturer + "-" + model + (cpu ? "-" + cpu : "")) + "-" + hashDeviceKey(key);
        if (!devices.has(key)) {
            devices.set(key, {
                id,
                name: displayName.slice(0, 180),
                manufacturer: manufacturer.slice(0, 100),
                model: model.slice(0, 140),
                cpu: cpu.slice(0, 140)
            });
        }
    }

    const catalogDevices = devices.size;
    let handheldsAdded = 0;
    let handheldsAlreadyInCatalog = 0;
    for (const name of ANDROID_HANDHELD_DEVICES) {
        const manufacturer = handheldManufacturer(name);
        const model = name.slice(manufacturer === "Other" ? 0 : manufacturer.length).trim() || name;
        const key = [manufacturer, model, ""].map(normalizeDevicePart).join("|");
        if (devices.has(key)) {
            handheldsAlreadyInCatalog++;
            continue;
        }
        devices.set(key, {
            id: "handheld:" + deviceSlug(name) + "-" + hashDeviceKey(key),
            name: name.slice(0, 180),
            manufacturer: manufacturer.slice(0, 100),
            model: model.slice(0, 140),
            cpu: ""
        });
        handheldsAdded++;
    }

    const result = Array.from(devices.values()).sort((a, b) => a.name.localeCompare(b.name));
    if (!result.length) throw new Error("No se encontraron dispositivos Android compatibles; la base no fue modificada.");

    const manufacturerCounts = {};
    for (const device of result) {
        manufacturerCounts[device.manufacturer] = (manufacturerCounts[device.manufacturer] || 0) + 1;
    }
    const sortedManufacturerCounts = Object.fromEntries(
        Object.entries(manufacturerCounts).sort((a, b) => a[0].localeCompare(b[0]))
    );
    const ids = new Set();
    let idCollisionCount = 0;
    let invalidIdCount = 0;
    for (const device of result) {
        if (ids.has(device.id)) idCollisionCount++;
        ids.add(device.id);
        if (/[^a-zA-Z0-9:_-]/.test(device.id)) invalidIdCount++;
    }

    const handheldDevices = result.filter((device) => device.id.startsWith("handheld:"));
    const redmiDevices = result.filter((device) =>
        /redmi/i.test(device.model) || /redmi/i.test(device.manufacturer)
    );
    const xiaomiDevices = result.filter((device) =>
        /xiaomi|poco/i.test(device.manufacturer) || /xiaomi|poco/i.test(device.model)
    );

    return {
        devices: result,
        stats: {
            sourceRecords: source.length,
            matchingRecords,
            phones: formFactorCounts.Phone,
            tablets: formFactorCounts.Tablet,
            catalogDevices,
            handheldsInManualList: ANDROID_HANDHELD_DEVICES.length,
            handheldsAdded,
            handheldsAlreadyInCatalog,
            duplicatesGrouped: Math.max(0, matchingRecords - catalogDevices),
            invalidRecords,
            missingCpu,
            total: result.length,
            redmiCount: redmiDevices.length,
            xiaomiPocoCount: xiaomiDevices.length,
            manufacturerCounts: sortedManufacturerCounts,
            idCollisionCount,
            invalidIdCount,
            redmiDevices,
            xiaomiPocoDevices: xiaomiDevices,
            handheldDevices,
            examples: result.slice(0, 12)
        }
    };
}

async function authorizeDeviceImport(request, env) {
    if (!env.IMPORT_SECRET) return jsonResponse({ success: false, error: "Import secret is not configured." }, 503);
    const authorization = request.headers.get("Authorization") || "";
    const supplied = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
    if (!supplied || supplied !== env.IMPORT_SECRET) return jsonResponse({ success: false, error: "Unauthorized." }, 401);
    return null;
}

async function handlePreviewDevices(request, env) {
    const denied = await authorizeDeviceImport(request, env);
    if (denied) return denied;
    try {
        const { devices, stats } = await loadAndNormalizeDevices();
        return jsonResponse({
            success: true,
            message: "Vista previa únicamente. La base de datos no fue modificada.",
            stats,
            sample: devices.slice(0, 30)
        });
    } catch (error) {
        return jsonResponse({ success: false, error: error.message || "Error al preparar el catálogo." }, 502);
    }
}

async function handleImportDevices(request, env) {
    const denied = await authorizeDeviceImport(request, env);
    if (denied) return denied;

    let normalized;
    try {
        normalized = await loadAndNormalizeDevices();
    } catch (error) {
        return jsonResponse({ success: false, error: error.message || "Error al preparar el catálogo." }, 502);
    }

    const devices = normalized.devices;
    const statements = devices.map((device) =>
        env.DEVICES_DB.prepare(
            `INSERT INTO devices (id, name, manufacturer, model, cpu)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                manufacturer = excluded.manufacturer,
                model = excluded.model,
                cpu = excluded.cpu`
        ).bind(device.id, device.name, device.manufacturer, device.model, device.cpu)
    );

    for (let i = 0; i < statements.length; i += 50) {
        await env.DEVICES_DB.batch(statements.slice(i, i + 50));
    }

    const counts = await env.DEVICES_DB.prepare("SELECT COUNT(*) AS total FROM devices").first();
    return jsonResponse({
        success: true,
        message: "Catálogo importado. No se eliminaron dispositivos ni reportes de compatibilidad.",
        imported: devices.length,
        totalDevices: Number(counts?.total) || 0,
        stats: normalized.stats
    });
}

function handleImportDevicesPage() {
    const html = `<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>NAPL — Catálogo de dispositivos Android</title>
<body style="font:16px system-ui;max-width:680px;margin:40px auto;padding:0 18px;background:#101810;color:#eef5ee">
<h2>Catálogo de dispositivos Android</h2>
<p>Se incluyen teléfonos, tablets y consolas portátiles Android. Las variantes de RAM/almacenamiento se agrupan; los modelos con procesadores diferentes permanecen separados.</p>
<p>Primero ejecutá una vista previa. Esa acción no modifica la base de datos.</p>
<form id="f">
<input id="secret" type="password" autocomplete="off" required placeholder="IMPORT_SECRET" style="box-sizing:border-box;width:100%;padding:12px;margin:8px 0;background:#202d20;color:white;border:1px solid #607060;border-radius:6px">
<div style="display:flex;gap:10px;flex-wrap:wrap">
<button type="button" id="preview" style="padding:12px 18px">Vista previa</button>
<button type="button" id="import" style="padding:12px 18px;background:#315b38;color:white;border:0;border-radius:6px">Importar catálogo</button>
</div>
</form><pre id="result" style="white-space:pre-wrap;overflow-wrap:anywhere"></pre>
<script>
const secret=()=>document.getElementById("secret").value;
const out=document.getElementById("result");
async function run(path,label){
 if(!secret()){out.textContent="Ingresá IMPORT_SECRET.";return;}
 out.textContent=label+"…";
 try{
  const response=await fetch(path,{method:"POST",headers:{Authorization:"Bearer "+secret()}});
  const data=await response.json();
  out.textContent=JSON.stringify(data,null,2);
 }catch(err){out.textContent="Error de conexión: "+err.message;}
}
document.getElementById("preview").addEventListener("click",()=>run("/admin/preview-devices","Generando vista previa"));
document.getElementById("import").addEventListener("click",()=>{
 if(!confirm("¿Importar el catálogo a D1? No se borrarán dispositivos ni reportes existentes."))return;
 run("/admin/import-devices","Importando catálogo");
});
</script></body></html>`;
    return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
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

async function runScheduledGitHubSync(env) {
    if (!env.GITHUB_TOKEN || !env.SHEETS_SERVICE_ACCOUNT_EMAIL || !env.SHEETS_SERVICE_ACCOUNT_PRIVATE_KEY) return;
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS github_sync_state (
        state_key TEXT PRIMARY KEY,
        next_offset INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`).run();
    await env.DB.prepare("INSERT OR IGNORE INTO github_sync_state (state_key, next_offset) VALUES ('catalog', 0)").run();
    const state = await env.DB.prepare("SELECT next_offset FROM github_sync_state WHERE state_key = 'catalog'").first();
    const offset = Math.max(0, Number(state?.next_offset) || 0);
    const result = await updateGitHubVersions(env, offset);
    const nextOffset = result.complete ? 0 : result.nextOffset;
    await env.DB.prepare("UPDATE github_sync_state SET next_offset = ?, updated_at = CURRENT_TIMESTAMP WHERE state_key = 'catalog'").bind(nextOffset).run();
    console.log("Scheduled GitHub sync:", JSON.stringify({
        offset, nextOffset, complete: result.complete,
        processedRepositories: result.processedRepositories,
        uniqueRepositories: result.uniqueRepositories,
        errors: result.errors.length
    }));
}

async function refreshCatalogCache(env) {
    if (!env.CATALOG_KV || !env.SHEETS_SERVICE_ACCOUNT_EMAIL || !env.SHEETS_SERVICE_ACCOUNT_PRIVATE_KEY) return;
    const sheet = await readSheetRows(env);
    const catalog = buildCatalogFromSheet(sheet);
    if (!catalog.games.length) throw new Error("Sheet catalog is empty; keeping previous KV value.");
    await env.CATALOG_KV.put("catalog:v1", JSON.stringify({ ...catalog, updatedAt: new Date().toISOString() }));
}

export default {
    async scheduled(controller, env, ctx) {
        ctx.waitUntil(Promise.allSettled([
            runScheduledGitHubSync(env),
            refreshCatalogCache(env)
        ]));
    },

    async fetch(request, env) {
        if (request.method === "OPTIONS") {
            return new Response(null, { status: 204, headers: CORS_HEADERS });
        }

        const url = new URL(request.url);
        const path = url.pathname.replace(/\/+$/, "") || "/";

        try {
            if (request.method === "GET" && path === "/admin/ports/list") {
                return await handleAdminListPorts(request, env);
            }
            if (request.method === "POST" && path === "/admin/ports/save") {
                return await handleAdminSavePort(request, env);
            }
            if (request.method === "POST" && path === "/admin/ports/delete") {
                return await handleAdminDeletePort(request, env);
            }

            if (request.method === "GET" && path === "/admin/import-devices") {
                return handleImportDevicesPage();
            }

            if (request.method === "POST" && path === "/admin/preview-devices") {
                return await handlePreviewDevices(request, env);
            }

            if (request.method === "POST" && path === "/admin/import-devices") {
                return await handleImportDevices(request, env);
            }

            if (request.method === "GET" && path === "/admin/import") {
                return handleImportPage();
            }

            if (request.method === "GET" && path === "/admin/import-daily-visits") {
                return handleImportDailyVisitsPage();
            }

            if (request.method === "POST" && path === "/admin/import-daily-visits") {
                return await handleImportDailyVisits(request, env);
            }

            if (request.method === "GET" && path === "/admin/import-visits") {
                return handleImportVisitsPage();
            }

            if (request.method === "POST" && path === "/admin/import-visits") {
                return await handleImportVisits(request, env);
            }

            if (request.method === "POST" && path === "/admin/import-sheet") {
                return await handleImportSheet(request, env);
            }

            if (request.method === "POST" && path === "/admin/update-github-versions") {
                return await handleUpdateGitHubVersions(request, env);
            }

            if (request.method === "POST" && path === "/admin/update-developers") {
                return await handleUpdateDevelopers(request, env);
            }

            if (request.method === "POST" && path === "/admin/update-launchbox-data") {
                return await handleUpdateLaunchBoxData(request, env);
            }

            if (request.method === "POST" && path === "/admin/update-steam-data") {
                return await handleUpdateSteamGameData(request, env);
            }

            if (request.method === "POST" && path === "/admin/register-missing-dates") {
                return await handleRegisterMissingPortDates(request, env);
            }

            if (request.method === "GET" && path === "/health") {
                return await handleHealth(env);
            }

            if (request.method === "GET" && path === "/catalog") {
                return await handleGetCatalog(env);
            }

            if (request.method === "POST" && path === "/admin/sync-catalog-cache") {
                return await handleSyncCatalogCache(request, env);
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
