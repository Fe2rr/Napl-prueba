/*
 * NAPL — SIDE MENU & PAGE NAVIGATION COMPONENT
 *
 * Shared between index.html and game.html.
 */

import { normalizeText, normalizePlatformLabel } from "../core/helpers.js";

export function getPlatformGroup(platform) {
    const normalized = normalizeText(platform);

    if (normalized === "others" || normalized === "other") {
        return "Others";
    }

    if (normalized.includes("playstation")) {
        return "PlayStation";
    }

    if (normalized.startsWith("xbox")) {
        return "Xbox";
    }

    if (
        normalized.includes("nintendo") ||
        normalized.includes("game boy") ||
        normalized.includes("gameboy") ||
        normalized.includes("gamecube") ||
        normalized === "nes"
    ) {
        return "Nintendo";
    }

    return "Others";
}

function getUniquePlatforms(platformOrder, games) {
    const unique = new Map();

    const source =
        Array.isArray(platformOrder) && platformOrder.length > 0
            ? platformOrder
            : (games || []).flatMap((g) => g.platforms || []);

    for (const raw of source) {
        const platform = normalizePlatformLabel(raw);
        if (!platform) continue;

        const key = normalizeText(platform);
        if (key === "multi-game apps" || key === "multi game apps") continue;

        if (!unique.has(key)) {
            unique.set(key, platform);
        }
    }

    return Array.from(unique.values());
}

export function initNavigation(options = {}) {
    const {
        mode = "home",
        onGoHome = null,
        onSelectAllGames = null,
        onSelectCategory = null,
        onSelectPlatform = null,
        onBeforeOpenMenu = null,
        onActionResetSearch = null,
    } = options;

    const menuButton = document.getElementById("menu-button");
    const menuClose = document.getElementById("menu-close");
    const sideMenu = document.getElementById("side-menu");
    const menuOverlay = document.getElementById("menu-overlay");
    const platformList = document.getElementById("platform-list");
    const allGamesButton = document.getElementById("all-games-button");

    const homeButton = document.getElementById("home-button");
    const backButton = document.getElementById("back-button");

    function openMenu() {
        onBeforeOpenMenu?.();
        sideMenu?.classList.add("open");
        menuOverlay?.classList.add("visible");
        sideMenu?.setAttribute("aria-hidden", "false");
        menuOverlay?.setAttribute("aria-hidden", "false");
        menuButton?.setAttribute("aria-expanded", "true");
        menuClose?.focus();
    }

    function closeMenu() {
        sideMenu?.classList.remove("open");
        menuOverlay?.classList.remove("visible");
        sideMenu?.setAttribute("aria-hidden", "true");
        menuOverlay?.setAttribute("aria-hidden", "true");
        menuButton?.setAttribute("aria-expanded", "false");
    }

    function addMenuSeparator(title) {
        if (!platformList) return;
        const separator = document.createElement("div");
        separator.className = "menu-separator";
        separator.textContent = `── ${title} ──`;
        platformList.appendChild(separator);
    }

    function addMenuItem(label, href, onClick) {
        if (!platformList) return;

        if (mode === "game") {
            const link = document.createElement("a");
            link.className = "platform-button";
            link.href = href;
            link.textContent = label;
            link.addEventListener("click", closeMenu);
            platformList.appendChild(link);
            return;
        }

        const button = document.createElement("button");
        button.type = "button";
        button.className = "platform-button";
        button.textContent = label;
        button.addEventListener("click", () => {
            onActionResetSearch?.();
            onClick?.();
            closeMenu();
        });
        platformList.appendChild(button);
    }

    function renderPlatforms(platformOrder, loadedGames) {
        if (!platformList) return;

        platformList.replaceChildren();

        addMenuItem(
            "Multi-Game Apps",
            "index.html?category=multi-game-apps",
            () => onSelectCategory?.("multi-game-apps")
        );

        addMenuItem(
            "Dual Screen",
            "index.html?category=dual-screen",
            () => onSelectCategory?.("dual-screen")
        );

        const platforms = getUniquePlatforms(platformOrder, loadedGames);
        const groupOrder = ["Nintendo", "PlayStation", "Xbox", "Others"];
        const grouped = new Map(groupOrder.map((group) => [group, []]));

        for (const platform of platforms) {
            const group = getPlatformGroup(platform);
            if (!grouped.has(group)) {
                grouped.set(group, []);
                groupOrder.push(group);
            }
            grouped.get(group).push(platform);
        }

        for (const group of groupOrder) {
            const entries = grouped.get(group);
            if (!entries || entries.length === 0) continue;

            addMenuSeparator(group);

            for (const platform of entries) {
                addMenuItem(
                    platform,
                    `index.html?platform=${encodeURIComponent(platform)}`,
                    () => onSelectPlatform?.(platform)
                );
            }
        }

        if (platforms.length === 0) {
            const msg = document.createElement("div");
            msg.className = "menu-separator";
            msg.textContent = "No platforms available";
            platformList.appendChild(msg);
        }
    }

    menuButton?.addEventListener("click", () => {
        if (sideMenu?.classList.contains("open")) {
            closeMenu();
        } else {
            openMenu();
        }
    });

    menuClose?.addEventListener("click", closeMenu);
    menuOverlay?.addEventListener("click", closeMenu);

    document.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && sideMenu?.classList.contains("open")) {
            closeMenu();
            menuButton?.focus();
        }
    });

    if (homeButton) {
        const triggerHome = () => {
            if (mode === "game") {
                window.location.href = "index.html";
            } else {
                onActionResetSearch?.();
                onGoHome?.();
                closeMenu();
            }
        };

        homeButton.addEventListener("click", triggerHome);
        homeButton.addEventListener("keydown", (event) => {
            if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                triggerHome();
            }
        });
    }

    if (backButton) {
        backButton.addEventListener("click", (event) => {
            if (!document.referrer) return;
            try {
                if (new URL(document.referrer).origin === location.origin) {
                    event.preventDefault();
                    history.back();
                }
            } catch {
                // Keep normal link fallback
            }
        });
    }

    if (allGamesButton && mode === "home") {
        allGamesButton.addEventListener("click", () => {
            onActionResetSearch?.();
            onSelectAllGames?.();
            closeMenu();
        });
    }

    return {
        renderPlatforms,
        closeMenu,
        setPlatformError(message) {
            if (!platformList) return;
            platformList.replaceChildren();
            const el = document.createElement("div");
            el.className = "menu-separator";
            el.textContent = message;
            platformList.appendChild(el);
        },
    };
}
