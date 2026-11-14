import { readFile } from "node:fs/promises";

const supabaseUrl = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceRoleKey) {
    throw new Error(
        "Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY before running this script."
    );
}

const sourceUrl = new URL("../../public/assets/data/devices.json", import.meta.url);
const devices = JSON.parse(await readFile(sourceUrl, "utf8"));

if (!Array.isArray(devices) || devices.length === 0) {
    throw new Error("The device source file is empty or has an invalid format.");
}

const normalized = devices
    .map((device) => ({
        id: String(device.id || "").trim(),
        name: String(device.name || "").trim(),
    }))
    .filter((device) => device.id && device.name);

if (normalized.length !== devices.length) {
    throw new Error("Some device entries have a missing ID or name; import aborted.");
}

const endpoint = `${supabaseUrl.replace(/\/$/, "")}/rest/v1/devices?on_conflict=id`;
const batchSize = 500;
let imported = 0;

for (let offset = 0; offset < normalized.length; offset += batchSize) {
    const batch = normalized.slice(offset, offset + batchSize);
    const response = await fetch(endpoint, {
        method: "POST",
        headers: {
            apikey: serviceRoleKey,
            Authorization: `Bearer ${serviceRoleKey}`,
            "Content-Type": "application/json",
            Prefer: "resolution=merge-duplicates",
        },
        body: JSON.stringify(batch),
    });

    if (!response.ok) {
        const detail = await response.text();
        throw new Error(
            `Device import failed at row ${offset + 1} (HTTP ${response.status}): ${detail}`
        );
    }

    imported += batch.length;
    console.log(`Imported ${imported}/${normalized.length} devices`);
}

console.log(`Finished. ${imported} devices synchronized.`);
