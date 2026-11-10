const fs = require("node:fs/promises");
const path = require("node:path");
const { sync } = require("../../src/import");
(async () => {
  const [root, asar] = process.argv.slice(2), vaultRoot = path.join(root, "vault");
  await fs.mkdir(vaultRoot, { recursive: true });
  const statePath = path.join(root, "state.json");
  let state; try { state = JSON.parse(await fs.readFile(statePath, "utf8")); } catch (e) { if (e.code !== "ENOENT") throw e; state = { version: 1, scopes: {} }; }
  const resolve = p => path.join(vaultRoot, p);
  const read = async p => { try { return await fs.readFile(resolve(p), "utf8"); } catch (e) { if (e.code === "ENOENT") return null; throw e; } };
  const vault = { safeToMutate: async () => true, exists: async p => { try { await fs.access(resolve(p)); return true; } catch (e) { if (e.code === "ENOENT") return false; throw e; } }, read,
    create: async (p, c) => { await fs.mkdir(path.dirname(resolve(p)), { recursive: true }); await fs.writeFile(resolve(p), c, { flag: "wx" }); },
    compareAndWrite: async (p, old, next) => { if (await read(p) !== old) return false; await fs.writeFile(resolve(p), next); return true; } };
  const report = await sync({ database: path.join(root, "library", "db.sqlite"), folder: "Target", vault, vaultId: vaultRoot, state, studioAsar: asar, localExperiment: true, save: async () => fs.writeFile(statePath, JSON.stringify(state)) });
  console.log(JSON.stringify({ report, state }));
})().catch(e => { console.error(e); process.exit(1); });
