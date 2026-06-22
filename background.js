const TST_ID = "treestyletab@piro.sakura.ne.jp";
const STATES = ["heat-older", "heat-oldest", "heat-fossil"];
const RECENT = 15;        // ranks 0..9   → unmarked
const OLDER  = 30;        // ranks 10..24 → heat-older; 25+ → heat-oldest
const FOSSIL_MS = 48 * 24 * 60 * 60 * 1000;
const DEBOUNCE_MS = 150;
const SESSION_KEY = "heatState"; // per-tab key for browser.sessions (survives restart)

// ─── State ───
const applied = new Map(); // tabId → current heat state
let lastRun = 0;
let timer = null;

// ─── Registration ───

async function registerSelf() {
  try {
    await browser.runtime.sendMessage(TST_ID, {
      type: "register-self",
      name: "TST Recency Heatmap",
      listeningTypes: ["ready"],
      allowBulkMessaging: true,
      style: "",  // explicit blank: clears any sticky style from prior versions
    });
    return true;
  } catch (e) {
    console.warn("TST register-self failed (is TST running?):", e);
    return false;
  }
}

// Retry registration to close the install-while-TST-starting race.
// TST's "ready" message is the primary recovery, but this covers the window
// before that arrives and the edge case where ready was missed.
async function ensureRegistered(attempts = 6) {
  for (let i = 0; i < attempts; i++) {
    if (await registerSelf()) return true;
    await new Promise(r => setTimeout(r, 500 * (i + 1)));
  }
  return false; // TST likely absent/disabled; ready will re-trigger later
}

// ─── Ranking ───

function scheduleRank() {
  const now = Date.now();
  if (now - lastRun > DEBOUNCE_MS) {
    lastRun = now;
    rank();
  } else {
    clearTimeout(timer);
    timer = setTimeout(() => { lastRun = Date.now(); rank(); }, DEBOUNCE_MS);
  }
}

async function rank() {
  let tabs;
  try {
    tabs = await browser.tabs.query({});
  } catch (e) {
    return;
  }

  const tst = [];        // TST message ops (sent as one bulk call)
  const sessionOps = []; // browser.sessions ops

  // Hidden tabs: remove any state we still hold, then exclude from ranking.
  for (const t of tabs) {
    if (t.hidden && applied.has(t.id)) {
      tst.push({ type: "remove-tab-state", tabs: [t.id], state: applied.get(t.id) });
      applied.delete(t.id);
      sessionOps.push({ id: t.id, state: null });
    }
  }
  tabs = tabs.filter(t => !t.hidden);

  const byWindow = new Map();
  for (const t of tabs) {
    if (!byWindow.has(t.windowId)) byWindow.set(t.windowId, []);
    byWindow.get(t.windowId).push(t);
  }

  const now = Date.now();
  const seen = new Set();

  for (const windowTabs of byWindow.values()) {
    windowTabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));

    windowTabs.forEach((t, i) => {
      seen.add(t.id);
      const age = now - (t.lastAccessed || now);
      const want = age >= FOSSIL_MS        ? "heat-fossil"
                 : i >= RECENT + OLDER     ? "heat-oldest"
                 : i >= RECENT             ? "heat-older"
                 : null;
      const have = applied.get(t.id) ?? null;
      if (want === have) return;

      if (have) tst.push({ type: "remove-tab-state", tabs: [t.id], state: have });
      if (want) tst.push({ type: "add-tab-state",    tabs: [t.id], state: want });

      if (want) applied.set(t.id, want);
      else      applied.delete(t.id);
      sessionOps.push({ id: t.id, state: want });
    });
  }

  // Clean up closed tabs from tracking.
  for (const id of applied.keys()) {
    if (!seen.has(id)) applied.delete(id);
  }

  // One bulk call to TST instead of N individual messages.
  if (tst.length) {
    try {
      await browser.runtime.sendMessage(TST_ID, { messages: tst });
    } catch (e) {}
  }

  // Mirror changes into per-tab session data. Firefox reassociates these with
  // restored tabs after a browser restart, so the next startup can diff
  // instead of blind-clearing. Only changed tabs are written.
  for (const op of sessionOps) {
    try {
      if (op.state) await browser.sessions.setTabValue(op.id, SESSION_KEY, op.state);
      else          await browser.sessions.removeTabValue(op.id, SESSION_KEY);
    } catch (e) {}
  }
}

// ─── Persistence / Reconciliation ───

// Rebuild `applied` from per-tab session data. Firefox reassociates values
// with restored tabs after a restart (handling the tab-id change). This lets
// rank() diff against TST's cached states and remove genuine orphans precisely.
async function restoreApplied() {
  applied.clear();
  let tabs;
  try {
    tabs = await browser.tabs.query({});
  } catch (e) {
    return;
  }
  await Promise.all(tabs.map(async (t) => {
    try {
      const state = await browser.sessions.getTabValue(t.id, SESSION_KEY);
      if (STATES.includes(state)) applied.set(t.id, state);
    } catch (e) {}
  }));
}

// Blunt fallback: strip every STATE from every live tab and drop our session
// markers. Used once on version change to migrate orphans left by builds that
// didn't track via the sessions API. Not used on ordinary launches.
async function clearAll() {
  let tabs;
  try {
    tabs = await browser.tabs.query({});
  } catch (e) {
    return;
  }
  const ids = tabs.map(t => t.id);
  applied.clear();
  if (!ids.length) return;

  const tst = STATES.map(state => ({ type: "remove-tab-state", tabs: ids, state }));
  try {
    await browser.runtime.sendMessage(TST_ID, { messages: tst });
  } catch (e) {}

  await Promise.all(ids.map(async (id) => {
    try { await browser.sessions.removeTabValue(id, SESSION_KEY); } catch (e) {}
  }));
}

// Run clearAll() once per installed version (install/update), never on
// ordinary launches. Returns true if it migrated, so callers skip restore.
async function reapIfNewVersion() {
  let ver;
  try {
    ver = browser.runtime.getManifest().version;
    const { reapVersion } = await browser.storage.local.get("reapVersion");
    if (reapVersion === ver) return false;
  } catch (e) {
    return false;
  }
  await clearAll();
  try {
    await browser.storage.local.set({ reapVersion: ver });
  } catch (e) {}
  return true;
}

// ─── Shared Init ───
// Used by both the startup IIFE and the "ready" handler so the migration
// can't be skipped by the install-time race, and TST restarts reconcile
// the same way as cold launches.

async function init() {
  await ensureRegistered();
  const migrated = await reapIfNewVersion(); // one blind clear on install/update only
  if (!migrated) await restoreApplied();     // else recover precise per-tab tracking
  await rank();                              // emits deltas; removes restated orphans
}

// ─── TST Notifications ───

browser.runtime.onMessageExternal.addListener((message, sender) => {
  if (sender.id !== TST_ID) return;
  if (message.type === "ready") {
    // TST (re)initialized and may have restored cached states (incl. ours)
    // from its IndexedDB tree cache. Full init reconciles.
    init();
  }
});

// ─── Tab Events ───

browser.tabs.onActivated.addListener(scheduleRank);
browser.tabs.onCreated.addListener(scheduleRank);
browser.tabs.onRemoved.addListener(scheduleRank);
browser.tabs.onAttached.addListener(scheduleRank);
browser.tabs.onDetached.addListener(scheduleRank);

// ─── Startup ───

init();
