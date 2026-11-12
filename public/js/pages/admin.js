import { CATALOG_API_BASE } from "../core/config.js";

const API = CATALOG_API_BASE;
const SECRET_KEY = "napl_admin_secret_session";
const $ = (id) => document.getElementById(id);
const authPanel = $("auth-panel");
const adminPanel = $("admin-panel");
const authForm = $("auth-form");
const secretInput = $("secret-input");
const authError = $("auth-error");
const logoutButton = $("logout-button");
const list = $("ports-list");
const searchInput = $("search-input");
const editor = $("editor-panel");
const form = $("port-form");
const formMessage = $("form-message");
const saveButton = $("save-button");
const gameSearch = $("game-search");
const gameOptions = $("game-options");
const gameSelectionHint = $("game-selection-hint");
const platformOptions = $("platform-options");

let secret = "";
let games = [];
let ports = [];
let platformOrder = [];
let editing = null;
let selectedGameSlug = "__new__";

const fields = {
  gameName: "game-name", year: "game-year", genre: "game-genre",
  description: "game-description", coverUrl: "cover-url", launchboxUrl: "launchbox-url",
  portId: "port-id", platform: "platform", project: "project", link: "link",
  url: "port-url", developer: "developer", version: "version",
  lastUpdate: "last-update", dateAdded: "date-added", needsFiles: "needs-files",
  dataUrl: "data-url", notes: "notes", works: "works",
  controllerSupport: "controller-support"
};

