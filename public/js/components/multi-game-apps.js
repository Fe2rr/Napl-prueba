/*
 * NAPL — MULTI-GAME APPS & DUAL SCREEN COMPONENT
 *
 * Unifies game-apps.js and multi-game-apps.js into a single module.
 */

import {
    normalizeText,
    createSlug,
    parseLastUpdate,
} from "../core/helpers.js";
import { getAllTimeVisits } from "../services/popularity.js";

export function isDualScreen(game) {
    if (!game || !Array.isArray(game.ports)) {
        return false;
    }

    return game.ports.some((port) => {
        const project = normalizeText(port?.project);
        const platform = normalizeText(port?.platform);

        return (
            project.includes("dual screen") ||
            platform.includes("dual screen")
        );
    });
}

export function isMultiGameApp(game) {
    if (!game || !Array.isArray(game.ports)) {
        return false;
    }

    return game.ports.some(
        (port) => normalizeText(port?.platform) === "multi-game apps"
    );
}

export function isMultiGameAppPort(port, allRows) {
    if (!port || !port.project || !Array.isArray(allRows)) {
        return false;
    }

    const projectName = normalizeText(port.project);

    return allRows.some((row) => {
        if (!row) return false;

        return (
            normalizeText(row.platform) === "multi-game apps" &&
            normalizeText(row.game) === projectName
        );
    });
}

export function findGamesUsingApp(appName, allRows) {
    const appNameNormalized = normalizeText(appName);

    if (!appNameNormalized || !Array.isArray(allRows)) {
        return [];
    }

    const gamesUsingApp = new Map();

    for (const row of allRows) {
        if (!row || !row.game || !row.project) {
            continue;
        }

        const gameName = String(row.game).trim();
        const projectName = normalizeText(row.project);
        const normalizedGameName = normalizeText(gameName);

        if (normalizedGameName === appNameNormalized) continue;
        if (projectName !== appNameNormalized) continue;

        if (!gamesUsingApp.has(normalizedGameName)) {
            gamesUsingApp.set(normalizedGameName, {
                name: gameName,
                year: String(row.year ?? "").trim(),
            });
        }
    }

    return Array.from(gamesUsingApp.values()).sort((a, b) =>
        a.name.localeCompare(b.name, "en", { sensitivity: "base" })
    );
}

export function getMultiGameApps(games) {
    if (!Array.isArray(games)) {
        return [];
    }

    const projects = new Map();

    for (const game of games) {
        if (!game || !Array.isArray(game.ports)) continue;

        for (const port of game.ports) {
            if (!port) continue;

            const projectName = String(port.project ?? "").trim();
            const normalizedProject = normalizeText(projectName);

            const isMarkedAsApp = [
                "multi-game apps",
                "multi game apps",
            ].includes(normalizeText(port.platform));

            if (
                normalizedProject === "unofficial port" ||
                normalizedProject === "android port"
            ) {
                continue;
            }

            const appName = isMarkedAsApp
                ? String(game.name ?? "").trim()
                : projectName;

            if (!appName) continue;

            const key = normalizeText(appName);

            if (!projects.has(key)) {
                projects.set(key, {
                    name: appName,
                    games: new Map(),
                    latestUpdate: null,
                    visits: 0,
                    explicitlyMarked: false,
                });
            }

            const app = projects.get(key);

            if (isMarkedAsApp) {
                app.explicitlyMarked = true;
            } else if (projectName && game.name) {
                const gameKey = normalizeText(game.name);
                if (!app.games.has(gameKey)) {
                    app.games.set(gameKey, {
                        name: game.name,
                        year: game.year || "",
                    });
                }
            }

            if (port.lastUpdate) {
                const updateDate = parseLastUpdate(port.lastUpdate);
                if (
                    updateDate &&
                    (!app.latestUpdate || updateDate > app.latestUpdate)
                ) {
                    app.latestUpdate = updateDate;
                }
            }
        }
    }

    const result = [];

    for (const app of projects.values()) {
        if (app.games.size <= 1 && !app.explicitlyMarked) {
            continue;
        }

        app.games = Array.from(app.games.values()).sort((a, b) =>
            a.name.localeCompare(b.name, "en", { sensitivity: "base" })
        );

        app.slug = createSlug(app.name);
        app.gameCount = app.games.length;

        let totalVisits = 0;
        for (const compatibleGame of app.games) {
            totalVisits += Number(
                getAllTimeVisits(createSlug(compatibleGame.name))
            );
        }
        app.visits = totalVisits;

        delete app.explicitlyMarked;
        result.push(app);
    }

    return result;
}

export function sortMultiGameApps(list, sortBy, descending) {
    const sorted = Array.isArray(list) ? [...list] : [];

    switch (sortBy) {
        case "updated":
            sorted.sort((a, b) => {
                if (!a.latestUpdate && !b.latestUpdate) return 0;
                if (!a.latestUpdate) return 1;
                if (!b.latestUpdate) return -1;
                const res = b.latestUpdate - a.latestUpdate;
                return descending ? -res : res;
            });
            break;

        case "name":
            sorted.sort((a, b) => {
                const res = a.name.localeCompare(b.name, "en", {
                    sensitivity: "base",
                });
                return descending ? -res : res;
            });
            break;

        case "popular":
            sorted.sort((a, b) => {
                const res =
                    (Number(b.visits) || 0) - (Number(a.visits) || 0);
                if (res !== 0) return descending ? -res : res;
                return a.name.localeCompare(b.name, "en", {
                    sensitivity: "base",
                });
            });
            break;
    }

    return sorted;
}

export function createGamesUsingAppSection(titleText, gamesList) {
    const section = document.createElement("section");
    section.className = "games-using-app";

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "games-using-app-toggle";
    toggle.setAttribute("aria-expanded", "false");

    const title = document.createElement("span");
    title.textContent = titleText;

    const arrow = document.createElement("span");
    arrow.className = "games-using-app-arrow";
    arrow.textContent = "▼";
    arrow.setAttribute("aria-hidden", "true");

    toggle.append(title, arrow);

    const list = document.createElement("div");
    list.className = "games-using-app-list";
    list.hidden = true;

    for (const game of gamesList) {
        const link = document.createElement("a");
        link.className = "games-using-app-item";
        link.href = `game.html?game=${encodeURIComponent(
            createSlug(game.name)
        )}`;
        link.textContent = game.name;

        if (game.year) {
            const year = document.createElement("span");
            year.textContent = ` (${game.year})`;
            link.appendChild(year);
        }

        list.appendChild(link);
    }

    toggle.addEventListener("click", () => {
        const isOpen = toggle.getAttribute("aria-expanded") === "true";
        toggle.setAttribute("aria-expanded", String(!isOpen));
        list.hidden = isOpen;
        arrow.textContent = isOpen ? "▼" : "▲";
    });

    section.append(toggle, list);
    return section;
}
