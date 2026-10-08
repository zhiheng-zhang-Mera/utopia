# REX-890 — the 2026-10-08 study and the package that carries its own trace evidence

```text
这一份是**按 Owner 2026-10-08 裁决（B 案）重跑出来的 study 包**，与上一份的关键区别只有一个，
但那个区别决定了 final gate 的 trace 要素能不能成立：**包自己携带它所指的 trace 记录**
（`trace-records.jsonl` + `trace-coverage.json`），因此不再依赖城市的有界保留期。
```

## What is here / 这里是什么

```text
包           evidence/raw/rex890-studies/2026-10-08-B/artifact/   13 文件（含 checksums.json）
artifact id  artifact-544adda1-3059-4c6f-ae7d-71ddfd0f3b8c-41-campaigns
             campaigns=41 · runs=205 · measured=205
导出主机     dev-544adda1-3059-4c6f-ae7d-71ddfd0f3b8c (Mega-rep, the development host)
城市         http://172.31.12.151:4310 （City id 544adda1-3059-4c6f-ae7d-71ddfd0f3b8c）
study 结果   **21/21** development-study checks（8 要素齐备，见下）
独立校验器   15/15 independent checks 在该包上通过
```

## Why this package exists / 为什么又做了一份

前一份包（`evidence/raw/rex890-dev-study/artifact/`）发布了 206 条 trace 指针，**没有携带记录本身**。
城市的 trace 保留是**有界**的（256 条窗口 + 2 MiB × **一代**轮转），而 2026-10-08 当天为验证工具而做的
反复复现把这批记录挤了出去：同一天早先 206/206 可解析，午後 **0/206**；城市备份
`previous-city-20261007-194534` 的最新记录早于 study，因此**任何可达存储里都没有了**。

结论不是"少了一条证据"，而是一句关于可复现性的普适事实：
**一个工件包可以把指针发布得比它所指向的城市状态活得更久，而指针的有效期没有写在包里。**
这一份包把记录写进自己，正是为了不再有这个期限。

## The eight elements this study produced / 本 study 产出的八个要素

```text
multi-device execution   6 次重复逐条落在两台**真实**设备上（dev-544adda1 / dev-1428bce5 交替）
repetitions              计划 6 / 计入 6 / 实测 6
one routing decision     每条重复的放置都点名执行设备
one injected fault       fault-c22b857f-…，并**实测定向性**：被注入设备 claim→503，另一台→200
recovery                 recoveryTimeMs=901（读自城市）
one replay               campaign-45e406a5-… COMPLETED，在 dev-1428bce5 上真实执行
one ablation             campaign-dbba5342-… COMPLETED，在 dev-544adda1 上；
                         且**消融真的改变了放置**：来源 run=dev-1428bce5 → 消融后=dev-544adda1
artifact export          本包（41 campaigns / 205 runs / 205 measured），独立校验器 15/15
未测                     fault detectionTimeMs=null（typed NOT_MEASURED，理由：该故障拒绝认领而非心跳）
```

**选哪条 run 去回放是一个决定，不是碰运气**：消融会把放置固定到 campaign 的**第一个** worker，
所以要证明"禁用该机制改变了放置"，来源 run 必须原本落在**别的**设备上。第一版脚本取"第一条已测 run"，
于是这一要素取决于种子——2026-10-08 重跑时它曾给出 `source=dev-544adda1 / ablation=dev-544adda1`，
study 因此报 18/20，而城市并没有任何问题。现在**刻意挑一条能被该机制移动的记录 run，并把选了哪条、为什么写进结果**。

## Verify it before you use it / 用之前自己核一遍

```bash
# 1. the package's own checksums, over the 12 files it lists
node -e "const fs=require('fs'),c=require('crypto'),p=require('path');const d='evidence/raw/rex890-studies/2026-10-08-B/artifact';const cs=JSON.parse(fs.readFileSync(p.join(d,'checksums.json'),'utf8'));let ok=0;for(const [n,m] of Object.entries(cs.files??cs)){const g=c.createHash('sha256').update(fs.readFileSync(p.join(d,n))).digest('hex');ok+=g===(m.sha256??m)?1:0}console.log('verified',ok,'of',Object.keys(cs.files??cs).length)"

# 2. the independent manifest beside this README, over ALL 13 files
sha256sum -c evidence/raw/rex890-studies/2026-10-08-B/MANIFEST.sha256

# 3. the package carries every record it points at
cat evidence/raw/rex890-studies/2026-10-08-B/artifact/trace-coverage.json   # listed must equal captured
```

## How the opposite host reproduces it / 对侧怎么复现

```bash
node scripts/rex890-opposite-host-reproduce.mjs \
  --artifact evidence/raw/rex890-studies/2026-10-08-B/artifact \
  --city <the City> --config <a file holding {"token":"..."}> --out <out dir> --label <this host>
```

Exit codes: `0` reproduced and **fully compared** · `1` disagreements, each named ·
`2` the harness could not run, or evidence could not be fully compared — **not** an acceptance.

Measured on the development host, from a clean checkout of this branch with **no install**:
`checksums VERIFIED over 12 files` · 205 run references rebuilt from 41 receipts · four metrics agreeing ·
`214/214` canonical-task pointers · `205/205` run joins · **`243/243` trace pointers** ·
an independent campaign COMPLETED on both real devices · the software identity observed from the checkout ·
**0 inconsistencies · 0 evidence gaps · reproductionComplete true · exit 0**.

## What this file does not claim / 这里不声称的事

- The **physical-host reproduction has not happened**. This README describes the development host's own
  rehearsal of the procedure. The independent verdict belongs to the opposite host.
- The previous package is kept rather than deleted, because its trace loss is a fact the programme learned
  from and a report that erased it would hide the lesson.
- No credential is here, and none should be: the City token must be configured on the reproducing host.
