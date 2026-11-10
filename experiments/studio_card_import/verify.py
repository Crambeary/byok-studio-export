#!/usr/bin/env python3
"""Check the recorded synthetic observations, including row-level preservation."""
import json, sys
from pathlib import Path
x=json.loads((Path(__file__).parent/'evidence.json').read_text())
entry=x['card']['plan']['projects'][0]['files'][0]
before={r[0]:r for r in x['files_before']}; after={r[0]:r for r in x['files_after']}
target=x['seed']['file_id']
checks={
 'only_loopback':all(x[p]['jail_network_interfaces']==['lo'] for p in ('seed','card','replan')),
 'name_collision_selected_ui_file':entry['studioFileId']==target and entry['action']=='update' and entry['status']=='changed-card',
 'other_existing_files_identical':all(before[k]==after[k] for k in ('synthetic-duplicate','synthetic-unrelated')),
 'only_target_file_changed':set(before)==set(after) and [k for k in before if before[k]!=after[k]]==[target],
 'studio_imported_planned_html':x['card']['after_file']['content']==entry['html']=='<p>card alpha  </p><p>card beta\t</p>',
 'whitespace_only_change_ignored':x['replan']['plan']['counts']['actionable']==0 and x['replan']['plan']['projects'][0]['files'][0]['status']=='unchanged',
 'existing_project_unchanged':x['table_changes_seed_to_import']['projects']['equal'],
 'version_table_unchanged':x['versions_before']==x['versions_after'],
 'studio_queue_changed':not x['table_changes_seed_to_import']['outbox']['equal'],
 'database_integrity':x['integrity']==['ok']*3 and x['foreign_key_violations']==[0]*3,
}
for key,value in checks.items(): print(('PASS ' if value else 'FAIL ')+key)
sys.exit(not all(checks.values()))
