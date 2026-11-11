/*
 * NAPL — GAME DETAIL PAGE CONTROLLER
 *
 * Uses the shared catalog loader (1 single fetch instead of 2)
 * and shared navigation/search components.
 */

import { createSlug } from "../core/helpers.js";
import { loadCatalog } from "../core/data.js";
import { registerGameVisit } from "../services/visits.js";
import { loadPortRatings, createRatingActions } from "../services/ratings.js";
import {
    loadGameCompatibility,
    createCompatibilityActions,
} from "../services/compatibility.js";
import { initNavigation } from "../components/navigation.js";
import { initSearch } from "../components/search.js";
import { initThemeToggle } from "../components/theme.js";
import { displayGame } from "./game-render.js";

initThemeToggle();
const searchController = initSearch();
const navController = initNavigation({
    mode: "game",
    onBeforeOpenMenu: () => searchController.closeSearch(false),
});

async function loadSelectedGame() {
    const gameHeader = document.getElementById("game-header");
    const portList = document.getElementById("port-list");
    const status = document.getElementById("status");

    if (!gameHeader || !portList || !status) {
        console.error("NAPL: required game page elements are missing.");
        return;
    }

    const params = new URLSearchParams(window.location.search);
    const requestedSlug = params.get("game");

    try {
        const catalog = await loadCatalog();
        searchController.setGames(catalog.games);
        navController.renderPlatforms(catalog.platformOrder, catalog.games);

        if (!requestedSlug) {
            gameHeader.textContent = "No game selected.";
            status.textContent = "Return to the list and select a game.";
            portList.replaceChildren();
            return;
        }

        status.textContent = "Loading ports...";
        portList.replaceChildren();

        const targetSlug = createSlug(requestedSlug);
        const game = catalog.games.find((item) => item.slug === targetSlug);

        if (!game) {
            gameHeader.textContent = "Game not found.";
            status.textContent =
                "This game could not be found in the spreadsheet.";
            portList.replaceChildren();
            return;
        }

        document.title = `${game.name} — NAPL`;
        registerGameVisit(game.name);

        const portIds = game.ports.map((p) => p.portId).filter(Boolean);
        const [ratings, compatibility] = await Promise.all([
            loadPortRatings(),
            loadGameCompatibility(portIds),
        ]);

        displayGame(
            game,
            catalog.allRows,
            ratings,
            createRatingActions(),
            compatibility,
            createCompatibilityActions()
        );
    } catch (error) {
        console.error("NAPL: could not load selected game.", error);
        navController.setPlatformError(
            "Could not load platforms. Please try again later."
        );
        gameHeader.textContent = "Could not load this game.";
        status.textContent =
            error instanceof Error
                ? error.message
                : "An unexpected error occurred.";
        portList.replaceChildren();
    }
}

loadSelectedGame();
