/*
 * NAPL — POPULARITY SERVICE
 */

import { CATALOG_API_BASE } from "../core/config.js";
import { createSlug } from "../core/helpers.js";

const allTimePopular = new Map();
let allTimePopularLoaded = false;
let allTimePopularPromise = null;

async function fetchFallbackPopular(period) {
    const isGitHubPages =
        typeof window !== "undefined" &&
        window.location.hostname.endsWith("github.io");

    if (isGitHubPages) {
        return [];
    }

    try {
        const response = await fetch(
            `/api/popular?popular=${encodeURIComponent(period)}`,
            { method: "GET", cache: "default" }
        );
        if (!response.ok) {
            return [];
        }
        const data = await response.json();
        return data?.success && Array.isArray(data.games) ? data.games : [];
    } catch {
        return [];
    }
}

export async function fetchPopularPeriod(period = "week") {
    try {
        const response = await fetch(
            `${CATALOG_API_BASE}/popular?period=${encodeURIComponent(period)}`,
            { method: "GET", cache: "no-store" }
        );
        if (!response.ok) {
            return await fetchFallbackPopular(period);
        }
        const data = await response.json();
        if (!data?.success || !Array.isArray(data.games)) {
            return await fetchFallbackPopular(period);
        }
        return data.games;
    } catch {
        return await fetchFallbackPopular(period);
    }
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
            console.warn("Could not load All Time popularity:", error);
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
