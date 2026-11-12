/*
 * NAPL — GAME CARD COMPONENT
 */

export function getRepresentativePort(game) {
    if (!game || !Array.isArray(game.ports)) {
        return null;
    }

    return (
        game.ports.find(
            (port) => port && String(port.project || "").trim()
        ) ||
        game.ports.find(
            (port) =>
                port &&
                (String(port.platform || "").trim() ||
                    String(port.developer || "").trim())
        ) ||
        null
    );
}

export function getPortDisplayName(port) {
    if (!port) return "Android port";

    const project = String(port.project || "").trim();
    if (project) return project;

    const platform = String(port.platform || "").trim();
    if (platform) return platform;

    const developer = String(port.developer || "").trim();
    if (developer) return developer;

    return "Android port";
}

export function getGamePlatformLabel(game, port) {
    let platforms = [];

    if (Array.isArray(game?.platforms)) {
        platforms = game.platforms;
    }

    if (platforms.length === 0 && port?.platform) {
        platforms = [port.platform];
    }

    platforms = [
        ...new Set(
            platforms
                .map((platform) => String(platform || "").trim())
                .filter(Boolean)
        ),
    ];

    if (platforms.length === 0) return "";
    if (platforms.length <= 2) return platforms.join(" · ");

    return `${platforms[0]} · ${platforms[1]} +${platforms.length - 2}`;
}

export function createHomeGameCard(game, port, options = {}) {
    const element = document.createElement("a");
    element.className = "home-game";
    const gameUrl = new URL("game.html", window.location.href);
    gameUrl.searchParams.set("game", game.slug);
    gameUrl.searchParams.set("return", options.returnUrl || "index.html");
    element.href = gameUrl.href;

    const coverContainer = document.createElement("div");
    coverContainer.className = "home-game-cover-container";

    const coverUrl = String(game.coverUrl || "").trim();

    if (coverUrl) {
        const cover = document.createElement("img");
        cover.className = "home-game-cover";
        cover.src = coverUrl;
        cover.alt = `${game.name} cover`;
        cover.loading = "lazy";
        cover.decoding = "async";
        cover.referrerPolicy = "no-referrer";

        cover.addEventListener(
            "error",
            () => {
                cover.remove();
                coverContainer.classList.add("cover-unavailable");
            },
            { once: true }
        );

        coverContainer.appendChild(cover);
    } else {
        coverContainer.classList.add("cover-unavailable");
    }

    const content = document.createElement("div");
    content.className = "home-game-content";

    if (Number.isFinite(options.rank)) {
        const rank = document.createElement("span");
        rank.className = "home-game-rank";
        rank.textContent = `#${options.rank}`;
        content.appendChild(rank);
    }

    const name = document.createElement("span");
    name.className = "home-game-name";
    name.textContent = game.name;

    const metadata = document.createElement("span");
    metadata.className = "home-game-metadata";

    const platformLabel = getGamePlatformLabel(game, port);
    const year = String(game.year || port?.year || "").trim();

    const metadataParts = [];
    if (platformLabel) metadataParts.push(platformLabel);
    if (year) metadataParts.push(year);

    metadata.textContent = metadataParts.join(" · ");
    content.appendChild(name);

    if (metadataParts.length > 0) {
        content.appendChild(metadata);
    }

    if (options.showPort !== false) {
        const portName = document.createElement("span");
        portName.className = "home-game-port";
        portName.textContent = getPortDisplayName(port);
        content.appendChild(portName);
    }

    element.append(coverContainer, content);
    return element;
}
