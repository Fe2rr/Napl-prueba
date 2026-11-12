/*
 * NAPL — GOOGLE SHEETS API
 *
 * Google Sheets is the source of truth for the public catalog.
 * Configure SHEETS_SERVICE_ACCOUNT_EMAIL and SHEETS_SERVICE_ACCOUNT_PRIVATE_KEY
 * as Worker secrets. The service account must have Editor access to the sheet.
 */

const DEFAULT_SPREADSHEET_ID = "1CO7dH7mbj9sl67g4e94wczHESp0NAsOa7_chKKii9OA";
const DEFAULT_TAB_NAME = "Community Ports";
const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";

let cachedAccessToken = "";
let cachedAccessTokenExpiresAt = 0;

function base64UrlEncode(value) {
    const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function pemToBytes(pem) {
    const clean = String(pem || "")
        .replace(/-----BEGIN PRIVATE KEY-----/g, "")
        .replace(/-----END PRIVATE KEY-----/g, "")
        .replace(/\\n/g, "\n")
        .replace(/\s+/g, "");
    if (!clean) throw new Error("SHEETS_SERVICE_ACCOUNT_PRIVATE_KEY is not configured.");
    const binary = atob(clean);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function getGoogleAccessToken(env) {
    if (cachedAccessToken && Date.now() < cachedAccessTokenExpiresAt - 60_000) {
        return cachedAccessToken;
    }

    const email = String(env.SHEETS_SERVICE_ACCOUNT_EMAIL || "").trim();
    const privateKey = String(env.SHEETS_SERVICE_ACCOUNT_PRIVATE_KEY || "").trim();
    if (!email || !privateKey) {
        throw new Error("Google Sheets credentials are missing. Configure SHEETS_SERVICE_ACCOUNT_EMAIL and SHEETS_SERVICE_ACCOUNT_PRIVATE_KEY.");
    }

    const now = Math.floor(Date.now() / 1000);
    const header = base64UrlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claims = base64UrlEncode(JSON.stringify({
        iss: email,
        scope: SHEETS_SCOPE,
        aud: "https://oauth2.googleapis.com/token",
        iat: now,
        exp: now + 3600
    }));
    const unsigned = header + "." + claims;
    const key = await crypto.subtle.importKey(
        "pkcs8",
        pemToBytes(privateKey),
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["sign"]
    );
    const signature = await crypto.subtle.sign(
        "RSASSA-PKCS1-v1_5",
        key,
        new TextEncoder().encode(unsigned)
    );
    const assertion = unsigned + "." + base64UrlEncode(new Uint8Array(signature));
    const response = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
            assertion
        })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.access_token) {
        throw new Error("Google OAuth failed (HTTP " + response.status + "): " + String(payload.error_description || payload.error || "Unknown error").slice(0, 240));
    }
    cachedAccessToken = payload.access_token;
    cachedAccessTokenExpiresAt = Date.now() + Math.max(60, Number(payload.expires_in) || 3600) * 1000;
    return cachedAccessToken;
}

export function getSheetConfig(env) {
    return {
        spreadsheetId: String(env.SHEETS_SPREADSHEET_ID || DEFAULT_SPREADSHEET_ID).trim(),
        tabName: String(env.SHEETS_TAB_NAME || DEFAULT_TAB_NAME).trim()
    };
}

