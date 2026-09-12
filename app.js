import { TS, connectFirebase, connectLocal } from "./backend.js";
import { FIREBASE_CONFIG } from "./firebase-config.js";

/* ============================================================================
   NSG draft room. One shared tree in the database:

     draft/config   order, snake slots, cap, roster rules, keepers   (commissioner)
     draft/state    status, current pick, clock                      (moves with picks)
     draft/picks/N  {p: player id, t: team id, by: owner|auto|commish, at}
     draft/taken/ID pick number ("k" for keepers) - makes a double pick impossible

   Every browser derives rosters, cap and legality from that tree, so there is
   nothing to drift out of sync. The clock is a server timestamp plus a length;
   when it runs out, any connected team's browser makes the auto-pick and the
   database accepts exactly one of them.
   ========================================================================= */

const $ = s => document.querySelector(s);
const params = new URLSearchParams(location.search);
const LOCAL = params.has("local") || !FIREBASE_CONFIG;
const GROUPS = ["F", "D", "G"];
const AUTO_GRACE_MS = 500;       // the server must agree the clock is out
const MAX_ROWS = 250;

const fmtM = v => "$" + (v / 1e6).toFixed(2) + "M";
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fold = s => String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

const [PLAYERS, LEAGUE] = await Promise.all([
  fetch("players.json", { cache: "no-store" }).then(r => r.json()),
  fetch("league.json", { cache: "no-store" }).then(r => r.json()),
]);
const P = new Map(PLAYERS.map(p => [p.id, p]));
const TEAM = new Map(LEAGUE.teams.map(t => [t.id, t]));
const N_TEAMS = LEAGUE.teams.length;
PLAYERS.forEach(p => { p._f = fold(p.n); });

let backend = null;
let D = null;                               // derived view of the draft tree
const me = { team: null, commish: false };
const ui = { tab: "players", pos: "all", q: "", sort: "adp", desc: false, fitsOnly: false, open: new Set() };
let autoTried = -1, lastOnClock = null, pendingPick = false;

/* ---------------------------------------------------------------- derive */

function rows(obj) {
  // Firebase hands back sequential integer keys as an array (with holes).
  return Object.entries(obj || {}).filter(([, v]) => v != null);
}

function derive(t) {
  const cfg = t && t.config;
  if (!cfg) return null;
  const st = t.state || {};
  const picks = rows(t.picks).map(([k, v]) => ({ n: +k, ...v })).sort((a, b) => a.n - b.n);
  const taken = new Set(Object.keys(t.taken || {}));
  const teams = {};
  for (const id of cfg.order) teams[id] = { id, cap: 0, cnt: { F: 0, D: 0, G: 0 }, keepers: [], picks: [] };
  for (const [id, list] of rows(cfg.keepers)) {
    for (const pid of rows(list).map(([, v]) => v)) {
      const p = P.get(pid);
      if (!p || !teams[id]) continue;
      teams[id].keepers.push(p); teams[id].cap += p.cap; teams[id].cnt[p.g]++;
    }
  }
  for (const pk of picks) {
    const tm = teams[pk.t], p = P.get(pk.p);
    if (!tm) continue;
    tm.picks.push({ ...pk, player: p });
    if (p) { tm.cap += p.cap; tm.cnt[p.g]++; }
  }
  const cur = Number(st.pick || 0);
  const done = cur >= cfg.total;
  const available = PLAYERS.filter(p => !taken.has(p.id));
  const cheap = {};
  for (const g of GROUPS) cheap[g] = available.filter(p => p.g === g).sort((a, b) => a.cap - b.cap);
  return {
    cfg, st, picks, taken, teams, cur, done, available, cheap,
    status: done ? "done" : (st.status || "setup"),
    onClock: done ? null : cfg.slots[cur],
  };
}

const teamName = id => (TEAM.get(id) || { name: id }).name;
const slotTeam = (d, n) => d.cfg.slots[n];

function teamAfter(d, teamId, adjust) {
  const tm = d.teams[teamId];
  if (!tm) return null;
  const cnt = { ...tm.cnt };
  let cap = tm.cap;
  if (adjust) { cnt[adjust.g]--; cap -= adjust.cap; }      // commissioner replacing a pick
  return { cnt, cap };
}

/* The league's rules, as hard blocks: no pick may take a team over the cap,
   and no position can be overfilled. Returns the reason, or null. */
function whyNot(d, teamId, p, adjust) {
  const s = teamAfter(d, teamId, adjust);
  if (!s) return "Unknown team";
  const req = d.cfg.req;
  if (s.cnt[p.g] >= req[p.g]) return `${p.g} spots full (${s.cnt[p.g]}/${req[p.g]})`;
  const left = d.cfg.capMax - s.cap - p.cap;
  if (left < 0) return `Over the cap by ${fmtM(-left)}`;
  return null;
}

/* A warning, not a block: the pick fits, but leaves less cap than the
   cheapest players still available would cost to fill the other open spots,
   so the team will likely end up with a forced pick over the cap later. */
function fillWarning(d, teamId, p, adjust) {
  const s = teamAfter(d, teamId, adjust);
  if (!s) return null;
  const req = d.cfg.req;
  const left = d.cfg.capMax - s.cap - p.cap;
  let need = 0, spots = 0;
  for (const g of GROUPS) {
    let k = req[g] - s.cnt[g] - (g === p.g ? 1 : 0);
    for (const c of d.cheap[g]) {
      if (k <= 0) break;
      if (c.id === p.id) continue;
      need += c.cap; k--; spots++;
    }
  }
  return left < need ? `Leaves ${fmtM(left)} for ${spots} open spot${spots === 1 ? "" : "s"} (cheapest fill ${fmtM(need)})` : null;
}

/* The clock's pick: best ESPN ADP that fits under the cap and keeps the
   roster completable; failing that, best ADP that at least fits under the
   cap. When NOTHING fits under the cap, the league's rule is the cheapest
   player (then the lowest projection) at a position still open, even though
   it goes over - a forced pick. */
function autoChoice(d, teamId) {
  const byAdp = [...d.available].sort((a, b) => (a.adp ?? 1e9) - (b.adp ?? 1e9) || (b.pts ?? -1) - (a.pts ?? -1));
  const fits = byAdp.filter(p => !whyNot(d, teamId, p));
  return fits.find(p => !fillWarning(d, teamId, p)) || fits[0] || forcedChoice(d, teamId);
}

