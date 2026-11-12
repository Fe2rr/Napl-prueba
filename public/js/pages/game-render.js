/*
 * NAPL — GAME DETAIL RENDERER
 *
 * Renders game summary, port cards, multi-game app lists and ratings.
 * All rating styles live in assets/css/game.css (no CSS injected in JS).
 */

import { restoreDescriptionLineBreaks } from "../core/helpers.js";
import {
    isMultiGameApp,
    isMultiGameAppPort,
    findGamesUsingApp,
    createGamesUsingAppSection,
} from "../components/multi-game-apps.js";
import {
    loadDevices,
    searchDevices,
    getStoredUserDevice,
    setStoredUserDevice,
} from "../services/compatibility.js";


let ratingPopoverEventsInitialized = false;

function parseLastUpdate(value) {
    const raw = String(value || "").trim();
    if (!raw) return 0;

    // D1 stores timestamps as Montevideo local time without a timezone suffix.
    const localMatch = raw.match(/^(\\d{4}-\\d{2}-\\d{2})[ T](\\d{2}:\\d{2}(?::\\d{2})?)$/);
    if (localMatch) {
        const time = localMatch[2].length === 5 ? `${localMatch[2]}:00` : localMatch[2];
        const timestamp = Date.parse(`${localMatch[1]}T${time}-03:00`);
        return Number.isFinite(timestamp) ? timestamp : 0;
    }

    const timestamp = Date.parse(raw);
    return Number.isFinite(timestamp) ? timestamp : 0;
}

function closeRatingPopover(container) {
    if (!container) return;

    const popover = container.querySelector(".port-rating-popover");
    const button = container.querySelector(".port-rating-button");
    const trigger = container.querySelector(".port-rating-trigger");

    if (popover) popover.hidden = true;
    if (button) button.setAttribute("aria-expanded", "false");
    if (trigger) trigger.classList.remove("is-open");
}

function closeCompatibilityPopover(container) {
    if (!container) return;

    const popover = container.querySelector(".port-compat-popover");
    const button = container.querySelector(".port-compat-button");
    const trigger = container.querySelector(".port-compat-trigger");

    if (popover) popover.hidden = true;
    if (button) button.setAttribute("aria-expanded", "false");
    if (trigger) trigger.classList.remove("is-open");
}

function closeReportLinkPopover(container) {
    if (!container) return;

    const popover = container.querySelector(".port-report-link-popover");
    const button = container.querySelector(".port-report-link-button");

    if (popover) popover.hidden = true;
    if (button) button.setAttribute("aria-expanded", "false");
    container.classList.remove("is-open");
}

function initializeRatingPopoverEvents() {
    if (ratingPopoverEventsInitialized) return;
    ratingPopoverEventsInitialized = true;

    document.addEventListener("click", (event) => {
        const clickedRating = event.target.closest(".port-rating");
        document.querySelectorAll(".port-rating").forEach((container) => {
            if (container !== clickedRating) {
                closeRatingPopover(container);
            }
        });

        const clickedCompat = event.target.closest(".port-compat");
        document.querySelectorAll(".port-compat").forEach((container) => {
            if (container !== clickedCompat) {
                closeCompatibilityPopover(container);
            }
        });

        const clickedReportLink = event.target.closest(
            ".port-report-link-trigger"
        );
        document
            .querySelectorAll(".port-report-link-trigger")
            .forEach((container) => {
                if (container !== clickedReportLink) {
                    closeReportLinkPopover(container);
                }
            });
    });

    document.addEventListener("keydown", (event) => {
        if (event.key !== "Escape") return;
        document.querySelectorAll(".port-rating").forEach((container) => {
            closeRatingPopover(container);
        });
        document.querySelectorAll(".port-compat").forEach((container) => {
            closeCompatibilityPopover(container);
        });
        document
            .querySelectorAll(".port-report-link-trigger")
            .forEach((container) => {
                closeReportLinkPopover(container);
            });
    });
}

function createRatingStars(average) {
    const stars = document.createElement("span");
    stars.className = "port-rating-stars";
    stars.setAttribute("aria-label", `${average.toFixed(1)} out of 5`);

    for (let i = 1; i <= 5; i++) {
        const star = document.createElement("span");
        star.className = "port-rating-star";
        star.textContent = "★";

        const fill = document.createElement("span");
        fill.className = "port-rating-star-fill";
        fill.textContent = "★";

        const percentage = Math.max(
            0,
            Math.min(100, (average - i + 1) * 100)
        );
        fill.style.width = `${percentage}%`;

        star.appendChild(fill);
        stars.appendChild(star);
    }

    return stars;
}

