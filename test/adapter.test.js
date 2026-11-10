const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { execFileSync } = require("node:child_process");

// Vault excludes dot paths; DataAdapter addresses the underlying filesystem.
// https://github.com/obsidianmd/obsidian-developer-docs/blob/main/en/Plugins/Vault.md
// The public API documents loadData's null result but no rejection guarantee.
// Exercise null-on-error / fulfilled-no-op saves as defensive compatibility cases.
const normalizePath = p => p.replace(/\u00a0/g, " ").replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/|\/$/g, "").normalize("NFC");
const hidden = p => p.split("/").some(part => part.startsWith("."));
const dataPath = ".obsidian/plugins/synthetic/data.json";
async function harness(t, folder = "Target", noteName = ".雪") {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "byok-adapter-"));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const db = path.join(tmp, "synthetic.sqlite");
  execFileSync("python3", ["-c", `import sqlite3,json,sys
c=sqlite3.connect(sys.argv[1])
c.executescript('create table projects(id text,data text); create table folders(id text,parent_folder_id text,data text); create table files(id text,project_id text,folder_id text,type text,is_trashed integer,data text); create table manuscript_files(id text,project_id text,folder_id text,is_trashed integer,data text);')
c.execute('insert into projects values (?,?)', ('p',json.dumps({'name':'Projet é'})))
c.execute('insert into files values (?,?,?,?,?,?)', ('a','p',None,'text',0,json.dumps({'name':sys.argv[2],'content':'<p>Hello</p>'})))
c.commit()`, db, noteName]);
  const files = new Map(), dirs = new Set([".obsidian", ".obsidian/plugins", ".obsidian/plugins/synthetic"]);
  const notices = [], reports = []; let leaves = [], canvasLeaves = [], hover = false, saveMode = "ok", beforeProcess;
  function normalized(p) { assert.equal(p, normalizePath(p), "adapter path must be normalized"); }
  const adapter = {
    getBasePath: () => tmp,
    exists: async p => { normalized(p); return files.has(p) || dirs.has(p); },
    stat: async p => { normalized(p); return files.has(p) ? { type: "file" } : dirs.has(p) ? { type: "folder" } : null; },
    read: async p => { normalized(p); if (!files.has(p)) throw Error("ENOENT"); return files.get(p); },
    mkdir: async p => { normalized(p); if (dirs.has(p) || files.has(p)) throw Error("EEXIST"); dirs.add(p); },
    write: async (p, c) => { normalized(p); files.set(p, c); },
    process: async (p, fn) => { normalized(p); if (beforeProcess) beforeProcess(); files.set(p, fn(await adapter.read(p))); }
  };
  class TFile { constructor(p) { this.path = p; } }
  const vault = {
    adapter,
    getAbstractFileByPath: p => hidden(p) ? null : files.has(p) ? new TFile(p) : dirs.has(p) ? { path: p } : null,
    read: f => adapter.read(f.path), process: (f, fn) => adapter.process(f.path, fn),
    createFolder: p => adapter.mkdir(p),
    create: async (p, c) => { if (files.has(p)) throw Error("File already exists"); await adapter.write(p, c); }
  };
  class Plugin {
    async loadData() { try { return JSON.parse(await adapter.read(dataPath)); } catch { return null; } }
    async saveData(data) {
      if (saveMode === "reject") throw Error("synthetic save failure");
      if (saveMode === "noop") return;
      await adapter.write(dataPath, JSON.stringify(data));
    }
    addSettingTab() {} addCommand() {}
  }
  const module = { exports: {} }, localRequire = createRequire(path.resolve("src/main.js"));
  vm.runInNewContext(await fs.readFile("src/main.js", "utf8"), {
    module, require: id => id === "obsidian" ? { Plugin, PluginSettingTab: class {}, Setting: class {},
      Notice: class { constructor(message) { notices.push(message); } }, normalizePath, TFile } : localRequire(id),
    document: { querySelector: () => hover ? {} : null },
    console: { info: (_, report) => reports.push(report), error() {} }
  });
  const plugin = new module.exports();
  plugin.manifest = { dir: ".obsidian\\plugins/synthetic" };
  plugin.app = { vault, workspace: { getLeavesOfType: type => type === "markdown" ? leaves : type === "canvas" ? canvasLeaves : [], iterateAllLeaves: () => {} } };
  await plugin.onload();
  plugin.data.database = db; plugin.data.folder = folder;
  const run = () => plugin.runImport();
  return { plugin, files, notices, reports, run, adapter, setLeaves: value => { leaves = value; }, setCanvasLeaves: value => { canvasLeaves = value; }, setHover: value => { hover = value; },
    setSaveMode: value => { saveMode = value; }, setBeforeProcess: value => { beforeProcess = value; },
    update: content => execFileSync("python3", ["-c", `import sqlite3,json,sys
c=sqlite3.connect(sys.argv[1]); d=json.loads(c.execute("select data from files where id='a'").fetchone()[0]); d['content']=sys.argv[2]; c.execute("update files set data=? where id='a'", (json.dumps(d),)); c.commit()`, db, content]) };
}

