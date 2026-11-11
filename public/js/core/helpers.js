/*
 * NAPL — SHARED HELPERS (TEXT, SLUG & DATES)
 *
 * Single source of truth shared across home and game pages.
 */

export function normalizeText(value) {
    return String(value ?? "")
        .trim()
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "");
}

export function createSlug(name) {
    return normalizeText(name)
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
}

export function normalizeHeader(value) {
    return String(value ?? "")
        .replace(/^\uFEFF/, "")
        .trim()
        .toUpperCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "");
}

export function normalizePlatformLabel(value) {
    return String(value ?? "")
        .trim()
        .replace(/\s+/g, " ");
}

export function restoreDescriptionLineBreaks(description) {
    return String(description ?? "")
        .replace(/\s*\|\|\|\s*/g, "\n")
        .trim();
}

export function parseLastUpdate(value) {
    if (!value) return null;

    const match = String(value)
        .trim()
        .match(/^(\d{4})\s*,\s*([A-Za-z]+)(?:\s+(\d{1,2}))?$/);

    if (!match) return null;

    const year = Number(match[1]);
    const monthName = match[2].toLowerCase();
    const day = match[3] ? Number(match[3]) : 1;

    const months = {
        january: 0, february: 1, march: 2,
        april: 3, may: 4, june: 5,
        july: 6, august: 7, september: 8,
        october: 9, november: 10, december: 11,
    };

    if (!Object.prototype.hasOwnProperty.call(months, monthName)) {
        return null;
    }

    const date = new Date(year, months[monthName], day);

    if (
        date.getFullYear() !== year ||
        date.getMonth() !== months[monthName] ||
        date.getDate() !== day
    ) {
        return null;
    }

    return date;
}

export function parseDateAdded(value) {
    if (value === null || value === undefined) return null;

    const text = String(value).trim();
    if (!text) return null;

    let datePart = text;
    let hours = 0;
    let minutes = 0;
    let seconds = 0;

    const timeMatch = text.match(
        /(?:\s+|T)(\d{1,2}):(\d{2})(?::(\d{2}))?\s*$/i
    );

    if (timeMatch) {
        hours = Number(timeMatch[1]);
        minutes = Number(timeMatch[2]);
        seconds = Number(timeMatch[3] || 0);

        if (hours > 23 || minutes > 59 || seconds > 59) {
            return null;
        }

        datePart = text.slice(0, timeMatch.index).trim();
    }

    let year;
    let month;
    let day;

    const monthMatch = datePart.match(
        /^(\d{4})\s*,\s*([A-Za-zÁÉÍÓÚÜÑáéíóúüñ]+)(?:\s+(\d{1,2}))?$/i
    );

    if (monthMatch) {
        year = Number(monthMatch[1]);

        const monthName = monthMatch[2]
            .toLowerCase()
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "");

        day = monthMatch[3] ? Number(monthMatch[3]) : 1;

        const months = {
            january: 0, enero: 0,
            february: 1, febrero: 1,
            march: 2, marzo: 2,
            april: 3, abril: 3,
            may: 4, mayo: 4,
            june: 5, junio: 5,
            july: 6, julio: 6,
            august: 7, agosto: 7,
            september: 8, septiembre: 8, setiembre: 8,
            october: 9, octubre: 9,
            november: 10, noviembre: 10,
            december: 11, diciembre: 11,
        };

        if (!Object.prototype.hasOwnProperty.call(months, monthName)) {
            return null;
        }

        month = months[monthName];
    } else {
        const localMatch = datePart.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);

        if (localMatch) {
            day = Number(localMatch[1]);
            month = Number(localMatch[2]) - 1;
            year = Number(localMatch[3]);
        } else {
            const isoMatch = datePart.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
            if (!isoMatch) return null;

            year = Number(isoMatch[1]);
            month = Number(isoMatch[2]) - 1;
            day = Number(isoMatch[3]);
        }
    }

    const date = new Date(year, month, day, hours, minutes, seconds);

    if (
        date.getFullYear() !== year ||
        date.getMonth() !== month ||
        date.getDate() !== day
    ) {
        return null;
    }

    return date;
}

export function getLatestUpdate(game) {
    const dates = game.ports
        .map((port) => parseLastUpdate(port.lastUpdate))
        .filter((date) => date !== null);

    if (dates.length === 0) return null;

    return dates.reduce((latest, current) =>
        current > latest ? current : latest
    );
}

export function getDateAdded(game) {
    const dates = game.ports
        .map((port) => parseDateAdded(port.dateAdded))
        .filter((date) => date !== null);

    if (dates.length === 0) return null;

    return dates.reduce((latest, current) =>
        current > latest ? current : latest
    );
}

export function getPortForDate(game, field, parser) {
    if (!game || !Array.isArray(game.ports)) {
        return null;
    }

    let selectedPort = null;
    let selectedDate = null;

    for (const port of game.ports) {
        if (!port) continue;

        const date = parser(port[field]);
        if (!date) continue;

        if (!selectedDate || date > selectedDate) {
            selectedDate = date;
            selectedPort = port;
        }
    }

    return selectedPort;
}
