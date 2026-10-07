#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Census the four series workbooks in Digital-City/mission-book.

Series: city-self-health-check (CHK), personal-compute-fabric (PCF),
        research-strengthening (REX), deliberative-governance-expansion-migration (DGX)
"""
import json
import os
import re
import sys

ROOT = r"D:\utopia-chat\dc\mission-book\mission-group"
SERIES = {
    "CHK": "city-self-health-check",
    "PCF": "personal-compute-fabric",
    "REX": "research-strengthening",
    "DGX": "deliberative-governance-expansion-migration",
}

FM_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n", re.S)


def parse_frontmatter(text):
    m = FM_RE.match(text)
    if not m:
        return None, None
    body = m.group(1)
    data = {}
    for line in body.splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if ":" not in line:
            continue
        k, v = line.split(":", 1)
        data[k.strip()] = v.strip()
    return data, m.group(0)


def main():
    out = {}
    for sid, d in SERIES.items():
        dirpath = os.path.join(ROOT, d)
        entries = []
        for name in sorted(os.listdir(dirpath)):
            if not name.endswith(".md"):
                continue
            if name == "README.md":
                continue
            if not name.startswith(sid + "-"):
                continue
            p = os.path.join(dirpath, name)
            with open(p, encoding="utf-8") as f:
                text = f.read()
            fm, _ = parse_frontmatter(text)
            entries.append({"file": name, "fm": fm})
        out[sid] = entries
    print(json.dumps(out, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
