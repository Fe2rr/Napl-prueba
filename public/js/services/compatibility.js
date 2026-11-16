/*
 * NAPL — COMPATIBILITY SERVICE
 *
 * Manages Works? Yes/No reports paired with strict Android device selection
 * from the Supabase devices catalog and compatibility_reports tables.
 */

import {
    COMPATIBILITY_API_URL,
    REPORT_LINK_API_URL,
    USER_DEVICE_STORAGE_KEY,
} from "../core/config.js";
import { getRatingToken } from "./ratings.js";

let devicesCache = null;
let devicesPromise = null;

// Bump this version whenever the device catalog's data or shape changes.
// It is also sent to the API so the browser and any intermediary caches can
// distinguish the new catalog from an older one.
const DEVICE_CATALOG_VERSION = "2";
const DEVICE_CATALOG_STORAGE_KEY = `napl_device_catalog_v${DEVICE_CATALOG_VERSION}`;

const COMPATIBILITY_CACHE_PREFIX = "napl_compatibility_v2:";
const COMPATIBILITY_CACHE_TTL = 60_000;

function readStoredDeviceCatalog() {
    try {
        const raw = localStorage.getItem(DEVICE_CATALOG_STORAGE_KEY);
        if (!raw) return null;

        const devices = JSON.parse(raw);
        if (!Array.isArray(devices)) {
            localStorage.removeItem(DEVICE_CATALOG_STORAGE_KEY);
            return null;
        }

        return devices;
    } catch {
        // Storage can be disabled, unavailable, or over quota.
        return null;
    }
}

function storeDeviceCatalog(devices) {
    try {
        localStorage.setItem(
            DEVICE_CATALOG_STORAGE_KEY,
            JSON.stringify(devices)
        );
    } catch {
        // The catalog still works for this page session if storage is full.
    }
}

export const COMPAT_STATUSES = [
    {
        id: "playable_60",
        label: "Playable (60fps)",
        shortLabel: "60fps",
        score: 4,
        works: true,
    },
    {
        id: "playable_30",
        label: "Playable (30fps)",
        shortLabel: "30fps",
        score: 3,
        works: true,
    },
    {
        id: "low_fps",
        label: "Boots (low FPS)",
        shortLabel: "Low FPS",
        score: 2,
        works: false,
    },
    {
        id: "crash",
        label: "Doesn't boot / Crash",
        shortLabel: "Crash",
        score: 1,
        works: false,
    },
];

export const COMPAT_STATUS_MAP = Object.fromEntries(
    COMPAT_STATUSES.map((item) => [item.id, item])
);

export function normalizeCompatStatus(rawStatus, fallbackWorks = null) {
    const clean = String(rawStatus || "").trim();
    if (COMPAT_STATUS_MAP[clean]) return clean;
    if (fallbackWorks === true) return "playable_30";
    if (fallbackWorks === false) return "crash";
    return "crash";
}

export function getCompatStatusMeta(rawStatus, fallbackWorks = null) {
    return COMPAT_STATUS_MAP[normalizeCompatStatus(rawStatus, fallbackWorks)];
}

export function normalizeCompatSummary(summary) {
    const reports = Array.isArray(summary?.reports)
        ? summary.reports.map((report) => {
              const status = normalizeCompatStatus(
                  report?.status,
                  report?.works
              );
              const works =
                  status === "playable_30" || status === "playable_60";
              return { ...report, status, works };
          })
        : [];

    const rawCounts = summary?.counts || {};
    const hasExplicitCounts =
        rawCounts &&
        (rawCounts.playable_60 !== undefined ||
            rawCounts.playable_30 !== undefined ||
            rawCounts.low_fps !== undefined ||
            rawCounts.crash !== undefined);

    const counts = hasExplicitCounts
        ? {
              playable_60: Number(rawCounts.playable_60) || 0,
              playable_30: Number(rawCounts.playable_30) || 0,
              low_fps: Number(rawCounts.low_fps) || 0,
              crash: Number(rawCounts.crash) || 0,
          }
        : {
              playable_60: 0,
              playable_30: Number(summary?.yes) || 0,
              low_fps: 0,
              crash: Number(summary?.no) || 0,
          };

    const playableCount = counts.playable_60 + counts.playable_30;
    const unplayableCount = counts.low_fps + counts.crash;

    return {
        yes: playableCount,
        no: unplayableCount,
        total: playableCount + unplayableCount,
        counts,
        reports,
    };
}

