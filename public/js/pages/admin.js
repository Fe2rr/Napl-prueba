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
const gameSelect = $("game-select");
const platformOptions = $("platform-options");

let secret = "";
let games = [];
let ports = [];
let editing = null;

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
  authPanel.hidden = true;
  adminPanel.hidden = false;
  logoutButton.hidden = false;
  renderList();
  populateGameOptions();
}

function populateGameOptions(selected = "") {
  gameSelect.replaceChildren();
  const existing = document.createElement("option");
  existing.value = "__new__";
  existing.textContent = "＋ Create a new game";
  gameSelect.append(existing);
  for (const game of games) {
    const option = document.createElement("option");
    option.value = game.slug;
    option.textContent = game.name;
    gameSelect.append(option);
  }
  gameSelect.value = selected || "__new__";
  const platforms = [...new Set(ports.map((p) => p.platform).filter(Boolean))].sort();
  platformOptions.replaceChildren(...platforms.map((platform) => {
    const option = document.createElement("option");
    option.value = platform;
    return option;
  }));
}

function renderList() {
  const query = searchInput.value.trim().toLowerCase();
  const filtered = ports.filter((port) => [
    port.gameName, port.platform, port.portId, port.project, port.developer
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
  const fragment = document.createDocumentFragment();
  for (const port of filtered) {
    const row = document.createElement("article");
    row.className = "port-row";
    const main = document.createElement("div");
    main.className = "port-main";
    const name = document.createElement("div");
    name.className = "port-name";
    name.textContent = port.gameName;
    const meta = document.createElement("div");
    meta.className = "port-meta";
    meta.textContent = [port.platform, port.project, port.portId].filter(Boolean).join(" · ");
    main.append(name, meta);
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "button secondary";
    edit.textContent = "Edit";
    edit.addEventListener("click", () => openEditor(port));
    row.append(main, edit);
    fragment.append(row);
  }
  list.append(fragment);
}

function openEditor(port = null) {
  editing = port ? { gameSlug: port.gameSlug, portId: port.portId } : null;
  form.reset();
  showMessage(formMessage, "");
  $("editor-title").textContent = port ? "Edit port" : "Add port";
  saveButton.textContent = port ? "Save changes" : "Add port";
  populateGameOptions(port?.gameSlug || "__new__");
  if (port) {
    for (const [key, id] of Object.entries(fields)) setValue(key, port[key]);
    gameSelect.disabled = true;
    $("port-id").readOnly = true;
  } else {
    gameSelect.disabled = false;
    $("port-id").readOnly = false;
    setValue("dateAdded", new Date().toISOString().slice(0, 19).replace("T", " "));
  }
  updateGameFields();
  editor.hidden = false;
  editor.scrollIntoView({ behavior: "smooth", block: "start" });
}

function updateGameFields() {
  const selected = games.find((game) => game.slug === gameSelect.value);
  const isNew = gameSelect.value === "__new__";
  $("game-name").disabled = !isNew && !editing;
  if (selected && !editing) {
    setValue("gameName", selected.name);
    setValue("year", selected.year);
    setValue("genre", selected.genre);
    setValue("description", selected.description);
    setValue("coverUrl", selected.cover_url);
    setValue("launchboxUrl", selected.launchbox_url);
  } else if (isNew && !editing) {
    for (const key of ["gameName", "year", "genre", "description", "coverUrl", "launchboxUrl"]) setValue(key, "");
    $("game-name").disabled = false;
  } else if (editing) {
    $("game-name").disabled = false;
  }
}

gameSelect.addEventListener("change", updateGameFields);
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
  saveButton.disabled = true;
  showMessage(formMessage, "Saving…");
  const payload = {};
  for (const [key, id] of Object.entries(fields)) payload[key] = value(id);
  payload.gameSlug = editing ? editing.gameSlug : gameSelect.value;
  try {
    await api("/admin/ports/save", { method: "POST", body: JSON.stringify(payload) });
    const data = await api("/admin/ports/list");
    games = data.games || [];
    ports = data.ports || [];
    renderList();
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
