/*
 * NAPL — VISIT TRACKING SERVICE
 */

import { CATALOG_API_BASE, POPULAR_URL, VISIT_API_URL } from "../core/config.js";
import { createSlug } from "../core/helpers.js";

export function registerGameVisit(gameName) {
    if (!gameName) return;

    const slug = createSlug(gameName);
    if (!slug) return;

    if (CATALOG_API_BASE || VISIT_API_URL === "/api/visit") {
        fetch(VISIT_API_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ slug, name: gameName }),
            cache: "no-store",
            keepalive: true,
        }).catch((error) => {
            console.warn("NAPL: could not send the game visit.", error);
        });
        return;
    }

    const url = new URL(POPULAR_URL);
    url.searchParams.set("game", slug);
    url.searchParams.set("_", String(Date.now()));

    fetch(url.toString(), {
        method: "GET",
        mode: "no-cors",
        cache: "no-store",
        keepalive: true,
    }).catch((error) => {
        console.warn("NAPL: could not send the game visit.", error);
    });
}