function forcedChoice(d, teamId) {
  const tm = d.teams[teamId];
  if (!tm) return null;
  const open = d.available.filter(p => tm.cnt[p.g] < d.cfg.req[p.g]);
  open.sort((a, b) => a.cap - b.cap || (a.pts ?? -1) - (b.pts ?? -1));
  return open[0] || null;
}

// No player fits under this team's cap: its turn can only be a forced pick.
function isStuck(d, teamId) {
  return !!teamId && !d.available.some(p => !whyNot(d, teamId, p));
}

function remainingMs(d) {
  if (!d || d.done) return null;
  const full = d.cfg.clockSec * 1000;
  if (d.status === "paused") return d.st.pausedLeft ?? full;
  if (d.status !== "live") return full;
  return d.st.clockStart + d.st.clockMs - backend.serverNow();
}

function canPickNow(d) {
  if (!d || d.done) return false;
  if (me.commish) return d.status === "live" || d.status === "paused";
  return d.status === "live" && me.team === d.onClock;
}

/* ---------------------------------------------------------------- writes */

function pickUpdate(d, teamId, pid, by) {
  const n = String(d.cur);
  const rec = { p: pid, t: teamId, by, at: TS };
  if (whyNot(d, teamId, P.get(pid))) rec.forced = true;     // over the cap: only ever the forced auto-pick
  const u = {
    [`draft/picks/${n}`]: rec,
    [`draft/taken/${pid}`]: n,
    "draft/state/pick": String(d.cur + 1),
  };
  if (d.status === "paused") u["draft/state/pausedLeft"] = d.cfg.clockSec * 1000;
  else { u["draft/state/clockStart"] = TS; u["draft/state/clockMs"] = d.cfg.clockSec * 1000; }
  return u;
}

async function write(u, what) {
  try { await backend.update(u); return true; }
  catch (e) { toast(`${what} failed: ${e.message || e}`, true); return false; }
}

function buildSlots(order, rounds) {
  const slots = [], next = [];
  for (let r = 0; r < rounds; r++) {
    for (const id of (r % 2 ? [...order].reverse() : order)) { next.push(String(slots.length + 1)); slots.push(id); }
  }
  return { slots, next, total: slots.length };
}

