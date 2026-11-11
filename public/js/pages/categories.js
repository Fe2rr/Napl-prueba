/*
 * NAPL — CATEGORY VIEW & FILTERING
 */

import { normalizeText, getLatestUpdate } from "../core/helpers.js";
import {
    ensureAllTimePopular,
    getAllTimeVisits,
} from "../services/popularity.js";
import {
    createHomeGameCard,
    getRepresentativePort,
} from "../components/game-card.js";
import {
    isDualScreen,
    getMultiGameApps,
    sortMultiGameApps,
    createGamesUsingAppSection,
} from "../components/multi-game-apps.js";

export function createCategoryController(state) {
    const gameList = document.getElementById("game-list");
    const statusElement = document.getElementById("status");
    const categoryControls = document.getElementById("category-controls");
    const categorySearchInput = document.getElementById("category-search");
    const categorySortOptions = document.querySelectorAll(".category-sort-option");
    const categorySortDirection = document.getElementById("category-sort-direction");
    const homeTabsNav = document.getElementById("home-tabs");

    function updateCategorySortDirection() {
        if (!categorySortDirection) return;
        categorySortDirection.textContent = state.categorySortDescending ? "↑" : "↓";
    }

    function showHomeSections(activeHomeSectionFn) {
        if (categoryControls) categoryControls.hidden = true;
        if (homeTabsNav) homeTabsNav.hidden = false;
        activeHomeSectionFn?.();
    }

    function showCategoryView() {
        document.querySelectorAll(".home-section").forEach((section) => {
            section.hidden = true;
        });
        if (categoryControls) categoryControls.hidden = false;
        if (homeTabsNav) homeTabsNav.hidden = true;
    }

    function resetCategoryControls() {
        if (categorySearchInput) categorySearchInput.value = "";
        state.selectedCategorySort = "updated";
        state.categorySortDescending = false;

        categorySortOptions.forEach((option) => {
            option.classList.toggle(
                "active",
                option.dataset.sort === state.selectedCategorySort
            );
        });

        updateCategorySortDirection();
    }

    function sortGames(list) {
        const sorted = [...list];

        switch (state.selectedCategorySort) {
            case "updated":
                sorted.sort((a, b) => {
                    const dateA = getLatestUpdate(a);
                    const dateB = getLatestUpdate(b);
                    if (!dateA && !dateB) return 0;
                    if (!dateA) return 1;
                    if (!dateB) return -1;
                    const res = dateB - dateA;
                    return state.categorySortDescending ? -res : res;
                });
                break;

            case "name":
                sorted.sort((a, b) => {
                    const res = a.name.localeCompare(b.name, "en", {
                        sensitivity: "base",
                    });
                    return state.categorySortDescending ? -res : res;
                });
                break;

            case "popular":
                sorted.sort((a, b) => {
                    const visitsA = getAllTimeVisits(a.slug);
                    const visitsB = getAllTimeVisits(b.slug);
                    const res = visitsB - visitsA;
                    if (res !== 0) {
                        return state.categorySortDescending ? -res : res;
                    }
                    return a.name.localeCompare(b.name, "en", {
                        sensitivity: "base",
                    });
                });
                break;
        }

        return sorted;
    }

    function displayGames(list) {
        if (!gameList || !statusElement) return;
        gameList.hidden = false;
        gameList.replaceChildren();

        if (!Array.isArray(list) || list.length === 0) {
            const message = document.createElement("div");
            message.className = "no-results";
            message.textContent = "No games found.";
            gameList.appendChild(message);
            statusElement.textContent = "0 games";
            return;
        }

        statusElement.textContent = `${list.length} game${
            list.length !== 1 ? "s" : ""
        }`;

        const fragment = document.createDocumentFragment();
        for (const game of list) {
            const port = getRepresentativePort(game);
            fragment.appendChild(createHomeGameCard(game, port));
        }

        gameList.appendChild(fragment);
    }

    function displayMultiGameApps(list) {
        if (!gameList || !statusElement) return;
        gameList.hidden = false;
        gameList.replaceChildren();

        const apps = Array.isArray(list) ? list : [];

        if (apps.length === 0) {
            const message = document.createElement("div");
            message.className = "no-results";
            message.textContent = "No Multi-game Apps found.";
            gameList.appendChild(message);
            statusElement.textContent = "0 Multi-game Apps";
            return;
        }

        statusElement.textContent = `${apps.length} Multi-game App${
            apps.length !== 1 ? "s" : ""
        }`;

        const fragment = document.createDocumentFragment();
        for (const app of apps) {
            const element = document.createElement("div");
            element.className = "game";

            const name = document.createElement("h2");
            name.className = "game-name";
            name.textContent = app.name;

            const info = document.createElement("div");
            info.className = "game-info";

            const count = document.createElement("span");
            count.textContent = `${app.gameCount} game${
                app.gameCount !== 1 ? "s" : ""
            }`;
            info.appendChild(count);

            element.append(
                name,
                info,
                createGamesUsingAppSection("You can also play:", app.games)
            );
            fragment.appendChild(element);
        }

        gameList.appendChild(fragment);
    }

    function filterAndSortByQuery(items, getName, query) {
        return items
            .filter((item) => normalizeText(getName(item)).includes(query))
            .sort((a, b) => {
                const nameA = normalizeText(getName(a));
                const nameB = normalizeText(getName(b));
                const startsA = nameA.startsWith(query);
                const startsB = nameB.startsWith(query);
                if (startsA !== startsB) return startsA ? -1 : 1;
                return nameA.localeCompare(nameB, "en", { sensitivity: "base" });
            });
    }

    function displayFilteredGames() {
        const query = normalizeText(categorySearchInput?.value || "");

        if (state.selectedCategory === "multi-game-apps") {
            const renderApps = () => {
                const apps = getMultiGameApps(state.games);
                if (query) {
                    displayMultiGameApps(
                        filterAndSortByQuery(apps, (a) => a.name, query)
                    );
                } else {
                    displayMultiGameApps(
                        sortMultiGameApps(
                            apps,
                            state.selectedCategorySort,
                            state.categorySortDescending
                        )
                    );
                }
            };

            if (!query && state.selectedCategorySort === "popular") {
                ensureAllTimePopular().then(renderApps);
                return;
            }

            renderApps();
            return;
        }

        const filtered = state.games.filter((game) => {
            if (state.selectedCategory === "dual-screen" && !isDualScreen(game)) {
                return false;
            }

            if (
                state.selectedPlatform &&
                !game.platforms.some(
                    (platform) =>
                        normalizeText(platform) ===
                        normalizeText(state.selectedPlatform)
                )
            ) {
                return false;
            }

            if (!query) return true;
            return normalizeText(game.name).includes(query);
        });

        const sortedByQuery = query
            ? filterAndSortByQuery(filtered, (g) => g.name, query)
            : null;

        if (!query && state.selectedCategorySort === "popular") {
            ensureAllTimePopular().then(() => {
                displayGames(sortGames(filtered));
            });
            return;
        }

        displayGames(query ? sortedByQuery : sortGames(filtered));
    }

    categorySearchInput?.addEventListener("input", displayFilteredGames);

    categorySortOptions.forEach((option) => {
        option.addEventListener("click", () => {
            const newSort = option.dataset.sort;
            if (state.selectedCategorySort === newSort) return;

            state.selectedCategorySort = newSort;
            state.categorySortDescending = false;

            categorySortOptions.forEach((other) => {
                other.classList.toggle(
                    "active",
                    other.dataset.sort === state.selectedCategorySort
                );
            });

            updateCategorySortDirection();
            displayFilteredGames();
        });
    });

    categorySortDirection?.addEventListener("click", () => {
        state.categorySortDescending = !state.categorySortDescending;
        updateCategorySortDirection();
        displayFilteredGames();
    });

    updateCategorySortDirection();

    return {
        showHomeSections,
        showCategoryView,
        resetCategoryControls,
        displayFilteredGames,
    };
}