test("repeat sync sees unindexed dot marker and safe Unicode notes", async t => {
  const h = await harness(t, "Écriture\\caché//雪");
  await h.run(); await h.run();
  assert.equal(h.reports.length, 2, h.notices.join("; "));
  assert.ok(h.reports[0].some(r => r.status === "imported"));
  assert.ok(h.reports[1].some(r => r.status === "unchanged"));
  assert.equal([...h.files.keys()].filter(p => p.endsWith(".md")).length, 1);
});

test("missing and corrupt marker are distinguished through filesystem", async t => {
  const h = await harness(t); await h.run();
  const marker = [...h.files.keys()].find(p => p.includes(".byok-sync-"));
  assert.ok(marker);
  const originalMarker = h.files.get(marker);
  h.files.set(marker, "{"); await h.run();
  assert.match(h.notices.at(-1), /Invalid import marker/);
  h.files.delete(marker); await h.run();
  assert.match(h.notices.at(-1), /Import marker missing/);
  h.files.set(marker, originalMarker);
  h.plugin.data.state = { version: 1, scopes: {} };
  h.files.set(dataPath, JSON.stringify(h.plugin.data)); await h.run();
  assert.match(h.notices.at(-1), /state missing/);
});

test("corrupt persisted settings fail closed even if loadData would return null", async t => {
  const h = await harness(t);
  for (const raw of ["{", "null", "[]", JSON.stringify({ database: "x", folder: "Target" })]) {
    h.files.set(dataPath, raw);
    await assert.rejects(h.plugin.onload(), /Invalid|JSON|Unexpected|Expected/);
    assert.equal(h.files.get(dataPath), raw);
  }
});

test("missing or failed state saves cannot authorize note creation", async t => {
  const h = await harness(t);
  for (const mode of ["noop", "reject"]) {
    h.setSaveMode(mode); await h.run();
    assert.match(h.notices.at(-1), /failed/);
    assert.equal([...h.files.keys()].filter(p => p.endsWith(".md") || p.includes(".byok-sync-")).length, 0);
    assert.equal(Object.keys(h.plugin.data.state.scopes).length, 0);
  }
});

test("open or unavailable editors block all filesystem mutations", async t => {
  const h = await harness(t);
  h.setLeaves([{}]); await h.run();
  assert.equal(h.files.size, 0);
  h.plugin.app.workspace.getLeavesOfType = undefined; await h.run();
  assert.equal(h.files.size, 0);
});

test("Canvas and hover editors refuse import, including a Canvas opened during an update", async t => {
  const h = await harness(t, "Target", "Visible");
  await h.run();
  const note = [...h.files.keys()].find(p => p.endsWith(".md"));
  const before = h.files.get(note);
  h.update("<p>Studio revision</p>");
  h.setCanvasLeaves([{}]); await h.run();
  assert.match(h.notices.at(-1), /Close all .*editors/);
  assert.equal(h.files.get(note), before);
  h.setCanvasLeaves([]); h.setHover(true); await h.run();
  assert.match(h.notices.at(-1), /Close all .*editors/);
  assert.equal(h.files.get(note), before);
  h.setHover(false); h.setBeforeProcess(() => h.setCanvasLeaves([{}])); await h.run();
  assert.equal(h.files.get(note), before);
  assert.ok(h.reports.at(-1).some(r => r.status === "changed-during-sync"));
  h.setCanvasLeaves([]); h.setBeforeProcess(undefined); await h.run();
  assert.ok(h.reports.at(-1).some(r => r.status === "updated"));
});

test("disk state deletion, corruption, or replacement blocks repeat sync", async t => {
  const h = await harness(t); await h.run();
  const raw = h.files.get(dataPath);
  for (const damaged of [undefined, "{", "null", JSON.stringify({ state: { version: 1, scopes: {} } })]) {
    if (damaged === undefined) h.files.delete(dataPath); else h.files.set(dataPath, damaged);
    const snapshot = new Map(h.files); await h.run();
    assert.match(h.notices.at(-1), /failed/);
    assert.deepEqual(h.files, snapshot);
  }
  h.files.set(dataPath, raw); await h.run();
  assert.ok(h.reports.at(-1).some(r => r.status === "unchanged"));
});

