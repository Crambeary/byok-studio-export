#!/usr/bin/env python3
"""Disposable local-only round-trip probe; never use on a real library."""
import argparse, copy, json, shutil, sqlite3, subprocess, sys, tempfile
from pathlib import Path
HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(ROOT / 'experiments/studio_writeback'))
import run_experiment as lab
import writeback
lab.HERE = HERE

def snapshot(db, file_id, project_id):
    with sqlite3.connect(f'file:{db}?mode=ro', uri=True) as con:
        con.row_factory = sqlite3.Row
        def rows(query, args=()): return [dict(x) for x in con.execute(query, args)]
        return {'file': rows('select * from files where id=?', (file_id,))[0],
                'project': rows('select * from projects where id=?', (project_id,))[0],
                'history': rows('select * from local_versions where file_id=? order by created_at,id', (file_id,)),
                'outbox': rows('select * from outbox order by id'),
                'integrity': con.execute('pragma integrity_check').fetchone()[0],
                'foreign_keys': len(rows('pragma foreign_key_check'))}

def codec(op, text, original=None):
    script = "const c=require(process.argv[1]); const a=JSON.parse(process.argv[2]); console.log(JSON.stringify(c[a.op](a.text,a.original)))"
    return json.loads(subprocess.check_output(['node','-e',script,str(ROOT/'src/text-codec.js'),json.dumps(dict(op=op,text=text,original=original))], text=True))

def main():
    p=argparse.ArgumentParser(); p.add_argument('--studio-dir',type=Path,required=True); p.add_argument('--xvfb',type=Path,required=True); p.add_argument('--evidence',type=Path,default=HERE/'evidence.json'); a=p.parse_args()
    root=Path(tempfile.mkdtemp(prefix='studio-local-roundtrip-')); work=root/'seed'; work.mkdir(); (work/writeback.MARKER).write_text('synthetic only\n'); (work/'config').mkdir()
    db=work/'config/studio-desktop/byokwa/db.sqlite'
    try:
        seed=lab.jail(work,a.studio_dir.resolve(),a.xvfb.resolve(),'seed'); fid=seed['file_id']; pid=seed['project_id']
        # Preserve the UI-created seed and run the exchange on a disposable copy.
        copied=root/'copy'; shutil.copytree(work,copied); work=copied
        db=work/'config/studio-desktop/byokwa/db.sqlite'
        before=snapshot(db,fid,pid); old=json.loads(before['file']['data']); project=json.loads(before['project']['data'])
        baseline=codec('htmlToMarkdown',old['content']); assert baseline is not None
        vault=work/'vault.md'; vault.write_text(baseline); edited=baseline.replace('Original synthetic', 'Vault revised synthetic'); assert edited != baseline; vault.write_text(edited)
        converted=codec('markdownToHtml',edited,old['content']); assert converted is not None
        applied=writeback.apply_text_writeback(db,work,fid,converted); after=snapshot(db,fid,pid)
        (work/'target.json').write_text(json.dumps({'project_id':pid,'file_id':fid,'pre_image_version_id':applied['pre_image_version_id']}))
        verify=lab.jail(work,a.studio_dir.resolve(),a.xvfb.resolve(),'verify'); reopened=snapshot(db,fid,pid)
        # Repeat synchronization on unchanged sides: no direct write or baseline change.
        synced_html=json.loads(reopened['file']['data'])['content']; repeat = codec('htmlToMarkdown',synced_html)==vault.read_text() and synced_html==converted
        repeat_snapshot=snapshot(db,fid,pid)
        edit=lab.jail(work,a.studio_dir.resolve(),a.xvfb.resolve(),'edit-restore'); later=snapshot(db,fid,pid)
        studio_html=json.loads(later['file']['data'])['content']; incoming=codec('htmlToMarkdown',studio_html)
        assert incoming is not None
        vault_before_studio=vault.read_text(); vault.write_text(incoming)
        final=snapshot(db,fid,pid)
        repeat_after_export = codec('htmlToMarkdown', json.loads(final['file']['data'])['content']) == vault.read_text() and final == snapshot(db,fid,pid)
        with sqlite3.connect(f'file:{db}?mode=ro', uri=True) as con:
            keys = [r[0] for r in con.execute('select key from metadata')]
            mode = con.execute("select value from metadata where key='mode'").fetchone()
        indexes=lab.INDEXED
        checks={'no_auth_token_or_synced_mode':'authToken' not in keys and (mode is None or mode[0] != 'synced'),
          'repeat_after_export_noop':repeat_after_export, 'loopback_only':all(x['jail_network_interfaces']==['lo'] for x in (seed,verify,edit)),
          'ui_project_null_and_file_user_absent':project.get('user','missing') is None and 'user' not in old,
          'preexisting_outbox':bool(before['outbox']), 'outbox_unchanged_by_write':before['outbox']==after['outbox'],
          'outbox_unchanged_by_reopen':after['outbox']==reopened['outbox'], 'indexed_unchanged':all(before['file'][k]==after['file'][k]==reopened['file'][k] for k in indexes),
          'project_unchanged':before['project']==after['project']==reopened['project'], 'write_reopened_in_ui':verify['at_boot']['file']['content']==converted and 'Vault revised synthetic' in verify['editor_html'],
          'preimage_in_history':any(v['id']==applied['pre_image_version_id'] and json.loads(v['content'])==old['content'] for v in reopened['history']),
          'repeat_noop':repeat and reopened==repeat_snapshot, 'later_ui_edit_keeps_vault_edit':'Vault revised synthetic' in studio_html and 'Edit typed in Studio' in studio_html,
          'studio_edit_exported_to_vault':'Edit typed in Studio' in vault.read_text(), 'outbox_unchanged_by_export':later['outbox']==final['outbox'],
          'integrity':all(s['integrity']=='ok' and s['foreign_keys']==0 for s in (before,after,reopened,later,final)),
          'clean_exits':all(x['studio_exit']=={'code':0,'signal':None} for x in (seed,verify,edit))}
        report={'checks':checks,'environment':{'studio_app_version':seed['studio_app_version'],'electron':seed['electron'],'app_asar_sha256':lab.sha256_file(a.studio_dir/'resources/app.asar'),'mode':seed['desktop_mode']}, 'vault':{'baseline':baseline,'edited':edited,'before_studio_export':vault_before_studio,'after_studio_export':vault.read_text()},'source_html':{'before':old['content'],'written':converted,'after_reopen':synced_html,'after_studio_edit':studio_html},'snapshots':{'before':before,'after_write':after,'after_reopen':reopened,'after_studio_edit':later,'after_export':final},'studio':{'verify':verify,'edit':edit}}
        a.evidence.write_text(json.dumps(report,indent=2,ensure_ascii=False)+'\n'); print(f'{sum(checks.values())}/{len(checks)} checks passed'); print('failed:',[k for k,v in checks.items() if not v]); return int(not all(checks.values()))
    finally: shutil.rmtree(root,ignore_errors=True)
if __name__=='__main__': sys.exit(main())
