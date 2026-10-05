# Experiment manifests and the experiment registry

DATE: 2026-10-05
STATUS: REX-801 EXPERIMENT_MANIFEST_REGISTRY_ACCEPTED (development complete; opposite-host formal review pending)

A research claim is only reproducible if the experiment behind it was described before it ran. `REX-801` adds a
machine-readable experiment manifest and a registry for those manifests, so a question is bound to its topology,
variables, metrics, repetitions, seed policy, required capabilities, stop conditions, artifact policy, acceptance
criteria and exact software identities rather than to prose in a report.

The registry answers four things and nothing else: list the registered experiments, inspect one manifest, validate
a manifest without registering it, and create or import one. There is no run, pause, stop or export here, and a
caller that expects one receives a typed 404 rather than a surprise: this contract describes experiments, and
executing them belongs to the scenario runner.

A manifest never invents a value. Every required field that is missing produces a typed issue naming its path, so
a manifest cannot become valid by being repaired silently. An impossible topology is refused in each way it can be
impossible — too few hosts, no real worker, no control surface, a worker that is not one of the declared hosts, a
topology that requires an Android control surface that was not named. A required capability is checked against the
capability vocabulary this City actually provides, and an empty vocabulary refuses everything rather than
accepting everything. Software identity must be exact: a short commit SHA or a truncated paste is refused by
name, because a manifest whose software identity can move is not a reproducible experiment.

The same manifest always yields the same seeds. Seed derivation is pure and depends on the experiment identity,
the seed policy and the repetition or variant index — never on a clock or a random source — so five repetitions
are five distinct deterministic runs on any host at any time, and a fixed-seed experiment really is fixed.

A manifest is not a task database. A registration carrying task-domain keys such as tasks, assignments, leases or
results is refused by name, the storage is file-based under the git-ignored runtime directory rather than in the
task-keyed City store, and a registered description cannot be edited: changed content requires a new experiment
identifier, while re-registering identical content is idempotent. A refused manifest is stored as a rejection with
its issue list, so negative results survive as evidence instead of being dropped.

Reading and describing experiments requires the control credential. A worker may not register the experiment it
will be judged by, because that would make the acceptance criteria self-certified.

Research routes live under the research namespace and are reachable by any surface that already holds the owner
credential; the layered Research interface that presents them belongs to the later research surface task, so this
review correction adds the thinnest Advanced > Research entry: list/inspect authored manifests, import JSON, validate without persisting, and explicitly register without executing. REX-807 still owns the fuller layered research workflow.

Physical two-host results remain NOT_RUN when unavailable; no experiment is executed by this task, so no
measurement, hardware or performance claim is made here.

Review correction: repeated host/worker/control-surface identities cannot satisfy topology cardinality. Validated manifests reject movable branch refs and require at least one40-character code commit; supplementary explicit component versions remain labelled. The parsing helper may describe an unanchored label, but validation refuses it. A committed registration is retained even when subsequent list refresh fails; the failure is a separate message. Drafts survive periodic rendering; late context/page responses cannot replace the current view. No cross-device experiment or model decision is added.
