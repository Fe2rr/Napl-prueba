/*
 * NAPL — HOME PAGE CONTROLLER
 */

import {
    createSlug,
    parseLastUpdate,
    parseDateAdded,
    getLatestUpdate,
    getDateAdded,
    getPortForDate,
} from "../core/helpers.js";
import { loadCatalog } from "../core/data.js";
import { fetchPopularPeriod } from "../services/popularity.js";
import { initNavigation } from "../components/navigation.js";
import { initSearch } from "../components/search.js";
import { initThemeToggle } from "../components/theme.js";
import {
    createHomeGameCard,
    getRepresentativePort,
} from "../components/game-card.js";
import {
    renderErrorBox,
    renderListSkeletons,
} from "../components/loading.js";
import { createCategoryController } from "./categories.js";

initThemeToggle();

const state = {
    games: [],
    platformOrder: [],
    currentView: "home",
    selectedPlatform: "",
    selectedCategory: "",
    selectedCategorySort: "updated",
    categorySortDescending: false,
    activeHomeTab: "last-added",
    showingAllLastAdded: false,
    showingAllLastUpdated: false,
    showingAllPopular: false,
    selectedPopularPeriod: "week",
};

const gameList = document.getElementById("game-list");
const statusElement = document.getElementById("status");

const lastAddedList = document.getElementById("last-added-list");
const lastAddedMore = document.getElementById("last-added-more");
const lastAddedSection = document.getElementById("last-added-section");

const lastUpdatedList = document.getElementById("last-updated-list");
const lastUpdatedMore = document.getElementById("last-updated-more");
const lastUpdatedSection = document.getElementById("last-updated-section");

const popularList = document.getElementById("popular-list");
const popularMore = document.getElementById("popular-more");
const popularSection = document.getElementById("popular-section");
const popularTabs = document.querySelectorAll(".popular-tab");

const homeTabs = document.querySelectorAll(".home-tab");
const homeSections = {
    "last-added": lastAddedSection,
    popular: popularSection,
    "last-updated": lastUpdatedSection,
};

function showHomeSection(sectionName = state.activeHomeTab) {
    const selectedSection = homeSections[sectionName];
    if (!selectedSection) return;

    state.activeHomeTab = sectionName;

    Object.entries(homeSections).forEach(([name, section]) => {
        if (section) section.hidden = name !== sectionName;
    });

    homeTabs.forEach((tab) => {
        const isActive = tab.dataset.section === sectionName;
        tab.classList.toggle("active", isActive);
        tab.setAttribute("aria-selected", String(isActive));
        tab.tabIndex = isActive ? 0 : -1;
    });
}

function displayLastAdded() {
    if (!lastAddedList || !lastAddedMore) return;

    const sortedGames = state.games
        .map((game) => ({
            game,
            dateAdded: getDateAdded(game),
            port: getPortForDate(game, "dateAdded", parseDateAdded),
        }))
        .filter((item) => item.dateAdded !== null)
        .sort((a, b) => b.dateAdded - a.dateAdded);

    lastAddedList.replaceChildren();

    if (sortedGames.length === 0) {
        lastAddedMore.hidden = true;
        return;
    }

    const visibleGames = state.showingAllLastAdded
        ? sortedGames
        : sortedGames.slice(0, 10);

    const fragment = document.createDocumentFragment();
    for (const item of visibleGames) {
        fragment.appendChild(createHomeGameCard(item.game, item.port, { returnUrl: "index.html?view=last-added" }));
    }

    lastAddedList.appendChild(fragment);
    lastAddedMore.hidden = !(
        sortedGames.length > 10 && !state.showingAllLastAdded
    );
}

function displayLastUpdated() {
    if (!lastUpdatedList || !lastUpdatedMore) return;

    const sortedGames = state.games
        .map((game) => ({
            game,
            lastUpdate: getLatestUpdate(game),
            port: getPortForDate(game, "lastUpdate", parseLastUpdate),
        }))
        .filter((item) => item.lastUpdate !== null)
        .sort((a, b) => b.lastUpdate - a.lastUpdate);

    lastUpdatedList.replaceChildren();

    if (sortedGames.length === 0) {
        lastUpdatedMore.hidden = true;
        return;
    }

    const visibleGames = state.showingAllLastUpdated
        ? sortedGames
        : sortedGames.slice(0, 10);

    const fragment = document.createDocumentFragment();
    for (const item of visibleGames) {
        fragment.appendChild(createHomeGameCard(item.game, item.port, { returnUrl: "index.html?view=last-updated" }));
    }

    lastUpdatedList.appendChild(fragment);
    lastUpdatedMore.hidden = !(
        sortedGames.length > 10 && !state.showingAllLastUpdated
    );
}

function displayPopular(ranking) {
    if (!popularList || !popularMore) return;
    popularList.replaceChildren();

    if (ranking.length === 0) {
        popularList.innerHTML = `<div class="no-results">No popular games found.</div>`;
        popularMore.hidden = true;
        return;
    }

    const visibleGames = state.showingAllPopular
        ? ranking
        : ranking.slice(0, 10);

    const fragment = document.createDocumentFragment();
    for (let i = 0; i < visibleGames.length; i++) {
        const item = visibleGames[i];
        fragment.appendChild(
            createHomeGameCard(item.game, item.port, {
                rank: i + 1,
                showPort: false,
                returnUrl: `index.html?view=popular&period=${encodeURIComponent(state.selectedPopularPeriod)}`,
            })
        );
    }

    popularList.appendChild(fragment);
    popularMore.hidden = !(ranking.length > 10 && !state.showingAllPopular);
}