function createPortRating(port, ratings, ratingActions) {
    if (!port.portId) return null;

    const container = document.createElement("div");
    container.className = "port-rating";

    let currentRating = ratings?.[port.portId] || {};
    let starsElement = createRatingStars(Number(currentRating.avg) || 0);
    container.appendChild(starsElement);

    const averageElement = document.createElement("span");
    averageElement.className = "port-rating-average";

    const countElement = document.createElement("span");
    countElement.className = "port-rating-count";

    function updateRatingDisplay(rating) {
        currentRating = rating || {};
        const average = Number(currentRating.avg) || 0;
        const votes = Number(currentRating.votes) || 0;

        const newStars = createRatingStars(votes > 0 ? average : 0);
        starsElement.replaceWith(newStars);
        starsElement = newStars;

        averageElement.textContent = votes > 0 ? average.toFixed(1) : "—";
        countElement.textContent = `(${votes})`;
        countElement.title = `${votes} ${votes === 1 ? "vote" : "votes"}`;
    }

    updateRatingDisplay(currentRating);
    container.append(averageElement, countElement);

    const rateButton = document.createElement("button");
    rateButton.type = "button";
    rateButton.className = "port-rating-button";
    rateButton.textContent = "Rate";
    rateButton.setAttribute("aria-expanded", "false");

    const popover = document.createElement("div");
    popover.className = "port-rating-popover";
    popover.hidden = true;

    const heading = document.createElement("h4");
    heading.className = "port-rating-popover-title";
    heading.textContent = "Rate this port";

    const description = document.createElement("p");
    description.className = "port-rating-popover-description";
    description.textContent = "Choose your rating";

    popover.append(heading, description);

    const options = [
        "AI Slop",
        "Just emulate it bro",
        "Decent",
        "Good Port",
        "Gem",
    ];

    let selectedRating = 0;
    let previousRating = 0;
    let loadingVote = false;
    let submitting = false;

    const optionButtons = [];
    const submit = document.createElement("button");
    submit.type = "button";
    submit.className = "port-rating-submit";
    submit.textContent = "Submit vote";
    submit.disabled = true;

    const feedback = document.createElement("p");
    feedback.className = "port-rating-feedback";
    feedback.textContent = "Select one of the five options.";

    function setFeedback(message, type = "") {
        feedback.className = "port-rating-feedback";
        if (type) feedback.classList.add(type);
        feedback.textContent = message;
    }

    function updateSubmitButton() {
        submit.disabled = !selectedRating || loadingVote || submitting;
        submit.textContent =
            previousRating > 0 ? "Update vote" : "Submit vote";
    }

    function selectRating(score) {
        selectedRating = score;
        optionButtons.forEach((button, idx) => {
            button.classList.toggle("selected", idx + 1 === score);
        });
        updateSubmitButton();
        setFeedback(`Selected: ${options[score - 1]}`);
    }

    options.forEach((label, index) => {
        const score = index + 1;
        const option = document.createElement("button");
        option.type = "button";
        option.className = "port-rating-option";

        const optionLabel = document.createElement("span");
        optionLabel.textContent = label;

        const optionStars = document.createElement("span");
        optionStars.className = "port-rating-option-stars";
        optionStars.textContent = "★".repeat(score);

        option.append(optionLabel, optionStars);
        option.addEventListener("click", () => {
            if (loadingVote || submitting) return;
            selectRating(score);
        });

        optionButtons.push(option);
        popover.appendChild(option);
    });

    async function loadPreviousVote() {
        if (!ratingActions?.getMyVote) {
            setFeedback("Rating service is unavailable.", "error");
            return;
        }

        loadingVote = true;
        selectedRating = 0;
        optionButtons.forEach((btn) => {
            btn.classList.remove("selected");
            btn.disabled = true;
        });
        updateSubmitButton();
        setFeedback("Loading your previous vote...");

        try {
            const vote = await ratingActions.getMyVote(port.portId);
            previousRating = Number(vote) || 0;

            if (
                Number.isInteger(previousRating) &&
                previousRating >= 1 &&
                previousRating <= 5
            ) {
                selectedRating = previousRating;
                optionButtons[previousRating - 1].classList.add("selected");
                setFeedback(
                    `Your current rating: ${options[previousRating - 1]}`
                );
            } else {
                previousRating = 0;
                selectedRating = 0;
                setFeedback("Select one of the five options.");
            }
        } catch (error) {
            console.error("Could not load previous vote:", error);
            previousRating = 0;
            selectedRating = 0;
            setFeedback(
                error.message || "Could not load your previous vote.",
                "error"
            );
        } finally {
            loadingVote = false;
            optionButtons.forEach((btn) => {
                btn.disabled = false;
            });
            updateSubmitButton();
        }
    }

    submit.addEventListener("click", async () => {
        if (
            !selectedRating ||
            submitting ||
            loadingVote ||
            !ratingActions?.submitVote
        ) {
            return;
        }

        submitting = true;
        optionButtons.forEach((btn) => {
            btn.disabled = true;
        });
        updateSubmitButton();
        setFeedback("Sending your rating...");

        try {
            const result = await ratingActions.submitVote(
                port.portId,
                selectedRating
            );
            previousRating = selectedRating;

            if (result?.rating) {
                updateRatingDisplay(result.rating);
            }

            setFeedback("Your rating has been saved!", "success");
            rateButton.textContent = "Rated";
            submit.textContent = "Saved";

            setTimeout(() => {
                closeRatingPopover(container);
                rateButton.textContent = "Rate";
            }, 900);
        } catch (error) {
            console.error("Vote submission failed:", error);
            setFeedback(
                error.message || "Could not submit your rating.",
                "error"
            );
        } finally {
            submitting = false;
            optionButtons.forEach((btn) => {
                btn.disabled = false;
            });
            updateSubmitButton();
        }
    });

    popover.append(submit, feedback);

    const trigger = document.createElement("div");
    trigger.className = "port-rating-trigger";
    trigger.append(rateButton, popover);

    rateButton.addEventListener("click", async (event) => {
        event.stopPropagation();

        if (!popover.hidden) {
            closeRatingPopover(container);
            return;
        }

        document.querySelectorAll(".port-rating").forEach((other) => {
            if (other !== container) {
                closeRatingPopover(other);
            }
        });

        popover.hidden = false;
        trigger.classList.add("is-open");
        rateButton.setAttribute("aria-expanded", "true");
        await loadPreviousVote();
    });

    container.appendChild(trigger);
    return container;
}

