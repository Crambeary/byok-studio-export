// Drives the real Obsidian desktop app over the Chrome DevTools Protocol. Runs inside the
// bubblewrap jail created by run.sh: every path here is a jail path under /work or /out.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const net = require("node:net");
const { spawn, execFileSync } = require("node:child_process");

const ELECTRON = "/usr/lib/electron43/electron", APP = "/usr/lib/obsidian/app.asar";
const VAULT = "/work/vault", DB = "/work/studio/db.sqlite", OUT = "/out";
const CFG = "/work/cfg/obsidian", PLUGIN_ID = "byok-studio-import", COMMAND = `${PLUGIN_ID}:import-library`;
const PLUGIN_DIR = `${VAULT}/.obsidian/plugins/${PLUGIN_ID}`, DATA = `${PLUGIN_DIR}/data.json`;
const ROOT = "BYOK Studio", PROJECT = `${ROOT}/Synthetic Project`;
const NOTES = { alpha: `${PROJECT}/Alpha.md`, beta: `${PROJECT}/Chapters/Beta.md`, gamma: `${PROJECT}/Gamma.md`, delta: `${PROJECT}/Delta.md` };

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const results = [];
let scenario = "setup";
function check(name, pass, observed) {
  results.push({ scenario, name, pass: Boolean(pass), ...(observed === undefined ? {} : { observed }) });
  console.log(`${pass ? "PASS" : "FAIL"} [${scenario}] ${name}${pass || observed === undefined ? "" : ` :: ${JSON.stringify(observed)}`}`);
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
async function waitFor(what, predicate, ms = 30000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > end) throw Error(`Timed out waiting for ${what}`);
    await sleep(50);
  }
}

// --- Synthetic Studio library -------------------------------------------------------------
const lit = value => value === null ? "NULL" : typeof value === "number" ? String(value) : `'${String(value).replace(/'/g, "''")}'`;
const sqlite = (sql, args = []) => execFileSync("/usr/bin/sqlite3", [...args, DB], { input: sql, encoding: "utf8" });
const textData = (name, html, updatedAt = "2026-01-01T00:00:00Z") => JSON.stringify({ name, content: html, updatedAt });
function insertFile(id, folder, type, trashed, data) {
  return `INSERT INTO files(id,user_id,project_id,folder_id,type,is_trashed,position,created_at,data,mirrored_at) VALUES(${[id, null, "p1", folder, type, trashed, 0, "2026-01-01", data, 1].map(lit).join(",")});\n`;
}
function createLibrary() {
  fs.mkdirSync(path.dirname(DB), { recursive: true });
  const schema = JSON.parse(fs.readFileSync("/work/tested-schema.json", "utf8"));
  const ordered = [...schema.filter(s => s[0] === "table"), ...schema.filter(s => s[0] !== "table")];
  let sql = "PRAGMA journal_mode=WAL;\nBEGIN;\n" + ordered.map(s => `${s[2]};`).join("\n") + "\n";
  sql += `INSERT INTO projects(id,user_id,created_at,data,mirrored_at) VALUES('p1',NULL,'2026-01-01',${lit(JSON.stringify({ name: "Synthetic Project" }))},1);\n`;
  sql += `INSERT INTO folders(id,user_id,project_id,parent_folder_id,is_trashed,position,data,mirrored_at) VALUES('f1',NULL,'p1',NULL,0,0,${lit(JSON.stringify({ name: "Chapters" }))},1);\n`;
  sql += insertFile("alpha", null, "text", 0, textData("Alpha", "<p>Alpha original.</p>"));
  sql += insertFile("beta", "f1", "text", 0, textData("Beta", "<p>Beta original.</p>"));
  sql += insertFile("gamma", null, "text", 0, textData("Gamma", "<p>Gamma stable.</p>"));
  sql += insertFile("delta", null, "text", 0, textData("Delta", "<p>Delta original.</p>"));
  sql += insertFile("trashed", null, "text", 1, textData("Trashed", "<p>Must not import.</p>"));
  sql += insertFile("picture", null, "image", 0, JSON.stringify({ name: "Picture" }));
  sql += `INSERT INTO manuscript_files(id,user_id,project_id,folder_id,is_trashed,position,data,mirrored_at) VALUES('m1',NULL,'p1',NULL,0,0,${lit(JSON.stringify({ name: "Manuscript" }))},1);\n`;
  sql += `INSERT INTO outbox(kind,entity_type,entity_id,method,url,body,status,created_at,updated_at) VALUES('update','file','alpha','PUT','https://invalid.example/synthetic',${lit("synthetic outbox sentinel")},'pending',1,1);\n`;
  sqlite(sql + "COMMIT;\n");
}
function studioUpdate(id, html, updatedAt) {
  sqlite(`UPDATE files SET data=json_set(data,'$.content',${lit(html)},'$.updatedAt',${lit(updatedAt)}) WHERE id=${lit(id)};`);
}
const studioState = () => ({
  mainDbSha: sha(fs.readFileSync(DB)),
  files: sha(sqlite("SELECT id,type,is_trashed,data FROM files ORDER BY id;", ["-readonly", "-json"])),
  outbox: sqlite("SELECT * FROM outbox ORDER BY id;", ["-readonly", "-json"]).trim(),
});
const expectedNote = (id, updated, body) => `---\nbyok-id: "${id}"\nbyok-type: text\nbyok-updated: "${updated}"\n---\n\n${body}\n`;

