const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { realpath } = require("node:fs/promises");
const { parseDocument } = require("htmlparser2");
const exec = promisify(execFile);

// A single SELECT holds one SQLite read snapshot across all tables, including WAL.
async function readLibrary(path) {
  const sql = `SELECT 'project' AS kind, id, NULL AS project_id, NULL AS folder_id, NULL AS type, 0 AS is_trashed, data FROM projects
    UNION ALL SELECT 'folder', id, NULL, parent_folder_id, NULL, 0, data FROM folders
    UNION ALL SELECT 'file', id, project_id, folder_id, type, is_trashed, data FROM files
    UNION ALL SELECT 'manuscript', id, project_id, folder_id, 'manuscript', is_trashed, data FROM manuscript_files;`;
  const { stdout } = await exec("sqlite3", ["-readonly", "-json", path, sql], { maxBuffer: 128 * 1024 * 1024 });
  return JSON.parse(stdout || "[]").map(row => ({ ...row, data: JSON.parse(row.data) }));
}
function safe(value) {
  const name = String(value || "Untitled").replace(/[\\/:*?"<>|#^\[\]\x00-\x1f]/g, "-").trim().replace(/[. ]+$/g, "");
  return (!name || name === "." || name === ".." || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name)) ? "Untitled" : name;
}
function render(html) {
  const issues = new Set();
  function visit(node) {
    if (node.type === "text") return node.data;
    if (node.type !== "tag") { issues.add("non-text HTML"); return ""; }
    const children = (node.children || []).map(visit).join("");
    if (Object.keys(node.attribs || {}).length) issues.add("HTML attributes");
    switch (node.name) {
      case "p": case "div": return children + "\n\n";
      case "br": return "\n";
      case "strong": case "b": return `**${children}**`;
      case "em": case "i": return `*${children}*`;
      case "h1": case "h2": case "h3": return `${"#".repeat(Number(node.name[1]))} ${children}\n\n`;
      default: issues.add(`<${node.name}>`); return children;
    }
  }
  const body = parseDocument(html).children.map(visit).join("").trim() + "\n";
  // Markdown syntax and even supported HTML cannot yet be proven round-trip safe.
  issues.add("HTML-to-Markdown conversion is not verified lossless");
  return { body, issues: [...issues] };
}
function metadata(id, updated) {
  return `---\nbyok-id: ${JSON.stringify(String(id))}\nbyok-type: text\nbyok-updated: ${JSON.stringify(String(updated || ""))}\n---\n\n`;
}
function destination(value) {
  const parts = value.replace(/\\/g, "/").split("/").filter(Boolean);
  if (parts.some(p => p === "." || p === ".." || safe(p) !== p)) throw new Error("Invalid destination folder");
  return parts.join("/");
}
async function sync({ database, folder, vault, state, save }) {
  const root = destination(folder);
  const library = await realpath(database);
  const rows = await readLibrary(library); // no vault mutations until the source has been read
  if (!state || state.version !== 1 || !state.scopes || typeof state.scopes !== "object") throw new Error("Invalid import state");
  const key = JSON.stringify([library, root]);
  const entries = state.scopes[key] || {};
  const reports = [];
  const projects = new Map(rows.filter(r => r.kind === "project").map(r => [String(r.id), r]));
  const folders = new Map(rows.filter(r => r.kind === "folder").map(r => [String(r.id), r]));
  function folderParts(id) {
    const seen = new Set(), result = [];
    while (id != null && id !== "") {
      id = String(id);
      if (seen.has(id) || !folders.has(id)) throw new Error(`Invalid folder hierarchy: ${id}`);
      seen.add(id); const f = folders.get(id); result.unshift(safe(f.data.name)); id = f.folder_id;
    }
    return result;
  }
  // Disambiguate same-named projects and sibling folders deterministically.
  function component(row, peers) {
    const name = safe(row.data.name);
    return peers.filter(p => safe(p.data.name).toLowerCase() === name.toLowerCase()).length > 1
      ? `${name} (${String(row.id).replace(/[^a-zA-Z0-9_-]/g, "-")})` : name;
  }
  function hierarchy(row) {
    const project = projects.get(String(row.project_id));
    if (!project) throw new Error(`Missing project ${row.project_id}`);
    const projectName = component(project, [...projects.values()]);
    folderParts(row.folder_id); let id = row.folder_id; const chain = [];
    while (id != null && id !== "") { const f = folders.get(String(id)); chain.unshift(f); id = f.folder_id; }
    return [projectName, ...chain.map(f => component(f, [...folders.values()].filter(p => String(p.folder_id || "") === String(f.folder_id || ""))))];
  }
  const records = rows.filter(r => r.kind === "file" || r.kind === "manuscript");
  const seen = new Set();
  for (const row of records) {
    const id = `${row.kind}:${row.id}`; seen.add(id);
    if (row.is_trashed) { reports.push({ id, status: "trashed" }); continue; }
    if (row.kind !== "file" || row.type !== "text" || typeof row.data.content !== "string") {
      reports.push({ id, status: "unsupported", detail: String(row.type || "unknown") }); continue;
    }
    try {
      const { body, issues } = render(row.data.content);
      reports.push({ id, status: "lossy", detail: issues.join(", ") });
      const content = metadata(row.id, row.data.updatedAt) + body;
      const prior = entries[id];
      if (prior) {
        const current = await vault.read(prior.path);
        if (current === null) { reports.push({ id, status: "missing", path: prior.path }); continue; }
        if (current === content) { reports.push({ id, status: "unchanged", path: prior.path }); continue; }
        // This foundation never overwrites either side; later reconciliation can use baseline.
        reports.push({ id, status: "changed", path: prior.path }); continue;
      }
      const base = [root, ...hierarchy(row), safe(row.data.name)].filter(Boolean).join("/");
      let path = `${base}.md`, n = 1;
      while (await vault.exists(path)) { if (n === 1) reports.push({ id, status: "collision", path }); path = `${base} (${++n}).md`; }
      await vault.create(path, content);
      entries[id] = { path, baseline: content };
      state.scopes[key] = entries;
      try { await save(state); } catch (error) { delete entries[id]; throw error; }
      reports.push({ id, status: "imported", path });
    } catch (e) { reports.push({ id, status: "failed", detail: String(e.message || e) }); }
  }
  for (const id of Object.keys(entries)) if (!seen.has(id)) reports.push({ id, status: "deleted", path: entries[id].path });
  return reports;
}
module.exports = { sync, readLibrary, destination };