function newToken() {
  const b = crypto.getRandomValues(new Uint8Array(12));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function configFromLeague(clockSec) {
  const order = LEAGUE.teams.map(t => t.id);
  const { slots, next, total } = buildSlots(order, LEAGUE.rounds);
  return {
    order, slots, next, total, clockSec, capMax: LEAGUE.capMax, req: LEAGUE.req,
    rounds: LEAGUE.rounds, playersVersion: LEAGUE.playersVersion,
  };
}

async function setupRoom(clockSec) {
  const secrets = await backend.readSecrets().catch(() => ({}));
  const u = {
    "draft/config": configFromLeague(clockSec),
    "draft/state": { status: "setup", pick: "0", clockStart: 0, clockMs: clockSec * 1000, pausedLeft: clockSec * 1000 },
    "draft/picks": null,
    "draft/taken": null,          // keepers are only written at Start
  };
  for (const t of LEAGUE.teams) if (!secrets[t.id]) u[`secrets/teams/${t.id}`] = newToken();
  if (await write(u, "Setup")) toast("Draft room is set up. Send each team its link (Team links).");
}

const commish = {
  pause: () => write({ "draft/state/status": "paused", "draft/state/pausedLeft": Math.max(0, remainingMs(D)) }, "Pause"),
  resume: () => write({ "draft/state/status": "live", "draft/state/clockStart": TS,
                        "draft/state/clockMs": D.st.pausedLeft ?? D.cfg.clockSec * 1000 }, "Resume"),
  // The pick the clock would make, without waiting for it. No confirm step:
  // speed is the point, and Undo reverses it.
  async autoNow() {
    if (!D || D.done || D.status === "setup") return;
    const team = D.onClock;
    const choice = autoChoice(D, team);
    if (!choice) return toast(`No legal auto-pick exists for ${teamName(team)}.`, true);
    if (await write(pickUpdate(D, team, choice.id, "auto"), "Auto-pick")) {
      toast(`Auto-pick: ${choice.n} to ${teamName(team)}`);
    }
  },
  undo() {
    const last = D.picks[D.picks.length - 1];
    if (!last) return;
    const p = P.get(last.p);
    confirmBox(`Undo pick #${last.n + 1}?`,
      `<div class="row"><span>${esc(teamName(last.t))}</span><b>${esc(p ? p.n : last.p)}</b></div>
       <p>The player goes back on the board and ${esc(teamName(last.t))} is on the clock again with a full clock.</p>`,
      "Undo pick", () => write({
        [`draft/picks/${last.n}`]: null, [`draft/taken/${last.p}`]: null,
        "draft/state/pick": String(last.n), "draft/state/clockStart": TS,
        "draft/state/clockMs": D.cfg.clockSec * 1000, "draft/state/pausedLeft": D.cfg.clockSec * 1000,
      }, "Undo"));
  },
  setClock() {
    const s = Math.round(Number($("#cClock").value));
    if (!(s >= 10 && s <= 600)) return toast("Clock must be 10-600 seconds", true);
    const u = { "draft/config/clockSec": s };
    if (D.status === "setup") { u["draft/state/clockMs"] = s * 1000; u["draft/state/pausedLeft"] = s * 1000; }
    write(u, "Clock").then(ok => ok && toast(`Clock set to ${s}s (applies from the next pick)`));
  },
  reset() {
    confirmBox("Reset the whole draft?", `<p>Every pick is erased, keepers are hidden again, and the room goes back to "not started". Owners' keeper choices, your defaults and the team links all stay.</p>`,
      "Reset draft", () => write({
        "draft/picks": null, "draft/taken": null, "draft/config/keepers": null, "draft/config/keeperMode": null,
        "draft/state": { status: "setup", pick: "0", clockStart: 0, clockMs: D.cfg.clockSec * 1000, pausedLeft: D.cfg.clockSec * 1000 },
      }, "Reset"), true);
  },
  async links() {
    let secrets = {};
    try { secrets = await backend.readSecrets(); } catch (e) { return toast("Could not read team links: " + e.message, true); }
    const base = location.origin + location.pathname;
    const items = LEAGUE.teams.map(t => {
      const url = LOCAL ? `${base}?local=1&team=${t.id}` : `${base}?team=${t.id}&key=${secrets[t.id] || ""}`;
      return { t, url };
    });
    showModal(`<h3>Team links</h3>
      <p>Send each owner <b>only their own</b> link - it lets them pick for that team. Anyone with the plain page address can watch but not pick.</p>
      ${items.map(({ t, url }) => `<div class="linkrow"><label>${esc(t.name)}${t.id === LEAGUE.commishTeam ? " (you - not needed while signed in as commissioner)" : ""}</label>
        <input readonly value="${esc(url)}"><button class="btn small" data-copy="${esc(url)}">Copy</button></div>`).join("")}
      <div class="modal-actions"><button class="btn" data-copyall>Copy all</button><button class="btn primary" data-close>Done</button></div>`);
    $("#modalBox").querySelectorAll("[data-copy]").forEach(b => b.onclick = () => copy(b.dataset.copy));
    $("#modalBox").querySelector("[data-copyall]").onclick = () => copy(items.map(({ t, url }) => `${t.name}: ${url}`).join("\n"));
  },
  exportCsv() {
    const lines = [["Pick", "Round", "Team", "Player", "Pos", "NHL Team", "Cap Hit", "How"].join(",")];
    for (const pk of D.picks) {
      const p = P.get(pk.p) || { n: pk.p, pos: "", tm: "", cap: 0 };
      lines.push([pk.n + 1, Math.floor(pk.n / N_TEAMS) + 1, teamName(pk.t), p.n, p.pos, p.tm, p.cap, pk.by]
        .map(v => `"${String(v).replace(/"/g, '""')}"`).join(","));
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([lines.join("\r\n")], { type: "text/csv" }));
    a.download = `draft-${LEAGUE.season}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  },
  applyNewList() {
    if (D.status !== "setup") return toast("Reset the draft first to switch player lists.", true);
    write({ "draft/config": configFromLeague(D.cfg.clockSec), "draft/taken": null }, "Update")
      .then(ok => ok && toast("Room now uses this page's player list."));
  },
};

/* ---------------------------------------------------------------- keepers
   Owners choose their own keepers before the draft. A choice is stored where
   only that team and the commissioner can read it, and nobody sees anyone
   else's until the commissioner starts the draft - that is when keepers are
   copied into the public config. A team that hasn't chosen gets the
   commissioner's default, kept in secrets (never public before the start).
   A TEST draft uses the defaults for every team, so a test never exposes a
   real choice. */
const KEEP_N = LEAGUE.keeperCount || 3;
let myKeepers = null;                                   // my team's saved choice

const idsOf = v => (v ? Object.values(v).filter(x => x != null).map(String) : []);

async function loadMyKeepers() {
  myKeepers = null;
  if (!me.team) return;
  try { myKeepers = await backend.get(`keepers/${me.team}`); } catch { /* not readable yet */ }
}

// A saved choice counts only if it is exactly KEEP_N signed players from that team's own roster.
function validChoice(teamId, rec) {
  const ids = idsOf(rec && rec.ids);
  const roster = new Set(LEAGUE.rosters[teamId] || []);
  return ids.length === KEEP_N && ids.every(id => roster.has(id) && P.has(id)) ? ids : null;
}

function openKeeperChooser() {
  if (!me.team || !D || D.status !== "setup") return;
  const roster = (LEAGUE.rosters[me.team] || []).map(id => P.get(id)).filter(Boolean)
    .sort((a, b) => GROUPS.indexOf(a.g) - GROUPS.indexOf(b.g) || a.n.localeCompare(b.n));
  const sel = new Set(idsOf(myKeepers && myKeepers.ids));
  showModal(`<h3>Choose your ${KEEP_N} keepers</h3>
    <p>From your 2025-26 roster. Nobody else sees your choice until the draft starts, and you can change it until then.</p>
    <div id="kpList"></div>
    <p class="hint" id="kpCount" style="padding:8px 0 0"></p>
    <div class="modal-actions"><button class="btn" data-close>Cancel</button><button class="btn primary" id="kpSave">Save keepers</button></div>`);
  const draw = () => {
    const cap = [...sel].reduce((s, id) => s + (P.get(id) ? P.get(id).cap : 0), 0);
    $("#kpList").innerHTML = roster.map(p => `<label class="kprow"><input type="checkbox" data-kp="${p.id}"${sel.has(p.id) ? " checked" : ""}>
      <span class="pos ${p.g}">${esc(p.pos)}</span><span><span class="pname">${esc(p.n)}</span><span class="pteam">${esc(p.tm)}</span></span>
      <span class="kpcap">${fmtM(p.cap)}</span></label>`).join("") || `<div class="empty">No signed players found on your 2025-26 roster.</div>`;
    $("#kpCount").textContent = `${sel.size} of ${KEEP_N} chosen · ${fmtM(cap)} of your ${fmtM(LEAGUE.capMax)} cap`;
    $("#kpSave").disabled = sel.size !== KEEP_N;
  };
  $("#kpList").onchange = e => {
    const id = e.target.dataset && e.target.dataset.kp;
    if (!id) return;
    if (e.target.checked) {
      if (sel.size >= KEEP_N) { e.target.checked = false; return toast(`You keep exactly ${KEEP_N} - untick one first.`, true); }
      sel.add(id);
    } else sel.delete(id);
    draw();
  };
  $("#kpSave").onclick = async () => {
    const ids = [...sel];
    if (await write({ [`keepers/${me.team}`]: { ids, at: TS } }, "Saving keepers")) {
      myKeepers = { ids };
      closeModal();
      toast("Keepers saved");
      render();
    }
  };
  draw();
}

// Commissioner: who has chosen (never what), the defaults, and importing them.
async function openKeeperAdmin() {
  const [chosen, defaults] = await Promise.all([
    backend.get("keepers").catch(() => null), backend.get("secrets/keeperDefaults").catch(() => null)]);
  const hasDefault = t => idsOf(defaults && defaults[t]).length === KEEP_N;
  const lines = LEAGUE.teams.map(t => {
    const c = validChoice(t.id, chosen && chosen[t.id]);
    return `<div class="row"><span>${esc(t.name)}</span><b>${c ? "&#10003; chose" : hasDefault(t.id) ? "not yet (your default)" : "&#9888; not yet, no default"}</b></div>`;
  }).join("");
  showModal(`<h3>Keepers</h3>
    <p>Who has chosen. What they chose stays hidden, from you too, until you start the draft. Teams that haven't chosen get your default.</p>
    ${lines}
    <p class="hint" style="padding:10px 0 8px">Your defaults loaded: ${LEAGUE.teams.filter(t => hasDefault(t.id)).length} of ${LEAGUE.teams.length} teams.</p>
    <label class="btn">Import default keepers file<input type="file" id="kpFile" accept=".json,application/json" hidden></label>
    <div class="modal-actions"><button class="btn primary" data-close>Done</button></div>`);
  $("#kpFile").onchange = async e => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const j = JSON.parse(await f.text());
      const u = {};
      for (const t of LEAGUE.teams) {
        const ids = idsOf(j[t.id] && (j[t.id].ids || j[t.id]));
        if (ids.length) u[`secrets/keeperDefaults/${t.id}`] = ids;
      }
      if (!Object.keys(u).length) return toast("No teams found in that file.", true);
      if (await write(u, "Import")) { toast(`Defaults imported for ${Object.keys(u).length} teams`); openKeeperAdmin(); }
    } catch (err) { toast("Couldn't read that file: " + err.message, true); }
  };
}

// Start = each owner's choice, else the default. Test = the defaults for everyone.
async function startDraft(test) {
  if (!D || D.status !== "setup") return;
  const [chosen, defaults] = await Promise.all([
    test ? null : backend.get("keepers").catch(() => null),
    backend.get("secrets/keeperDefaults").catch(() => null)]);
  const keepers = {}, usedDefault = [], missing = [];
  for (const t of LEAGUE.teams) {
    const c = test ? null : validChoice(t.id, chosen && chosen[t.id]);
    const d = idsOf(defaults && defaults[t.id]);
    if (c) keepers[t.id] = c;
    else if (d.length) { keepers[t.id] = d; usedDefault.push(t.name); }
    else missing.push(t.name);
  }
  if (missing.length) return toast(`No keepers for ${missing.join(", ")} - import your defaults first (Keepers).`, true);
  const keptBy = new Map();
  for (const [t, ids] of Object.entries(keepers)) for (const id of ids) {
    if (keptBy.has(id)) return toast(`${(P.get(id) || { n: id }).n} is kept by two teams.`, true);
    keptBy.set(id, t);
  }
  const body = test
    ? `<p>A <b>test draft</b> uses your default keepers for every team. Anyone watching will see them.</p>`
    : `<p>Keepers become visible to everyone now and can't be changed after this.</p>` +
      (usedDefault.length ? `<p>Using your default for: <b>${usedDefault.map(esc).join(", ")}</b> (they didn't choose).</p>`
                          : `<p>Every team chose its own keepers.</p>`);
  confirmBox(test ? "Start a test draft?" : "Start the draft?", body, test ? "Start test draft" : "Start draft", () => {
    const taken = {};
    for (const id of keptBy.keys()) taken[id] = "k";
    write({
      "draft/config/keepers": keepers, "draft/config/keeperMode": test ? "test" : "real", "draft/taken": taken,
      "draft/state/status": "live", "draft/state/clockStart": TS, "draft/state/clockMs": D.cfg.clockSec * 1000,
    }, "Start");
  });
}

/* ---------------------------------------------------------------- picking */

function askPick(pid) {
  const d = D, p = P.get(pid);
  if (!p || !canPickNow(d)) return;
  const team = d.onClock;
  const why = whyNot(d, team, p);
  if (why) return toast(why, true);
  const tm = d.teams[team];
  const forOther = team !== me.team;
  const warn = fillWarning(d, team, p);
  confirmBox(`Draft ${p.n}?`,
    `<div class="row"><span>Team</span><b>${esc(teamName(team))}${forOther ? " (as commissioner)" : ""}</b></div>
     <div class="row"><span>Position</span><b>${esc(p.pos)} &middot; ${esc(p.tm)}</b></div>
     <div class="row"><span>Cap hit</span><b>${fmtM(p.cap)}</b></div>
     <div class="row"><span>Cap left after</span><b>${fmtM(d.cfg.capMax - tm.cap - p.cap)}</b></div>
     ${warn ? `<p class="warnline">&#9888; ${esc(warn)}. If nobody fits later, the room makes a forced pick of the cheapest player, over the cap.</p>` : ""}`,
    "Draft", async () => {
      // the board may have moved while the dialog was open
      if (D.cur !== d.cur || D.taken.has(pid)) return toast("The board changed - try again.", true);
      pendingPick = true;
      const by = forOther ? "commish" : "owner";
      const ok = await write(pickUpdate(D, team, pid, by), "Pick");
      pendingPick = false;
      if (ok) toast(`${p.n} drafted`);
    });
}

async function tryAutoPick() {
  const d = D;
  const team = d.onClock;
  const choice = autoChoice(d, team);
  if (!choice) { toast(`No legal auto-pick exists for ${teamName(team)} - commissioner must pick.`, true); return; }
  try { await backend.update(pickUpdate(d, team, choice.id, "auto")); }
  catch (e) {
    // Usually another browser won the race, which is fine. If the pick is
    // still open, allow another attempt shortly.
    const n = d.cur;
    setTimeout(() => { if (D && D.cur === n) autoTried = -1; }, 3000);
  }
}

/* ---------------------------------------------------------------- render */

function render() {
  renderBanner();
  renderHeader();
  renderCommish();
  renderUpNext();
  renderPlayers();
  renderTeams();
  if (ui.tab === "board") renderBoard();
  if (ui.tab === "log") renderLog();
}

function renderBanner() {
  const b = $("#banner");
  let html = "", bad = false;
  if (!D) {
    html = me.commish
      ? `The draft room isn't set up yet. Clock: <input type="number" id="setupClock" value="${LEAGUE.clockSec}" min="10" max="600" style="width:64px"> seconds
         <button class="btn primary" id="setupBtn">Set up draft room</button>`
      : "The draft room hasn't been set up yet - check back soon.";
  } else if (D.cfg.playersVersion !== LEAGUE.playersVersion) {
    bad = true;
    html = me.commish
      ? `This page's player list (${esc(LEAGUE.playersVersion)}) differs from the one the room was set up with (${esc(D.cfg.playersVersion)}). Reload first; if it persists, <button class="btn small" id="applyList">Use this page's list</button>`
      : "The player list was updated - reload this page (Ctrl+F5) to get it.";
  } else if (D.stuck && D.onClock === me.team) {
    bad = true;
    html = "No available player fits under your cap, so the room makes a forced pick for you: the cheapest player at a position you still need.";
  } else if (D.status === "setup" && me.team) {
    const ids = idsOf(myKeepers && myKeepers.ids);
    html = ids.length
      ? `Your keepers: <b>${ids.map(id => esc((P.get(id) || { n: id }).n)).join(", ")}</b>. You can change them until the draft starts. <button class="btn small" id="kpOpen">Change</button>`
      : `Choose your ${KEEP_N} keepers before the draft starts. Nobody else sees them until then. <button class="btn small primary" id="kpOpen">Choose keepers</button>`;
  } else if (D.cfg.keeperMode === "test" && !D.done) {
    html = "Test draft: keepers are placeholders, not anyone's real choices.";
  } else if (LOCAL) {
    html = "Local test mode: everything stays in this browser. Open more tabs with <code>?local=1&amp;team=t3</code> etc. to play other teams.";
  }
  if (banner.extra) { html = banner.extra; bad = banner.bad; }
  b.hidden = !html;
  b.className = "banner" + (bad ? " bad" : "");
  b.innerHTML = html;
  const sb = $("#setupBtn");
  if (sb) sb.onclick = () => setupRoom(Math.round(Number($("#setupClock").value)) || LEAGUE.clockSec);
  const al = $("#applyList");
  if (al) al.onclick = () => commish.applyNewList();
  const kb = $("#kpOpen");
  if (kb) kb.onclick = openKeeperChooser;
}
const banner = { extra: "", bad: false };

function renderHeader() {
  $("#season").textContent = `${LEAGUE.season} draft`;
  $("#leagueName").textContent = LEAGUE.league;
  const chip = $("#whoChip");
  chip.textContent = me.commish ? `${teamName(me.team)} · commissioner` : me.team ? teamName(me.team) : "Viewing only";
  chip.classList.toggle("me", !!me.team);
  $("#commishSignIn").hidden = me.commish;
  $("#builtInfo").textContent = `Projections & ADP: ESPN · player list ${LEAGUE.built}`;
  const card = $("#clockCard");
  if (!D) {
    $("#pickLabel").textContent = " "; $("#statusBadge").textContent = "";
    $("#onClock").textContent = "Not set up"; card.classList.remove("mine");
    return;
  }
  const badge = $("#statusBadge");
  badge.textContent = { live: "LIVE", paused: "PAUSED", setup: "NOT STARTED", done: "" }[D.status];
  badge.className = "badge " + D.status;
  if (D.done) {
    $("#pickLabel").textContent = "Draft complete";
    $("#onClock").textContent = `${D.picks.length} picks made`;
    card.classList.remove("mine");
  } else {
    const r = Math.floor(D.cur / N_TEAMS) + 1, k = (D.cur % N_TEAMS) + 1;
    $("#pickLabel").textContent = `Round ${r} · Pick ${k} · #${D.cur + 1}`;
    const mine = D.onClock === me.team;
    $("#onClock").textContent = teamName(D.onClock) + (mine ? " — you're up!" : "");
    card.classList.toggle("mine", mine);
  }
  tickClock();
}

function tickClock() {
  const ms = remainingMs(D);
  const el = $("#clockTime"), bar = $("#clockBar");
  if (ms == null) { el.textContent = D && D.done ? "✓" : "--:--"; bar.style.width = "0"; el.classList.remove("low"); return; }
  const s = Math.max(0, Math.ceil(ms / 1000));
  el.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  el.classList.toggle("low", D.status === "live" && s <= 10);
  const full = D.status === "live" ? D.st.clockMs : D.cfg.clockSec * 1000;
  bar.style.width = `${Math.max(0, Math.min(100, (ms / full) * 100))}%`;
}

function renderCommish() {
  const bar = $("#commishBar");
  bar.hidden = !me.commish || !D;
  if (bar.hidden) return;
  $("#cStart").hidden = D.status !== "setup";
  $("#cTest").hidden = D.status !== "setup";
  $("#cKeepers").hidden = D.status !== "setup";
  $("#cPause").hidden = D.status !== "live";
  $("#cResume").hidden = D.status !== "paused";
  $("#cAuto").disabled = D.done || D.status === "setup";
  $("#cUndo").disabled = !D.picks.length;
  if (document.activeElement !== $("#cClock")) $("#cClock").value = D.cfg.clockSec;
}

/* The pick strip: every pick made so far (player + salary), the team on the
   clock, and the next 14. Each time the draft moves on it scrolls so the
   PREVIOUS pick sits at the left edge - what just happened, then who's up.
   Between picks it stays wherever the viewer scrolled to. */
let upScrolledFor = null;
function renderUpNext() {
  const el = $("#upNext");
  if (!D) { el.innerHTML = ""; return; }
  const byN = new Map(D.picks.map(pk => [pk.n, pk]));
  const end = D.done ? D.cfg.total : Math.min(D.cfg.total, D.cur + 14);
  const out = [];
  for (let n = 0; n < end; n++) {
    const t = slotTeam(D, n), pk = byN.get(n), p = pk && P.get(pk.p);
    const tag = !pk ? "" : pk.forced ? " · OVER CAP" : pk.by === "auto" ? " · AUTO" : "";
    const cls = ["up", n === D.cur && !D.done ? "now" : "", t === me.team ? "me" : "", pk ? "done" : ""].filter(Boolean).join(" ");
    out.push(`<div class="${cls}" data-n="${n}"><b>#${n + 1}</b> ${esc(teamName(t))}` +
      (p ? `<div class="upp">${esc(p.n)} · ${fmtM(p.cap)}${tag}</div>` : n === D.cur && !D.done ? `<div class="upp">on the clock</div>` : "") +
      `</div>`);
  }
  el.innerHTML = out.join("");
  const target = D.done ? D.cfg.total - 1 : Math.max(0, D.cur - 1);
  if (upScrolledFor !== target) {
    upScrolledFor = target;
    const node = el.querySelector(`[data-n="${target}"]`);
    if (node) el.scrollLeft += node.getBoundingClientRect().left - el.getBoundingClientRect().left - 20;
  }
}

function renderPlayers() {
  const tbody = $("#playerRows");
  if (!D) { tbody.innerHTML = `<tr><td colspan="6" class="empty">Waiting for the draft room to be set up.</td></tr>`; return; }
  const pickNow = canPickNow(D);
  const ctx = pickNow ? D.onClock : me.team;      // whose legality to show
  $("#fitsWrap").hidden = !ctx;
  const q = fold(ui.q.trim());
  let list = D.available.filter(p => (ui.pos === "all" || p.g === ui.pos) && (!q || p._f.includes(q)));
  const reasons = new Map(), warns = new Map();
  if (ctx) for (const p of list) {
    const w = whyNot(D, ctx, p);
    if (w) reasons.set(p.id, w);
    else { const f = fillWarning(D, ctx, p); if (f) warns.set(p.id, f); }
  }
  if (ui.fitsOnly && ctx) list = list.filter(p => !reasons.has(p.id));
  const dir = ui.desc ? -1 : 1;
  const cmp = {
    adp: (a, b) => ((a.adp ?? 1e9) - (b.adp ?? 1e9)) * dir || (b.pts ?? -1) - (a.pts ?? -1),
    pts: (a, b) => ((a.pts ?? -1) - (b.pts ?? -1)) * dir,
    cap: (a, b) => (a.cap - b.cap) * dir,
    n: (a, b) => a.n.localeCompare(b.n) * dir,
  }[ui.sort];
  list.sort(cmp);
  document.querySelectorAll("th[data-sort]").forEach(th => {
    th.classList.toggle("sorted", th.dataset.sort === ui.sort);
    th.classList.toggle("desc", th.dataset.sort === ui.sort && ui.desc);
  });
  const shown = list.slice(0, MAX_ROWS);
  tbody.innerHTML = shown.length ? shown.map(p => {
    const why = reasons.get(p.id), warn = warns.get(p.id);
    const btn = pickNow ? `<button class="btn small primary" data-pick="${p.id}"${why ? " disabled" : ""}>Draft</button>` : "";
    return `<tr class="${why ? "nofit" : ""}"${why || warn ? ` title="${esc(why || warn)}"` : ""}>
      <td><span class="pname">${esc(p.n)}</span><span class="pteam">${esc(p.tm)}</span>${why ? `<div class="why">${esc(why)}</div>`
        : warn ? `<div class="warnline">${esc(warn)}</div>` : ""}</td>
      <td><span class="pos ${p.g}">${esc(p.pos)}</span></td>
      <td class="num">${fmtM(p.cap)}</td>
      <td class="num">${p.pts == null ? "—" : p.pts.toFixed(1)}</td>
      <td class="num">${p.adp == null ? "—" : p.adp.toFixed(1)}</td>
      <td class="num">${btn}</td></tr>`;
  }).join("") : `<tr><td colspan="6" class="empty">No players match.</td></tr>`;
  $("#rowHint").textContent = list.length > MAX_ROWS ? `Showing ${MAX_ROWS} of ${list.length} - search to find anyone else.` : "";
}

function renderTeams() {
  const el = $("#teamList");
  if (!D) { el.innerHTML = ""; return; }
  el.innerHTML = (D.status === "setup" ? `<p class="hint" style="padding:0 0 8px">Keepers are revealed when the draft starts.</p>` : "") +
    D.cfg.order.map(id => {
    const tm = D.teams[id];
    const left = D.cfg.capMax - tm.cap;
    const slots = GROUPS.map(g => `<span class="${tm.cnt[g] >= D.cfg.req[g] ? "full" : ""}">${g} ${tm.cnt[g]}/${D.cfg.req[g]}</span>`).join("");
    const open = ui.open.has(id);
    const roster = open ? `<div class="roster">${[
      ...tm.keepers.map(p => `<div><span><span class="pos ${p.g}">${esc(p.pos)}</span> ${esc(p.n)}<span class="k">K</span></span><span>${fmtM(p.cap)}</span></div>`),
      ...tm.picks.map(pk => pk.player ? `<div><span><span class="pos ${pk.player.g}">${esc(pk.player.pos)}</span> ${esc(pk.player.n)}</span><span>${fmtM(pk.player.cap)}</span></div>` : ""),
    ].join("")}</div>` : "";
    return `<div class="team${id === D.onClock ? " onclock" : ""}${id === me.team ? " me" : ""}" data-team="${id}">
      <div class="team-head"><span>${esc(teamName(id))}</span><span class="cap${left < 3e6 ? " low" : ""}">${fmtM(left)}</span></div>
      <div class="slots">${slots}<span>${tm.keepers.length + tm.picks.length}/${D.cfg.req.F + D.cfg.req.D + D.cfg.req.G}</span></div>${roster}</div>`;
  }).join("");
}

function renderBoard() {
  const tbl = $("#boardTable");
  if (!D) { tbl.innerHTML = ""; return; }
  const order = D.cfg.order;
  const byN = new Map(D.picks.map(pk => [pk.n, pk]));
  const cell = (p, extra) => p ? `<div class="bn">${esc(p.n)}${extra || ""}</div><div class="bm"><span class="pos ${p.g}">${esc(p.pos)}</span> ${fmtM(p.cap)}</div>` : "";
  let html = `<thead><tr><th></th>${order.map(id => `<th>${esc(teamName(id))}</th>`).join("")}</tr></thead><tbody>`;
  const maxK = Math.max(...order.map(id => D.teams[id].keepers.length));
  for (let k = 0; k < maxK; k++) {
    html += `<tr><td class="rnd">${k === 0 ? "K" : ""}</td>${order.map(id => `<td class="keeper${id === me.team ? " mecol" : ""}">${cell(D.teams[id].keepers[k])}</td>`).join("")}</tr>`;
  }
  for (let r = 0; r < D.cfg.rounds; r++) {
    html += `<tr><td class="rnd">${r + 1}</td>`;
    order.forEach((id, i) => {
      const n = r * N_TEAMS + (r % 2 ? N_TEAMS - 1 - i : i);
      const pk = byN.get(n);
      const p = pk && P.get(pk.p);
      const cls = [n === D.cur && !D.done ? "now" : "", id === me.team ? "mecol" : ""].join(" ");
      const tag = !pk ? "" : pk.forced ? `<span class="auto">OVER CAP</span>` : pk.by === "auto" ? `<span class="auto">AUTO</span>` : "";
      html += `<td class="${cls}">${cell(p, tag)}</td>`;
    });
    html += "</tr>";
  }
  tbl.innerHTML = html + "</tbody>";
}

function renderLog() {
  const el = $("#logList");
  if (!D || !D.picks.length) { el.innerHTML = `<div class="empty">No picks yet.</div>`; return; }
  el.innerHTML = [...D.picks].reverse().map(pk => {
    const p = P.get(pk.p) || { n: pk.p, pos: "?", g: "F", tm: "", cap: 0 };
    const r = Math.floor(pk.n / N_TEAMS) + 1, k = (pk.n % N_TEAMS) + 1;
    const by = pk.forced ? `<span class="by">AUTO &middot; OVER CAP</span>` : pk.by === "auto" ? `<span class="by">AUTO</span>`
      : pk.by === "commish" ? `<span class="by">COMMISH</span>` : "";
    return `<div class="logrow"><span class="no">#${pk.n + 1} &middot; ${r}.${k}</span>
      <span class="who"><b>${esc(p.n)}</b> <span class="pos ${p.g}">${esc(p.pos)}</span> <span class="pteam">${esc(p.tm)} &middot; ${fmtM(p.cap)}</span><br>
      <span class="pteam" style="margin:0">${esc(teamName(pk.t))}</span> ${by}</span>
      ${me.commish ? `<button class="btn small" data-edit="${pk.n}">Change</button>` : ""}</div>`;
  }).join("");
}

/* Commissioner: swap the player on an already-made pick. */
function editPick(n) {
  const pk = D.picks.find(x => x.n === n);
  if (!pk) return;
  const old = P.get(pk.p);
  showModal(`<h3>Change pick #${n + 1} (${esc(teamName(pk.t))})</h3>
    <p>Currently <b>${esc(old ? old.n : pk.p)}</b>. Choose the replacement:</p>
    <input id="editSearch" type="search" placeholder="Search players" style="width:100%;padding:8px;margin-bottom:8px">
    <div id="editList"></div>
    <div class="modal-actions"><button class="btn" data-close>Cancel</button></div>`);
  const draw = () => {
    const q = fold($("#editSearch").value.trim());
    const list = D.available.filter(p => !q || p._f.includes(q)).slice(0, 40);
    $("#editList").innerHTML = list.map(p => {
      const why = old ? whyNot(D, pk.t, p, old) : null;
      return `<div class="pickrow" data-to="${p.id}"><span><span class="pos ${p.g}">${esc(p.pos)}</span> ${esc(p.n)} <span class="pteam">${esc(p.tm)}</span>${why ? `<div class="why">${esc(why)}</div>` : ""}</span><span>${fmtM(p.cap)}</span></div>`;
    }).join("");
    $("#editList").querySelectorAll("[data-to]").forEach(row => row.onclick = () => {
      const to = row.dataset.to;
      closeModal();
      write({
        [`draft/picks/${n}/p`]: to, [`draft/picks/${n}/by`]: "commish",
        [`draft/taken/${pk.p}`]: null, [`draft/taken/${to}`]: String(n),
      }, "Change").then(ok => ok && toast(`Pick #${n + 1} is now ${P.get(to).n}`));
    });
  };
  $("#editSearch").oninput = draw;
  draw();
  $("#editSearch").focus();
}

/* ---------------------------------------------------------------- modal / toast */

function showModal(html) {
  $("#modalBox").innerHTML = html;
  $("#modal").hidden = false;
  $("#modalBox").querySelectorAll("[data-close]").forEach(b => b.onclick = closeModal);
}
function closeModal() { $("#modal").hidden = true; $("#modalBox").innerHTML = ""; }
function confirmBox(title, body, okLabel, onOk, danger) {
  showModal(`<h3>${esc(title)}</h3>${body}<div class="modal-actions">
    <button class="btn" data-close>Cancel</button>
    <button class="btn ${danger ? "danger" : "primary"}" id="modalOk">${esc(okLabel)}</button></div>`);
  $("#modalOk").onclick = () => { closeModal(); onOk(); };
  $("#modalOk").focus();
}
let toastTimer = null;
function toast(msg, bad) {
  const t = $("#toast");
  t.textContent = msg; t.className = "toast" + (bad ? " bad" : ""); t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, bad ? 6000 : 3000);
}
function copy(text) {
  navigator.clipboard.writeText(text).then(() => toast("Copied"), () => toast("Copy failed - select and copy manually", true));
}

/* ---------------------------------------------------------------- your-turn alert */

let audioCtx = null;
function beep() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.frequency.value = 880; g.gain.value = 0.08;
    o.connect(g); g.connect(audioCtx.destination);
    o.start(); o.stop(audioCtx.currentTime + 0.18);
  } catch { /* no audio until the page has been clicked once */ }
}
function onClockChanged() {
  if (!D) return;
  const mine = !D.done && D.status === "live" && D.onClock === me.team;
  if (mine && lastOnClock !== D.cur) { beep(); setTimeout(beep, 260); }
  lastOnClock = mine ? D.cur : null;
  document.title = mine ? "⏰ You're on the clock!" : `${LEAGUE.league} draft`;
}