function createPortCompatibility(port, compatibility, compatibilityActions) {
    if (!port.portId) return null;

    const container = document.createElement("div");
    container.className = "port-compat";

    let summary = compatibility?.[port.portId] || {
        yes: 0,
        no: 0,
        reports: [],
    };

    const bar = document.createElement("div");
    bar.className = "port-compat-bar";

    const summaryGroup = document.createElement("div");
    summaryGroup.className = "port-compat-summary-group";

    const summaryTitle = document.createElement("span");
    summaryTitle.className = "port-compat-title";
    summaryTitle.textContent = "Works";

    const summaryText = document.createElement("span");
    summaryText.className = "port-compat-summary";

    summaryGroup.append(summaryTitle, summaryText);

    const actionsGroup = document.createElement("div");
    actionsGroup.className = "port-compat-actions";

    const toggleListButton = document.createElement("button");
    toggleListButton.type = "button";
    toggleListButton.className = "port-compat-toggle";
    toggleListButton.setAttribute("aria-expanded", "false");

    const meter = document.createElement("div");
    meter.className = "port-compat-meter";
    meter.setAttribute("role", "img");

    const meterYes = document.createElement("div");
    meterYes.className = "port-compat-meter-yes";

    const meterNo = document.createElement("div");
    meterNo.className = "port-compat-meter-no";

    meter.append(meterYes, meterNo);

    const listElement = document.createElement("div");
    listElement.className = "port-compat-list";
    listElement.hidden = true;

    function renderCompatibilitySummary(nextSummary) {
        summary = nextSummary || { yes: 0, no: 0, reports: [] };
        const yesCount = Number(summary.yes) || 0;
        const noCount = Number(summary.no) || 0;
        const total = yesCount + noCount;

        if (total === 0) {
            summaryText.textContent = "No votes yet";
            summaryText.classList.add("is-empty");
            meter.classList.add("is-empty");
            meterYes.style.width = "50%";
            meterNo.style.width = "50%";
            meter.setAttribute("aria-label", "No compatibility votes yet");
        } else {
            const yesPct = Math.round((yesCount / total) * 100);
            const noPct = 100 - yesPct;
            summaryText.textContent = `${yesPct}% (${yesCount} Yes · ${noCount} No)`;
            summaryText.classList.remove("is-empty");
            meter.classList.remove("is-empty");
            meterYes.style.width = `${yesPct}%`;
            meterNo.style.width = `${noPct}%`;
            meter.setAttribute(
                "aria-label",
                `${yesPct}% works (${yesCount} yes, ${noCount} no)`
            );
        }

        const reports = Array.isArray(summary.reports) ? summary.reports : [];
        if (reports.length === 0) {
            toggleListButton.hidden = true;
            listElement.hidden = true;
            toggleListButton.setAttribute("aria-expanded", "false");
            listElement.replaceChildren();
        } else {
            toggleListButton.hidden = false;
            toggleListButton.textContent = `Devices (${reports.length})`;
            listElement.replaceChildren();

            for (const item of reports.slice(0, 15)) {
                const row = document.createElement("div");
                row.className = "port-compat-row";

                const name = document.createElement("span");
                name.className = "port-compat-device";
                name.textContent = item.deviceName || item.deviceId;

                const status = document.createElement("span");
                status.className = item.works
                    ? "port-compat-status is-yes"
                    : "port-compat-status is-no";
                status.textContent = item.works ? "Works" : "Doesn't work";

                row.append(name, status);
                listElement.appendChild(row);
            }
        }
    }

    toggleListButton.addEventListener("click", () => {
        const nextHidden = !listElement.hidden;
        listElement.hidden = nextHidden;
        toggleListButton.setAttribute(
            "aria-expanded",
            nextHidden ? "false" : "true"
        );
    });

    const reportButton = document.createElement("button");
    reportButton.type = "button";
    reportButton.className = "port-compat-button";
    reportButton.textContent = "Works?";
    reportButton.setAttribute("aria-expanded", "false");

    const popover = document.createElement("div");
    popover.className = "port-compat-popover";
    popover.hidden = true;

    const title = document.createElement("h4");
    title.className = "port-rating-popover-title";
    title.textContent = "Device compatibility";

    const subtitle = document.createElement("p");
    subtitle.className = "port-rating-popover-description";
    subtitle.textContent = "Does it work on your Android device?";

    const binaryGroup = document.createElement("div");
    binaryGroup.className = "port-compat-binary";

    const yesBtn = document.createElement("button");
    yesBtn.type = "button";
    yesBtn.className = "port-compat-choice";
    yesBtn.textContent = "Yes, works";

    const noBtn = document.createElement("button");
    noBtn.type = "button";
    noBtn.className = "port-compat-choice";
    noBtn.textContent = "No, fails";

    binaryGroup.append(yesBtn, noBtn);

    const deviceField = document.createElement("div");
    deviceField.className = "port-device-field";

    const deviceLabel = document.createElement("label");
    deviceLabel.className = "port-device-label";
    deviceLabel.textContent = "Phone / tablet model (select from list)";

    const deviceInput = document.createElement("input");
    deviceInput.type = "text";
    deviceInput.className = "port-device-input";
    deviceInput.placeholder = "Search model (e.g. Poco F5, Galaxy S23)";
    deviceInput.autocomplete = "off";

    const resultsBox = document.createElement("div");
    resultsBox.className = "port-device-results";
    resultsBox.hidden = true;

    const selectedNote = document.createElement("div");
    selectedNote.className = "port-device-selected";
    selectedNote.hidden = true;

    deviceField.append(deviceLabel, deviceInput, resultsBox, selectedNote);

    const submitBtn = document.createElement("button");
    submitBtn.type = "button";
    submitBtn.className = "port-rating-submit";
    submitBtn.textContent = "Submit report";
    submitBtn.disabled = true;

    const feedback = document.createElement("p");
    feedback.className = "port-rating-feedback";
    feedback.textContent = "Choose Yes/No and select an exact device.";

    popover.append(
        title,
        subtitle,
        binaryGroup,
        deviceField,
        submitBtn,
        feedback
    );

    let selectedWorks = null;
    let selectedDevice = getStoredUserDevice();
    let devicesList = null;
    let loadingDevices = false;
    let submitting = false;

    function setCompatFeedback(message, type = "") {
        feedback.className = "port-rating-feedback";
        if (type) feedback.classList.add(type);
        feedback.textContent = message;
    }

    function updateSelectedDeviceUI() {
        if (selectedDevice) {
            selectedNote.hidden = false;
            selectedNote.textContent = `Selected: ${selectedDevice.name}`;
            if (deviceInput.value !== selectedDevice.name) {
                deviceInput.value = selectedDevice.name;
            }
        } else {
            selectedNote.hidden = true;
            selectedNote.textContent = "";
        }
    }

    function updateCompatSubmitState() {
        submitBtn.disabled =
            submitting ||
            selectedWorks === null ||
            !selectedDevice ||
            !selectedDevice.id;
    }

    updateSelectedDeviceUI();
    updateCompatSubmitState();

    yesBtn.addEventListener("click", () => {
        if (submitting) return;
        selectedWorks = true;
        yesBtn.classList.add("selected", "is-yes");
        noBtn.classList.remove("selected", "is-no");
        updateCompatSubmitState();
    });

    noBtn.addEventListener("click", () => {
        if (submitting) return;
        selectedWorks = false;
        noBtn.classList.add("selected", "is-no");
        yesBtn.classList.remove("selected", "is-yes");
        updateCompatSubmitState();
    });

    async function ensureDevicesLoaded() {
        if (devicesList) return devicesList;
        if (loadingDevices) return null;
        loadingDevices = true;
        setCompatFeedback("Loading Android device database...");
        try {
            devicesList = await loadDevices();
            setCompatFeedback("Choose Yes/No and select an exact device.");
            return devicesList;
        } catch (error) {
            setCompatFeedback(
                error.message || "Could not load device list.",
                "error"
            );
            return null;
        } finally {
            loadingDevices = false;
        }
    }

    function renderDeviceResults(matches) {
        resultsBox.replaceChildren();
        if (!matches || matches.length === 0) {
            resultsBox.hidden = true;
            return;
        }

        for (const device of matches) {
            const option = document.createElement("button");
            option.type = "button";
            option.className = "port-device-option";
            option.textContent = device.name;
            option.addEventListener("click", () => {
                selectedDevice = { id: device.id, name: device.name };
                setStoredUserDevice(selectedDevice);
                resultsBox.hidden = true;
                updateSelectedDeviceUI();
                updateCompatSubmitState();
                setCompatFeedback("Ready to submit.");
            });
            resultsBox.appendChild(option);
        }
        resultsBox.hidden = false;
    }

    deviceInput.addEventListener("input", async () => {
        // Strict rule: typing invalidates any previous selection until clicked from list
        selectedDevice = null;
        updateSelectedDeviceUI();
        updateCompatSubmitState();

        const query = deviceInput.value.trim();
        if (query.length < 2) {
            resultsBox.hidden = true;
            resultsBox.replaceChildren();
            return;
        }

        const list = await ensureDevicesLoaded();
        if (!list) return;

        const matches = searchDevices(list, query, 25);
        if (matches.length === 0) {
            resultsBox.replaceChildren();
            const empty = document.createElement("div");
            empty.className = "port-device-empty";
            empty.textContent = "No matching Android device found.";
            resultsBox.appendChild(empty);
            resultsBox.hidden = false;
            return;
        }

        renderDeviceResults(matches);
    });

    submitBtn.addEventListener("click", async () => {
        if (
            submitting ||
            selectedWorks === null ||
            !selectedDevice ||
            !compatibilityActions?.submitReport
        ) {
            return;
        }

        submitting = true;
        updateCompatSubmitState();
        setCompatFeedback("Saving compatibility report...");

        try {
            const result = await compatibilityActions.submitReport({
                portId: port.portId,
                deviceId: selectedDevice.id,
                works: selectedWorks,
            });

            if (result?.summary) {
                renderCompatibilitySummary(result.summary);
            }

            setCompatFeedback("Report saved!", "success");
            setTimeout(() => {
                closeCompatibilityPopover(container);
            }, 800);
        } catch (error) {
            setCompatFeedback(
                error.message || "Could not save your report.",
                "error"
            );
        } finally {
            submitting = false;
            updateCompatSubmitState();
        }
    });

    const trigger = document.createElement("div");
    trigger.className = "port-compat-trigger";
    trigger.append(reportButton, popover);

    reportButton.addEventListener("click", async (event) => {
        event.stopPropagation();

        if (!popover.hidden) {
            closeCompatibilityPopover(container);
            return;
        }

        document.querySelectorAll(".port-compat").forEach((other) => {
            if (other !== container) closeCompatibilityPopover(other);
        });
        document.querySelectorAll(".port-rating").forEach((other) => {
            closeRatingPopover(other);
        });

        popover.hidden = false;
        trigger.classList.add("is-open");
        reportButton.setAttribute("aria-expanded", "true");
        await ensureDevicesLoaded();
    });

    actionsGroup.append(toggleListButton, trigger);
    bar.append(summaryGroup, actionsGroup);
    container.append(bar, meter, listElement);

    renderCompatibilitySummary(summary);
    return container;
}

