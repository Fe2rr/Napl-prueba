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
const deleteButton = $("delete-port-button");
const gameSearch = $("game-name");
const gameSuggestions = $("game-suggestions");
const projectSearch = $("project");
const projectSuggestions = $("project-suggestions");
const gameSelectionHint = $("game-selection-hint");
const platformSelect = $("platform-select");
const platformNew = $("platform-new");

let secret = "";
let games = [];
let ports = [];
let platformOrder = [];
let editing = null;
let selectedGameSlug = "__new__";
let originalLastUpdate = "";

const fields = {
  gameName: "game-name", year: "game-year", genre: "game-genre",
  description: "game-description", coverUrl: "cover-url", launchboxUrl: "launchbox-url", visits: "visits",
  portId: "port-id", platform: "platform", project: "project", link: "link",
  url: "port-url", developer: "developer", version: "version",
  lastUpdate: "last-update", dateAdded: "date-added", needsFiles: "needs-files",
  dataUrl: "data-url", notes: "notes",
  inputMethods: "input-methods"
};

function value(id) { return $(id).value.trim(); }
function setValue(key, val = "") { $(fields[key]).value = val ?? ""; }

function getMontevideoTimestamp() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Montevideo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}:${values.second}`;
}

function dateOnly(value) {
  return String(value ?? "").trim().replace(/^(\d{4}-\d{2}-\d{2})[ T].*$/, "$1");
}

function updateCoverPreview() {
  const url = value(fields.coverUrl);
  const image = $("cover-preview");
  const placeholder = $("cover-placeholder");
  if (/^https?:\/\/\S+$/i.test(url)) {
    image.src = url;
    image.hidden = false;
    placeholder.hidden = true;
    image.onerror = () => {
      image.hidden = true;
      placeholder.hidden = false;
    };
  } else {
    image.removeAttribute("src");
    image.hidden = true;
    placeholder.hidden = false;
  }
}
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

const maintenanceButtons = [...document.querySelectorAll("[data-maintenance-action]")];
const maintenanceStatus = $("maintenance-status");
let maintenanceRunning = false;

function summarizeMaintenance(action, data) {
  const errors = Array.isArray(data.errors) ? data.errors : [];
  const parts = [];
  if (action === "update-github-versions") {
    parts.push(`${data.updatedRows ?? 0} ports updated`, `${data.versionRows ?? 0} versions`, `${data.dateRows ?? 0} dates`);
    parts.push(`${data.withoutVersion ?? 0} repos without releases/tags`);
  } else if (action === "update-developers") {
    parts.push(`${data.updatedRows ?? 0} developers completed`, `${data.scannedRows ?? 0} ports scanned`);
  } else if (action === "update-launchbox-data") {
    parts.push(`${data.updatedGames ?? 0} games updated`, `${data.filledFields ?? 0} fields completed`, `${data.candidates ?? 0} candidates`);
  } else if (action === "sync-catalog-cache") {
    parts.push(`${data.games ?? 0} games`, `${data.ports ?? 0} ports`, `${data.platforms ?? 0} platforms cached`);
  }
  if (errors.length) {
    const grouped = new Map();
    for (const item of errors) {
      const reason = item.error || "unknown_error";
      if (!grouped.has(reason)) grouped.set(reason, { samples: [], detail: "" });
      const group = grouped.get(reason);
      group.samples.push(item.game || item.repository || item.slug || item.appId || "unknown");
      if (!group.detail && item.detail) group.detail = item.detail;
    }
    for (const [reason, group] of grouped) {
      const preview = group.samples.slice(0, 3).join(", ");
      const detail = group.detail ? " — " + group.detail : "";
      parts.push(reason + ": " + group.samples.length + (preview ? " (" + preview + ")" : "") + detail);
    }
  }
  return parts.join(" · ");
}

async function runMaintenance(action, button) {
  if (maintenanceRunning) return;
  maintenanceRunning = true;
  maintenanceButtons.forEach((item) => { item.disabled = true; });
  const originalLabel = button.textContent;
  button.textContent = "Running…";
  maintenanceStatus.classList.remove("error");
  maintenanceStatus.textContent = "The update is running. Keep this page open until it finishes.";
  try {
    let data;
    if (action === "update-github-versions") {
      const totals = {
        success: true, uniqueRepositories: 0, processedRepositories: 0,
        repositoriesWithVersion: 0, withoutVersion: 0,
        updatedRows: 0, versionRows: 0, dateRows: 0, errors: []
      };
      let offset = 0;
      let complete = false;
      do {
        const chunk = await api(`/admin/${action}`, {
          method: "POST",
          body: JSON.stringify({ offset })
        });
        totals.uniqueRepositories = chunk.uniqueRepositories ?? totals.uniqueRepositories;
        totals.processedRepositories += chunk.processedRepositories ?? 0;
        totals.repositoriesWithVersion += chunk.repositoriesWithVersion ?? 0;
        totals.withoutVersion += chunk.withoutVersion ?? 0;
        totals.updatedRows += chunk.updatedRows ?? 0;
        totals.versionRows += chunk.versionRows ?? 0;
        totals.dateRows += chunk.dateRows ?? 0;
        totals.errors.push(...(Array.isArray(chunk.errors) ? chunk.errors : []));
        offset = chunk.nextOffset ?? offset;
        complete = Boolean(chunk.complete);
        maintenanceStatus.textContent =
          `Updating GitHub releases: ${totals.processedRepositories}/${totals.uniqueRepositories} repositories processed…`;
        if (!complete && !chunk.processedRepositories) {
          throw new Error("The GitHub updater returned an empty batch before completion.");
        }
      } while (!complete);
      data = totals;
    } else {
      data = await api(`/admin/${action}`, { method: "POST" });
    }
    maintenanceStatus.textContent = `Completed: ${summarizeMaintenance(action, data)}`;
  } catch (error) {
    maintenanceStatus.textContent = `Update failed: ${error.message}`;
    maintenanceStatus.classList.add("error");
  } finally {
    button.textContent = originalLabel;
    maintenanceButtons.forEach((item) => { item.disabled = false; });
    maintenanceRunning = false;
  }
}

maintenanceButtons.forEach((button) => {
  button.addEventListener("click", () => runMaintenance(button.dataset.maintenanceAction, button));
});

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
        .slice(0, 6)
    : [];

  gameSuggestions.replaceChildren();
  for (const game of matches) {
    const option = document.createElement("button");
    option.type = "button";
    option.className = "game-suggestion";
    option.textContent = game.name;
    option.addEventListener("pointerdown", (event) => event.preventDefault());
    option.addEventListener("click", () => {
      gameSearch.value = game.name;
      updateGameSelection();
      gameSuggestions.hidden = true;
    });
    gameSuggestions.append(option);
  }
  gameSuggestions.hidden = !matches.length || !normalizedQuery;
}

function getMultiAppOptions(query = "") {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const candidates = ports.filter((port) =>
    ["multi-game apps", "multi game apps"].includes(String(port.platform || "").trim().toLocaleLowerCase().replace(/\s+/g, " ")) &&
    String(port.gameName || "").trim()
  );

  const byApp = new Map();
  for (const port of candidates) {
    const name = String(port.gameName).trim();
    const key = name.toLocaleLowerCase();
    const completeness = ["link", "url", "version", "developer", "needsFiles", "inputMethods", "lastUpdate"]
      .filter((field) => String(port[field] ?? "").trim()).length;
    const timestamp = Date.parse(String(port.lastUpdate || "").replace(" ", "T")) || 0;
    const current = byApp.get(key);
    if (!current || completeness > current.completeness ||
        (completeness === current.completeness && timestamp > current.timestamp)) {
      byApp.set(key, { name, port, completeness, timestamp });
    }
  }

  return [...byApp.values()]
    .filter((item) => !normalizedQuery || item.name.toLocaleLowerCase().includes(normalizedQuery))
    .sort((a, b) => {
      const aStarts = a.name.toLocaleLowerCase().startsWith(normalizedQuery);
      const bStarts = b.name.toLocaleLowerCase().startsWith(normalizedQuery);
      if (aStarts !== bStarts) return aStarts ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    })
    .slice(0, 8);
}

function populateProjectOptions(query = "") {
  const matches = getMultiAppOptions(query);
  projectSuggestions.replaceChildren();

  for (const item of matches) {
    const option = document.createElement("button");
    option.type = "button";
    option.className = "game-suggestion";
    option.textContent = item.name;
    option.addEventListener("pointerdown", (event) => event.preventDefault());
    option.addEventListener("click", () => {
      projectSearch.value = item.name;
      const port = item.port;
      setValue("link", port.link);
      setValue("url", port.url);
      setValue("version", port.version);
      setValue("developer", port.developer);
      setValue("needsFiles", port.needsFiles);
      setValue("inputMethods", port.inputMethods);
      setValue("lastUpdate", dateOnly(port.lastUpdate));
      originalLastUpdate = String(port.lastUpdate || "").trim();
      $("use-current-time").checked = false;
      projectSuggestions.hidden = true;
      showMessage(formMessage, `Multi App template loaded: ${item.name}`);
    });
    projectSuggestions.append(option);
  }

  projectSuggestions.hidden = !matches.length;
}

function populatePlatformOptions(selectedPlatform = "") {
  const availablePlatforms = [...new Set([...platformOrder, ...ports.map((p) => p.platform).filter(Boolean)])]
    .sort((a, b) => a.localeCompare(b));
  platformSelect.replaceChildren(new Option("Select a platform…", ""));
  for (const platform of availablePlatforms) platformSelect.add(new Option(platform, platform));
  platformSelect.add(new Option("＋ Add new platform…", "__new__"));
  if (selectedPlatform && availablePlatforms.includes(selectedPlatform)) {
    platformSelect.value = selectedPlatform;
    platformNew.hidden = true;
    platformNew.value = "";
    $("platform").value = selectedPlatform;
  } else if (selectedPlatform) {
    platformSelect.value = "__new__";
    platformNew.hidden = false;
    platformNew.value = selectedPlatform;
    $("platform").value = selectedPlatform;
  } else {
    platformSelect.value = "";
    platformNew.hidden = true;
    platformNew.value = "";
    $("platform").value = "";
  }
}

function populateOptions(selectedName = "", selectedPlatform = "") {
  gameSearch.value = selectedName;
  populateGameOptions(selectedName);
  populatePlatformOptions(selectedPlatform);
}

function getDownloadLabel(port) {
  return String(port.link || port.project || port.portId || "Download").trim();
}

function isGitHubPort(port) {
  return [port.url].some((candidate) => {
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
  const destination = port.url;
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
    const isOthersPlatform = ["other", "others"].includes(normalizePlatform(platform));
    const getSource = (port) => {
      const sourceText = [port.url, port.link, port.project].filter(Boolean).join(" ").toLowerCase();
      if (/github\.com|github\.io/.test(sourceText)) return "GitHub";
      if (/\b(t\.me|telegram\.me|telegram\.org)\b/.test(sourceText)) return "Telegram";
      if (/\b(discord\.gg|discord\.com|discordapp\.com)\b/.test(sourceText)) return "Discord";
      if (/\bitch\.io\b/.test(sourceText)) return "itch.io";
      return "Other sources";
    };
    const compareText = (a, b) => String(a || "").trim().localeCompare(
      String(b || "").trim(),
      undefined,
      { sensitivity: "base", numeric: true }
    );

    if (isOthersPlatform) {
      const sourceOrder = ["Telegram", "Discord", "itch.io", "Other sources", "GitHub"];
      const sourceGroups = new Map(sourceOrder.map((source) => [source, []]));
      for (const port of categoryPorts) sourceGroups.get(getSource(port)).push(port);

      const availableSources = sourceOrder.filter((source) => sourceGroups.get(source).length);
      const tabs = document.createElement("div");
      tabs.className = "others-source-tabs";
      tabs.setAttribute("role", "tablist");
      tabs.setAttribute("aria-label", "Port sources");
      const panels = document.createElement("div");
      panels.className = "others-source-panels";

      availableSources.forEach((source, sourceIndex) => {
        const items = sourceGroups.get(source);
        const platformId = normalizePlatform(platform).replace(/[^a-z0-9]+/g, "-");
        const tabId = `others-${platformId}-tab-${sourceIndex}`;
        const panelId = `${tabId}-panel`;

        const tab = document.createElement("button");
        tab.type = "button";
        tab.className = "others-source-tab";
        tab.id = tabId;
        tab.setAttribute("role", "tab");
        tab.setAttribute("aria-controls", panelId);
        tab.setAttribute("aria-selected", sourceIndex === 0 ? "true" : "false");
        tab.tabIndex = sourceIndex === 0 ? 0 : -1;
        const tabLabel = document.createElement("span");
        tabLabel.textContent = source;
        const tabCount = document.createElement("span");
        tabCount.className = "source-tab-count";
        tabCount.textContent = String(items.length);
        tab.append(tabLabel, tabCount);
        tabs.append(tab);

        const panel = document.createElement("div");
        panel.className = "others-source-panel";
        panel.id = panelId;
        panel.setAttribute("role", "tabpanel");
        panel.setAttribute("aria-labelledby", tabId);
        panel.hidden = sourceIndex !== 0;

        const byDeveloper = new Map();
        for (const port of items) {
          const developer = String(port.developer || "").trim() || "Unknown developer";
          if (!byDeveloper.has(developer)) byDeveloper.set(developer, []);
          byDeveloper.get(developer).push(port);
        }

        const developers = [...byDeveloper.keys()].sort(compareText);
        for (const developer of developers) {
          const group = document.createElement("section");
          group.className = "developer-group";
          const heading = document.createElement("h4");
          heading.className = "developer-group-heading";
          heading.textContent = developer;
          const developerPorts = byDeveloper.get(developer);
          const sortedPorts = source === "GitHub"
            ? [...developerPorts].sort((a, b) => compareText(a.project || getDownloadLabel(a), b.project || getDownloadLabel(b)))
            : [...developerPorts].sort((a, b) => compareText(getDownloadLabel(a), getDownloadLabel(b)));
          group.append(heading);
          for (const port of sortedPorts) group.append(makePortRow(port));
          panel.append(group);
        }

        tab.addEventListener("click", () => {
          tabs.querySelectorAll('[role="tab"]').forEach((otherTab) => {
            const selected = otherTab === tab;
            otherTab.setAttribute("aria-selected", selected ? "true" : "false");
            otherTab.tabIndex = selected ? 0 : -1;
          });
          panels.querySelectorAll('[role="tabpanel"]').forEach((otherPanel) => {
            otherPanel.hidden = otherPanel !== panel;
          });
        });

        panels.append(panel);
      });

      body.append(tabs, panels);
    } else {
      const otherLinks = categoryPorts.filter((port) => !isGitHubPort(port));
      const githubLinks = categoryPorts.filter(isGitHubPort);
      const sortByDownloadLabel = (a, b) => compareText(getDownloadLabel(a), getDownloadLabel(b));

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
    }
    details.append(body);
    fragment.append(details);
  }
  list.append(fragment);
}

function openEditor(port = null) {
  editing = port ? { gameSlug: port.gameSlug, portId: port.portId } : null;
  originalLastUpdate = String(port?.lastUpdate || "").trim();
  form.reset();
  showMessage(formMessage, "");
  $("editor-title").textContent = port ? "Edit port" : "Add port";
  saveButton.textContent = port ? "Save changes" : "Add port";
  deleteButton.hidden = !port;
  populateOptions(port?.gameName || "", port?.platform || "");
  selectedGameSlug = port?.gameSlug || "__new__";

  if (port) {
    for (const [key] of Object.entries(fields)) setValue(key, port[key]);
    setValue("lastUpdate", dateOnly(port.lastUpdate));
    $("unofficial-port").checked = /-unofficial-port(?:-\d+)?$/i.test(port.portId || "");
    gameSearch.disabled = false;
    $("game-name").readOnly = false;
    gameSuggestions.hidden = true;
    $("port-id").readOnly = false;
    gameSelectionHint.textContent = "Edit the game name if needed. The port remains linked to this game record.";
  } else {
    gameSearch.disabled = false;
    $("game-name").readOnly = false;
    $("port-id").readOnly = false;
    setValue("dateAdded", new Date().toISOString().slice(0, 19).replace("T", " "));
    gameSelectionHint.textContent = "Choose an existing game from the suggestions, or type a new name.";
  }
  updateCoverPreview();
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
    setValue("visits", selected.visits);
    updateCoverPreview();
    $("game-name").readOnly = true;
    gameSelectionHint.textContent = "Existing game selected. Its information has been loaded.";
  } else {
    selectedGameSlug = "__new__";
    setValue("gameName", typedName);
    for (const key of ["year", "genre", "description", "coverUrl", "launchboxUrl"]) setValue(key, "");
    setValue("visits", 0);
    updateCoverPreview();
    $("game-name").readOnly = false;
    gameSelectionHint.textContent = typedName ? "New game — it will be created when you save the port." : "Choose an existing game or enter a new name.";
  }
}

projectSearch.addEventListener("input", () => populateProjectOptions(projectSearch.value));
projectSearch.addEventListener("focus", () => populateProjectOptions(projectSearch.value));
projectSearch.addEventListener("blur", () => {
  window.setTimeout(() => { projectSuggestions.hidden = true; }, 120);
});
$("cover-url").addEventListener("input", updateCoverPreview);
gameSearch.addEventListener("input", updateGameSelection);
gameSearch.addEventListener("focus", () => populateGameOptions(gameSearch.value));
gameSearch.addEventListener("change", updateGameSelection);
gameSearch.addEventListener("blur", () => { window.setTimeout(() => { gameSuggestions.hidden = true; }, 120); });
platformSelect.addEventListener("change", () => {
  const addingNew = platformSelect.value === "__new__";
  platformNew.hidden = !addingNew;
  if (addingNew) {
    $("platform").value = platformNew.value.trim();
    platformNew.focus();
  } else {
    platformNew.value = "";
    $("platform").value = platformSelect.value;
  }
});
platformNew.addEventListener("input", () => { $("platform").value = platformNew.value.trim(); });
$("new-port-button").addEventListener("click", () => openEditor());
$("cancel-edit").addEventListener("click", () => { editor.hidden = true; editing = null; });
searchInput.addEventListener("input", renderList);
logoutButton.addEventListener("click", lock);

deleteButton.addEventListener("click", async () => {
  if (!editing || deleteButton.disabled) return;
  const port = ports.find((item) => item.gameSlug === editing.gameSlug && item.portId === editing.portId);
  const label = port ? `${port.gameName} — ${port.project || port.portId}` : editing.portId;
  if (!window.confirm(`Delete only this port entry?\n\n${label}\n\nThe game and its other ports will remain unchanged.`)) return;

  deleteButton.disabled = true;
  deleteButton.textContent = "Deleting…";
  showMessage(formMessage, "Deleting port…");
  try {
    await api("/admin/ports/delete", {
      method: "POST",
      body: JSON.stringify({ gameSlug: editing.gameSlug, portId: editing.portId })
    });
    const data = await api("/admin/ports/list");
    games = data.games || [];
    ports = data.ports || [];
    platformOrder = data.platforms || [];
    renderList();
    populateOptions();
    editor.hidden = true;
    editing = null;
    showMessage($("global-message"), "Port deleted. Other ports and the game were preserved.");
  } catch (error) {
    showMessage(formMessage, error.message, true);
  } finally {
    deleteButton.disabled = false;
    deleteButton.textContent = "Delete this port";
  }
});

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
  if (platformSelect.value === "__new__") $("platform").value = platformNew.value.trim();
  else $("platform").value = platformSelect.value;
  if (!editing) updateGameSelection();
  if (!editing && selectedGameSlug === "__new__" && !value(fields.gameName)) {
    showMessage(formMessage, "Enter a game name.", true);
    return;
  }
  saveButton.disabled = true;
  showMessage(formMessage, "Saving…");
  const payload = {};
  for (const [key, id] of Object.entries(fields)) payload[key] = value(id);
  const enteredLastUpdate = dateOnly(payload.lastUpdate);
  const originalDate = dateOnly(originalLastUpdate);
  payload.lastUpdate = $("use-current-time").checked
    ? getMontevideoTimestamp()
    : (originalLastUpdate && enteredLastUpdate === originalDate
      ? originalLastUpdate
      : enteredLastUpdate);
  payload.gameSlug = editing ? editing.gameSlug : selectedGameSlug;
  payload.originalPortId = editing ? editing.portId : "";
  payload.isUnofficialPort = $("unofficial-port").checked;
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