// --- Vault inspection ---------------------------------------------------------------------
const disk = rel => fs.readFileSync(`${VAULT}/${rel}`, "utf8");
const statusesOf = report => Object.fromEntries(report.map(r => [`${r.id}:${r.status}`, true]));
function snapshot(dir = ROOT) {
  const out = {};
  (function walk(rel) {
    for (const entry of fs.readdirSync(`${VAULT}/${rel}`, { withFileTypes: true })) {
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else { const stat = fs.statSync(`${VAULT}/${child}`); out[child] = { sha: sha(fs.readFileSync(`${VAULT}/${child}`)), mtimeMs: stat.mtimeMs }; }
    }
  })(dir);
  return out;
}
const markerPath = () => {
  const name = fs.readdirSync(`${VAULT}/${ROOT}`).find(entry => /^\.byok-sync-[0-9a-f]{64}\.json$/.test(entry));
  return name ? `${ROOT}/${name}` : null;
};
const scopeKey = JSON.stringify([DB, VAULT, ROOT]);
const pluginData = () => JSON.parse(fs.readFileSync(DATA, "utf8"));

// --- Obsidian session over CDP ------------------------------------------------------------
let session, settings;
class Session {
  constructor(child, ws) { Object.assign(this, { child, ws, id: 0, pending: new Map(), consoles: [], requests: [] }); }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject, method }); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  onMessage(raw) {
    const msg = JSON.parse(raw);
    if (msg.id) {
      const waiter = this.pending.get(msg.id); this.pending.delete(msg.id);
      if (msg.error) waiter.reject(Error(`${waiter.method}: ${msg.error.message}`)); else waiter.resolve(msg.result);
    } else if (msg.method === "Runtime.consoleAPICalled") this.onConsole(msg.params);
    else if (msg.method === "Network.requestWillBeSent") this.requests.push(msg.params.request.url);
  }
  async onConsole({ type, args }) {
    const parts = await Promise.all(args.map(async arg => {
      if (arg.objectId) {
        try {
          const { result } = await this.send("Runtime.callFunctionOn", { objectId: arg.objectId, returnByValue: true,
            functionDeclaration: "function(){return this instanceof Error?String(this.message):JSON.stringify(this)}" });
          return result.value;
        } catch { return arg.description; }
      }
      return arg.value;
    }));
    this.consoles.push({ type, parts });
  }
  async evaluate(expression) {
    const { result, exceptionDetails } = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (exceptionDetails) throw Error(`App evaluate failed: ${exceptionDetails.exception?.description || exceptionDetails.text}\n${expression}`);
    return result.value;
  }
  async click(expression) {
    const box = await this.evaluate(`(()=>{const e=${expression}; if(!e) return null; e.scrollIntoView({block:"center"}); const r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    if (!box) throw Error(`Nothing to click: ${expression}`);
    const mouse = (type, extra = {}) => this.send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, ...extra });
    await mouse("mouseMoved"); await mouse("mousePressed", { button: "left", clickCount: 1 }); await mouse("mouseReleased", { button: "left", clickCount: 1 });
  }
  async doubleClick(expression) {
    const box = await this.evaluate(`(()=>{const r=(${expression}).getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    const mouse = (type, clickCount) => this.send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount });
    for (const count of [1, 2]) { await mouse("mousePressed", count); await mouse("mouseReleased", count); }
  }
  async key(key, code, vk, modifiers = 0, text) {
    const base = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers };
    await this.send("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", ...base, ...(text ? { text } : {}) });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  }
  type(text) { return this.send("Input.insertText", { text }); }
  async screenshot(name) {
    const { data } = await this.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(`${OUT}/${name}.png`, Buffer.from(data, "base64"));
  }
  bodyText() { return this.evaluate("document.body.innerText"); }
}
async function launch() {
  const log = fs.createWriteStream(`${OUT}/obsidian-app.log`, { flags: "a" });
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(ELECTRON, [APP, "--ozone-platform=headless", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--remote-debugging-port=0", "--window-size=1400,900"], { env, stdio: ["ignore", "pipe", "pipe"] });
  let buffered = "";
  const browser = await new Promise((resolve, reject) => {
    const scan = chunk => { log.write(chunk); buffered += chunk; const match = buffered.match(/ws:\/\/127\.0\.0\.1:(\d+)\//); if (match) resolve(match[1]); };
    child.stdout.on("data", scan); child.stderr.on("data", scan);
    child.on("exit", code => reject(Error(`Obsidian exited early (${code})`)));
  });
  const page = await waitFor("Obsidian window", async () => {
    const targets = await (await fetch(`http://127.0.0.1:${browser}/json`)).json();
    return targets.find(t => t.type === "page" && t.url.includes("obsidian.md/index.html"));
  });
  const s = await attach(page, child);
  await Promise.all(["Runtime.enable", "Network.enable"].map(m => s.send(m)));
  await waitFor("workspace ready", () => s.evaluate("Boolean(window.app&&app.workspace&&app.workspace.layoutReady)"), 60000);
  Object.assign(s, { browser, targetId: page.id });
  return s;
}
async function attach(target, child) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  const s = new Session(child, ws);
  ws.onmessage = event => s.onMessage(event.data);
  await s.send("Page.enable");
  await s.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  // Headless ozone ignores --window-size and starts tiny; give the layout a desktop viewport.
  await s.send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
  return s;
}
async function settingsPopout() {
  await waitFor("settings popout", () => session.evaluate("Boolean(app.setting.popout?.win)"));
  const target = await waitFor("popout target", async () => {
    const targets = await (await fetch(`http://127.0.0.1:${session.browser}/json`)).json();
    return targets.find(t => t.type === "page" && t.id !== session.targetId);
  });
  return attach(target, session.child);
}
async function quit(s) {
  const exited = new Promise(resolve => s.child.once("exit", resolve));
  await s.send("Page.close").catch(() => {});
  await Promise.race([exited, sleep(5000)]);
  if (s.child.exitCode === null) s.child.kill("SIGTERM");
  await Promise.race([exited, sleep(3000)]);
}

// --- Plugin interactions ------------------------------------------------------------------
const buttonNamed = text => `[...document.querySelectorAll("button")].find(b=>b.textContent.trim()===${JSON.stringify(text)})`;
const closeSettings = () => session.evaluate("app.setting.close(); 0");
async function installFromUi() {
  // A vault that already contains a plugin (README step 2) opens with Obsidian's trust prompt.
  await waitFor("vault trust prompt", () => session.evaluate(`Boolean(${buttonNamed("Trust author and enable plugins")})`));
  await session.screenshot("01-vault-trust-prompt");
  report.observations.vaultTrustPromptShownAfterManualCopy = true;
  await session.click(buttonNamed("Trust author and enable plugins"));
  await waitFor("trust prompt closed", () => session.evaluate(`!${buttonNamed("Trust author and enable plugins")}`));
  check("plugin stays disabled until enabled in settings", await session.evaluate(`!app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}]`));
  const row = `[...document.querySelectorAll(".vertical-tab-content .setting-item")].find(e=>e.textContent.includes("BYOK Studio Import"))`;
  // Obsidian's trust button leaves Restricted Mode and opens this settings tab itself.
  // Desktop 1.15 renders Settings in a popout window, which is its own DevTools target.
  settings = await settingsPopout();
  report.observations.settingsRenderedInPopoutWindow = true;
  await waitFor("installed plugin row", () => settings.evaluate(`Boolean(${row})`), 20000);
  await settings.screenshot("02-community-plugins");
  await settings.click(`${row}.querySelector(".checkbox-container")`);
  await waitFor("plugin enabled", () => session.evaluate(`app.plugins.enabledPlugins.has(${JSON.stringify(PLUGIN_ID)}) && Boolean(app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}])`));
}
async function configureFromUi() {
  await session.evaluate(`app.setting.openTabById(${JSON.stringify(PLUGIN_ID)}); 0`);
  const input = name => `[...document.querySelectorAll(".vertical-tab-content .setting-item")].find(e=>e.textContent.includes(${JSON.stringify(name)})).querySelector("input")`;
  await waitFor("plugin settings tab", () => settings.evaluate(`Boolean([...document.querySelectorAll(".vertical-tab-content .setting-item")].find(e=>e.textContent.includes("Studio database path")))`));
  await settings.click(input("Studio database path"));
  await settings.type(DB);
  await waitFor("database path persisted", () => { try { return pluginData().database === DB; } catch { return false; } });
  await settings.screenshot("03-plugin-settings");
  await closeSettings();
  await waitFor("settings popout closed", () => session.evaluate("!app.setting.popout"));
  settings.ws.close(); settings = null;
}
async function palette() {
  await session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 700, y: 400 });
  await session.key("p", "KeyP", 80, 2);
  await waitFor("command palette", () => session.evaluate(`Boolean(document.querySelector(".prompt input"))`));
  await session.type("Import local Studio Library");
  await waitFor("palette suggestion", () => session.evaluate(`[...document.querySelectorAll(".prompt .suggestion-item")].some(e=>e.textContent.includes("Import local Studio Library"))`));
  await session.key("Enter", "Enter", 13, 0, "\r");
}
const viaCommand = () => session.evaluate(`app.commands.executeCommandById(${JSON.stringify(COMMAND)})`);
async function runImport(label, trigger = palette, { allowStudioChange = false } = {}) {
  const before = studioState(), mark = session.consoles.length;
  await trigger();
  const entry = await waitFor(`${label} result`, () => session.consoles.slice(mark).find(c => /^BYOK import (report|failed)/.test(String(c.parts[0]))), 120000);
  await sleep(200);
  const notices = await session.evaluate(`[...document.querySelectorAll(".notice")].map(n=>n.textContent)`);
  await session.evaluate(`document.querySelectorAll(".notice").forEach(n=>n.click())`);
  const failed = entry.parts[0] === "BYOK import failed";
  const report = failed ? null : JSON.parse(entry.parts[1]);
  if (!allowStudioChange) check(`${label}: Studio database bytes, records and outbox unchanged by the plugin`, same(before, studioState()), { before, after: studioState() });
  return { failed, error: failed ? entry.parts[1] : null, report, notices };
}
async function openNote(rel) {
  await session.evaluate(`app.workspace.openLinkText(${JSON.stringify(rel)}, "", false)`);
  await waitFor(`editor for ${rel}`, () => session.evaluate(`app.workspace.activeEditor?.file?.path===${JSON.stringify(rel)} && Boolean(app.workspace.activeEditor.editor)`));
}
async function typeAtEnd(text) {
  await session.evaluate(`(()=>{const e=app.workspace.activeEditor.editor; const line=e.lastLine(); e.setCursor({line,ch:e.getLine(line).length}); e.focus();})()`);
  await session.type(text);
}
const buffer = () => session.evaluate("app.workspace.activeEditor.editor.getValue()");
const closeEditors = () => session.evaluate(`app.workspace.getLeavesOfType("markdown").forEach(l=>l.detach()); app.workspace.getLeavesOfType("markdown").length`);

// --- Scenarios ----------------------------------------------------------------------------
async function isolation() {
  scenario = "isolation";
  check("/home is empty inside the jail", fs.readdirSync("/home").length === 0);
  const interfaces = fs.readFileSync("/proc/net/dev", "utf8").split("\n").slice(2).filter(Boolean).map(line => line.split(":")[0].trim()).sort();
  check("only loopback network interface exists", same(interfaces, ["lo"]), interfaces);
  const external = await new Promise(resolve => {
    const socket = net.connect({ host: "1.1.1.1", port: 443, timeout: 3000 });
    socket.on("connect", () => { socket.destroy(); resolve("connected"); });
    socket.on("timeout", () => { socket.destroy(); resolve("timeout"); });
    socket.on("error", error => resolve(error.code));
  });
  check("external connection attempt fails", external === "ENETUNREACH" || external === "ENETDOWN", external);
  const secretLike = Object.keys(process.env).filter(k => /token|secret|key|pass|auth|cred/i.test(k));
  check("no credential-like environment variables", secretLike.length === 0, secretLike);
}
async function install() {
  scenario = "install";
  createLibrary();
  fs.mkdirSync(PLUGIN_DIR, { recursive: true });
  for (const file of ["manifest.json", "main.js"]) fs.copyFileSync(`/work/plugin/${file}`, `${PLUGIN_DIR}/${file}`);
  fs.mkdirSync(CFG, { recursive: true }); fs.mkdirSync("/work/tmp"); fs.mkdirSync("/work/home"); fs.mkdirSync("/work/run", { mode: 0o700 });
  fs.writeFileSync(`${CFG}/obsidian.json`, JSON.stringify({ vaults: { disposable00000a: { path: VAULT, ts: 1, open: true } } }));
  session = await launch();
  const env = await session.evaluate(`({versions:process.versions.electron, app:window.require("electron").ipcRenderer.sendSync("version"), mobile:app.isMobile, vault:app.vault.adapter.getBasePath(), home:window.require("os").homedir(), sqlite:window.require("child_process").execFileSync("sqlite3",["-version"],{encoding:"utf8"}).split(" ")[0]})`);
  report.environment = { obsidian: env.app, electron: env.versions, sqlite: env.sqlite, display: "Chromium ozone headless (real Electron app, no compositor or window manager)" };
  check("the real desktop app is running on the disposable vault", !env.mobile && env.vault === VAULT && env.home === "/work/home", env);
  check("plugin is not active before the user enables it", await session.evaluate(`!app.plugins.enabledPlugins.has(${JSON.stringify(PLUGIN_ID)})`));
  await installFromUi();
  const enabledList = await waitFor("community-plugins.json", () => { try { return JSON.parse(fs.readFileSync(`${VAULT}/.obsidian/community-plugins.json`, "utf8")); } catch { return null; } });
  check("community-plugins.json records the plugin after UI enable", same(enabledList, [PLUGIN_ID]), enabledList);
  check("import command is registered", await session.evaluate(`Boolean(app.commands.commands[${JSON.stringify(COMMAND)}])`));
  await configureFromUi();
  const data = pluginData();
  check("settings UI persisted database path and default folder", data.database === DB && data.folder === ROOT, data);
  check("write-back is not configured", !data.studioAsar, data.studioAsar);
}
async function firstImport() {
  scenario = "first-import";
  check("no Markdown editor open before import", await session.evaluate(`app.workspace.getLeavesOfType("markdown").length===0`));
  const { failed, error, report: rows, notices } = await runImport("first import");
  check("import succeeded", !failed, error);
  if (failed) return;
  const statuses = statusesOf(rows);
  for (const id of ["alpha", "beta", "gamma", "delta"]) check(`${id} imported`, statuses[`file:${id}:imported`], rows);
  check("trashed record reported and not imported", statuses["file:trashed:trashed"] && !fs.existsSync(`${VAULT}/${PROJECT}/Trashed.md`));
  check("non-text file reported unsupported", statuses["file:picture:unsupported"]);
  check("manuscript reported unsupported", statuses["manuscript:m1:unsupported"]);
  check("notice summarizes the run", notices.some(n => /BYOK import: 4 imported, \d+ reports/.test(n)), notices);
  check("note bytes match the expected format", disk(NOTES.alpha) === expectedNote("alpha", "2026-01-01T00:00:00Z", "Alpha original.") && disk(NOTES.beta) === expectedNote("beta", "2026-01-01T00:00:00Z", "Beta original."), disk(NOTES.alpha));
  const indexed = await session.evaluate(`app.vault.getMarkdownFiles().map(f=>f.path).sort()`);
  check("Obsidian indexed exactly the four notes", same(indexed, Object.values(NOTES).sort()), indexed);
  await waitFor("frontmatter indexing", () => session.evaluate(`app.metadataCache.getCache(${JSON.stringify(NOTES.alpha)})?.frontmatter?.["byok-id"]==="alpha"`));
  check("Obsidian parsed byok-id frontmatter", true);
  const marker = markerPath();
  check("hidden marker exists in the destination folder", marker, fs.readdirSync(`${VAULT}/${ROOT}`));
  const markerJson = JSON.parse(disk(marker)), data = pluginData(), entries = data.state.scopes[scopeKey] || {};
  check("marker scope binds database, vault and destination", markerJson.version === 1 && markerJson.scope === scopeKey, markerJson);
  check("marker reserves exactly the imported record IDs", same([...markerJson.ids].sort(), Object.keys(entries).sort()) && markerJson.ids.length === 4, markerJson.ids);
  check("marker is absent from the vault index", await session.evaluate(`app.vault.getAbstractFileByPath(${JSON.stringify(marker)})===null && !app.vault.getFiles().some(f=>f.name.startsWith(".byok-sync-"))`));
  check("state has no pending reservation after success", Object.values(entries).every(e => !e.pending && typeof e.baseline === "string" && typeof e.studioContent === "string"), entries);
  await session.screenshot("03-after-first-import");
}
async function repeat(label, trigger = palette) {
  const before = snapshot(), dataBefore = fs.readFileSync(DATA, "utf8");
  const { failed, error, report: rows } = await runImport(label, trigger);
  check("import succeeded", !failed, error);
  if (failed) return;
  const statuses = statusesOf(rows);
  check("all four notes are unchanged", ["alpha", "beta", "gamma", "delta"].every(id => statuses[`file:${id}:unchanged`]), rows);
  check("nothing newly imported", !rows.some(r => r.status === "imported"), rows);
  check("destination files, including hidden marker, are byte and mtime identical", same(before, snapshot()), { before, after: snapshot() });
  check("plugin state bytes unchanged", dataBefore === fs.readFileSync(DATA, "utf8"));
}
async function restart() {
  scenario = "restart";
  await quit(session); await sleep(500);
  session = await launch();
  check("plugin is active after restart without re-enabling", await session.evaluate(`Boolean(app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}])`));
  await repeat("repeat import after restart");
}
async function studioSideUpdate() {
  scenario = "studio-update";
  studioUpdate("alpha", "<p>Alpha revised in Studio.</p>", "2026-02-02T00:00:00Z");
  const others = snapshot(), oldEntry = pluginData().state.scopes[scopeKey]["file:alpha"];
  const { failed, error, report: rows } = await runImport("Studio-side update");
  check("import succeeded", !failed, error);
  if (failed) return;
  check("alpha reported updated", statusesOf(rows)["file:alpha:updated"], rows);
  const expected = expectedNote("alpha", "2026-02-02T00:00:00Z", "Alpha revised in Studio.");
  check("alpha note replaced on disk", disk(NOTES.alpha) === expected, disk(NOTES.alpha));
  const after = snapshot();
  for (const note of [NOTES.beta, NOTES.gamma, NOTES.delta]) check(`${path.basename(note)} untouched`, same(others[note], after[note]));
  const entry = pluginData().state.scopes[scopeKey]["file:alpha"];
  check("baseline advanced to the new note", entry.baseline === expected && entry.studioContent === "<p>Alpha revised in Studio.</p>" && entry.baseline !== oldEntry.baseline, entry);
  check("Obsidian reads the replacement through its Vault API", await session.evaluate(`app.vault.read(app.vault.getAbstractFileByPath(${JSON.stringify(NOTES.alpha)}))`) === expected);
}
async function vaultEditPreserved() {
  scenario = "saved-vault-edit";
  const added = " Added in the Obsidian editor.";
  await openNote(NOTES.beta);
  await typeAtEnd(added);
  const edited = expectedNote("beta", "2026-01-01T00:00:00Z", "Beta original.").replace(/\n$/, "") + added + "\n";
  // Obsidian appends after the final text; assert the real on-disk form rather than assuming it.
  await waitFor("editor autosave", () => disk(NOTES.beta).includes(added), 15000);
  const saved = disk(NOTES.beta);
  report.observations.savedEditForm = { expected: edited, actual: saved };
  await closeEditors();
  studioUpdate("beta", "<p>Beta revised in Studio.</p>", "2026-03-03T00:00:00Z");
  const baselineBefore = pluginData().state.scopes[scopeKey]["file:beta"];
  const { failed, error, report: rows } = await runImport("saved vault edit vs Studio change");
  check("import ran", !failed, error);
  if (failed) return;
  check("beta reported changed, not updated", statusesOf(rows)["file:beta:changed"] && !statusesOf(rows)["file:beta:updated"], rows);
  check("edited note bytes preserved", disk(NOTES.beta) === saved, disk(NOTES.beta));
  check("Studio text was not merged into the note", !disk(NOTES.beta).includes("revised in Studio"));
  check("baseline not advanced", same(baselineBefore, pluginData().state.scopes[scopeKey]["file:beta"]));
}
async function unsavedEditorProtection() {
  scenario = "unsaved-editor";
  studioUpdate("delta", "<p>Delta revised in Studio.</p>", "2026-04-04T00:00:00Z");
  const sentinel = " UNSAVED-EDITOR-SENTINEL";
  await openNote(NOTES.delta);
  const onDiskBefore = disk(NOTES.delta), snapBefore = snapshot(), dataBefore = fs.readFileSync(DATA, "utf8");
  await typeAtEnd(sentinel);
  // Sample the buffer and the disk, then fire the same command, in a single renderer turn.
  const started = await session.evaluate(`(async()=>{
    const view=app.workspace.activeEditor, buffer=view.editor.getValue();
    const disk=await app.vault.adapter.read(view.file.path);
    app.commands.executeCommandById(${JSON.stringify(COMMAND)});
    return {buffer,disk};
  })()`);
  check("typed text was genuinely unsaved when import started", started.buffer.includes(sentinel) && !started.disk.includes(sentinel), started);
  check("note on disk matched its pre-edit bytes when import started", started.disk === onDiskBefore);
  const { failed, error, notices } = await runImport("import with unsaved editor", async () => {});
  check("import refused", failed && /Close all Markdown editors, Canvas views and hover popovers/.test(error), error);
  check("user sees the refusal notice", notices.some(n => n.includes("Close all Markdown editors, Canvas views and hover popovers")), notices);
  await session.screenshot("04-unsaved-editor-refused");
  check("editor buffer retained the unsaved text", (await buffer()).includes(sentinel));
  check("Studio text did not reach the editor", !(await buffer()).includes("revised in Studio"));
  const snapAfter = snapshot(); delete snapBefore[NOTES.delta]; delete snapAfter[NOTES.delta];
  check("other destination files untouched by the refused import", same(snapBefore, snapAfter));
  check("plugin state bytes unchanged", dataBefore === fs.readFileSync(DATA, "utf8"));
  await waitFor("editor autosave of user text", () => disk(NOTES.delta).includes(sentinel), 15000);
  const saved = disk(NOTES.delta);
  check("user text reached disk through Obsidian's own save", saved.includes("Delta original.") && !saved.includes("revised in Studio"), saved);
  await closeEditors();
  const later = await runImport("import after closing the editor");
  check("later import ran", !later.failed, later.error);
  if (later.failed) return;
  check("edited note is reported, not overwritten", statusesOf(later.report)["file:delta:changed"] && disk(NOTES.delta) === saved, later.report);
}
async function editorOpenedDuringImport() {
  scenario = "editor-opened-mid-import";
  const count = 300;
  let sql = "BEGIN;\n";
  for (let i = 0; i < count; i++) sql += insertFile(`bulk${i}`, null, "text", 0, textData(`Bulk ${String(i).padStart(3, "0")}`, `<p>Bulk body ${i}.</p>`));
  sqlite(sql + "COMMIT;\n");
  const gamma = disk(NOTES.gamma);
  const bulkOnDisk = () => fs.readdirSync(`${VAULT}/${PROJECT}`).filter(n => n.startsWith("Bulk ")).length;
  const run = await runImport("import interrupted by opening an editor", async () => {
    await viaCommand();
    await waitFor("first bulk notes", () => bulkOnDisk() >= 5, 60000);
    await openNote(NOTES.gamma);
  });
  const created = bulkOnDisk();
  const statuses = run.report ? run.report.reduce((all, r) => (all[r.status] = (all[r.status] || 0) + 1, all), {}) : null;
  report.observations.midImport = { created, statuses, failedDetail: run.error || run.report?.find(r => r.status === "failed")?.detail };
  check("the guard fired part-way through (scenario exercised)", created >= 5 && created < count, report.observations.midImport);
  check("open note was not written", disk(NOTES.gamma) === gamma);
  await closeEditors();
  const retry = await runImport("retry after closing the editor");
  check("retry ran", !retry.failed, retry.error);
  if (retry.failed) return;
  const finished = retry.report.filter(r => /^file:bulk/.test(r.id) && ["imported", "recovered"].includes(r.status)).length;
  report.observations.midImport.retry = retry.report.reduce((all, r) => (all[r.status] = (all[r.status] || 0) + 1, all), {});
  check("all remaining records completed on retry", finished === count - created, { finished, count, created });
  check("every bulk record exists exactly once", bulkOnDisk() === count, bulkOnDisk());
  const entries = pluginData().state.scopes[scopeKey], markerJson = JSON.parse(disk(markerPath()));
  check("no pending reservation remains", Object.values(entries).every(e => !e.pending));
  check("marker reserves every tracked record once", same([...markerJson.ids].sort(), Object.keys(entries).sort()), { marker: markerJson.ids.length, state: Object.keys(entries).length });
  const sample = disk(`${PROJECT}/Bulk 250.md`);
  check("completed note bytes are correct", sample === expectedNote("bulk250", "2026-01-01T00:00:00Z", "Bulk body 250."), sample);
}
async function markerAndStateGuards() {
  scenario = "marker-and-state-guards";
  const marker = markerPath(), parked = "/work/parked-marker.json";
  const beforeMissing = snapshot(); delete beforeMissing[marker];
  fs.renameSync(`${VAULT}/${marker}`, parked);
  const missing = await runImport("import with marker removed");
  check("missing marker refused", missing.failed === false ? false : /Import marker missing/.test(missing.error), missing.error || missing.report);
  check("no note changed", same(beforeMissing, snapshot()));
  check("no replacement marker was fabricated", !fs.existsSync(`${VAULT}/${marker}`));
  fs.renameSync(parked, `${VAULT}/${marker}`);
  const original = fs.readFileSync(DATA, "utf8"), tampered = JSON.parse(original);
  tampered.state.scopes[scopeKey]["file:gamma"].baseline += "tampered";
  fs.writeFileSync(DATA, JSON.stringify(tampered));
  const changedState = await runImport("import with state changed on disk");
  check("external state change refused", changedState.failed && /Plugin state changed on disk/.test(changedState.error), changedState.error || changedState.report);
  check("refused import left the external state bytes alone", fs.readFileSync(DATA, "utf8") === JSON.stringify(tampered));
  fs.writeFileSync(DATA, original);
  const healthy = await runImport("import after restoring marker and state");
  check("restored marker and state work again", !healthy.failed, healthy.error);
}
async function unsavedCanvasEmbed() {
  // The plugin's guard counts "markdown" leaves. A note edited inside a Canvas is a different leaf type.
  scenario = "unsaved-canvas-embed";
  studioUpdate("gamma", "<p>Gamma revised in Studio.</p>", "2026-05-05T00:00:00Z");
  const canvas = "Disposable.canvas", sentinel = " UNSAVED-CANVAS-SENTINEL";
  fs.writeFileSync(`${VAULT}/${canvas}`, JSON.stringify({ nodes: [{ id: "n1", type: "file", file: NOTES.gamma, x: -300, y: -200, width: 600, height: 400 }], edges: [] }));
  await waitFor("canvas indexed", () => session.evaluate(`Boolean(app.vault.getAbstractFileByPath(${JSON.stringify(canvas)}))`));
  await session.evaluate(`app.workspace.openLinkText(${JSON.stringify(canvas)}, "", false)`);
  await waitFor("canvas view", () => session.evaluate(`app.workspace.getLeavesOfType("canvas").length===1 && app.workspace.getLeavesOfType("canvas")[0].view.canvas?.nodes?.size===1`));
  await waitFor("canvas note rendered", () => session.evaluate(`Boolean(document.querySelector(".canvas-node-content .markdown-preview-view, .canvas-node-content .markdown-embed"))`));
  await sleep(500);
  // Canvas hosts its note editor in an iframe, so the outer document has no .cm-content.
  // Entering edit mode and placing the caret use app objects; the text itself is real input to the focused frame.
  const child = `[...app.workspace.getLeavesOfType("canvas")[0].view.canvas.nodes.values()][0].child`;
  await session.evaluate(`[...app.workspace.getLeavesOfType("canvas")[0].view.canvas.nodes.values()][0].startEditing(); 0`);
  await waitFor("embedded editor", () => session.evaluate(`typeof ${child}?.editor?.getValue?.()==="string" && document.activeElement?.tagName==="IFRAME"`), 8000);
  const onDisk = disk(NOTES.gamma);
  await session.evaluate(`(()=>{const e=${child}.editor;e.focus();e.setCursor(e.lastLine()-1,e.getLine(e.lastLine()-1).length)})(); 0`);
  await session.type(sentinel);
  await waitFor("embedded editor shows typed text", () => session.evaluate(`${child}.editor.getValue().includes(${JSON.stringify(sentinel.trim())})`), 1500);
  const started = await session.evaluate(`(async()=>{
    const buffer=${child}.editor.getValue(), disk=await app.vault.adapter.read(${JSON.stringify(NOTES.gamma)});
    const markdownLeaves=app.workspace.getLeavesOfType("markdown").length;
    app.commands.executeCommandById(${JSON.stringify(COMMAND)});
    return {buffer,disk,markdownLeaves};
  })()`);
  check("typed text was unsaved when import started", started.buffer.includes(sentinel.trim()) && started.disk === onDisk, started);
  check("no markdown-type leaf exists, so the plugin's guard has nothing to count", started.markdownLeaves === 0, started.markdownLeaves);
  const run = await runImport("import with unsaved Canvas-embedded editor", async () => {});
  const diskRightAfterImport = disk(NOTES.gamma);
  await sleep(5000); // Allow any editor autosave and any file-change reload to settle.
  const finalDisk = disk(NOTES.gamma);
  const finalBuffer = await session.evaluate(`${child}?.editor?.getValue?.() ?? null`);
  const entry = pluginData().state.scopes[scopeKey]["file:gamma"];
  report.observations.unsavedCanvasEmbed = { failed: run.failed, error: run.error, gamma: run.report?.filter(r => r.id === "file:gamma"), diskRightAfterImport, finalDisk, finalBuffer, baselineMatchesDisk: entry.baseline === finalDisk };
  check("Canvas editor blocks import before the Studio revision is written", run.failed && /Close all Markdown editors, Canvas views and hover popovers/i.test(run.error) && diskRightAfterImport === onDisk, report.observations.unsavedCanvasEmbed);
  check("unsaved Canvas edit survives the import", finalDisk.includes(sentinel.trim()) || finalBuffer?.includes(sentinel.trim()), report.observations.unsavedCanvasEmbed);
  await session.evaluate(`app.workspace.getLeavesOfType("canvas").forEach(l=>l.detach()); 0`);
  await sleep(500);
  const followUp = await runImport("import after the Canvas editor closed");
  const followUpDisk = disk(NOTES.gamma);
  report.observations.unsavedCanvasEmbed.followUp = { failed: followUp.failed, error: followUp.error, gamma: followUp.report?.filter(r => r.id === "file:gamma"), disk: followUpDisk };
  const revision = "Gamma revised in Studio";
  if (!run.failed && run.report?.some(r => r.id === "file:gamma" && r.status === "updated") && !finalDisk.includes(revision))
    finding("import with a note open in a Canvas editor is not refused: it reports the note updated, then the open editor saves over the Studio revision", { diskRightAfterImport, finalDisk, followUp: report.observations.unsavedCanvasEmbed.followUp });
}
const report = { harness: "experiments/obsidian_desktop", plugin: { sha256: process.env.PLUGIN_SHA, srcTree: process.env.SRC_TREE, baseCommit: process.env.BASE_COMMIT }, observations: {}, findings: [] };
// A finding is observed behaviour the harness documents without failing; checks assert the plugin's stated guarantees.
function finding(summary, observed) { report.findings.push({ scenario, summary, observed }); console.log(`FINDING [${scenario}] ${summary}`); }
async function main() {
  try {
    await isolation();
    await install();
    await firstImport();
    scenario = "repeat-import"; await repeat("repeat import");
    await restart();
    await studioSideUpdate();
    await vaultEditPreserved();
    await unsavedEditorProtection();
    await editorOpenedDuringImport();
    await markerAndStateGuards();
    await unsavedCanvasEmbed();
    report.observations.studioDirectoryAfterAllImports = fs.readdirSync("/work/studio").sort();
  } catch (error) {
    check("scenario completed without harness failure", false, String(error.stack || error));
    try { await session.screenshot(`failure-${scenario}`); fs.writeFileSync(`${OUT}/failure-${scenario}.txt`, await session.bodyText()); } catch {}
  }
  const renderer = [...new Set((session?.requests || []).map(url => { try { return new URL(url); } catch { return null; } }).filter(u => u && /^https?:$/.test(u.protocol)).map(u => u.host))];
  report.observations.rendererHttpHostsRequestedByApp = renderer;
  report.results = results; report.summary = { total: results.length, failed: results.filter(r => !r.pass).length, findings: report.findings.length };
  fs.writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report.summary));
  if (session) await quit(session);
  process.exit(report.summary.failed ? 1 : 0);
}
main();
