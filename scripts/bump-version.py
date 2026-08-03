#!/usr/bin/env python3
"""Synchronise la version entre manifest.json, package.json et le tag git.

    python scripts/bump-version.py patch      # 2.0.0 -> 2.0.1
    python scripts/bump-version.py minor      # 2.0.0 -> 2.1.0
    python scripts/bump-version.py major      # 2.0.0 -> 3.0.0
    python scripts/bump-version.py 2.4.1      # version explicite
    python scripts/bump-version.py patch --tag  # pose aussi le tag git vX.Y.Z
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MANIFEST = ROOT / "manifest.json"
PACKAGE = ROOT / "package.json"
SEMVER = re.compile(r"^\d+\.\d+\.\d+$")


def fail(message: str) -> None:
    print(f"ERREUR : {message}", file=sys.stderr)
    sys.exit(1)


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def write_version(path: Path, version: str) -> None:
    # Réécriture ciblée : on ne réordonne pas le fichier, on ne touche qu'à la version.
    text = path.read_text(encoding="utf-8")
    updated, count = re.subn(r'("version"\s*:\s*")[^"]+(")', rf"\g<1>{version}\g<2>", text, count=1)
    if count != 1:
        fail(f"champ version introuvable dans {path.name}")
    path.write_text(updated, encoding="utf-8")


def next_version(current: str, bump: str) -> str:
    if SEMVER.match(bump):
        return bump
    major, minor, patch = (int(part) for part in current.split("."))
    if bump == "major":
        return f"{major + 1}.0.0"
    if bump == "minor":
        return f"{major}.{minor + 1}.0"
    if bump == "patch":
        return f"{major}.{minor}.{patch + 1}"
    fail(f"bump inconnu : {bump} (major, minor, patch ou X.Y.Z)")
    return ""


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("bump", help="major, minor, patch ou une version X.Y.Z")
    parser.add_argument("--tag", action="store_true", help="pose le tag git vX.Y.Z")
    args = parser.parse_args()

    manifest, package = read_json(MANIFEST), read_json(PACKAGE)
    if manifest["version"] != package["version"]:
        fail(f"déjà désynchronisé : {manifest['version']} vs {package['version']}, corrige à la main")

    version = next_version(manifest["version"], args.bump)
    write_version(MANIFEST, version)
    write_version(PACKAGE, version)
    print(f"{manifest['version']} -> {version} (manifest.json + package.json)")

    if args.tag:
        result = subprocess.run(["git", "tag", f"v{version}"], capture_output=True, text=True)
        if result.returncode != 0:
            fail(f"tag git impossible : {result.stderr.strip()}")
        print(f"tag v{version} posé")


if __name__ == "__main__":
    main()