function createPortDetail(label, value, url = "") {
    if (!String(value || "").trim()) return null;

    const detail = document.createElement("div");
    detail.className = "port-detail";

    const labelElement = document.createElement("span");
    labelElement.className = "port-detail-label";
    labelElement.textContent = label;

    const hasUrl = /^https?:\/\/\S+$/i.test(String(url || "").trim());
    const valueElement = hasUrl
        ? document.createElement("a")
        : document.createElement("div");

    valueElement.className = "port-detail-value";
    valueElement.textContent = value;

    if (hasUrl) {
        valueElement.href = url;
        valueElement.target = "_blank";
        valueElement.rel = "noopener noreferrer";
    }

    detail.append(labelElement, valueElement);
    return detail;
}

function createExpandableDescription(description) {
    const container = document.createElement("div");
    container.className = "game-summary-description-container";

    const text = document.createElement("p");
    text.className = "game-summary-description";
    text.textContent = restoreDescriptionLineBreaks(description);

    const collapsedStyles = {
        display: "-webkit-box",
        overflow: "hidden",
        WebkitBoxOrient: "vertical",
        WebkitLineClamp: "4",
    };

    Object.assign(text.style, collapsedStyles);
    container.appendChild(text);

    requestAnimationFrame(() => {
        if (!text.isConnected) return;

        const isLong = text.scrollHeight > text.clientHeight + 1;
        if (!isLong) {
            text.style.display = "block";
            text.style.overflow = "visible";
            text.style.webkitLineClamp = "unset";
            return;
        }

        const button = document.createElement("button");
        button.type = "button";
        button.className = "game-description-toggle";
        button.textContent = "Show more";
        button.setAttribute("aria-expanded", "false");

        button.addEventListener("click", () => {
            const expanded = button.getAttribute("aria-expanded") === "true";

            if (expanded) {
                Object.assign(text.style, collapsedStyles);
                button.textContent = "Show more";
                button.setAttribute("aria-expanded", "false");
            } else {
                text.style.display = "block";
                text.style.overflow = "visible";
                text.style.webkitLineClamp = "unset";
                text.style.webkitBoxOrient = "initial";
                button.textContent = "Show less";
                button.setAttribute("aria-expanded", "true");
            }
        });

        container.appendChild(button);
    });

    return container;
}

