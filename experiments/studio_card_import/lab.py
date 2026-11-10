#!/usr/bin/env python3
"""Run synthetic Studio/card exploration in a loopback-only disposable jail."""
import argparse, hashlib, json, shutil, sqlite3, subprocess, tempfile
from pathlib import Path
HERE=Path(__file__).resolve().parent
PIN='25e93b78fb4753f7b47236a91f8907e674c341aab19af271d93c7dd1e04dbcfa'
p=argparse.ArgumentParser(); p.add_argument('--studio-dir',type=Path,required=True); p.add_argument('--xvfb',type=Path,required=True); p.add_argument('--keep-work',action='store_true'); a=p.parse_args()
studio=a.studio_dir.resolve(); xvfb=a.xvfb.resolve()
assert hashlib.sha256((studio/'resources/app.asar').read_bytes()).hexdigest()==PIN
work=Path(tempfile.mkdtemp(prefix='studio-card-lab-')); (work/'config').mkdir(); (work/'card').mkdir(); (work/'passwd').write_text('synthetic:x:1000:1000:Synthetic:/home/synthetic:/bin/false\n')
def phase(name):
 cmd=['timeout','180','bwrap','--unshare-all','--die-with-parent','--new-session','--clearenv','--setenv','HOME','/home/synthetic','--setenv','XDG_CONFIG_HOME','/work/config','--setenv','PATH','/usr/bin','--setenv','LANG','C.UTF-8','--setenv','ELECTRON_RUN_AS_NODE','1','--ro-bind','/usr','/usr','--symlink','usr/lib','/lib','--symlink','usr/lib','/lib64','--symlink','usr/bin','/bin','--symlink','usr/bin','/sbin','--ro-bind',str(work/'passwd'),'/etc/passwd','--ro-bind-try','/etc/fonts','/etc/fonts','--ro-bind-try','/etc/ld.so.cache','/etc/ld.so.cache','--proc','/proc','--dev','/dev','--tmpfs','/tmp','--dir','/tmp/.X11-unix','--tmpfs','/home','--dir','/home/synthetic','--dir','/run','--dir','/mnt','--ro-bind',str(work/'card'),'/mnt/card','--ro-bind',str(studio),'/opt/studio/electron','--ro-bind',str(xvfb),'/opt/xvfb/Xvfb','--ro-bind',str(HERE),'/driver','--bind',str(work),'/work','/opt/studio/electron/studio','/driver/driver.js',name]
 print('phase',name,flush=True); proc=subprocess.run(cmd,capture_output=True,text=True); path=work/(name+'.json')
 if not path.exists(): raise RuntimeError(proc.stdout+'\n'+proc.stderr)
 result=json.loads(path.read_text()); assert not result.get('error'), result.get('error'); assert result['jail_network_interfaces']==['lo']; return result
def snapshot():
 db=work/'config/studio-desktop/byokwa/db.sqlite'
 with sqlite3.connect(f'file:{db}?mode=ro',uri=True) as con:
  tables=[r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]
  rows={t:con.execute('SELECT * FROM "'+t+'"').fetchall() for t in tables}
  return {'rows':rows,'integrity':con.execute('PRAGMA integrity_check').fetchone()[0], 'foreign_keys':con.execute('PRAGMA foreign_key_check').fetchall()}
def changed(before,after):
 return {k:{'before':len(before['rows'][k]),'after':len(after['rows'][k]),'equal':before['rows'][k]==after['rows'][k]} for k in before['rows']}
try:
 seed=phase('seed'); (work/'target.json').write_text(json.dumps(seed)); before=snapshot()
 card=work/'card'; (card/'Projects'/'Synthetic Write-back Project').mkdir(parents=True); (card/'Fonts').mkdir(); (card/'Scripts').mkdir()
 textfile=card/'Projects'/'Synthetic Write-back Project'/'Untitled Text.txt'; original='card alpha  \n\ncard beta\t\n'; textfile.write_text(original)
 result=phase('card'); after=snapshot(); textfile.write_text('card alpha\ncard beta\n'); replan=phase('replan'); final=snapshot()
 report={'seed':seed,'input_text':original,'card':result,'whitespace_only_input':textfile.read_text(),'replan':replan,'table_changes_seed_to_import':changed(before,after),'table_changes_import_to_replan':changed(after,final),'integrity':[before['integrity'],after['integrity'],final['integrity']],'foreign_key_violations':[len(x['foreign_keys']) for x in (before,after,final)],'asar_sha256':PIN,'files_before':before['rows']['files'],'files_after':after['rows']['files'],'versions_before':before['rows']['local_versions'],'versions_after':after['rows']['local_versions']}
 (HERE/'evidence.json').write_text(json.dumps(report,indent=2,ensure_ascii=False)+'\n'); print('report:',HERE/'evidence.json')
finally:
 if a.keep_work: print('work:',work)
 else: shutil.rmtree(work)
