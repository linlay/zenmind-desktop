const healthEl = document.querySelector("#health");
const serverTimeEl = document.querySelector("#server-time");
const visitsEl = document.querySelector("#visits");
const refreshButton = document.querySelector("#refresh");

async function loadStatus() {
  refreshButton.disabled = true;
  try {
    const response = await fetch("/api/demo");
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const payload = await response.json();
    healthEl.textContent = payload.ok ? "running" : "error";
    serverTimeEl.textContent = new Date(payload.serverTime).toLocaleTimeString();
    visitsEl.textContent = String(payload.visits);
  } catch (error) {
    healthEl.textContent = "error";
    serverTimeEl.textContent = "--";
    visitsEl.textContent = "--";
    console.error(error);
  } finally {
    refreshButton.disabled = false;
  }
}

refreshButton.addEventListener("click", () => {
  void loadStatus();
});

void loadStatus();
