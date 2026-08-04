#!/usr/bin/env python3
"""Construit dist/ puis release/twitch-drops-claimer-vX.Y.Z.zip.

Le paquet ne contient QUE ce qui est livré : manifeste, src/, _locales/, assets/.
Ni tests, ni docs, ni dev, ni scripts, ni package.json (cf. docs/SECURITY-AUDIT.md).

    python scripts/build.py             # paquet lisible (recommandé pour la relecture)
    python scripts/build.py --minify    # passe Terser si npx est disponible
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"
RELEASE = ROOT / "release"

# Ce qui part dans le zip. Tout le reste est exclu par construction.
SHIPPED = ["manifest.json", "src", "_locales", "assets"]

# Sécurité : ces motifs ne doivent jamais se retrouver dans dist/.
FORBIDDEN_NAMES = {".git", ".env", "node_modules", "__pycache__"}
FORBIDDEN_SUFFIXES = {".map", ".test.js", ".pyc", ".md"}


def fail(message: str) -> None:
    print(f"ERREUR : {message}", file=sys.stderr)
    sys.exit(1)


def read_version() -> str:
    manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
    package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    if manifest["version"] != package["version"]:
        fail(
            f"versions désynchronisées : manifest {manifest['version']} "
            f"!= package.json {package['version']} (lance scripts/bump-version.py)"
        )
    return manifest["version"]


def copy_shipped() -> None:
    if DIST.exists():
        shutil.rmtree(DIST)
    DIST.mkdir(parents=True)

    for name in SHIPPED:
        source = ROOT / name
        if not source.exists():
            fail(f"{name} est introuvable")
        if source.is_dir():
            shutil.copytree(source, DIST / name)
        else:
            shutil.copy2(source, DIST / name)


def check_clean() -> None:
    for path in DIST.rglob("*"):
        if path.name in FORBIDDEN_NAMES or path.suffix in FORBIDDEN_SUFFIXES:
            fail(f"fichier interdit dans le paquet : {path.relative_to(DIST)}")


def minify() -> None:
    npx = shutil.which("npx") or shutil.which("npx.cmd")
    if not npx:
        print("npx introuvable, minification ignorée.")
        return

    files = sorted(DIST.rglob("*.js"))
    for path in files:
        result = subprocess.run(
            [npx, "--yes", "terser", str(path), "--compress", "--mangle", "--output", str(path)],
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            fail(f"terser a échoué sur {path.relative_to(DIST)} :\n{result.stderr}")
    print(f"Minifié : {len(files)} fichiers.")


def make_zip(version: str) -> Path:
    RELEASE.mkdir(exist_ok=True)
    target = RELEASE / f"twitch-drops-claimer-v{version}.zip"
    if target.exists():
        target.unlink()

    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(DIST.rglob("*")):
            if path.is_file():
                archive.write(path, path.relative_to(DIST).as_posix())
    return target


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--minify", action="store_true", help="passe Terser sur le JS")
    args = parser.parse_args()

    version = read_version()
    copy_shipped()
    check_clean()
    if args.minify:
        minify()

    target = make_zip(version)
    count = sum(1 for p in DIST.rglob("*") if p.is_file())
    size = target.stat().st_size / 1024
    print(f"dist/ : {count} fichiers")
    print(f"{target.relative_to(ROOT)} : {size:.1f} Ko")


if __name__ == "__main__":
    main()
