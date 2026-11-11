/*
 * NAPL — LOADING & ERROR UI COMPONENT
 */

export function renderListSkeletons(container, count = 6) {
    if (!container) return;

    const fragment = document.createDocumentFragment();
    for (let i = 0; i < count; i++) {
        const card = document.createElement("div");
        card.className = "skeleton-card";
        card.setAttribute("aria-hidden", "true");
        card.innerHTML = `
            <div class="skeleton skeleton-cover"></div>
            <div class="skeleton-content">
                <div class="skeleton skeleton-title"></div>
                <div class="skeleton skeleton-subtitle"></div>
                <div class="skeleton skeleton-meta"></div>
            </div>
        `;
        fragment.appendChild(card);
    }

    container.replaceChildren(fragment);
}

export function renderGameDetailSkeletons(gameHeader, portList, portCount = 2) {
    if (gameHeader) {
        gameHeader.innerHTML = `
            <div class="skeleton-summary-card" aria-hidden="true">
                <div class="skeleton skeleton-summary-cover"></div>
                <div class="skeleton-content">
                    <div class="skeleton skeleton-title skeleton-w-md"></div>
                    <div class="skeleton skeleton-meta skeleton-w-sm"></div>
                    <div class="skeleton skeleton-text skeleton-w-full"></div>
                    <div class="skeleton skeleton-text skeleton-w-lg"></div>
                    <div class="skeleton skeleton-text skeleton-w-md"></div>
                </div>
            </div>
        `;
    }

    if (portList) {
        const fragment = document.createDocumentFragment();
        for (let i = 0; i < portCount; i++) {
            const card = document.createElement("div");
            card.className = "skeleton-port-card";
            card.setAttribute("aria-hidden", "true");
            card.innerHTML = `
                <div class="skeleton skeleton-title skeleton-w-md"></div>
                <div class="skeleton-port-grid">
                    <div class="skeleton skeleton-text skeleton-w-lg"></div>
                    <div class="skeleton skeleton-text skeleton-w-md"></div>
                    <div class="skeleton skeleton-text skeleton-w-md"></div>
                    <div class="skeleton skeleton-text skeleton-w-lg"></div>
                </div>
                <div class="skeleton skeleton-button"></div>
            `;
            fragment.appendChild(card);
        }
        portList.replaceChildren(fragment);
    }
}

export function renderErrorBox(container, titleText, messageText, onRetry = null) {
    if (!container) return;

    container.replaceChildren();
    container.hidden = false;

    const errorContainer = document.createElement("div");
    errorContainer.className = "error";

    const errorTitle = document.createElement("strong");
    errorTitle.textContent = titleText;

    const errorMessage = document.createElement("p");
    errorMessage.textContent = messageText;

    errorContainer.append(errorTitle, errorMessage);

    if (typeof onRetry === "function") {
        const retryButton = document.createElement("button");
        retryButton.type = "button";
        retryButton.className = "retry-button";
        retryButton.textContent = "Try again";
        retryButton.addEventListener("click", onRetry);
        errorContainer.appendChild(retryButton);
    }

    container.appendChild(errorContainer);
}