/* ---------------------------------------------------------------- wiring */

function wire() {
  document.querySelectorAll("#tabs button").forEach(b => b.onclick = () => {
    ui.tab = b.dataset.tab;
    document.querySelectorAll("#tabs button").forEach(x => x.classList.toggle("active", x === b));
    for (const t of ["players", "board", "log", "teams"]) $(`#tab-${t}`).hidden = t !== ui.tab;
    render();
  });
  $("#search").oninput = e => { ui.q = e.target.value; renderPlayers(); };
  // a mouse wheel scrolls the pick strip sideways (touch and trackpads already do)
  $("#upNext").addEventListener("wheel", e => {
    if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
    e.currentTarget.scrollLeft += e.deltaY;
    e.preventDefault();
  }, { passive: false });
  document.querySelectorAll("#posFilter button").forEach(b => b.onclick = () => {
    ui.pos = b.dataset.pos;
    document.querySelectorAll("#posFilter button").forEach(x => x.classList.toggle("on", x === b));
    renderPlayers();
  });
  $("#fitsOnly").onchange = e => { ui.fitsOnly = e.target.checked; renderPlayers(); };
  document.querySelectorAll("th[data-sort]").forEach(th => th.onclick = () => {
    const s = th.dataset.sort;
    if (ui.sort === s) ui.desc = !ui.desc;
    else { ui.sort = s; ui.desc = s === "pts" || s === "cap"; }
    renderPlayers();
  });
  $("#playerRows").onclick = e => { const b = e.target.closest("[data-pick]"); if (b && !b.disabled) askPick(b.dataset.pick); };
  $("#teamList").onclick = e => {
    const t = e.target.closest("[data-team]"); if (!t) return;
    const id = t.dataset.team; ui.open.has(id) ? ui.open.delete(id) : ui.open.add(id); renderTeams();
  };
  $("#logList").onclick = e => { const b = e.target.closest("[data-edit]"); if (b) editPick(Number(b.dataset.edit)); };
  $("#modal").onclick = e => { if (e.target.id === "modal") closeModal(); };
  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && !$("#modal").hidden) closeModal();
    if (e.key === "/" && document.activeElement.tagName !== "INPUT") { e.preventDefault(); $("#search").focus(); }
  });
  $("#cStart").onclick = () => startDraft(false);
  $("#cTest").onclick = () => startDraft(true);
  $("#cKeepers").onclick = () => openKeeperAdmin();
  $("#cPause").onclick = () => commish.pause();
  $("#cResume").onclick = () => commish.resume();
  $("#cAuto").onclick = () => commish.autoNow();
  $("#cUndo").onclick = () => commish.undo();
  $("#cClockSet").onclick = () => commish.setClock();
  $("#cLinks").onclick = () => commish.links();
  $("#cExport").onclick = () => commish.exportCsv();
  $("#cReset").onclick = () => commish.reset();
  $("#commishSignIn").onclick = async () => {
    try {
      if (await backend.commishSignIn()) {
        me.commish = true; me.team = LEAGUE.commishTeam; banner.extra = ""; await loadMyKeepers(); render();
        toast("Signed in as commissioner");
      } else {
        await backend.signOut();
        toast("That Google account isn't the commissioner.", true);
        await restoreTeam();
        render();
      }
    } catch (e) { toast("Sign-in failed: " + (e.message || e), true); }
  };
}

