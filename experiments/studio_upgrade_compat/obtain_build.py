#!/usr/bin/env python3
"""Obtain and stage Studio 0.5.2 for the real-upgrade lab (issue #5).

Sources, none of them operated by BYOK:

- The Windows installer, from one Internet Archive capture of the vendor's
  public download object. The vendor's own hosts are never contacted.
- The Linux Electron runtime, from the electron/electron GitHub release, checked
  against that release's SHASUMS256.txt. A local copy may be passed instead,
  and it must have the same hash.
- Microsoft's published root certificate, the trust anchor for the installer's
  Authenticode signature.

Nothing is run from the installer here. It is verified and then unpacked with
7z. The binary is proprietary, so it is not committed. This script recreates it
and refuses any byte that differs. Only standard-library Python and the
`openssl` and `7z` command-line tools are used.

Usage: obtain_build.py --out DIR [--installer PATH] [--electron-zip PATH]
                       [--evidence FILE]
"""
import argparse
import base64
import hashlib
import json
import shutil
import struct
import subprocess
import sys
import tempfile
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path

CAPTURE_TIME = "20261007005325"
ORIGINAL_URL = "https://byok-studio-downloads.s3.amazonaws.com/studio/latest/Studio-win-x64.exe"
CAPTURE_URL = f"https://web.archive.org/web/{CAPTURE_TIME}id_/{ORIGINAL_URL}"
CDX_URL = "https://web.archive.org/cdx/search/cdx?" + urllib.parse.urlencode(
    {"url": ORIGINAL_URL, "output": "json", "from": CAPTURE_TIME, "to": CAPTURE_TIME}
)
INSTALLER_SIZE = 121998864
INSTALLER_SHA256 = "2b8e45ad9978b67b010c9189bf6b77221183f324c5cdfdc614964ea22a9b1939"
# The capture's WARC payload digest, as the Internet Archive's index reports it.
WAYBACK_SHA1_BASE32 = "ZDKKFG6WI6OC76MNKBNOKHH3ZSV6UDJ7"
EXPECTED_SIGNER_ORG = "BYOK LLC"

STUDIO_VERSION = "0.5.2"
APP_ASAR_SHA256 = "7f73eccbc1fdee8caaa3f0e7c04154bebc3eb75767df901747765051b0044980"

ELECTRON_VERSION = "44.4.5"
ELECTRON_ZIP = f"electron-v{ELECTRON_VERSION}-linux-x64.zip"
ELECTRON_RELEASE = f"https://github.com/electron/electron/releases/download/v{ELECTRON_VERSION}"
ELECTRON_ZIP_SHA256 = "04586a0ec46c3283fbdaef85530f561f71f0b5e136ad0cb9ef63683615609780"

MS_ROOT_URL = (
    "https://www.microsoft.com/pkiops/certs/"
    "Microsoft%20Identity%20Verification%20Root%20Certificate%20Authority%202020.crt"
)
MS_ROOT_SUBJECT_CN = "Microsoft Identity Verification Root Certificate Authority 2020"

OID_SPC_INDIRECT = "1.3.6.1.4.1.311.2.1.4"
OID_MESSAGE_DIGEST = "1.2.840.113549.1.9.4"
OID_SHA256 = "2.16.840.1.101.3.4.2.1"


