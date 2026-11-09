const { Plugin, PluginSettingTab, Setting, Notice, normalizePath, TFile } = require("obsidian");
const { sync } = require("./import");
module.exports = class ByokImport extends Plugin {
  async onload() {
    const loaded = await this.loadData();
    this.data = loaded || { database: "", folder: "BYOK Studio", state: { version: 1, scopes: {} } };
    this.addSettingTab(new Settings(this.app, this));
    this.addCommand({ id: "import-library", name: "Import local Studio Library", callback: () => this.runImport() });
  }
  async runImport() {
    if (this.running) { new Notice("An import is already running"); return; }
    this.running = true;
    try {
      const app = this.app;
      const vault = {
        exists: async path => !!app.vault.getAbstractFileByPath(path),
        read: async path => { const f = app.vault.getAbstractFileByPath(path); return f instanceof TFile ? app.vault.read(f) : null; },
        compareAndWrite: async (path, expected, content) => {
          const f = app.vault.getAbstractFileByPath(path);
          if (!(f instanceof TFile)) return false;
          let written = false;
          await app.vault.process(f, current => { if (current !== expected) return current; written = true; return content; });
          return written;
        },
        create: async (path, content) => {
          const parts = path.split("/"); parts.pop(); let dir = "";
          for (const part of parts) { dir = normalizePath(dir ? `${dir}/${part}` : part); if (!app.vault.getAbstractFileByPath(dir)) await app.vault.createFolder(dir); }
          await app.vault.create(path, content);
        }
      };
      const report = await sync({ database: this.data.database, folder: this.data.folder, vault, vaultId: await require("node:fs/promises").realpath(app.vault.adapter.getBasePath()), state: this.data.state, save: () => this.saveData(this.data) });
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
    new Setting(this.containerEl).setName("Vault destination folder").addText(t => t.setValue(this.plugin.data.folder).onChange(async value => { this.plugin.data.folder = value; await this.plugin.saveData(this.plugin.data); }));
  }
}
