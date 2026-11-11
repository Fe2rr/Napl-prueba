/*
 * NAPL — RATINGS SERVICE
 *
 * Connects to the Cloudflare Workers ratings API.
 */

import {
    RATINGS_API_BASE,
    RATINGS_API_URL,
    RATING_TOKEN_STORAGE_KEY,
} from "../core/config.js";

let ratingTokenMemory = "";
let myVotesCache = null;

function readStoredRatingToken() {
    if (ratingTokenMemory) {
        return ratingTokenMemory;
    }

    try {
        ratingTokenMemory =
            localStorage.getItem(RATING_TOKEN_STORAGE_KEY) || "";
    } catch {
        // Continue using the in-memory token.
    }

    return ratingTokenMemory;
}

function storeRatingToken(token) {
    ratingTokenMemory = token;

    try {
        localStorage.setItem(RATING_TOKEN_STORAGE_KEY, token);
    } catch {
        // The token remains available for this page session.
    }
}

async function postRatingRequest(endpoint, payload) {
    const response = await fetch(RATINGS_API_BASE + endpoint, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        cache: "no-store",
    });

    const raw = await response.text();
    let data = {};

    try {
        data = raw ? JSON.parse(raw) : {};
    } catch {
        throw new Error("The ratings server returned an invalid response.");
    }

    if (!response.ok) {
        throw new Error(
            data.error ||
                data.message ||
                `Ratings server error (HTTP ${response.status}).`
        );
    }

    return data;
}

export async function getRatingToken() {
    const existingToken = readStoredRatingToken();
    if (existingToken) {
        return existingToken;
    }

    const data = await postRatingRequest("/token", {});

    if (!data || typeof data.token !== "string" || !data.token.trim()) {
        throw new Error(
            "The ratings server did not provide a valid voter token."
        );
    }

    storeRatingToken(data.token);
    return data.token;
}

async function loadMyVotes(force = false) {
    if (myVotesCache && !force) {
        return myVotesCache;
    }

    const token = await getRatingToken();
    const data = await postRatingRequest("/my-votes", { token });

    if (
        !data ||
        !data.votes ||
        typeof data.votes !== "object" ||
        Array.isArray(data.votes)
    ) {
        throw new Error("The ratings server returned an invalid vote list.");
    }

    myVotesCache = data.votes;
    return myVotesCache;
}

export async function loadPortRatings() {
    try {
        const response = await fetch(RATINGS_API_URL, {
            method: "GET",
            cache: "no-store",
        });

        if (!response.ok) {
            throw new Error(`Ratings API returned HTTP ${response.status}.`);
        }

        const data = await response.json();
        if (!data || !Array.isArray(data.ports)) {
            throw new Error("Ratings API returned an invalid response.");
        }

        const ratings = {};

        for (const port of data.ports) {
            if (typeof port.port_id !== "string" || !port.port_id.trim()) {
                continue;
            }

            const avg = Number(port.avg);
            const votes = Number(port.votes);
            const score = Number(port.score);

            ratings[port.port_id] = {
                avg: Number.isFinite(avg) ? avg : 0,
                votes: Number.isFinite(votes) ? votes : 0,
                score: Number.isFinite(score) ? score : 0,
            };
        }

        return ratings;
    } catch (error) {
        console.warn("NAPL: could not load port ratings.", error);
        return {};
    }
}

export function createRatingActions() {
    return {
        async getMyVote(portId) {
            const votes = await loadMyVotes();
            const value = Number(votes[portId]);

            return Number.isInteger(value) && value >= 1 && value <= 5
                ? value
                : 0;
        },

        async submitVote(portId, stars) {
            const token = await getRatingToken();

            await postRatingRequest("/vote", {
                token,
                port_id: portId,
                stars,
            });

            if (!myVotesCache) {
                myVotesCache = {};
            }

            myVotesCache[portId] = stars;

            const updatedRatings = await loadPortRatings();

            return {
                myVote: stars,
                rating: updatedRatings[portId] || null,
            };
        },
    };
}
