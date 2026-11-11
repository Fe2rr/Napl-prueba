/*
 * NAPL — CATALOG DATA LOADER & NORMALIZER
 *
 * Single unified CSV loader, normalizer and game grouper
 * used by both index.html and game.html (no duplicate fetches).
 */

import { CATALOG_API_BASE } from "./config.js";
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

        if (gameValue) currentGame = gameValue;
        if (yearValue) currentYear = yearValue;

        const platform = getColumn(row, ["PLATFORM", "PLATAFORM", "PLATAFORMA"]);
        const project = getColumn(row, ["PROJECT", "PROYECTO"]);
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

        const key = createSlug(port.game);
        if (!key) continue;

        if (!grouped.has(key)) {
            grouped.set(key, {
                name: port.game,
                year: port.year || "",
                slug: key,
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
        if (!CATALOG_API_BASE) {
            throw new Error("The NAPL catalog API is not configured.");
        }

        const response = await fetch(`${CATALOG_API_BASE}/catalog`, {
            method: "GET",
            cache: "default",
        });

        if (!response.ok) {
            throw new Error(`Catalog API returned HTTP ${response.status}.`);
        }

        const data = await response.json();
        if (
            !data?.success ||
            !Array.isArray(data.games) ||
            !Array.isArray(data.platforms)
        ) {
            throw new Error("Catalog API returned an invalid response.");
        }

        const games = data.games.map((game) => ({
            ...game,
            ports: Array.isArray(game.ports) ? game.ports : [],
            platforms: Array.isArray(game.platforms) ? game.platforms : [],
        }));

        const allRows = [];
        for (const game of games) {
            for (const port of game.ports) {
                allRows.push({
                    ...port,
                    game: port.game || game.name,
                    year: port.year || game.year || "",
                    coverUrl: game.coverUrl || "",
                    genre: game.genre || "",
                    description: game.description || "",
                });
            }
        }

        if (!games.length) {
            throw new Error("The catalog API returned no games.");
        }

        return {
            games,
            platformOrder: data.platforms,
            allRows,
        };
    })().catch((err) => {
        catalogPromise = null;
        throw err;
    });

    return catalogPromise;
}
