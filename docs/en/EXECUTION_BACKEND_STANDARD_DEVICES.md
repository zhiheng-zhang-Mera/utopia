# Execution backend contract and the STANDARD_DEVICES baseline

DATE: 2026-10-04
STATUS: WBC-601 EXECUTION_BACKEND_STANDARD_COMPAT_ACCEPTED (development complete; opposite-host formal review pending)

Utopia can execute work on more than one kind of resource in principle, but until now it could only do so on
the devices registered with its own City, and that fact lived inside the node routes rather than in a contract.
This change freezes the shape of an execution backend first — `contracts/execution-backend-v1` — and binds
today's behaviour to it as `STANDARD_DEVICES`. A future Workbench node pool becomes a second registration of the
same shape instead of a rewrite of the dispatch path.

A backend answers six questions and nothing else: whether it is usable and why not (`readiness`), which
execution endpoints exist with what availability (`endpoints`), and the four operations `dispatch`, `claim`,
`report` and `control`. A backend does not own task state. The canonical task record, its lease semantics and
its idempotency stay in Shared Task Core, and a backend is not allowed to grow a second scheduler or a second
task store.

`STANDARD_DEVICES` is registered unconditionally and is the default profile. It is not the fallback of a missing
Workbench; it is the baseline the product already runs on. No configuration can disable it, and naming a future
profile does not enable one: `CITY_EXECUTION_PROFILE` accepts only profiles this release actually ships, and a
dormant backend refuses ordinary work with a typed refusal rather than being ignored.

The placement rules did not change. A strict target is applied before generic availability, so a task aimed at
an away device is withheld and never reassigned. A device already holding unfinished work is offered nothing, so
two tasks cannot land on one device. An owner who stopped sharing keeps a device that is online and visible but
takes no work. The withheld set is still returned as data, so a device can tell "there is no work" from "there is
work and it is not yours".

Nothing here is a startup dependency. A City with no Workbench and no Linux server starts, serves, dispatches,
executes and reports exactly as before; the execution backend is reported on health and City status as its own
component with its own readiness word, and no device being online at this instant is not treated as a degraded
gateway.

The capability is not exposed to end users and needs no control surface: it is an internal dispatch seam.
Which profile is serving a City is observable on the City status payload, which is what keeps a future
"the pool did it" claim checkable.

Physical two-host results remain NOT_RUN when unavailable; isolated tests do not establish hardware performance
or the future Workbench path, which is WBC-603/604's work and is not enabled here.
