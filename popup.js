const api = typeof browser !== "undefined" ? browser : chrome;
const DEFAULTS = { lettersNav: true, optionShortcuts: true, autoLikeNext: false, hideGraphics: true };
const $ = (id) => document.getElementById(id);
const status = (msg, ok = true) => {
  const el = $("status");
  el.textContent = msg;
  el.style.color = ok ? "#7fd08a" : "#e08a8a";
};

async function loadSettings() {
  let s = DEFAULTS;
  try {
    const r = await api.storage.local.get("fsgSettings");
    s = Object.assign({}, DEFAULTS, r.fsgSettings || {});
  } catch (_) { /* ignore */ }
  $("lettersNav").checked = s.lettersNav;
  $("optionShortcuts").checked = s.optionShortcuts;
  $("autoLikeNext").checked = s.autoLikeNext;
  $("hideGraphics").checked = s.hideGraphics;
}

function saveSettings() {
  const s = {
    lettersNav: $("lettersNav").checked,
    optionShortcuts: $("optionShortcuts").checked,
    autoLikeNext: $("autoLikeNext").checked,
    hideGraphics: $("hideGraphics").checked
  };
  api.storage.local.set({ fsgSettings: s });
  status("Settings saved.");
}

["lettersNav", "optionShortcuts", "autoLikeNext", "hideGraphics"].forEach((id) =>
  $(id).addEventListener("change", saveSettings)
);

async function activeTab() {
  const tabs = await api.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

// The content script may not be present on tabs opened before the extension loaded;
// inject it on demand, then send the command.
async function sendToPage(type) {
  const tab = await activeTab();
  if (!tab || !tab.id) { status("No active tab.", false); return; }
  try {
    await api.tabs.sendMessage(tab.id, { type });
  } catch (_) {
    try {
      await api.tabs.executeScript(tab.id, { file: "content.js" });
      await api.tabs.sendMessage(tab.id, { type });
    } catch (err) {
      status("Can't run on this page.", false);
      return;
    }
  }
  window.close();
}

$("open").addEventListener("click", () => sendToPage("fsg-toggle"));
$("local").addEventListener("click", () => sendToPage("fsg-local"));
$("clear").addEventListener("click", async () => {
  try {
    await api.storage.local.set({ fsgLiked: [] });
    status("Saved gallery cleared.");
  } catch (_) {
    status("Couldn't clear.", false);
  }
});

loadSettings();
