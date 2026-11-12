/*
 * NAPL — CLEAN LIGHT / DARK THEME TOGGLE
 */

const STORAGE_KEY = "napl_theme_v1";

const SUN_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>`;

const MOON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>`;

function readSavedTheme() {
    try {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved === "light" || saved === "dark") return saved;
    } catch {
        // Ignore storage access issues
    }
    return "dark";
}

function setTheme(theme, button) {
    const mode = theme === "light" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", mode);

    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
        meta.setAttribute("content", mode === "light" ? "#ffffff" : "#11221b");
    }

    if (button) {
        const isLight = mode === "light";
        button.innerHTML = `${isLight ? MOON_SVG : SUN_SVG}<span>${isLight ? "Dark" : "Light"}</span>`;
        button.setAttribute(
            "aria-label",
            isLight ? "Cambiar a modo oscuro" : "Cambiar a modo claro"
        );
        button.setAttribute(
            "title",
            isLight ? "Cambiar a modo oscuro" : "Cambiar a modo claro"
        );
        button.setAttribute("aria-pressed", String(isLight));
    }
}

export function initThemeToggle() {
    const button = document.getElementById("theme-toggle");
    setTheme(readSavedTheme(), button);

    if (!button) return;

    button.addEventListener("click", () => {
        const current =
            document.documentElement.getAttribute("data-theme") === "light"
                ? "light"
                : "dark";
        const next = current === "light" ? "dark" : "light";

        try {
            localStorage.setItem(STORAGE_KEY, next);
        } catch {
            // Ignore storage access issues
        }

        setTheme(next, button);
    });
}
