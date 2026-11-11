/*
 * NAPL — CORE CONFIGURATION
 */

export const POPULAR_URL =
    "https://script.google.com/macros/s/AKfycbxio6DGpBJRkYdceeFVXk3gSOFcBe5KZJtHU8F2j66DDYx_G_az01p7rnsuCq0KPHY/exec";

export const CATALOG_API_BASE = "https://napl-catalog-worker.federicoxastro.workers.dev";

export const RATINGS_API_BASE =
    typeof window !== "undefined" &&
    window.location.hostname.endsWith("github.io")
        ? "https://ports-ratings-worker.federicoxastro.workers.dev"
        : "/api/ratings";

export const RATINGS_API_URL = `${RATINGS_API_BASE}/ratings`;

export const COMPATIBILITY_API_URL = CATALOG_API_BASE
    ? `${CATALOG_API_BASE}/compatibility`
    : "/api/compatibility";

export const REPORT_LINK_API_URL = CATALOG_API_BASE
    ? `${CATALOG_API_BASE}/report-link`
    : "/api/report-link";

export const VISIT_API_URL = CATALOG_API_BASE
    ? `${CATALOG_API_BASE}/visit`
    : typeof window !== "undefined" &&
      window.location.hostname.endsWith("github.io")
    ? POPULAR_URL
    : "/api/visit";

export const RATING_TOKEN_STORAGE_KEY = "napl_rating_token_v1";
export const USER_DEVICE_STORAGE_KEY = "napl_user_device_v1";