async function loadPopular(period = state.selectedPopularPeriod) {
    if (!popularList) return;
    renderListSkeletons(popularList, 6);

    try {
        const rawGames = await fetchPopularPeriod(period);
        const gameMap = new Map(state.games.map((g) => [g.slug, g]));

        const ranking = rawGames
            .map((item) => {
                // Prefer the API slug when available; fall back to the game name.
                const apiSlug = createSlug(item.slug || "");
                const gameSlug = createSlug(item.game || "");
                const game = gameMap.get(apiSlug) || gameMap.get(gameSlug);
                if (!game) return null;
                return {
                    game,
                    visits: Number(item.visits) || 0,
                    port: getRepresentativePort(game),
                };
            })
            .filter((item) => item !== null);

        displayPopular(ranking);
    } catch (error) {
        console.error("Could not load popular games:", error);
        popularList.innerHTML = `<div class="error">Could not load popular games.</div>`;
        if (popularMore) popularMore.hidden = true;
    }
}

const categoryController = createCategoryController(state);

const searchController = initSearch({
    onCloseFallback: () => {
        if (state.currentView === "category") {
            categoryController.displayFilteredGames();
        } else {
            if (gameList) {
                gameList.replaceChildren();
                gameList.hidden = true;
            }
            if (statusElement) statusElement.textContent = "";
        }
    },
});

function openCategory(category) {
    state.currentView = "category";
    state.selectedPlatform = "";
    state.selectedCategory = category;
    categoryController.resetCategoryControls();
    categoryController.showCategoryView();
    if (gameList) gameList.hidden = false;
    categoryController.displayFilteredGames();
}

function openPlatform(platform) {
    state.currentView = "category";
    state.selectedPlatform = platform;
    state.selectedCategory = "";
    categoryController.resetCategoryControls();
    categoryController.showCategoryView();
    if (gameList) gameList.hidden = false;
    categoryController.displayFilteredGames();
}

function goHome() {
    state.currentView = "home";
    state.selectedPlatform = "";
    state.selectedCategory = "";
    categoryController.resetCategoryControls();
    if (gameList) {
        gameList.replaceChildren();
        gameList.hidden = true;
    }
    if (statusElement) statusElement.textContent = "";
    categoryController.showHomeSections(() => showHomeSection(state.activeHomeTab));
}

const navController = initNavigation({
    mode: "home",
    onGoHome: goHome,
    onSelectAllGames: () => openCategory("all-games"),
    onSelectCategory: openCategory,
    onSelectPlatform: openPlatform,
    onBeforeOpenMenu: () => searchController.closeSearch(false),
    onActionResetSearch: () => searchController.resetSearchBar(),
});

function applyInitialRouteFromUrl() {
    const params = new URLSearchParams(window.location.search);
    const platform = params.get("platform");
    const category = params.get("category");
    const view = params.get("view");

    if (!platform && !category && !view) return;

    searchController.resetSearchBar();

    if (view === "all-games") {
        openCategory("all-games");
        return;
    }

    if (view === "last-added" || view === "last-updated" || view === "popular") {
        showHomeSection(view);
        if (view === "popular" && params.get("period")) {
            state.selectedPopularPeriod = params.get("period");
            popularTabs.forEach((tab) => {
                const active = tab.dataset.period === state.selectedPopularPeriod;
                tab.classList.toggle("active", active);
                tab.setAttribute("aria-pressed", String(active));
            });
            loadPopular(state.selectedPopularPeriod);
        }
        return;
    }

    if (category === "multi-game-apps" || category === "dual-screen") {
        openCategory(category);
        return;
    }

    if (platform) {
        openPlatform(platform);
    }
}

async function initHomePage() {
    if (!statusElement || !gameList) return;

    if (lastAddedList) renderListSkeletons(lastAddedList, 6);
    if (lastUpdatedList) renderListSkeletons(lastUpdatedList, 6);
    if (popularList) renderListSkeletons(popularList, 6);

    statusElement.textContent = "";
    gameList.replaceChildren();
    gameList.hidden = true;

    try {
        const catalog = await loadCatalog();
        state.games = catalog.games;
        state.platformOrder = catalog.platformOrder;

        searchController.setGames(state.games);
        navController.renderPlatforms(state.platformOrder, state.games);

        displayLastAdded();
        displayLastUpdated();
        loadPopular();

        statusElement.textContent = "";
        gameList.hidden = true;

        applyInitialRouteFromUrl();
    } catch (error) {
        console.error("NAPL: could not load games.", error);
        statusElement.textContent = "";
        renderErrorBox(
            gameList,
            "Could not load the games.",
            error instanceof Error
                ? error.message
                : "An unexpected error occurred.",
            initHomePage
        );
    }
}

homeTabs.forEach((tab) => {
    tab.addEventListener("click", () => showHomeSection(tab.dataset.section));
});

popularTabs.forEach((tab) => {
    tab.addEventListener("click", () => {
        popularTabs.forEach((other) => {
            other.classList.remove("active");
            other.setAttribute("aria-pressed", "false");
        });
        tab.classList.add("active");
        tab.setAttribute("aria-pressed", "true");
        state.selectedPopularPeriod = tab.dataset.period;
        state.showingAllPopular = false;
        loadPopular(state.selectedPopularPeriod);
    });
});

lastAddedMore?.addEventListener("click", () => {
    state.showingAllLastAdded = true;
    displayLastAdded();
});

popularMore?.addEventListener("click", () => {
    state.showingAllPopular = true;
    loadPopular(state.selectedPopularPeriod);
});

lastUpdatedMore?.addEventListener("click", () => {
    state.showingAllLastUpdated = true;
    displayLastUpdated();
});

showHomeSection("last-added");
initHomePage();
