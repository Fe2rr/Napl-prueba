/*
 * NAPL — VISIT TRACKING SERVICE
 */

import { VISIT_API_URL } from "../core/config.js";
import { createSlug } from "../core/helpers.js";

export function registerGameVisit(gameName) {
    if (!gameName) return;

    const slug = createSlug(gameName);
    if (!slug) return;

    fetch(VISIT_API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug, name: gameName }),
        cache: "no-store",
        keepalive: true,
    }).catch((error) => {
        console.warn("NAPL: could not send the game visit.", error);
    });
}
