/*
 * NAPL — LOADING & ERROR UI COMPONENT
 */

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