function readCachedCompatibility(portId) {
    try {
        const raw = localStorage.getItem(COMPATIBILITY_CACHE_PREFIX + portId);
        if (!raw) return null;
        const cached = JSON.parse(raw);
        if (
            !cached ||
            typeof cached.savedAt !== "number" ||
            Date.now() - cached.savedAt > COMPATIBILITY_CACHE_TTL ||
            !cached.value ||
            typeof cached.value !== "object"
        ) {
            localStorage.removeItem(COMPATIBILITY_CACHE_PREFIX + portId);
            return null;
        }
        return cached.value;
    } catch {
        return null;
    }
}

function writeCachedCompatibility(data) {
    try {
        for (const [portId, value] of Object.entries(data || {})) {
            localStorage.setItem(
                COMPATIBILITY_CACHE_PREFIX + portId,
                JSON.stringify({ savedAt: Date.now(), value })
            );
        }
    } catch {
        // Storage may be unavailable or full; the API response still works.
    }
}

export function parseDeviceDisplayParts(rawName, explicitSoc = "") {
    const cleanName = String(rawName || "").trim();
    let soc = String(explicitSoc || "").trim();
    let model = cleanName;

    if (cleanName) {
        const trailing = cleanName.match(/^(.+?)\s*\(([^()]+)\)$/);
        if (trailing) {
            const candidateModel = trailing[1].trim();
            const candidateSoc = trailing[2].trim();
            if (!soc) {
                model = candidateModel;
                soc = candidateSoc;
            } else if (candidateSoc.toLowerCase() === soc.toLowerCase()) {
                model = candidateModel;
            }
        }
    }

    return { model, soc };
}

export function groupIdenticalCompatReports(reports) {
    const grouped = new Map();

    for (const item of reports || []) {
        if (!item) continue;
        const tier = getCompatStatusMeta(item.status, item.works);
        const { model, soc } = parseDeviceDisplayParts(
            item.deviceName || item.deviceId,
            item.deviceSoc || item.soc || ""
        );
        const deviceKey = String(item.deviceId || model || "")
            .trim()
            .toLowerCase();
        const key = `${deviceKey}::${tier.id}`;

        const existing = grouped.get(key);
        if (existing) {
            existing.count += 1;
            const prevTs = Date.parse(existing.updatedAt || "") || 0;
            const nextTs = Date.parse(item.updatedAt || "") || 0;
            if (nextTs > prevTs) {
                existing.updatedAt = item.updatedAt;
            }
        } else {
            grouped.set(key, {
                ...item,
                status: tier.id,
                works: tier.works,
                model,
                soc,
                count: 1,
            });
        }
    }

    return Array.from(grouped.values()).sort((a, b) => {
        const tsDiff =
            (Date.parse(b.updatedAt || "") || 0) -
            (Date.parse(a.updatedAt || "") || 0);
        if (tsDiff !== 0) return tsDiff;
        return b.count - a.count;
    });
}

function normalizeDeviceRecord(device) {
    const id = String(device?.id || "");
    const rawName = String(device?.name || "").trim();
    const manufacturer = String(device?.manufacturer || "").trim();
    const deviceType = String(device?.deviceType || device?.device_type || "phone").trim() || "phone";
    const explicitModel = String(device?.model || "").trim();
    const explicitSoc = String(device?.soc || "").trim();

    const parsed = parseDeviceDisplayParts(rawName, explicitSoc);
    const model = explicitModel || parsed.model || rawName;
    const soc = explicitSoc || parsed.soc;
    const displayName = soc && model && !model.toLowerCase().includes(soc.toLowerCase())
        ? `${model} (${soc})`
        : (rawName || model);

    const searchText = [displayName, manufacturer, model, soc]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

    return {
        id,
        name: displayName,
        manufacturer,
        model,
        soc,
        deviceType,
        lower: searchText,
        modelLower: model.toLowerCase(),
    };
}

export async function loadDevices() {
    if (devicesCache) return devicesCache;

    if (!devicesPromise) {
        devicesPromise = (async () => {
            // Persist the raw API records so repeat visits do not download the
            // ~800 KB catalog again. The versioned key is invalidated by
            // incrementing DEVICE_CATALOG_VERSION when the catalog changes.
            const storedDevices = readStoredDeviceCatalog();
            if (storedDevices) {
                devicesCache = storedDevices.map(normalizeDeviceRecord);
                return devicesCache;
            }

            const response = await fetch(
                `${COMPATIBILITY_API_URL}?action=devices&catalog_version=${DEVICE_CATALOG_VERSION}`
            );
            if (!response.ok) {
                throw new Error(
                    `Could not load device database (HTTP ${response.status}).`
                );
            }

            const payload = await response.json();
            if (!payload?.success || !Array.isArray(payload.devices)) {
                throw new Error("Device database returned an invalid format.");
            }

            storeDeviceCatalog(payload.devices);
            devicesCache = payload.devices.map(normalizeDeviceRecord);
            return devicesCache;
        })();
    }

    try {
        return await devicesPromise;
    } catch (error) {
        devicesPromise = null;
        throw error;
    }
}

