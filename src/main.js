const { Plugin, PluginSettingTab, Setting, Notice, normalizePath, TFile } = require("obsidian");
const { sync } = require("./import");
module.exports = class ByokImport extends Plugin {
  dataPath() {
    if (!this.manifest.dir) throw Error("Plugin data directory unavailable");
    return normalizePath(`${this.manifest.dir}/data.json`);
  }
  async saveData(data) {
    // The public Plugin API does not specify error propagation. Verify the bytes
    // independently so a fulfilled but unsuccessful save cannot advance a baseline.
    const expected = JSON.stringify(data);
    await super.saveData(JSON.parse(expected));
    const actual = JSON.parse(await this.app.vault.adapter.read(this.dataPath()));
    if (!require("node:util").isDeepStrictEqual(actual, JSON.parse(expected))) throw Error("Plugin data save could not be verified");
    this.dataPersisted = true;
  }
  async onload() {
    // Read directly: do not conflate missing data with unreadable/invalid JSON.
    const adapter = this.app.vault.adapter;
    const path = this.dataPath();
    const exists = await adapter.exists(path);
    const loaded = exists ? JSON.parse(await adapter.read(path)) : null;
    const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
    if (exists && (!object(loaded) || typeof loaded.database !== "string" || typeof loaded.folder !== "string" ||
      !object(loaded.state) || loaded.state.version !== 1 || !object(loaded.state.scopes))) throw Error("Invalid plugin data; restore from backup");
    this.dataPersisted = exists;
    this.data = loaded || { database: "", folder: "BYOK Studio", state: { version: 1, scopes: {} } };
    this.addSettingTab(new Settings(this.app, this));
    this.addCommand({ id: "import-library", name: "Import local Studio Library", callback: () => this.runImport() });
  }
  async runImport() {
    if (this.running) { new Notice("An import is already running"); return; }
    this.running = true;
    try {
      const app = this.app;
      const adapter = app.vault.adapter;
      const safeToMutate = () => typeof app.workspace.getLeavesOfType === "function" && app.workspace.getLeavesOfType("markdown").length === 0;
      const assertSafe = () => { if (!safeToMutate()) throw Error("Close all Markdown editors before importing"); };
      assertSafe();
      if (this.dataPersisted) {
        const durable = JSON.parse(await adapter.read(this.dataPath()));
        if (!require("node:util").isDeepStrictEqual(durable?.state, JSON.parse(JSON.stringify(this.data.state)))) throw Error("Plugin state changed on disk; reload or restore from backup");
      }
      const vault = {
        // Even filesystem-only writes must not bypass an open editor.
        safeToMutate: async () => safeToMutate(),
        exists: path => adapter.exists(normalizePath(path)),
        read: async path => {
          path = normalizePath(path);
          const f = app.vault.getAbstractFileByPath(path);
          if (f instanceof TFile) return app.vault.read(f);
          return (await adapter.stat(path))?.type === "file" ? adapter.read(path) : null;
        },
        compareAndWrite: async (path, expected, content) => {
          if (!safeToMutate()) return false;
          path = normalizePath(path);
          const f = app.vault.getAbstractFileByPath(path);
          let written = false;
          const replace = current => {
            if (!safeToMutate() || current !== expected) return current;
            written = true; return content;
          };
          if (f instanceof TFile) await app.vault.process(f, replace);
          else {
            if ((await adapter.stat(path))?.type !== "file" || typeof adapter.process !== "function") return false;
            await adapter.process(path, replace);
          }
          return written;
        },
        create: async (path, content) => {
          assertSafe();
          path = normalizePath(path);
          const parts = path.split("/"); parts.pop(); let dir = "";
          for (const part of parts) {
            dir = dir ? `${dir}/${part}` : part;
            if (!await adapter.exists(dir)) {
              assertSafe();
              if (dir.split("/").some(part => part.startsWith("."))) await adapter.mkdir(dir);
              else await app.vault.createFolder(dir);
            }
          }
          // Vault cannot address dot paths. Adapter.write has no exclusive-create
          // option; recheck immediately before writing to avoid known collisions.
          if (await adapter.exists(path)) throw Error("Destination already exists");
          assertSafe();
          if (path.split("/").some(part => part.startsWith("."))) await adapter.write(path, content);
          else await app.vault.create(path, content);
        }
      };
      const report = await sync({ database: this.data.database, folder: this.data.folder, vault, vaultId: await require("node:fs/promises").realpath(app.vault.adapter.getBasePath()), state: this.data.state, studioAsar: this.data.studioAsar, save: () => this.saveData(this.data) });
      console.info("BYOK import report", report);
      new Notice(`BYOK import: ${report.filter(r => r.status === "imported").length} imported, ${report.filter(r => !["imported", "unchanged"].includes(r.status)).length} reports. See developer console.`, 12000);
    } catch (e) { console.error("BYOK import failed", e); new Notice(`BYOK import failed: ${e.message}`, 12000); }
    finally { this.running = false; }
  }
};
class Settings extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    this.containerEl.empty();
    new Setting(this.containerEl).setName("Studio database path").setDesc("Absolute path to the local db.sqlite. Requires the sqlite3 command on PATH.").addText(t => t.setValue(this.plugin.data.database).onChange(async value => { this.plugin.data.database = value; await this.plugin.saveData(this.plugin.data); }));
    new Setting(this.containerEl).setName("Studio app.asar path (experimental write-back)").setDesc("Experimental: only marked disposable libraries and the tested Linux Studio 1.1.3 build are supported. Leave empty to disable writes.").addText(t => t.setValue(this.plugin.data.studioAsar || "").onChange(async value => { this.plugin.data.studioAsar = value; await this.plugin.saveData(this.plugin.data); }));
    new Setting(this.containerEl).setName("Vault destination folder").addText(t => t.setValue(this.plugin.data.folder).onChange(async value => { this.plugin.data.folder = value; await this.plugin.saveData(this.plugin.data); }));
  }
}