/* A team link opened once is remembered on that device, so the plain page
   address works for that owner afterwards. Only a link typed in the address
   bar gets the "invalid" banner; a remembered one that no longer works (room
   reset with new links, or a local-mode test) is quietly forgotten. */
const SAVED_LINK = "nsgTeamLink";
async function restoreTeam() {
  let team = params.get("team"), key = params.get("key");
  const fromUrl = !!team;
  if (!fromUrl && !LOCAL) {
    try { const s = JSON.parse(localStorage.getItem(SAVED_LINK) || "null"); if (s) ({ team, key } = s); } catch { /* none saved */ }
  }
  if (!team || !TEAM.has(team)) return;
  if (await backend.claimTeam(team, key || "")) {
    me.team = team;
    if (!LOCAL) try { localStorage.setItem(SAVED_LINK, JSON.stringify({ team, key })); } catch { /* private mode */ }
  } else if (fromUrl) {
    banner.extra = "This team link isn't valid (or the room isn't set up yet). Ask the commissioner for your link.";
    banner.bad = true;
  } else {
    try { localStorage.removeItem(SAVED_LINK); } catch { /* private mode */ }
  }
}

async function main() {
  wire();
  try {
    backend = LOCAL ? connectLocal({ commish: params.has("commish") }) : await connectFirebase(FIREBASE_CONFIG);
  } catch (e) {
    banner.extra = "Could not reach the draft server: " + esc(e.message || e); banner.bad = true; render(); return;
  }
  backend.onConnection(ok => { const d = $("#connDot"); d.className = "dot " + (ok ? "on" : "off"); d.title = ok ? "Connected" : "Reconnecting..."; });
  await backend.authReady();
  me.commish = await backend.isCommish();
  if (me.commish) me.team = LEAGUE.commishTeam;
  else await restoreTeam();
  await loadMyKeepers();

  backend.subscribe(t => {
    D = derive(t);
    if (D && !D.done) D.stuck = isStuck(D, D.onClock);
    if (D && D.cur !== autoTried && autoTried !== -1 && D.cur > autoTried) autoTried = -1;
    render();
    onClockChanged();
  }, e => { banner.extra = "Lost access to the draft data: " + esc(e.message || e); banner.bad = true; render(); });

  setInterval(() => {
    if (!D) return;
    tickClock();
    const ms = remainingMs(D);
    if (D.status !== "live" || D.done || ms == null || pendingPick) return;
    if (!(me.team || me.commish) || autoTried === D.cur) return;
    // A team with nothing it can legally pick gets its forced pick at once -
    // from the commissioner's page, the only one the database lets act before
    // the clock runs out. Other pages fall back to the normal timeout below.
    if (D.stuck && me.commish) { autoTried = D.cur; tryAutoPick(); return; }
    // the commissioner's browser goes first; the others back it up
    const wait = AUTO_GRACE_MS + (me.commish ? 0 : 800 + Math.random() * 1500);
    if (ms < -wait) { autoTried = D.cur; tryAutoPick(); }
  }, 200);
  render();
}

main();