export function searchDevices(devices, query, limit = 25) {
    const clean = String(query || "").trim().toLowerCase();
    if (!clean) return [];

    const terms = clean.split(/\s+/).filter(Boolean);
    if (terms.length === 0) return [];

    const startsWithMatches = [];
    const otherMatches = [];

    for (const device of devices) {
        let allMatch = true;
        for (const term of terms) {
            if (!device.lower.includes(term)) {
                allMatch = false;
                break;
            }
        }
        if (!allMatch) continue;

        if (device.modelLower.startsWith(clean) || device.lower.startsWith(clean)) {
            startsWithMatches.push(device);
        } else {
            otherMatches.push(device);
        }

        if (
            startsWithMatches.length >= limit &&
            otherMatches.length >= limit
        ) {
            break;
        }
    }

    return [...startsWithMatches, ...otherMatches].slice(0, limit);
}

export function buildHardwareIndex(devices) {
    const socMap = new Map();
    for (const device of devices || []) {
        const soc = String(device?.soc || "").trim();
        if (!soc) continue;
        const key = soc.toLowerCase();
        const existing = socMap.get(key);
        if (existing) {
            existing.count += 1;
        } else {
            socMap.set(key, {
                soc,
                count: 1,
                lower: soc.toLowerCase(),
            });
        }
    }

    const socs = Array.from(socMap.values()).sort((a, b) =>
        b.count - a.count || a.soc.localeCompare(b.soc, "en")
    );

    return { devices: devices || [], socs };
}

export function searchHardwareCatalog(
    hardwareIndex,
    query,
    { socLimit = 6, deviceLimit = 18 } = {}
) {
    const clean = String(query || "").trim().toLowerCase();
    if (!clean) return { socs: [], devices: [] };

    const terms = clean.split(/\s+/).filter(Boolean);
    if (terms.length === 0) return { socs: [], devices: [] };

    const socStarts = [];
    const socContains = [];

    for (const entry of hardwareIndex?.socs || []) {
        if (!terms.every((t) => entry.lower.includes(t))) continue;
        if (entry.lower.startsWith(clean)) socStarts.push(entry);
        else socContains.push(entry);
    }

    const socs = [...socStarts, ...socContains].slice(0, socLimit);
    const devices = searchDevices(
        hardwareIndex?.devices || [],
        query,
        deviceLimit
    );

    return { socs, devices };
}

export async function searchCompatibilityByHardware({
    deviceId = "",
    soc = "",
    query = "",
    limit = 500,
} = {}) {
    const params = new URLSearchParams({ action: "search" });
    if (deviceId) params.set("device_id", deviceId);
    if (soc) params.set("soc", soc);
    if (query) params.set("q", query);
    if (limit) params.set("limit", String(limit));

    const response = await fetch(
        `${COMPATIBILITY_API_URL}?${params.toString()}`,
        {
            method: "GET",
            cache: "no-store",
        }
    );

    if (!response.ok) {
        throw new Error(
            `Compatibility search failed (HTTP ${response.status}).`
        );
    }

    const payload = await response.json();
    if (!payload?.success || !Array.isArray(payload.reports)) {
        throw new Error("Compatibility search returned an invalid response.");
    }

    return payload.reports.map((report) => {
        const status = normalizeCompatStatus(report?.status, report?.works);
        return {
            portId: String(report?.portId || "").trim(),
            deviceId: String(report?.deviceId || "").trim(),
            deviceName: String(report?.deviceName || report?.deviceId || "").trim(),
            deviceSoc: String(report?.deviceSoc || "").trim(),
            deviceType: String(report?.deviceType || "phone").trim() || "phone",
            status,
            works: status === "playable_30" || status === "playable_60",
            updatedAt: String(report?.updatedAt || ""),
        };
    });
}

