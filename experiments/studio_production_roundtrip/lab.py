#!/usr/bin/env python3
"""Production sync probe using a UI-created disposable Studio library."""
import argparse, json, shutil, sqlite3, subprocess, sys, tempfile
from pathlib import Path
HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(ROOT / "experiments/studio_local_roundtrip"))
import lab as prior
prior.lab.HERE = ROOT / "experiments/studio_local_roundtrip"
ASAR = "25e93b78fb4753f7b47236a91f8907e674c341aab19af271d93c7dd1e04dbcfa"
XVFB = "ffe89f25f4aa76a7c97d72bd4fa8b74d8304a1b4811a70a2614b0c953c241396"

def main():
    p=argparse.ArgumentParser(); p.add_argument("--studio-dir",type=Path,required=True); p.add_argument("--xvfb",type=Path,required=True); p.add_argument("--evidence",type=Path,default=HERE/"evidence.json"); a=p.parse_args()
    asar=a.studio_dir.resolve()/"resources/app.asar"; xvfb=a.xvfb.resolve()
    assert prior.lab.sha256_file(asar)==ASAR and prior.lab.sha256_file(xvfb)==XVFB, "pinned binary hash mismatch"
    root=Path(tempfile.mkdtemp(prefix="studio-production-probe-")); work=root/"work"; work.mkdir(); (work/"config").mkdir(); library=root/"library"; library.mkdir(); (library/"DISPOSABLE_SYNTHETIC_LIBRARY").write_text("synthetic\n")
    studio_db=work/"config/studio-desktop/byokwa/db.sqlite"; db=library/"db.sqlite"
    def copy_db(source,dest):
        # Studio has exited, so copy the entire closed SQLite state including any WAL.
        for suffix in ("", "-wal", "-shm"):
            s=Path(str(source)+suffix); d=Path(str(dest)+suffix)
            if s.exists(): shutil.copy2(s,d)
            elif d.exists(): d.unlink()
    def snapshot(*args):
        db_path, file_id, project_id = args
        con=sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        try:
            con.row_factory=sqlite3.Row
            def rows(sql, params=()): return [dict(row) for row in con.execute(sql, params)]
            return {"file":rows("select * from files where id=?", (file_id,))[0], "project":rows("select * from projects where id=?", (project_id,))[0], "history":rows("select * from local_versions where file_id=? order by created_at,id", (file_id,)), "outbox":rows("select * from outbox order by id"), "integrity":con.execute("pragma integrity_check").fetchone()[0], "foreign_keys":len(rows("pragma foreign_key_check"))}
        finally: con.close()
    def run(): return json.loads(subprocess.check_output(["node",str(HERE/"sync.js"),str(root),str(asar)],text=True))
    def record(result, fid): return next(r for r in result["report"] if r["id"]=="file:"+fid and r["status"] != "lossy")
    try:
        seed=prior.lab.jail(work,a.studio_dir.resolve(),xvfb,"seed"); fid=seed["file_id"]; pid=seed["project_id"]; copy_db(studio_db,db)
        before=snapshot(db,fid,pid); first=run(); imported=record(first,fid); assert imported["status"]=="imported", imported
        note=root/"vault"/imported["path"]; original=note.read_text(); note.write_text(original.replace("Original synthetic", "Vault revised synthetic")); assert note.read_text()!=original
        after_import=snapshot(db,fid,pid); written=run(); w=record(written,fid); assert w["status"]=="written-back", w
        after_write=snapshot(db,fid,pid); written_html=json.loads(after_write["file"]["data"])["content"]
        repeat=run(); assert record(repeat,fid)["status"]=="unchanged", repeat; after_repeat=snapshot(db,fid,pid)
        copy_db(db,studio_db); (work/"target.json").write_text(json.dumps({"project_id":pid,"file_id":fid}))
        verify=prior.lab.jail(work,a.studio_dir.resolve(),xvfb,"verify"); reopened=snapshot(studio_db,fid,pid)
        edit=prior.lab.jail(work,a.studio_dir.resolve(),xvfb,"edit-restore"); later=snapshot(studio_db,fid,pid); copy_db(studio_db,db)
        updated=run(); u=record(updated,fid); assert u["status"]=="updated", u
        final=snapshot(db,fid,pid); repeat2=run(); assert record(repeat2,fid)["status"]=="unchanged", repeat2; final_repeat=snapshot(db,fid,pid)
        entry=next(iter(repeat2["state"]["scopes"].values()))["file:"+fid]; final_html=json.loads(final["file"]["data"])["content"]
        checks={"loopback_only":all(x["jail_network_interfaces"]==["lo"] for x in (seed,verify,edit)), "local_mode":all(x["desktop_mode"]=="local" for x in (seed,verify,edit)), "populated_outbox":len(before["outbox"])>0, "outbox_import":before["outbox"]==after_import["outbox"], "outbox_write":after_import["outbox"]==after_write["outbox"], "outbox_repeat":after_write["outbox"]==after_repeat["outbox"], "outbox_reopen":after_repeat["outbox"]==reopened["outbox"], "outbox_export":later["outbox"]==final["outbox"]==final_repeat["outbox"], "reopened_editor": "Vault revised synthetic" in verify["editor_html"] and verify["at_boot"]["file"]["content"]==written_html, "studio_edit_exported":"Edit typed in Studio" in note.read_text() and "Vault revised synthetic" in note.read_text(), "persisted_baseline":entry["baseline"]==note.read_text() and entry["studioContent"]==final_html, "repeat_no_database_change":after_write==after_repeat and final==final_repeat, "integrity":all(x["integrity"]=="ok" and x["foreign_keys"]==0 for x in (before,after_import,after_write,after_repeat,reopened,later,final,final_repeat)), "clean_exits":all(x["studio_exit"]=={"code":0,"signal":None} for x in (seed,verify,edit))}
        report={"checks":checks,"environment":{"app_asar_sha256":ASAR,"xvfb_sha256":XVFB,"studio":seed["studio_app_version"],"electron":seed["electron"]},"results":{"import":imported,"write":w,"repeat":record(repeat,fid),"export":u,"repeat_after_export":record(repeat2,fid)},"baseline":entry,"snapshots":{"before":before,"after_import":after_import,"after_write":after_write,"after_repeat":after_repeat,"reopened":reopened,"studio_edit":later,"after_export":final,"final_repeat":final_repeat},"editor_html":verify["editor_html"]}
        a.evidence.write_text(json.dumps(report,indent=2,ensure_ascii=False)+"\n"); print(f"{sum(checks.values())}/{len(checks)} checks passed; failed: {[k for k,v in checks.items() if not v]}"); return int(not all(checks.values()))
    finally: shutil.rmtree(root,ignore_errors=True)
if __name__=="__main__": sys.exit(main())