function displayGameSummary(game, parentElement) {
    parentElement.replaceChildren();
    parentElement.className = "game-header game-summary-card";

    const topRow = document.createElement("div");
    topRow.className = "game-summary-top";

    const coverUrl = String(game.coverUrl || "").trim();
    if (/^https?:\/\/\S+$/i.test(coverUrl)) {
        const cover = document.createElement("img");
        cover.className = "game-summary-cover";
        cover.src = coverUrl;
        cover.alt = `${game.name} cover`;
        cover.loading = "eager";
        cover.decoding = "async";
        cover.referrerPolicy = "no-referrer";
        cover.addEventListener("error", () => cover.remove(), { once: true });
        topRow.appendChild(cover);
    }

    const info = document.createElement("div");
    info.className = "game-summary-info";

    const title = document.createElement("h1");
    title.id = "game-title";
    title.className = "game-summary-title";
    title.textContent = game.name;
    info.appendChild(title);

    const metadata = document.createElement("div");
    metadata.className = "game-summary-metadata";

    if (game.year) {
        const year = document.createElement("span");
        year.className = "game-summary-year";
        year.textContent = game.year;
        metadata.append(year);
    }

    if (game.genre) {
        const genre = document.createElement("span");
        genre.className = "game-summary-genre";
        genre.textContent = game.genre;
        metadata.append(genre);
    }

    if (metadata.children.length > 0) {
        info.appendChild(metadata);
    }

    topRow.appendChild(info);
    parentElement.appendChild(topRow);

    if (game.description) {
        parentElement.appendChild(createExpandableDescription(game.description));
    }
}