export function getStoredUserDevice() {
    try {
        const raw = localStorage.getItem(USER_DEVICE_STORAGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (
            parsed &&
            typeof parsed.id === "string" &&
            parsed.id.trim() &&
            typeof parsed.name === "string" &&
            parsed.name.trim()
        ) {
            const parts = parseDeviceDisplayParts(parsed.name, parsed.soc || "");
            return {
                id: parsed.id,
                name: parsed.name,
                model: typeof parsed.model === "string" && parsed.model.trim()
                    ? parsed.model.trim()
                    : parts.model,
                soc: typeof parsed.soc === "string" && parsed.soc.trim()
                    ? parsed.soc.trim()
                    : parts.soc,
            };
        }
    } catch {
        // Ignore storage read errors
    }
    return null;
}

export function setStoredUserDevice(device) {
    try {
        if (!device) {
            localStorage.removeItem(USER_DEVICE_STORAGE_KEY);
            return;
        }
        localStorage.setItem(
            USER_DEVICE_STORAGE_KEY,
            JSON.stringify({
                id: device.id,
                name: device.name,
                model: device.model || "",
                soc: device.soc || "",
            })
        );
    } catch {
        // Ignore storage write errors
    }
}

export async function loadGameCompatibility(portIds, fresh = false) {
    const cleanIds = Array.from(
        new Set(
            (portIds || []).map((id) => String(id || "").trim()).filter(Boolean)
        )
    );

    if (cleanIds.length === 0) {
        return {};
    }

    const cached = {};
    const missingIds = [];

    if (!fresh) {
        for (const id of cleanIds) {
            const value = readCachedCompatibility(id);
            if (value) cached[id] = value;
            else missingIds.push(id);
        }
        if (missingIds.length === 0) return cached;
    }

    const requestedIds = fresh ? cleanIds : missingIds;

    try {
        const params = new URLSearchParams({
            port_ids: requestedIds.join(","),
        });
        if (fresh) params.set("fresh", "1");
        const response = await fetch(
            `${COMPATIBILITY_API_URL}?${params.toString()}`,
            {
                method: "GET",
                cache: fresh ? "no-store" : "default",
            }
        );

        if (!response.ok) {
            throw new Error(
                `Compatibility API returned HTTP ${response.status}.`
            );
        }

        const data = await response.json();
        if (!data || typeof data.compatibility !== "object") {
            return cached;
        }

        writeCachedCompatibility(data.compatibility);
        return { ...cached, ...data.compatibility };
    } catch (error) {
        console.warn("NAPL: could not load compatibility reports.", error);
        return cached;
    }
}

export function createCompatibilityActions() {
    return {
        async loadSummary(portId) {
            const summaries = await loadGameCompatibility([portId]);
            return summaries[portId] || null;
        },

        async submitReport({ portId, deviceId, status, works }) {
            const token = await getRatingToken();
            const resolvedStatus = normalizeCompatStatus(status, works);
            const resolvedWorks =
                resolvedStatus === "playable_30" ||
                resolvedStatus === "playable_60";

            const response = await fetch(COMPATIBILITY_API_URL, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    token,
                    port_id: portId,
                    device_id: deviceId,
                    status: resolvedStatus,
                    works: resolvedWorks,
                }),
                cache: "no-store",
            });

            const raw = await response.text();
            let data = {};
            try {
                data = raw ? JSON.parse(raw) : {};
            } catch {
                throw new Error(
                    "The compatibility server returned an invalid response."
                );
            }

            if (!response.ok || !data.success) {
                throw new Error(
                    data.error ||
                        `Compatibility server error (HTTP ${response.status}).`
                );
            }

            const refreshed = await loadGameCompatibility([portId], true);
            return {
                report: data.report,
                summary: refreshed[portId] || data.summary || null,
            };
        },

        async reportBrokenLink({ portId, reason, url }) {
            const storageKey = "napl_link_report_client_v1";
            let clientId = "";

            try {
                clientId = localStorage.getItem(storageKey) || "";
                if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(clientId)) {
                    clientId = crypto.randomUUID();
                    localStorage.setItem(storageKey, clientId);
                }
            } catch {
                clientId = crypto.randomUUID();
            }

            const response = await fetch(REPORT_LINK_API_URL, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    client_id: clientId,
                    port_id: portId,
                    reason,
                    url,
                }),
                cache: "no-store",
            });

            const raw = await response.text();
            let data = {};
            try {
                data = raw ? JSON.parse(raw) : {};
            } catch {
                throw new Error(
                    "The report server returned an invalid response."
                );
            }

            if (!response.ok || !data.success) {
                const error = new Error(
                    data.error ||
                        `Report server error (HTTP ${response.status}).`
                );
                error.retryAfterSeconds = Number(data.retry_after_seconds) || 0;
                throw error;
            }

            return data;
        },
    };
}