function value(id) { return $(id).value.trim(); }
function setValue(key, val = "") { $(fields[key]).value = val ?? ""; }
function showMessage(target, message, isError = false) {
  target.textContent = message || "";
  target.classList.toggle("error", isError);
}
async function api(path, options = {}) {
  const response = await fetch(API + path, {
    ...options,
    headers: {
      ...(options.headers || {}),
      Authorization: "Bearer " + secret,
      ...(options.body ? { "Content-Type": "application/json" } : {})
    },
    cache: "no-store"
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.success) throw new Error(data.error || `Request failed (HTTP ${response.status}).`);
  return data;
}

function lock() {
  secret = "";
  sessionStorage.removeItem(SECRET_KEY);
  authPanel.hidden = false;
  adminPanel.hidden = true;
  logoutButton.hidden = true;
  editor.hidden = true;
  secretInput.value = "";
  list.replaceChildren();
}

async function unlock(candidate) {
  secret = candidate;
  const data = await api("/admin/ports/list");
  sessionStorage.setItem(SECRET_KEY, candidate);
  games = data.games || [];
  ports = data.ports || [];
  platformOrder = data.platforms || [];
  authPanel.hidden = true;
  adminPanel.hidden = false;
  logoutButton.hidden = false;
  renderList();
  populateOptions();
}

function populateGameOptions(query = "") {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const matches = normalizedQuery
    ? games
        .filter((game) => game.name.toLocaleLowerCase().includes(normalizedQuery))
        .sort((a, b) => {
          const aName = a.name.toLocaleLowerCase();
          const bName = b.name.toLocaleLowerCase();
          const aStarts = aName.startsWith(normalizedQuery);
          const bStarts = bName.startsWith(normalizedQuery);
          if (aStarts !== bStarts) return aStarts ? -1 : 1;
          return aName.localeCompare(bName);
        })
        .slice(0, 5)
    : [];

  gameOptions.replaceChildren(...matches.map((game) => {
    const option = document.createElement("option");
    option.value = game.name;
    return option;
  }));
}

function populateOptions(selectedName = "") {
  populateGameOptions(selectedName);
  gameSearch.value = selectedName;
  const availablePlatforms = [...new Set(ports.map((p) => p.platform).filter(Boolean))];
  const ordered = [...platformOrder, ...availablePlatforms.filter((p) => !platformOrder.includes(p))];
  const platforms = ordered.filter((p, index) => availablePlatforms.includes(p) && ordered.indexOf(p) === index);
  platformOptions.replaceChildren(...platforms.map((platform) => {
    const option = document.createElement("option");
    option.value = platform;
    return option;
  }));
}

function getDownloadLabel(port) {
  return String(port.project || port.url || port.link || port.portId || "Unnamed port").trim();
}

function isGitHubPort(port) {
  return [port.url, port.link].some((candidate) => {
    if (!candidate) return false;
    try { return new URL(candidate).hostname.toLowerCase() === "github.com" || new URL(candidate).hostname.toLowerCase().endsWith(".github.com"); }
    catch { return /(^|\/)github\.com\//i.test(candidate); }
  });
}

function makePortRow(port) {
  const row = document.createElement("article");
  row.className = "port-row";
  const main = document.createElement("div");
  main.className = "port-main";

  const name = document.createElement("div");
  name.className = "port-name";
  name.textContent = port.gameName;
  const meta = document.createElement("div");
  meta.className = "port-meta";
  meta.textContent = [port.project, port.developer, port.portId].filter(Boolean).join(" · ");
  main.append(name, meta);

  const actions = document.createElement("div");
  actions.className = "port-actions";
  const destination = port.url || port.link;
  if (destination) {
    const download = document.createElement("a");
    download.className = "button download-link";
    download.href = destination;
    download.target = "_blank";
    download.rel = "noopener noreferrer";
    download.textContent = getDownloadLabel(port);
    actions.append(download);
  }
  const edit = document.createElement("button");
  edit.type = "button";
  edit.className = "button secondary";
  edit.textContent = "Edit";
  edit.addEventListener("click", () => openEditor(port));
  actions.append(edit);

  row.append(main, actions);
  return row;
}

function renderList() {
  const query = searchInput.value.trim().toLowerCase();
  const filtered = ports.filter((port) => [
    port.gameName, port.platform, port.portId, port.project, port.developer, port.url, port.link
  ].join(" ").toLowerCase().includes(query));
  $("catalog-count").textContent = `${ports.length} ports · ${games.length} games`;
  list.replaceChildren();
  if (!filtered.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = query ? "No matching ports." : "No ports in the catalog.";
    list.append(empty);
    return;
  }

  const groups = new Map();
  for (const port of filtered) {
    const platform = port.platform || "Uncategorized";
    if (!groups.has(platform)) groups.set(platform, []);
    groups.get(platform).push(port);
  }

  const fragment = document.createDocumentFragment();
  const normalizePlatform = (value) => String(value || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const getPlatformGroup = (platform) => {
    const normalized = normalizePlatform(platform);
    if (normalized === "others" || normalized === "other") return "Others";
    if (normalized.includes("playstation")) return "PlayStation";
    if (normalized.startsWith("xbox")) return "Xbox";
    if (normalized.includes("nintendo") || normalized.includes("game boy") || normalized.includes("gameboy") || normalized.includes("gamecube") || normalized === "nes") return "Nintendo";
    return "Others";
  };
  const menuGroupOrder = ["Nintendo", "PlayStation", "Xbox", "Others"];
  const platformIndex = new Map(platformOrder.map((name, index) => [name, index]));
  const platforms = [...groups.keys()].sort((a, b) => {
    const groupDifference = menuGroupOrder.indexOf(getPlatformGroup(a)) - menuGroupOrder.indexOf(getPlatformGroup(b));
    if (groupDifference) return groupDifference;
    const indexA = platformIndex.has(a) ? platformIndex.get(a) : Number.MAX_SAFE_INTEGER;
    const indexB = platformIndex.has(b) ? platformIndex.get(b) : Number.MAX_SAFE_INTEGER;
    return indexA - indexB || a.localeCompare(b);
  });
  for (const platform of platforms) {
    const categoryPorts = groups.get(platform);
    const details = document.createElement("details");
    details.className = "platform-category";
    details.open = false;

    const summary = document.createElement("summary");
    summary.className = "platform-category-heading";
    const title = document.createElement("span");
    title.textContent = platform;
    const count = document.createElement("span");
    count.className = "category-count";
    count.textContent = String(categoryPorts.length);
    summary.append(title, count);
    details.append(summary);

    const body = document.createElement("div");
    body.className = "platform-category-body";
    const otherLinks = categoryPorts.filter((port) => !isGitHubPort(port));
    const githubLinks = categoryPorts.filter(isGitHubPort);
    const sortByDownloadLabel = (a, b) => getDownloadLabel(a).localeCompare(getDownloadLabel(b), undefined, { sensitivity: "base" });

    for (const [label, items] of [["Other sources", otherLinks], ["GitHub", githubLinks]]) {
      if (!items.length) continue;
      const section = document.createElement("section");
      section.className = "source-group";
      const heading = document.createElement("h4");
      heading.textContent = label;
      section.append(heading);
      for (const port of [...items].sort(sortByDownloadLabel)) section.append(makePortRow(port));
      body.append(section);
    }
    details.append(body);
    fragment.append(details);
  }
  list.append(fragment);
}

function openEditor(port = null) {
  editing = port ? { gameSlug: port.gameSlug, portId: port.portId } : null;
  form.reset();
  showMessage(formMessage, "");
  $("editor-title").textContent = port ? "Edit port" : "Add port";
  saveButton.textContent = port ? "Save changes" : "Add port";
  populateOptions(port?.gameName || "");
  selectedGameSlug = port?.gameSlug || "__new__";

  if (port) {
    for (const [key] of Object.entries(fields)) setValue(key, port[key]);
    gameSearch.disabled = true;
    $("game-name").readOnly = false;
    $("port-id").readOnly = false;
    gameSelectionHint.textContent = "You can edit the game name and Port ID. The game remains linked to its existing record.";
  } else {
    gameSearch.disabled = false;
    $("game-name").readOnly = false;
    $("port-id").readOnly = false;
    setValue("dateAdded", new Date().toISOString().slice(0, 19).replace("T", " "));
    gameSelectionHint.textContent = "Choose an existing game from the suggestions, or type a new name.";
  }
  editor.hidden = false;
  editor.scrollIntoView({ behavior: "smooth", block: "start" });
}

function updateGameSelection() {
  if (editing) return;
  const typedName = gameSearch.value.trim();
  populateGameOptions(typedName);
  const selected = games.find((game) => game.name.toLocaleLowerCase() === typedName.toLocaleLowerCase());

  if (selected) {
    selectedGameSlug = selected.slug;
    setValue("gameName", selected.name);
    setValue("year", selected.year);
    setValue("genre", selected.genre);
    setValue("description", selected.description);
    setValue("coverUrl", selected.cover_url);
    setValue("launchboxUrl", selected.launchbox_url);
    $("game-name").readOnly = true;
    gameSelectionHint.textContent = "Existing game selected. Its information has been loaded.";
  } else {
    selectedGameSlug = "__new__";
    setValue("gameName", typedName);
    for (const key of ["year", "genre", "description", "coverUrl", "launchboxUrl"]) setValue(key, "");
    $("game-name").readOnly = false;
    gameSelectionHint.textContent = typedName ? "New game — it will be created when you save the port." : "Choose an existing game or enter a new name.";
  }
}

gameSearch.addEventListener("input", updateGameSelection);
gameSearch.addEventListener("change", updateGameSelection);
$("new-port-button").addEventListener("click", () => openEditor());
$("cancel-edit").addEventListener("click", () => { editor.hidden = true; editing = null; });
searchInput.addEventListener("input", renderList);
logoutButton.addEventListener("click", lock);

authForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  showMessage(authError, "Checking access…");
  try {
    await unlock(secretInput.value.trim());
    showMessage(authError, "");
  } catch (error) {
    secret = "";
    showMessage(authError, error.message, true);
  }
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!editing) updateGameSelection();
  if (!editing && selectedGameSlug === "__new__" && !value("gameName")) {
    showMessage(formMessage, "Enter a game name.", true);
    return;
  }
  saveButton.disabled = true;
  showMessage(formMessage, "Saving…");
  const payload = {};
  for (const [key, id] of Object.entries(fields)) payload[key] = value(id);
  payload.gameSlug = editing ? editing.gameSlug : selectedGameSlug;
  payload.originalPortId = editing ? editing.portId : "";
  try {
    await api("/admin/ports/save", { method: "POST", body: JSON.stringify(payload) });
    const data = await api("/admin/ports/list");
    games = data.games || [];
    ports = data.ports || [];
    platformOrder = data.platforms || [];
    renderList();
    populateOptions();
    editor.hidden = true;
    editing = null;
    showMessage($("global-message"), "Port saved.");
  } catch (error) {
    showMessage(formMessage, error.message, true);
  } finally {
    saveButton.disabled = false;
  }
});

const savedSecret = sessionStorage.getItem(SECRET_KEY);
if (savedSecret) {
  unlock(savedSecret).catch((error) => {
    lock();
    showMessage(authError, error.message, true);
  });
}