function displayPortCard(
    port,
    index,
    allRows,
    ratings,
    ratingActions,
    compatibility,
    compatibilityActions
) {
    const card = document.createElement("article");
    card.className = "port port-card";

    const top = document.createElement("div");
    top.className = "port-top";

    const title = document.createElement("h3");
    title.className = "port-title";
    title.textContent = port.project || `Port ${index + 1}`;
    top.appendChild(title);

    const rating = createPortRating(port, ratings, ratingActions);
    if (rating) top.appendChild(rating);
    card.appendChild(top);

    const details = document.createElement("div");
    details.className = "port-details";

    const lastUpdateDisplay = String(port.lastUpdate || "").replace(/^(\d{4}-\d{2}-\d{2})[ T].*$/, "$1");
    const fields = [
        ["Version", port.version, ""],
        ["Developer", port.developer, ""],
        ["Need files?", port.files, port.dataUrl],
        ["Port type", port.platform, ""],
        ["Supported inputs", port.controller, ""],
        ["Works?", port.works, ""],
        ["Last update", lastUpdateDisplay, ""],
    ];

    for (const [label, value, url] of fields) {
        const detail = createPortDetail(label, value, url);
        if (detail) details.appendChild(detail);
    }

    if (details.childElementCount > 0) {
        card.appendChild(details);
    }

    const compatSection = createPortCompatibility(
        port,
        compatibility,
        compatibilityActions
    );
    if (compatSection) {
        card.appendChild(compatSection);
    }

    if (port.notes) {
        const notes = document.createElement("div");
        notes.className = "port-notes";

        const label = document.createElement("div");
        label.className = "port-notes-label";
        label.textContent = "NOTES";

        const text = document.createElement("p");
        text.className = "port-notes-text";
        text.textContent = port.notes;

        notes.append(label, text);
        card.appendChild(notes);
    }

    const portUrl = String(port.url || "").trim();
    if (/^https?:\/\/\S+$/i.test(portUrl)) {
        const linkRow = document.createElement("div");
        linkRow.className = "port-link-row";

        const link = document.createElement("a");
        link.className = "port-link";
        link.href = portUrl;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = port.link || "Download / View Port";

        const arrow = document.createElement("span");
        arrow.setAttribute("aria-hidden", "true");
        arrow.textContent = "↗";
        link.appendChild(arrow);
        linkRow.appendChild(link);

        const reportTrigger = document.createElement("div");
        reportTrigger.className = "port-report-link-trigger";

        const reportBtn = document.createElement("button");
        reportBtn.type = "button";
        reportBtn.className = "port-report-link-button";
        reportBtn.textContent = "Report link";
        reportBtn.setAttribute("aria-expanded", "false");

        const reportPopover = document.createElement("div");
        reportPopover.className = "port-report-link-popover";
        reportPopover.hidden = true;

        const rTitle = document.createElement("h4");
        rTitle.className = "port-rating-popover-title";
        rTitle.textContent = "Report broken link";

        const rDesc = document.createElement("p");
        rDesc.className = "port-rating-popover-description";
        rDesc.textContent = "Select the issue with this link";

        const reasons = [
            "Dead / 404 link",
            "Wrong game or version",
            "Requires account / paywall",
            "Suspicious / broken file",
        ];

        let selectedReason = "";
        let sendingReport = false;
        const reasonButtons = [];

        const submitReportBtn = document.createElement("button");
        submitReportBtn.type = "button";
        submitReportBtn.className = "port-rating-submit";
        submitReportBtn.textContent = "Submit report";
        submitReportBtn.disabled = true;

        const reportFeedback = document.createElement("p");
        reportFeedback.className = "port-rating-feedback";
        reportFeedback.textContent = "Choose a reason above.";

        reportPopover.append(rTitle, rDesc);

        reasons.forEach((reason) => {
            const opt = document.createElement("button");
            opt.type = "button";
            opt.className = "port-rating-option";
            opt.textContent = reason;
            opt.addEventListener("click", () => {
                if (sendingReport) return;
                selectedReason = reason;
                reasonButtons.forEach((b) =>
                    b.classList.toggle("selected", b === opt)
                );
                submitReportBtn.disabled = false;
                reportFeedback.className = "port-rating-feedback";
                reportFeedback.textContent = `Selected: ${reason}`;
            });
            reasonButtons.push(opt);
            reportPopover.appendChild(opt);
        });

        submitReportBtn.addEventListener("click", async () => {
            if (!selectedReason || sendingReport) return;
            sendingReport = true;
            submitReportBtn.disabled = true;
            reportFeedback.className = "port-rating-feedback";
            reportFeedback.textContent = "Sending report...";

            try {
                if (!compatibilityActions?.reportBrokenLink) {
                    throw new Error("Report service is unavailable.");
                }
                await compatibilityActions.reportBrokenLink({
                    portId: port.portId || port.project || port.game,
                    reason: selectedReason,
                    url: portUrl,
                });
                reportFeedback.className = "port-rating-feedback success";
                reportFeedback.textContent = "Link reported, thanks!";
                reportBtn.textContent = "Reported";
                setTimeout(() => {
                    closeReportLinkPopover(reportTrigger);
                }, 900);
            } catch (err) {
                reportFeedback.className = "port-rating-feedback error";
                reportFeedback.textContent =
                    err.message || "Could not send report.";
                submitReportBtn.disabled = false;
            } finally {
                sendingReport = false;
            }
        });

        reportPopover.append(submitReportBtn, reportFeedback);

        reportBtn.addEventListener("click", (event) => {
            event.stopPropagation();
            const willOpen = reportPopover.hidden;
            document
                .querySelectorAll(".port-report-link-trigger")
                .forEach((other) => {
                    if (other !== reportTrigger) closeReportLinkPopover(other);
                });
            document.querySelectorAll(".port-rating").forEach((other) => {
                closeRatingPopover(other);
            });
            document.querySelectorAll(".port-compat").forEach((other) => {
                closeCompatibilityPopover(other);
            });

            reportPopover.hidden = !willOpen;
            reportTrigger.classList.toggle("is-open", willOpen);
            reportBtn.setAttribute("aria-expanded", String(willOpen));
        });

        reportTrigger.append(reportBtn, reportPopover);
        linkRow.appendChild(reportTrigger);
        card.appendChild(linkRow);
    }

    if (isMultiGameAppPort(port, allRows)) {
        const gamesList = findGamesUsingApp(port.project, allRows);
        if (gamesList.length > 0) {
            card.appendChild(
                createGamesUsingAppSection(
                    "With this port you can also play:",
                    gamesList
                )
            );
        }
    }

    return card;
}

