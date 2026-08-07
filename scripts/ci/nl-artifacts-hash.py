#!/usr/bin/env python3
"""Content hash of every natural-language artifact in this plugin.

The nlpm score badge is a claim that cannot be recomputed by CI — scoring needs
the nlpm scorer agent. So CI verifies the next best thing: that the artifacts
have not changed since the score was recorded.

Hashing CONTENT rather than comparing commit timestamps matters. A timestamp
check fires on every commit that touches an artifact, including the commit that
records the score itself, so it would cry wolf until people stopped reading it.
A content hash is stable across commits, rebases, and file moves that do not
change what the artifacts actually say.

Usage:
    python3 scripts/ci/nl-artifacts-hash.py          # print the hash
    python3 scripts/ci/nl-artifacts-hash.py --check  # compare against nlpm-score.json
"""

from __future__ import annotations

import hashlib
import json
import pathlib
import subprocess
import sys

# Everything the nlpm score covers. Keep in sync with what /nlpm:score scores.
TRACKED = ["agents", "commands", "skills", "CLAUDE.md", ".nlpm-test"]

ROOT = pathlib.Path(__file__).resolve().parents[2]
SCORE_FILE = ROOT / "nlpm-score.json"


def tracked_files() -> list[str]:
    """NL artifacts, sorted for a stable hash.

    Includes untracked-but-not-ignored files (`--others --exclude-standard`), so
    the hash covers artifacts added but not yet committed. In CI everything is
    committed and the two sets are identical; locally this is what stops a new
    file from being silently left out of the attested set.
    """
    result = subprocess.run(
        ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard", *TRACKED],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=True,
    )
    seen = {p for p in result.stdout.split("\0") if p}
    return sorted(p for p in seen if (ROOT / p).is_file())


def compute() -> tuple[str, int]:
    files = tracked_files()
    if not files:
        # An empty file list hashes to a stable value that would silently "match"
        # forever. Refuse it rather than emit a hash of nothing.
        print("error: no tracked NL artifacts found — is this a git checkout?", file=sys.stderr)
        raise SystemExit(2)

    digest = hashlib.sha256()
    for name in files:
        digest.update(name.encode())
        digest.update(b"\0")
        digest.update((ROOT / name).read_bytes())
        digest.update(b"\0")
    return digest.hexdigest(), len(files)


def main() -> int:
    digest, count = compute()

    if "--check" not in sys.argv:
        print(digest)
        return 0

    if not SCORE_FILE.exists():
        print(f"error: {SCORE_FILE.name} is missing — run /nlpm:score and record the result.", file=sys.stderr)
        return 1

    recorded = json.loads(SCORE_FILE.read_text())
    if recorded.get("artifacts_sha256") == digest:
        print(f"score attestation is current: {recorded.get('score')}/100 over {count} artifacts ({digest[:12]})")
        return 0

    print(
        f"NL artifacts changed since the score was recorded.\n"
        f"  recorded: {recorded.get('artifacts_sha256', '(none)')[:12]} "
        f"({recorded.get('score')}/100 on {recorded.get('checked_at')})\n"
        f"  current:  {digest[:12]} over {count} artifacts\n"
        f"Re-run /nlpm:score, then update nlpm-score.json and the README badge.",
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