test("hidden note updates use atomic process and preserve editor races", async t => {
  const h = await harness(t); await h.run();
  const note = [...h.files.keys()].find(p => p.endsWith(".md"));
  h.update("<p>Updated</p>"); await h.run();
  assert.ok(h.reports.at(-1).some(r => r.status === "updated"));
  const previous = h.files.get(note);
  h.update("<p>Next</p>");
  h.setBeforeProcess(() => h.setLeaves([{}])); await h.run();
  assert.equal(h.files.get(note), previous);
  assert.ok(h.reports.at(-1).some(r => r.status === "changed-during-sync"));
  h.setLeaves([]); h.setBeforeProcess(() => h.files.set(note, "racing external edit")); await h.run();
  assert.equal(h.files.get(note), "racing external edit");
  assert.ok(h.reports.at(-1).some(r => r.status === "changed-during-sync"));
});

test("hidden collisions and directories are never overwritten", async t => {
  const h = await harness(t);
  const note = "Target/Projet é/_.雪.md";
  h.files.set(note, "unrelated"); await h.run();
  assert.equal(h.files.get(note), "unrelated");
  assert.ok(h.reports.at(-1).some(r => r.status === "collision"));
  assert.ok(h.files.has("Target/Projet é/_.雪 (2).md"));
});

test("editor opened during folder creation prevents file creation", async t => {
  const h = await harness(t);
  const mkdir = h.adapter.mkdir;
  h.adapter.mkdir = async p => { await mkdir(p); h.setLeaves([{}]); };
  await h.run();
  assert.equal([...h.files.keys()].filter(p => p.includes(".byok-sync-") || p.endsWith(".md")).length, 0);
});

test("indexed Unicode notes keep the Vault atomic update path", async t => {
  const h = await harness(t, "Visible//雪", "Résumé"); await h.run();
  // Adapter.process is the harness implementation of Vault.process as well.
  let calls = 0;
  const process = h.plugin.app.vault.process;
  h.plugin.app.vault.process = async (...args) => { calls++; return process(...args); };
  h.update("<p>Visible update</p>"); await h.run();
  assert.equal(calls, 1);
  assert.ok(h.reports.at(-1).some(r => r.status === "updated"));
  await h.run();
  assert.ok(h.reports.at(-1).some(r => r.status === "unchanged"));
});

test("fulfilled stale save is rejected and read errors propagate", async t => {
  const h = await harness(t); await h.run();
  const durable = h.files.get(dataPath);
  h.setSaveMode("noop"); h.plugin.data.folder = "Different";
  await assert.rejects(h.plugin.saveData(h.plugin.data), /could not be verified/);
  assert.equal(h.files.get(dataPath), durable);
  h.adapter.read = async () => { throw Error("synthetic read failure"); };
  await assert.rejects(h.plugin.onload(), /synthetic read failure/);
});


test("settings changes wait for import persistence and verification", async t => {
  const h = await harness(t);
  const read = h.adapter.read; let release, entered;
  const blocked = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  let once = true;
  h.adapter.read = async p => {
    if (p === dataPath && once) { once = false; entered(); await gate; }
    return read(p);
  };
  const importing = h.run(); await blocked;
  const setting = h.plugin.updateSetting("folder", "Later");
  assert.equal(h.plugin.data.folder, "Target");
  release(); await Promise.all([importing, setting]);
  assert.ok(h.reports[0].some(r => r.status === "imported"));
  const durable = JSON.parse(h.files.get(dataPath));
  assert.equal(durable.folder, "Later");
  assert.ok(Object.values(durable.state.scopes).some(entries => entries["file:a"] && !entries["file:a"].pending));
});

test("normalized nonbreaking spaces collide and reserved Windows names are sanitized", async t => {
  const h = await harness(t, "Target", "A\u00a0B");
  h.files.set("Target/Projet é/A B.md", "unrelated");
  await h.run();
  assert.equal(h.files.get("Target/Projet é/A B.md"), "unrelated");
  assert.ok(h.files.has("Target/Projet é/A B (2).md"));
  const windows = await harness(t, "Target", "CON.txt");
  await windows.run();
  assert.ok(windows.files.has("Target/Projet é/Untitled.md"));
});