export function displayGame(
    game,
    allRows,
    ratings = {},
    ratingActions = null,
    compatibility = {},
    compatibilityActions = null
) {
    const gameHeader = document.getElementById("game-header");
    const portList = document.getElementById("port-list");
    const statusElement = document.getElementById("status");

    if (!gameHeader || !portList || !statusElement) {
        console.error("Game page is missing a required element.");
        return;
    }

    initializeRatingPopoverEvents();
    displayGameSummary(game, gameHeader);

    const portCount = game.ports.length;
    statusElement.textContent = `${portCount} ${
        portCount === 1 ? "port" : "ports"
    }`;

    portList.replaceChildren();

    if (portCount === 0) {
        const emptyMessage = document.createElement("p");
        emptyMessage.className = "port-empty";
        emptyMessage.textContent =
            "No ports are currently listed for this game.";
        portList.appendChild(emptyMessage);
    } else {
        const sortedPorts = game.ports
            .map((port, originalIndex) => ({
                port,
                originalIndex,
                rating: ratings?.[port.portId] || {},
            }))
            .sort((a, b) => {
                const aVotes = Number(a.rating.votes) || 0;
                const bVotes = Number(b.rating.votes) || 0;
                const aHasVotes = aVotes > 0;
                const bHasVotes = bVotes > 0;

                if (aHasVotes !== bHasVotes) {
                    return aHasVotes ? -1 : 1;
                }

                if (aHasVotes && bHasVotes) {
                    const avgDiff =
                        (Number(b.rating.avg) || 0) -
                        (Number(a.rating.avg) || 0);
                    if (avgDiff !== 0) return avgDiff;
                }

                // When ratings are equal (or neither port has votes),
                // show the most recently updated port first.
                const aUpdated = parseLastUpdate(a.port.lastUpdate);
                const bUpdated = parseLastUpdate(b.port.lastUpdate);
                if (aUpdated !== bUpdated) return bUpdated - aUpdated;

                return a.originalIndex - b.originalIndex;
            });

        sortedPorts.forEach(({ port }, index) => {
            portList.appendChild(
                displayPortCard(
                    port,
                    index,
                    allRows,
                    ratings,
                    ratingActions,
                    compatibility,
                    compatibilityActions
                )
            );
        });
    }

    if (isMultiGameApp(game)) {
        const gamesList = findGamesUsingApp(game.name, allRows);
        if (gamesList.length > 0) {
            portList.appendChild(
                createGamesUsingAppSection("Games using this app", gamesList)
            );
        }
    }
}
