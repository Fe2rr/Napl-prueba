/*
 * NAPL — CATALOG DATA LOADER & NORMALIZER
 *
 * Single unified CSV loader, normalizer and game grouper
 * used by both index.html and game.html (no duplicate fetches).
 */

import {
    normalizeHeader,
    normalizeText,
    normalizePlatformLabel,
    createSlug,
} from "./helpers.js";

let catalogPromise = null;

export function parseCSV(csv) {
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

            if (row.some((value) => value.trim() !== "")) {
                rows.push(row);
            }

            row = [];
            continue;
        }

        field += char;
    }

    if (field.length > 0 || row.length > 0) {
        row.push(field);

        if (row.some((value) => value.trim() !== "")) {
            rows.push(row);
        }
    }

    if (rows.length === 0) {
        return [];
    }

    const headers = rows.shift().map(normalizeHeader);

    return rows.map((values) => {
        const rowObject = {};

        headers.forEach((header, index) => {
            if (header) {
                rowObject[header] = String(values[index] || "").trim();
            }
        });

        return rowObject;
    });
}

export function getColumn(row, possibleNames) {
    for (const name of possibleNames) {
        const normalizedName = normalizeHeader(name);

        if (Object.prototype.hasOwnProperty.call(row, normalizedName)) {
            return String(row[normalizedName] || "").trim();
        }
    }

    return "";
}

export function extractPlatformOrder(rows) {
    const uniquePlatforms = new Map();

    for (const row of rows) {
        const platform = normalizePlatformLabel(
            getColumn(row, ["PLATFORM", "PLATAFORM", "PLATAFORMA"])
        );

        if (!platform) continue;

        const key = normalizeText(platform);
        if (key === "multi-game apps" || key === "multi game apps") {
            continue;
        }

        if (!uniquePlatforms.has(key)) {
            uniquePlatforms.set(key, platform);
        }
    }

    return Array.from(uniquePlatforms.values());
}

export function processRows(rows) {
    let currentGame = "";
    let currentYear = "";
    const result = [];

    for (const row of rows) {
        const gameValue = getColumn(row, ["GAME", "GAME NAME", "NAME", "JUEGO"]);
        const yearValue = getColumn(row, ["YEAR", "ANO", "AÑO"]);
        const platformValue = getColumn(row, ["PLATFORM", "PLATAFORM", "PLATAFORMA"]);
        const projectValue = getColumn(row, ["PROJECT", "PROYECTO"]);

        if (gameValue) currentGame = gameValue;
        if (yearValue) currentYear = yearValue;

        // Match the working V3 behavior: PLATFORM and PROJECT belong only
        // to the current CSV row. Do not inherit values from previous rows.
        const platform = platformValue;
        const project = projectValue;
        const rawPortId = getColumn(row, ["PORTS_ID", "PORT ID", "PORT_ID"]);
        const portId =
            /^unofficial-port(?:-\d+)?$/i.test(rawPortId) && currentGame
                ? `${createSlug(currentGame)}-${rawPortId.toLowerCase()}`
                : rawPortId;
        const link = getColumn(row, ["LINK", "PROJECT LINK", "ENLACE"]);
        const url = getColumn(row, ["URL", "PORT URL", "PORT LINK"]);
        const dataUrl = getColumn(row, ["DATA URL", "DATA LINK", "GAME FILES URL"]);
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
        ].some((value) => String(value || "").trim() !== "");

        if (!currentGame || !hasPortData) {
            continue;
        }

        result.push({
            game: currentGame,
            year: currentYear,
            platform,
            project,
            portId,
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
            coverUrl,
            genre,
            description,
        });
    }

    return result;
}

export function groupGames(rows) {
    const grouped = new Map();

    if (!Array.isArray(rows)) {
        return [];
    }

    for (const port of rows) {
        if (!port || !port.game) continue;

        // V3 groups by normalized game name, not by its URL slug.
        const key = normalizeText(port.game);
        if (!key) continue;

        if (!grouped.has(key)) {
            grouped.set(key, {
                name: port.game,
                year: port.year || "",
                // Keep grouping by normalized name, but use URL-safe slugs for routes.
                slug: createSlug(port.game),
                coverUrl: port.coverUrl || "",
                genre: port.genre || "",
                description: port.description || "",
                ports: [],
                platforms: new Set(),
            });
        }

        const game = grouped.get(key);

        if (!game.year && port.year) game.year = port.year;
        if (!game.coverUrl && port.coverUrl) game.coverUrl = port.coverUrl;
        if (!game.genre && port.genre) game.genre = port.genre;
        if (!game.description && port.description) {
            game.description = port.description;
        }

        if (port.platform) {
            game.platforms.add(port.platform);
        }

        game.ports.push(port);
    }

    return Array.from(grouped.values()).map((game) => ({
        ...game,
        platforms: Array.from(game.platforms),
    }));
}

export async function loadCatalog(force = false) {
    if (catalogPromise && !force) {
        return catalogPromise;
    }

    catalogPromise = (async () => {
        const sheetUrl =
            "https://docs.google.com/spreadsheets/d/1CO7dH7mbj9sl67g4e94wczHESp0NAsOa7_chKKii9OA/export?format=csv";

        const response = await fetch(sheetUrl, {
            method: "GET",
            cache: "no-store",
        });

        if (!response.ok) {
            throw new Error(`Google Sheets returned HTTP ${response.status}.`);
        }

        const csv = await response.text();
        const rows = parseCSV(csv);

        if (!rows.length) {
            throw new Error("Google Sheets returned an empty catalog.");
        }

        const allRows = processRows(rows);
        if (!allRows.length) {
            throw new Error(
                "The Community Ports sheet was read, but no valid ports were found."
            );
        }

        const games = groupGames(allRows);
        const platformOrder = extractPlatformOrder(rows);

        // Temporary diagnostics: inspect where catalog entries may be lost.
        const countBy = (items, getValue) => {
            const counts = new Map();
            for (const item of items) {
                const value = String(getValue(item) || "").trim();
                if (!value) continue;
                counts.set(value, (counts.get(value) || 0) + 1);
            }
            return Object.fromEntries(
                [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]))
            );
        };

        const dualScreenPorts = allRows.filter((port) =>
            normalizeText(port.project).includes("dual screen")
        );

        console.groupCollapsed("[NAPL] Catalog diagnostics");
        console.log("CSV characters:", csv.length);
        console.log("Parsed CSV rows:", rows.length);
        console.log("Processed port rows:", allRows.length);
        console.log("Grouped games:", games.length);
        console.log("Rows discarded during processing:", rows.length - allRows.length);
        console.log("Platforms in raw CSV:", countBy(rows, (row) =>
            getColumn(row, ["PLATFORM", "PLATAFORM", "PLATAFORMA"])
        ));
        console.log("Platforms in processed ports:", countBy(allRows, (port) => port.platform));
        console.log("Dual Screen ports:", dualScreenPorts.length);
        console.log("Games with Dual Screen:", new Set(dualScreenPorts.map((port) =>
            normalizeText(port.game)
        )).size);
        console.log("Dual Screen project examples:", dualScreenPorts.slice(0, 10).map((port) => ({
            game: port.game,
            platform: port.platform,
            project: port.project
        })));
        console.groupEnd();

        if (!games.length) {
            throw new Error("The Community Ports sheet contains no games.");
        }

        return {
            games,
            platformOrder,
            allRows,
        };
    })().catch((err) => {
        catalogPromise = null;
        throw err;
    });

    return catalogPromise;
}