async function sheetsRequest(env, path, options = {}) {
    const token = await getGoogleAccessToken(env);
    const response = await fetch("https://sheets.googleapis.com/v4/spreadsheets/" + path, {
        ...options,
        headers: {
            Authorization: "Bearer " + token,
            ...(options.body ? { "Content-Type": "application/json" } : {}),
            ...(options.headers || {})
        }
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error("Google Sheets API returned HTTP " + response.status + ": " + String(payload.error?.message || "Unknown error").slice(0, 300));
    }
    return payload;
}

export async function readSheetRows(env) {
    const { spreadsheetId, tabName } = getSheetConfig(env);
    const range = "'" + tabName.replace(/'/g, "''") + "'!A:Z";
    const payload = await sheetsRequest(
        env,
        encodeURIComponent(spreadsheetId) + "/values/" + encodeURIComponent(range) + "?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE"
    );
    const values = Array.isArray(payload.values) ? payload.values : [];
    if (!values.length) throw new Error("The Google Sheet is empty or its header row is missing.");

    const headers = values[0].map((value) => normalizeSheetHeader(value));
    if (!headers.includes("GAME") || !headers.includes("URL") || !headers.includes("PORTS_ID")) {
        throw new Error("The Google Sheet must contain GAME, URL and PORTS_ID columns.");
    }
    return {
        spreadsheetId,
        tabName,
        headers,
        headerMap: new Map(headers.map((header, index) => [header, index]).filter(([header]) => header)),
        rows: values.slice(1).map((values, index) => ({
            rowNumber: index + 2,
            values,
            object: Object.fromEntries(headers.map((header, column) => [header, String(values[column] ?? "").trim()]).filter(([header]) => header))
        }))
    };
}

export function normalizeSheetHeader(value) {
    return String(value || "").replace(/^\uFEFF/, "").trim().toUpperCase()
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

export function sheetColumnName(index) {
    let number = Number(index) + 1;
    let result = "";
    while (number > 0) {
        const remainder = (number - 1) % 26;
        result = String.fromCharCode(65 + remainder) + result;
        number = Math.floor((number - 1) / 26);
    }
    return result;
}

export async function updateSheetCells(env, updates) {
    if (!Array.isArray(updates) || !updates.length) return { updatedCells: 0 };
    const { spreadsheetId, tabName } = getSheetConfig(env);
    const quotedTab = "'" + tabName.replace(/'/g, "''") + "'";
    const data = updates.map((item) => ({
        range: quotedTab + "!" + item.column + item.rowNumber,
        values: [[item.value]]
    }));
    const payload = await sheetsRequest(
        env,
        encodeURIComponent(spreadsheetId) + "/values:batchUpdate",
        {
            method: "POST",
            body: JSON.stringify({ valueInputOption: "RAW", data })
        }
    );
    return { updatedCells: Number(payload.totalUpdatedCells) || updates.length };
}

export function buildCatalogFromSheet(sheet) {
    const get = (row, aliases) => {
        for (const alias of aliases) {
            const key = normalizeSheetHeader(alias);
            if (Object.prototype.hasOwnProperty.call(row, key)) return String(row[key] ?? "").trim();
        }
        return "";
    };
    const slugify = (value) => String(value || "").trim().toLowerCase()
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

    let currentGame = "";
    let currentYear = "";
    const games = new Map();
    const platforms = new Map();

    for (const item of sheet.rows) {
        const row = item.object;
        const gameName = get(row, ["GAME", "GAME NAME", "NAME", "JUEGO"]);
        const year = get(row, ["YEAR", "ANO", "AÑO"]);
        if (gameName) currentGame = gameName;
        if (year) currentYear = year;
        if (!currentGame) continue;

        const platform = get(row, ["PLATFORM", "PLATAFORM", "PLATAFORMA"]);
        const project = get(row, ["PROJECT", "PROYECTO"]);
        const portIdRaw = get(row, ["PORTS_ID", "PORT ID", "PORT_ID"]);
        const gameSlug = slugify(currentGame);
        const portId = /^unofficial-port(?:-\d+)?$/i.test(portIdRaw)
            ? gameSlug + "-" + portIdRaw.toLowerCase()
            : (portIdRaw || gameSlug + "-row-" + item.rowNumber);
        const link = get(row, ["LINK", "PROJECT LINK", "ENLACE"]);
        const url = get(row, ["URL", "PORT URL", "PORT LINK"]);
        const developer = get(row, ["DEVELOPER", "DEVELOPER/PUBLISHER", "DESARROLLADOR"]);
        const version = get(row, ["VERSION", "VERSIÓN"]);
        const lastUpdate = get(row, ["LAST UPDATE", "LAST UPDATED", "ÚLTIMA ACTUALIZACIÓN"]);
        const dateAdded = get(row, ["DATE ADDED"]);
        const needsFiles = get(row, ["NEEDS GAME FILES?", "NEEDS GAME FILES", "GAME FILES", "NECESITA ARCHIVOS"]);
        const dataUrl = get(row, ["DATA URL", "DATA LINK", "GAME FILES URL"]);
        const notes = get(row, ["NOTES", "NOTE", "NOTAS"]);
        const works = get(row, ["WORKS?", "WORKS", "FUNCIONA"]);
        const controller = get(row, ["CONTROLLER SUPPORT", "CONTROLLER", "GAMEPAD", "MANDO"]);
        const genre = get(row, ["GENRE", "GÉNERO", "GENERO"]);
        const description = get(row, ["DESCRIPTION", "DESCRIPCIÓN", "DESCRIPCION"]);
        const coverUrl = get(row, ["COVER_URL", "COVER URL", "COVER", "COVER IMAGE", "IMAGE URL", "PORTADA"]);
        const launchboxUrl = get(row, ["LAUNCHBOX_URL", "LAUNCHBOX URL"]);
        const hasPortData = [platform, project, link, url, developer, version, lastUpdate, dateAdded, needsFiles, dataUrl, notes, works, controller]
            .some((value) => String(value || "").trim() !== "");
        if (!hasPortData) continue;

        if (!games.has(gameSlug)) {
            games.set(gameSlug, {
                slug: gameSlug, name: currentGame, year: currentYear || "", genre: genre || "",
                description: description || "", coverUrl: coverUrl || "", launchboxUrl: launchboxUrl || "",
                platforms: [], ports: []
            });
        }
        const game = games.get(gameSlug);
        if (!game.year && currentYear) game.year = currentYear;
        if (!game.genre && genre) game.genre = genre;
        if (!game.description && description) game.description = description;
        if (!game.coverUrl && coverUrl) game.coverUrl = coverUrl;
        if (!game.launchboxUrl && launchboxUrl) game.launchboxUrl = launchboxUrl;

        if (platform && !platforms.has(platform.toLowerCase()) &&
            !["multi-game apps", "multi game apps"].includes(platform.toLowerCase().replace(/\s+/g, " "))) {
            platforms.set(platform.toLowerCase(), platform);
        }
        if (platform && !game.platforms.includes(platform)) game.platforms.push(platform);

        game.ports.push({
            portId, game: currentGame, year: currentYear || "",
            platform, project, link, url, dataUrl, developer, version,
            controller, files: needsFiles, works, lastUpdate, dateAdded, notes
        });
    }

    return {
        success: true,
        platforms: Array.from(platforms.values()),
        games: Array.from(games.values())
    };
}

export async function writeSheetValues(env, range, values, options = {}) {
    const { spreadsheetId } = getSheetConfig(env);
    return sheetsRequest(
        env,
        encodeURIComponent(spreadsheetId) + "/values/" + encodeURIComponent(range) +
            (options.append ? ":append?valueInputOption=RAW&insertDataOption=INSERT_ROWS" : "?valueInputOption=RAW"),
        {
            method: options.append ? "POST" : "PUT",
            body: JSON.stringify({ majorDimension: "ROWS", values })
        }
    );
}

export async function deleteSheetRow(env, rowNumber) {
    const { spreadsheetId, tabName } = getSheetConfig(env);
    const metadata = await sheetsRequest(env, encodeURIComponent(spreadsheetId) + "?fields=sheets.properties");
    const sheet = (metadata.sheets || []).find((item) => item.properties?.title === tabName);
    if (!sheet) throw new Error("Google Sheet tab not found: " + tabName);
    const index = Number(rowNumber) - 1;
    if (!Number.isInteger(index) || index < 1) throw new Error("Invalid sheet row number.");
    return sheetsRequest(env, encodeURIComponent(spreadsheetId) + ":batchUpdate", {
        method: "POST",
        body: JSON.stringify({
            requests: [{ deleteDimension: { range: {
                sheetId: sheet.properties.sheetId,
                dimension: "ROWS",
                startIndex: index,
                endIndex: index + 1
            } } }]
        })
    });
}
