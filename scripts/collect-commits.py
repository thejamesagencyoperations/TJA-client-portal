#!/usr/bin/env python3
"""Collect commits from the last N hours into the JSON payload push-digest expects.

Lives in a FILE rather than inline in the workflow on purpose: Python needs
unindented top-level code, YAML's `run: |` block needs everything indented deeper
than the key, and the two can't both be satisfied. Inlining it silently broke the
whole workflow file (GitHub showed the commit message where the job name should be,
and the run failed in 0s without a log).

Usage:  python3 scripts/collect-commits.py [window_hours] [branch] > payload.json
"""
import json
import re
import subprocess
import sys

US, RS = "\x1f", "\x1e"          # field / record separators — commit subjects contain
                                 # commas, colons, quotes and newlines, so anything
                                 # friendlier than control chars corrupts the parse


def sh(args, timeout=30):
    return subprocess.run(args, capture_output=True, text=True, timeout=timeout).stdout


def shortstat(sha):
    """files, insertions, deletions for one commit.

    `git log -1 --shortstat --format=""` prints ONLY the stat line. Do NOT use
    `git show --shortstat --no-patch`: --no-patch suppresses the shortstat too, so
    every commit silently reports 0/0/0. And unlike `git diff sha^ sha`, this also
    works on the root commit, which has no parent.
    """
    try:
        out = sh(["git", "log", "-1", "--shortstat", "--format=", sha])
    except Exception:
        return 0, 0, 0
    def n(pat):
        m = re.search(pat, out)
        return int(m.group(1)) if m else 0
    return (n(r"(\d+) files? changed"),
            n(r"(\d+) insertions?\(\+\)"),
            n(r"(\d+) deletions?\(-\)"))


def main():
    hours = int(sys.argv[1]) if len(sys.argv) > 1 else 24
    branch = sys.argv[2] if len(sys.argv) > 2 else "main"

    fmt = US.join(["%H", "%an", "%ae", "%aI", "%s"]) + RS
    raw = sh(["git", "log", "--since", "%d hours ago" % hours, "--no-merges",
              "--pretty=format:" + fmt])

    commits = []
    for rec in (r for r in raw.split(RS) if r.strip()):
        parts = rec.strip("\n").split(US)
        if len(parts) < 5:
            continue
        sha, author, email, date, subject = parts[:5]
        files, ins, dels = shortstat(sha)
        commits.append({"sha": sha, "author": author, "email": email, "date": date,
                        "subject": subject, "files": files,
                        "insertions": ins, "deletions": dels})

    json.dump({"commits": commits, "windowHours": hours, "branch": branch}, sys.stdout)
    print("collected %d commit(s)" % len(commits), file=sys.stderr)


if __name__ == "__main__":
    main()
