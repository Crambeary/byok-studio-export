#!/usr/bin/env python3
"""Inspect only pinned Studio source; no library, token, outbox or network access."""
import argparse
import hashlib
import json
import struct
import subprocess
from pathlib import Path

PIN = '25e93b78fb4753f7b47236a91f8907e674c341aab19af271d93c7dd1e04dbcfa'
parser = argparse.ArgumentParser()
parser.add_argument('--asar', type=Path, required=True)
raw = parser.parse_args().asar.read_bytes()
assert hashlib.sha256(raw).hexdigest() == PIN, 'unexpected Studio build'
_, header_size, _, json_size = struct.unpack('<4I', raw[:16])
header = json.loads(raw[16:16 + json_size])

def source(name):
    item = header['files']['src']['files'][name]
    start = 8 + header_size + int(item['offset'])
    return raw[start:start + item['size']].decode()

card, text = source('deviceCard.js'), source('deviceText.js')
# Pin the planner branches that make a first name match an overwrite, not a conflict.
for fragment in (
    'if (!studioFile) studioFile = studioByName.get(nameKey(cf.baseName)) || null;',
    'const cardChanged = row ? row.card_hash !== cf.hash : sHash !== cf.hash;',
    'const studioChanged = row ? row.studio_hash !== sHash : false;',
    "entry.status = 'changed-card'; entry.action = 'update';",
):
    assert fragment in card, fragment
start = text.index('function canonicalText(')
end = text.index('\nmodule.exports', start)
canonical = text[start:end]
js = canonical + '''
const variants = ["alpha\\n\\nbeta", "alpha\\nbeta", "alpha  \\nbeta"];
process.stdout.write(JSON.stringify(variants.map(canonicalText)));
'''
result = json.loads(subprocess.run(['node', '-e', js], check=True, capture_output=True, text=True).stdout)
assert result == ['alpha\nbeta'] * 3
print(json.dumps({'asar_sha256': PIN, 'first_contact_branches_present': True,
                  'canonical_plain_text_variants': result}, indent=2))
