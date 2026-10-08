# REX-890 development-host study — the original artifact package

```text
这是**原始工件包**（原样字节），不是重新导出的。放进仓库只有一个目的：
**任何**取到本分支的机器都能拿到同一份原始字节去独立复现，而不必依赖"某台机器上的某个路径"。
```

## What this is / 这是什么

The artifact package the REX-890 development-host study produced, moved here byte-for-byte from the
machine that exported it. The study itself is described in
`Digital-City/mission-book/reports/REX-PROGRAMME/REX-890_DEV_STUDY_Mech_2026-10-07.md`.

```text
artifact dir      evidence/raw/rex890-dev-study/artifact/      （11 个文件，文件集合固定）
artifact id       artifact-544adda1-3059-4c6f-ae7d-71ddfd0f3b8c-5-campaigns
                  campaigns=5 · runs=15 · measured=15
exporter host     dev-544adda1-3059-4c6f-ae7d-71ddfd0f3b8c (Mega-rep, the development host)
City it came from http://172.31.12.151:4310 （City id 544adda1-3059-4c6f-ae7d-71ddfd0f3b8c）
```

## Why it is in the repository rather than handed over by hand / 为什么放进仓库

An independent reproduction must run on a **different** physical host, and that host could not reach the
package: it was not in the Git tree, and it is not reproducible from the City afterwards (a fresh export
would carry every campaign since, so it would be a different artifact with a different id and different
bytes). Handing a file from one machine to another makes the study depend on a manual step, which is the
opposite of a system-level capability. Committed bytes travel with the branch, so any host that fetches
the branch has the same input.

## Verify it before you use it / 用之前先自己核一遍

Two independent layers, and they are meant to be run by the host that receives the package:

```bash
# 1. the package's own checksums, over the 10 files it lists
node -e "const fs=require('fs'),c=require('crypto'),p=require('path');const d='evidence/raw/rex890-dev-study/artifact';const cs=JSON.parse(fs.readFileSync(p.join(d,'checksums.json'),'utf8'));for(const [n,m] of Object.entries(cs.files??cs)){const w=typeof m==='string'?m:(m.sha256??m.digest);const g=c.createHash('sha256').update(fs.readFileSync(p.join(d,n))).digest('hex');console.log(g===w?'ok  ':'BAD ',n)}"

# 2. the independent manifest, over ALL 11 files, kept OUTSIDE the package so the package's own file set is untouched
sha256sum -c evidence/raw/rex890-dev-study/MANIFEST.sha256     # or: certutil -hashfile <file> SHA256
```

`MANIFEST.sha256` is not part of the package: `checksums.json` inside it covers 10 files, so adding a file
to that directory would change what "the package" is. It lives one level up for that reason.

## How the opposite host uses it / 对侧怎么用

```bash
node scripts/rex890-opposite-host-reproduce.mjs \
  --artifact evidence/raw/rex890-dev-study/artifact \
  --city <the City> --config <a file holding {"token":"..."}> --out <output dir> --label <this host>
```

Exit codes: `0` reproduced and fully compared · `1` disagreements, each named · `2` the harness could not run
or evidence could not be fully compared — **not** an acceptance.

## What this file does not claim / 这里不声称的事

- The physical-host reproduction has **not** happened. Putting the package in the tree makes the input
  reachable; it proves nothing about the result.
- These bytes are the development host's own export. The City they came from, the study, and the package
  were all produced by the same programme, so an independent reproduction is what gives them weight — not
  this file.
- No credential is here, and none should be: the City token the harness needs must be configured on the
  reproducing host, out of band.
