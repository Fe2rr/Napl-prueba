/*
 * NAPL — GLOBAL SEARCH COMPONENT
 *
 * Shared between index.html and game.html.
 */

import { normalizeText } from "../core/helpers.js";

export function initSearch(options = {}) {
    const { onCloseFallback = null } = options;

    let games = [];

    const searchButton = document.getElementById("search-button");
    const searchContainer = document.getElementById("search-container");
    const searchInput = document.getElementById("search");
    const searchResults = document.getElementById("search-results");

    function resetSearchBar() {
        if (searchInput) searchInput.value = "";
        if (searchResults) {
            searchResults.replaceChildren();
            searchResults.hidden = true;
        }
        searchContainer?.setAttribute("hidden", "");
        searchButton?.setAttribute("aria-expanded", "false");
    }

    function closeSearch(triggerCallback = true) {
        if (!searchContainer || searchContainer.hasAttribute("hidden")) {
            return;
        }

        resetSearchBar();

        if (triggerCallback && onCloseFallback) {
            onCloseFallback();
        }
    }

    function openSearch() {
        if (!searchContainer) return;
        searchContainer.removeAttribute("hidden");
        searchButton?.setAttribute("aria-expanded", "true");
        searchInput?.focus();
    }

    function toggleSearch() {
        if (!searchContainer) return;
        if (searchContainer.hasAttribute("hidden")) {
            openSearch();
        } else {
            closeSearch();
        }
    }

    function renderSuggestions() {
        if (!searchInput || !searchResults) return;

        const query = normalizeText(searchInput.value);
        searchResults.replaceChildren();

        if (!query) {
            searchResults.hidden = true;
            return;
        }

        const matches = games
            .filter((game) => normalizeText(game.name).includes(query))
            .sort((a, b) => {
                const nameA = normalizeText(a.name);
                const nameB = normalizeText(b.name);
                const startsA = nameA.startsWith(query);
                const startsB = nameB.startsWith(query);

                if (startsA !== startsB) return startsA ? -1 : 1;
                return nameA.localeCompare(nameB, "en", { sensitivity: "base" });
            })
            .slice(0, 5);

        if (matches.length === 0) {
            searchResults.hidden = true;
            return;
        }

        const fragment = document.createDocumentFragment();
        for (const game of matches) {
            const link = document.createElement("a");
            link.className = "search-result";
            link.setAttribute("role", "listitem");
            link.href = `game.html?game=${encodeURIComponent(game.slug)}`;
            link.textContent = game.name;
            fragment.appendChild(link);
        }

        searchResults.appendChild(fragment);
        searchResults.hidden = false;
    }

    searchButton?.addEventListener("click", (event) => {
        event.stopPropagation();
        toggleSearch();
    });

    searchInput?.addEventListener("input", renderSuggestions);

    document.addEventListener("click", (event) => {
        if (!searchContainer || searchContainer.hasAttribute("hidden")) return;
        const clickedInside = searchContainer.contains(event.target);
        const clickedBtn = searchButton?.contains(event.target);
        if (!clickedInside && !clickedBtn) {
            closeSearch();
        }
    });

    window.addEventListener("scroll", () => closeSearch(), { passive: true });

    document.addEventListener("keydown", (event) => {
        if (
            event.key === "Escape" &&
            searchContainer &&
            !searchContainer.hasAttribute("hidden")
        ) {
            closeSearch();
            searchButton?.focus();
        }
    });

    return {
        setGames(loadedGames) {
            games = Array.isArray(loadedGames) ? loadedGames : [];
        },
        closeSearch,
        resetSearchBar,
    };
}
