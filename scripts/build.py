#!/usr/bin/env python3
"""Builds dist/ then release/twitch-drops-claimer-vX.Y.Z.zip.

The package contains ONLY what ships: manifest, src/, _locales/, assets/. No tests,
no docs, no dev, no scripts, no package.json (see docs/SECURITY-AUDIT.md).

    python scripts/build.py             # readable package (recommended for review)
    python scripts/build.py --minify    # runs Terser when npx is available
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

# What goes into the zip. Everything else is excluded by construction.
SHIPPED = ["manifest.json", "src", "_locales", "assets"]

# Safety: these patterns must never end up in dist/.
FORBIDDEN_NAMES = {".git", ".env", "node_modules", "__pycache__"}
FORBIDDEN_SUFFIXES = {".map", ".test.js", ".pyc", ".md"}


def fail(message: str) -> None:
    print(f"ERROR: {message}", file=sys.stderr)
    sys.exit(1)


def read_version() -> str:
    manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
    package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    if manifest["version"] != package["version"]:
        fail(
            f"versions out of sync: manifest {manifest['version']} "
            f"!= package.json {package['version']} (run scripts/bump-version.py)"
        )
    return manifest["version"]


def copy_shipped() -> None:
    if DIST.exists():
        shutil.rmtree(DIST)
    DIST.mkdir(parents=True)

    for name in SHIPPED:
        source = ROOT / name
        if not source.exists():
            fail(f"{name} is missing")
        if source.is_dir():
            shutil.copytree(source, DIST / name)
        else:
            shutil.copy2(source, DIST / name)


def check_clean() -> None:
    for path in DIST.rglob("*"):
        if path.name in FORBIDDEN_NAMES or path.suffix in FORBIDDEN_SUFFIXES:
            fail(f"forbidden file in the package: {path.relative_to(DIST)}")


def minify() -> None:
    npx = shutil.which("npx") or shutil.which("npx.cmd")
    if not npx:
        print("npx not found, minification skipped.")
        return

    files = sorted(DIST.rglob("*.js"))
    for path in files:
        result = subprocess.run(
            [npx, "--yes", "terser", str(path), "--compress", "--mangle", "--output", str(path)],
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            fail(f"terser failed on {path.relative_to(DIST)}:\n{result.stderr}")
    print(f"Minified: {len(files)} files.")


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
    parser.add_argument("--minify", action="store_true", help="run Terser over the JS")
    args = parser.parse_args()

    version = read_version()
    copy_shipped()
    check_clean()
    if args.minify:
        minify()

    target = make_zip(version)
    count = sum(1 for p in DIST.rglob("*") if p.is_file())
    size = target.stat().st_size / 1024
    print(f"dist/: {count} files")
    print(f"{target.relative_to(ROOT)}: {size:.1f} kB")


if __name__ == "__main__":
    main()
