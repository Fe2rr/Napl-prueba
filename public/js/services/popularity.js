/*
 * NAPL — POPULARITY SERVICE
 */

import { CATALOG_API_BASE } from "../core/config.js";
import { createSlug } from "../core/helpers.js";

const allTimePopular = new Map();
let allTimePopularLoaded = false;
let allTimePopularPromise = null;

export async function fetchPopularPeriod(period = "week") {
    const response = await fetch(
        `${CATALOG_API_BASE}/popular?period=${encodeURIComponent(period)}`,
        { method: "GET", cache: "no-store" }
    );
    if (!response.ok) {
        throw new Error(`Popular API returned HTTP ${response.status}.`);
    }
    const data = await response.json();
    if (!data?.success || !Array.isArray(data.games)) {
        throw new Error(data?.error || "Could not load popular games.");
    }
    return data.games;
}

export async function ensureAllTimePopular() {
    if (allTimePopularLoaded) {
        return allTimePopular;
    }

    if (allTimePopularPromise) {
        return allTimePopularPromise;
    }

    allTimePopularPromise = fetchPopularPeriod("alltime")
        .then((items) => {
            allTimePopular.clear();
            for (const item of items) {
                allTimePopular.set(
                    createSlug(item.game),
                    Number(item.visits) || 0
                );
            }
            allTimePopularLoaded = true;
            return allTimePopular;
        })
        .catch((error) => {
            console.error("Could not load All Time popularity:", error);
            return allTimePopular;
        })
        .finally(() => {
            allTimePopularPromise = null;
        });

    return allTimePopularPromise;
}

export function getAllTimeVisits(slug) {
    return allTimePopular.get(slug) || 0;
}
