#!/usr/bin/env python3
"""Capture synthetic Studio records with a fresh, network-isolated library."""
import argparse
import json
import re
import sqlite3
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / 'studio_writeback'))
import run_experiment as base

ASAR = '25e93b78fb4753f7b47236a91f8907e674c341aab19af271d93c7dd1e04dbcfa'
BINARY = 'ee9faf5bb9fe78a750cc5099863c85c4459e7f04c387fd1f111c83e4e8c57c97'

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--studio-dir', type=Path, required=True)
    parser.add_argument('--xvfb', type=Path, required=True)
    parser.add_argument('--output', type=Path, default=HERE / 'populated-evidence.json')
    args = parser.parse_args()
    studio, xvfb = args.studio_dir.resolve(), args.xvfb.resolve()
    if base.sha256_file(studio / 'resources/app.asar') != ASAR or base.sha256_file(studio / 'studio') != BINARY:
        sys.exit('Refusing unpinned Studio build')
    base.HERE = HERE
    with tempfile.TemporaryDirectory(prefix='studio-cardstack-grid-') as temp:
        work = Path(temp)
        (work / 'config').mkdir()
        seed = base.jail(work, studio, xvfb, 'seed')
        (work / 'target.json').write_text(json.dumps({'project_id': seed['project_id']}))
        verify = base.jail(work, studio, xvfb, 'verify')
        db = work / 'config/studio-desktop/byokwa/db.sqlite'
        with sqlite3.connect(f'file:{db}?mode=ro', uri=True) as con:
            integrity = con.execute('pragma integrity_check').fetchone()[0]
            fk = con.execute('pragma foreign_key_check').fetchall()
            keys = [r[0] for r in con.execute('select key from metadata')]
            disk = [json.loads(r[0]) for r in con.execute('select data from files')]
        def records(tree):
            return {r['type']: r for r in tree}
        before = records(seed['tree_sections'])['cardstack']['content']
        after = records(seed['tree_reordered'])['cardstack']['content']
        grid = records(seed['tree_tile_edited'])['grid']['content']
        reopened = records(verify['tree_reopened'])
        final_disk = records(disk)
        cards = before[0]['cards']
        tiles = grid['v2']['tiles']
        checks = {
            'loopback_only': all(p['jail_network_interfaces'] == ['lo'] for p in (seed, verify)),
            'local_mode': all(p['desktop_mode'] == 'local' for p in (seed, verify)),
            'no_auth_token_key': 'authToken' not in keys,
            'clean_exits': all(p['studio_exit'] == {'code': 0, 'signal': None} for p in (seed, verify)),
            'integrity': integrity == 'ok' and not fk,
            'populated_cards': len(cards) == 2 and [after[1]['cards'][0]['title'], after[0]['cards'][0]['title']] == ['Synthetic alpha', 'Synthetic beta'] and all(c['content'] for section in after for c in section['cards']),
            'card_move': len(after) == 2 and [c['id'] for c in after[0]['cards']] == [cards[1]['id']] and [c['id'] for c in after[1]['cards']] == [cards[0]['id']],
            'multiple_tiles': len(tiles) == 2 and len({t['id'] for t in tiles}) == 2 and len({(t['x'], t['y']) for t in tiles}) == 2,
            'tile_identity_across_edit': records(seed['tree_tile'])['grid']['content']['v2']['tiles'][0]['id'] == tiles[0]['id'],
            'saved_before_reopen': all(records(seed['disk_final'])[k]['content'] == expected for k, expected in [('cardstack', after), ('grid', grid)]),
            'reopen_matches_disk': all(reopened[k]['content'] == final_disk[k]['content'] == expected for k, expected in [('cardstack', after), ('grid', grid)]),
            'ui_reopened': all(t in verify['ui_card_reopened'] for t in ['Synthetic alpha', 'Synthetic beta']) and all(t in verify['ui_grid_reopened'] for t in ['Synthetic grid tile', 'Synthetic second tile']),
        }
        evidence = {'environment': {'studio_version': seed['studio_app_version'], 'electron': seed['electron'], 'studio_binary_sha256': BINARY, 'app_asar_sha256': ASAR, 'xvfb_sha256': base.sha256_file(xvfb)}, 'checks': checks, 'captures': {**{k:v for k,v in seed.items() if k.startswith('tree_') or k.startswith('disk_')}, 'tree_reopened': verify['tree_reopened'], 'ui_card_reopened': verify['ui_card_reopened'], 'ui_grid_reopened': verify['ui_grid_reopened']}}
        raw = json.dumps(evidence, ensure_ascii=False, indent=2)
        ids, times = {}, {}
        raw = re.sub(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', lambda m: ids.setdefault(m[0], f'<id-{len(ids)+1}>'), raw, flags=re.I)
        for i, card in enumerate(cards, 1):
            raw = re.sub(r'(?<=: )' + re.escape(str(card['id'])) + r'(?=,|\n)', f'"<card-{i}>"', raw)
        for i, tile in enumerate(tiles, 1):
            raw = raw.replace(tile['id'], f'<tile-{i}>')
        raw = re.sub(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z', lambda m: times.setdefault(m[0], f'<time-{len(times)+1}>'), raw)
        failed = [name for name, ok in checks.items() if not ok]
        if failed:
            sys.exit('Failed checks: ' + ', '.join(failed))
        args.output.write_text(raw + '\n')
        print(f'{len(checks)}/{len(checks)} checks passed: {args.output}')
    return 0

if __name__ == '__main__':
    sys.exit(main())
