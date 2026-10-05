# Start modes / 启动模式

Utopia starts in one of three modes, and the default is the single-machine one.

Utopia 有三种启动模式，默认是单机模式。

| Mode | How it starts | The City's life | Stored role |
|---|---|---|---|
| `standalone` + `page` | the default: `utopia-client-launcher.mjs` with no mode flag | tied to the page that opened it — closing the page closes the City | ignored |
| `standalone` + `service` | `--host-only`, or `scripts/start-city.ps1` | independent: it keeps running for phones and peer hosts | ignored |
| `online` | `--online`, or enrolling (`--enroll` / `--enroll-code`) | independent | honoured, and adjusted |

| 模式 | 如何进入 | 城市生命周期 | 已存储角色 |
|---|---|---|---|
| `standalone` + `page` | 默认：`utopia-client-launcher.mjs` 不带模式参数 | 与打开它的页面同生共死——关页面即关城市 | 忽略 |
| `standalone` + `service` | `--host-only`，或 `scripts/start-city.ps1` | 独立运行：为手机与对等主机持续提供服务 | 忽略 |
| `online` | `--online`，或入网（`--enroll` / `--enroll-code`） | 独立运行 | 被采用，并进行角色调整 |

## Why the default is page-tied / 为什么默认与页面同生共死

Opening Utopia on one machine is the ordinary way a person starts it, and on a single machine a City that outlives the
window is a process the person did not ask for. So the default start follows the page: it releases the City on unload,
and if the page dies without saying so the City closes once the last control surface has been gone for a grace period
(default 8 s, `CITY_PAGE_IDLE_MS`). A reload inside that window cancels the exit; a second page keeps the City alive.

在一台机器上打开 Utopia 是最常见的启动方式，而单机情况下"比窗口活得更久"的城市是用户没要求的进程。因此默认启动跟随
页面：卸载时主动释放；若页面没有告别就消失，则在最后一个控制面离开一个宽限期（默认 8 秒，`CITY_PAGE_IDLE_MS`）后关闭。
宽限期内重载会取消退出；第二个页面会让城市继续运行。

Hosting is the opposite case, and it is explicit: `start-city.ps1` and `--host-only` start a City that must survive
any page, and such a City answers `released: false` when a page tries to release it. The City reports which it is in
its own snapshot (`lifecycle: 'page' | 'service'`), so the page never has to guess and a member page can never release
a City that is not its own.

托管是相反的情形，且必须显式声明：`start-city.ps1` 与 `--host-only` 启动的城市必须能挺过任何页面关闭，这类城市在页面
尝试释放时会如实回 `released: false`。城市在自身快照中声明自己属于哪种（`lifecycle: 'page' | 'service'`），因此页面
无需猜测，成员页面也永远无法释放不属于它的城市。

## Why the role is ignored until online / 为什么进入联机前忽略角色

A host records the role it was last told to take in `role.json` (PRIMARY, or MEMBER of another City with an enrollment
file). That selection used to decide what an ordinary start did — and `publish()` rewrote the file to PRIMARY on every
start, so starting your own City silently destroyed the membership you had chosen.

主机会把上次被指定的角色记录在 `role.json`（PRIMARY，或"某城的 MEMBER + 入网文件"）。过去这个选择会决定一次普通启动
做什么，而且 `publish()` 会在每次启动时把该文件改写成 PRIMARY——于是"启动自己的城市"会悄悄毁掉你选好的成员身份。

Now the running role and the stored selection are two separate facts. A single-machine start runs a PRIMARY City but
leaves `role.json` exactly as it was (`persistRole: false`); only an online start writes it. Going online is the act
that adjusts the role, and it is the only one.

现在"运行角色"与"已存储选择"是两个独立事实。单机启动以 PRIMARY 运行城市，但原样保留 `role.json`
（`persistRole: false`）；只有联机启动才会写入。联机才是调整角色的动作，也是唯一的那个。

## What you are told when it starts / 启动时会告诉你什么

A start that decides how long a process lives should say so while the person is still standing at the start, rather
than let them infer it later from a City that disappeared. In human mode the launcher prints the endpoint and then one
line for the mode it chose — "This City follows this page: closing it closes the City.", or that it keeps running on
its own — plus, on a single-machine start, that the stored role was not used and that going online is what changes it.
`--json` stays a single parseable line and carries the same facts as fields (`mode`, `lifecycle`, `roleIgnored`).

一个决定"进程活多久"的启动动作，应当在用户还站在起点时就说清楚，而不是让他事后从"城市消失了"去猜。人类可读模式下，
启动器先打印地址，再打印一行当前模式——"This City follows this page: closing it closes the City."，或说明它会自行
继续运行；单机启动时还会说明已存储的角色未被采用、联机才是改变角色的动作。`--json` 保持单行可解析，并以字段
（`mode`、`lifecycle`、`roleIgnored`）承载同样的事实。

## Evidence / 证据

- `tests/host-standalone-lifecycle.test.mjs` — 8 probes: the plan defaults, page close closes the City, a reload inside
  the grace window does not, a second surface keeps it alive, a page-less City does not close itself, the owner may
  release and a member may not, a hosting City ignores the release, and the start disclosure says the right words for
  each mode (and invents none where it has no fact).
- `tests/acceptance/host-lifecycle-process-e2e.test.mjs` — 2 process-level acceptances against a real isolated City:
  closing the last page ends the process (exit code 0), and a stored MEMBER role is ignored on a single-machine start
  while the role file is left intact and is honoured only when going online. This file is deliberately outside
  `pnpm test`: starting a real City is a host-wide act (the preflight reads the process list, not ports), so it runs as
  its own step, `pnpm test:acceptance`, before the parallel suite in the same CI job.
- `evidence/raw/mission-book/HOST-START-MODES/development-receipt.json` — the recorded runs and their exact numbers.