def fetch(url, dest):
    request = urllib.request.Request(url, headers={"User-Agent": "byok-studio-export-research"})
    with urllib.request.urlopen(request, timeout=120) as response, open(dest, "wb") as out:
        shutil.copyfileobj(response, out)
        return dict(response.headers.items())


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for block in iter(lambda: stream.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def require(condition, message):
    if not condition:
        sys.exit(f"refused: {message}")


def der_read(buf, pos):
    """Return (tag, content_start, content_end, element_end) for the element at pos."""
    tag = buf[pos]
    length = buf[pos + 1]
    head = 2
    if length & 0x80:
        count = length & 0x7F
        length = int.from_bytes(buf[pos + 2 : pos + 2 + count], "big")
        head += count
    start = pos + head
    return tag, start, start + length, start + length


def der_children(buf, start, end):
    out = []
    pos = start
    while pos < end:
        item = der_read(buf, pos)
        out.append((pos, *item))
        pos = item[3]
    return out


def decode_oid(raw):
    first = raw[0]
    parts = [min(first // 40, 2), first - 40 * min(first // 40, 2)]
    value = 0
    for byte in raw[1:]:
        value = (value << 7) | (byte & 0x7F)
        if not byte & 0x80:
            parts.append(value)
            value = 0
    return ".".join(str(p) for p in parts)


def authenticode_hash(blob):
    """Return (computed PE digest, PKCS#7 DER) per the Authenticode PE rules."""
    pe = struct.unpack_from("<I", blob, 0x3C)[0]
    optional = pe + 24
    magic = struct.unpack_from("<H", blob, optional)[0]
    directories = optional + (96 if magic == 0x10B else 112)
    checksum = optional + 64
    cert_dir = directories + 8 * 4
    offset, size = struct.unpack_from("<II", blob, cert_dir)
    digest = hashlib.sha256()
    digest.update(blob[:checksum])
    digest.update(blob[checksum + 4 : cert_dir])
    digest.update(blob[cert_dir + 8 : offset])
    digest.update(blob[offset + size :])
    length = struct.unpack_from("<I", blob, offset)[0]
    return digest.hexdigest(), blob[offset + 8 : offset + length]


def parse_pkcs7(der):
    _, start, end, _ = der_read(der, 0)
    top = der_children(der, start, end)
    _, _, inner_start, inner_end, _ = top[1]
    _, sd_start, sd_end, _ = der_read(der, inner_start)
    signed = der_children(der, sd_start, sd_end)
    content_info = signed[2]
    ci_children = der_children(der, content_info[2], content_info[3])
    oid = decode_oid(der[ci_children[0][2] : ci_children[0][3]])
    require(oid == OID_SPC_INDIRECT, f"unexpected signed content type {oid}")
    wrapper = ci_children[1]
    _, spc_start, spc_end, _ = der_read(der, wrapper[2])
    spc = der[spc_start:spc_end]
    spc_kids = der_children(der, spc_start, spc_end)
    digest_info = der_children(der, spc_kids[1][2], spc_kids[1][3])
    alg = der_children(der, digest_info[0][2], digest_info[0][3])
    alg_oid = decode_oid(der[alg[0][2] : alg[0][3]])
    require(alg_oid == OID_SHA256, f"unexpected digest algorithm {alg_oid}")
    embedded = der[digest_info[1][2] : digest_info[1][3]].hex()
    signer_set = signed[-1]
    signers = der_children(der, signer_set[2], signer_set[3])
    require(len(signers) == 1, "expected exactly one signer")
    signer = der_children(der, signers[0][2], signers[0][3])
    attrs = next(item for item in signer if item[1] == 0xA0)
    signature = next(item for item in signer if item[1] == 0x04)
    attr_bytes = bytearray(der[attrs[0] : attrs[3]])
    attr_bytes[0] = 0x31
    message_digest = None
    for attr in der_children(der, attrs[2], attrs[3]):
        kids = der_children(der, attr[2], attr[3])
        if decode_oid(der[kids[0][2] : kids[0][3]]) == OID_MESSAGE_DIGEST:
            values = der_children(der, kids[1][2], kids[1][3])
            message_digest = der[values[0][2] : values[0][3]].hex()
    return {
        "embedded_pe_sha256": embedded,
        "signed_content_sha256": hashlib.sha256(spc).hexdigest(),
        "message_digest": message_digest,
        "signed_attrs": bytes(attr_bytes),
        "signature": der[signature[2] : signature[3]],
    }


def openssl(*args, data=None):
    return subprocess.run(["openssl", *args], input=data, capture_output=True)


def split_pem(text):
    marker = "-----END CERTIFICATE-----"
    return [chunk.strip() + "\n" + marker + "\n" for chunk in text.split(marker) if "BEGIN CERTIFICATE" in chunk]


def field(cert_path, *flags):
    return openssl("x509", "-in", str(cert_path), "-noout", *flags).stdout.decode().strip()


def verify_authenticode(installer, scratch):
    blob = Path(installer).read_bytes()
    computed, der = authenticode_hash(blob)
    parsed = parse_pkcs7(der)
    require(computed == parsed["embedded_pe_sha256"], "PE digest differs from the digest inside the signature")
    require(parsed["signed_content_sha256"] == parsed["message_digest"], "messageDigest attribute differs from the signed content")

    der_path = scratch / "sig.der"
    der_path.write_bytes(der)
    bundle = openssl("pkcs7", "-inform", "DER", "-in", str(der_path), "-print_certs")
    require(bundle.returncode == 0, "could not read the certificates in the signature")
    certs = []
    for index, pem in enumerate(split_pem(bundle.stdout.decode())):
        path = scratch / f"cert{index}.pem"
        path.write_text(pem)
        certs.append(path)

    attrs = scratch / "signed_attrs.der"
    attrs.write_bytes(parsed["signed_attrs"])
    signature = scratch / "signature.bin"
    signature.write_bytes(parsed["signature"])
    signer = None
    for path in certs:
        public = scratch / "pub.pem"
        public.write_bytes(openssl("x509", "-in", str(path), "-pubkey", "-noout").stdout)
        if openssl("dgst", "-sha256", "-verify", str(public), "-signature", str(signature), str(attrs)).returncode == 0:
            signer = path
            break
    require(signer is not None, "no embedded certificate verifies the signature")
    subject = field(signer, "-subject")
    require(f"O={EXPECTED_SIGNER_ORG}" in subject.replace(" = ", "="), f"unexpected signer: {subject}")

    root_der = scratch / "ms_root.crt"
    fetch(MS_ROOT_URL, root_der)
    root_pem = scratch / "ms_root.pem"
    root_pem.write_bytes(openssl("x509", "-inform", "DER", "-in", str(root_der)).stdout)
    require(MS_ROOT_SUBJECT_CN in field(root_pem, "-subject"), "Microsoft root has an unexpected subject")
    chain = scratch / "chain.pem"
    chain.write_text("".join(p.read_text() for p in certs if p != signer))
    # Signing certificates of this kind live for days, so the validity window is
    # not evaluated against today's clock. The signing time is recorded instead.
    verified = openssl(
        "verify", "-no_check_time", "-purpose", "any", "-CAfile", str(root_pem),
        "-untrusted", str(chain), str(signer),
    )
    require(verified.returncode == 0, f"certificate chain did not verify: {verified.stderr.decode()}")
    return {
        "computed_pe_sha256": computed,
        "embedded_pe_sha256": parsed["embedded_pe_sha256"],
        "signer_subject": subject,
        "signer_issuer": field(signer, "-issuer"),
        "signer_not_before": field(signer, "-startdate"),
        "signer_not_after": field(signer, "-enddate"),
        "signer_sha256_fingerprint": field(signer, "-fingerprint", "-sha256"),
        "trust_anchor": MS_ROOT_URL,
        "trust_anchor_sha256_fingerprint": field(root_pem, "-fingerprint", "-sha256"),
        "chain_verified_ignoring_expiry": True,
    }


def electron_zip(args, scratch):
    sums = scratch / "SHASUMS256.txt"
    fetch(f"{ELECTRON_RELEASE}/SHASUMS256.txt", sums)
    published = next(
        line.split()[0] for line in sums.read_text().splitlines() if line.endswith(f"*{ELECTRON_ZIP}") or line.endswith(f" {ELECTRON_ZIP}")
    )
    require(published == ELECTRON_ZIP_SHA256, "the Electron release's published hash differs from the pinned hash")
    path = args.electron_zip
    if path is None:
        path = scratch / ELECTRON_ZIP
        fetch(f"{ELECTRON_RELEASE}/{ELECTRON_ZIP}", path)
    require(sha256(path) == ELECTRON_ZIP_SHA256, "Electron zip hash differs from the release's published hash")
    return Path(path), published


def stage(installer, zip_path, out):
    extract = out / "extract"
    if extract.exists():
        shutil.rmtree(extract)
    (extract / "nsis").mkdir(parents=True)
    (extract / "app").mkdir()
    subprocess.run(["7z", "x", "-y", f"-o{extract / 'nsis'}", str(installer)], check=True, stdout=subprocess.DEVNULL)
    subprocess.run(["7z", "x", "-y", f"-o{extract / 'app'}", str(extract / "nsis/$PLUGINSDIR/app-64.7z")], check=True, stdout=subprocess.DEVNULL)
    resources = extract / "app/resources"
    require(sha256(resources / "app.asar") == APP_ASAR_SHA256, "app.asar hash differs from the pinned 0.5.2 hash")

    target = out / f"studio-{STUDIO_VERSION}" / "electron"
    if target.parent.exists():
        shutil.rmtree(target.parent)
    target.mkdir(parents=True)
    with zipfile.ZipFile(zip_path) as archive:
        for info in archive.infolist():
            written = archive.extract(info, target)
            mode = info.external_attr >> 16
            if mode:
                Path(written).chmod(mode & 0o777)
    (target / "resources/default_app.asar").unlink(missing_ok=True)
    (target / "electron").rename(target / "studio")
    shutil.copy2(resources / "app.asar", target / "resources/app.asar")
    shutil.copytree(resources / "app.asar.unpacked", target / "resources/app.asar.unpacked")
    shutil.copytree(resources / "app", target / "resources/app")
    # The build directory holds Windows output. Without it better-sqlite3 falls
    # through to the linux-x64 prebuild the installer ships, as in the 1.1.3 port.
    shutil.rmtree(target / "resources/app.asar.unpacked/node_modules/better-sqlite3/build")
    prebuild = target / "resources/app.asar.unpacked/node_modules/better-sqlite3/prebuilds/linux-x64.node"
    return target, sha256(prebuild)


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--installer", type=Path, help="previously downloaded capture; verified the same way")
    parser.add_argument("--electron-zip", type=Path, help=f"local {ELECTRON_ZIP}; must match the published hash")
    parser.add_argument("--evidence", type=Path, default=Path(__file__).resolve().parent / "evidence/provenance.json")
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=args.out) as tmp:
        scratch = Path(tmp)
        cdx = scratch / "cdx.json"
        fetch(CDX_URL, cdx)
        rows = json.loads(cdx.read_text())
        require(len(rows) >= 2, "the capture is no longer in the Internet Archive index")
        index = dict(zip(rows[0], rows[1]))
        require(index["digest"] == WAYBACK_SHA1_BASE32, "index digest differs from the pinned digest")
        require(index["statuscode"] == "200", "the capture is not an HTTP 200 response")

        headers = {}
        if args.installer:
            installer = args.installer
        else:
            download = args.out / "download"
            download.mkdir(exist_ok=True)
            installer = download / "Studio-win-x64.exe"
            headers = fetch(CAPTURE_URL, installer)
        require(installer.stat().st_size == INSTALLER_SIZE, "installer size differs from the pinned size")
        require(sha256(installer) == INSTALLER_SHA256, "installer hash differs from the pinned hash")
        body_sha1 = base64.b32encode(hashlib.sha1(Path(installer).read_bytes()).digest()).decode()
        require(body_sha1 == WAYBACK_SHA1_BASE32, "installer does not match the archived payload digest")

        signature = verify_authenticode(installer, scratch)
        zip_path, published = electron_zip(args, scratch)
        target, prebuild = stage(installer, zip_path, args.out)

        evidence = {
            "studio_version": STUDIO_VERSION,
            "installer": {
                "original_url_not_contacted": ORIGINAL_URL,
                "capture_url": CAPTURE_URL,
                "capture_time_utc": CAPTURE_TIME,
                "size": INSTALLER_SIZE,
                "sha256": INSTALLER_SHA256,
                "wayback_index_entry": index,
                "archived_origin_last_modified": headers.get("x-archive-orig-last-modified"),
                "archived_origin_etag": headers.get("x-archive-orig-etag"),
                "authenticode": signature,
            },
            "app_asar_sha256": APP_ASAR_SHA256,
            "better_sqlite3_linux_x64_prebuild_sha256": prebuild,
            "electron": {
                "version": ELECTRON_VERSION,
                "zip": ELECTRON_ZIP,
                "release": ELECTRON_RELEASE,
                "published_sha256": published,
            },
            "staged_files_modified": "none; the Windows-only better-sqlite3 build directory is omitted, and Electron's binary is renamed to `studio`, matching the 1.1.3 port",
        }
        args.evidence.parent.mkdir(parents=True, exist_ok=True)
        args.evidence.write_text(json.dumps(evidence, indent=1, sort_keys=True) + "\n")
    print(f"staged Studio {STUDIO_VERSION} at {target}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
