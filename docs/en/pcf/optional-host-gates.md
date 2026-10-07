# Optional host prerequisites

[中文](../../zh-CN/pcf/optional-host-gates.md)

PCF-717 has no bound authorized model/runtime/license or measured cold/warm inference. Model residency remains NOT_RUN; no model or provider is downloaded automatically. PCF-722 explicitly forbids HA implementation without an approved independent storage/fencing substrate. That substrate is absent, so no HA promotion mechanism is introduced. PCF-723 remains shadow-only until a frozen baseline study shows a justified shortcoming and held-out evidence exists.

PCF-718 uses the same fixed portable Node CPU worker and existing headless/canonical port, retaining separate host/boot/principal/fence identities. The isolated Linux CI job runs actual POSIX child lifecycle tests. Alien has no installed WSL runtime; a Windows skip is NOT_RUN for Linux. Hosted Linux CI is a component run, not a physical Mech worker, installation or acceptance.

PCF-720 records stable GPU UUID and driver identity, VRAM bytes, utilization ratio, Celsius, watts and freshness. Missing executable is UNSUPPORTED; failed driver reads are UNKNOWN. Runtime version, joules and reserved VRAM remain unknown unless their actual owner supplies evidence. The optional 701 adapter refuses to aggregate heterogeneous devices. Explicit accelerator constraints check current canonical reservations, safety limits, stale observations and hardware changes; they are constraints, never grants or scheduling authority. No thermal stress, overclocking or model/GPU execution is performed.

The complete flow is submitted once to the opposite host after local development, not split into per-task physical verification. All unavailable optional physical prerequisites remain visible in the coverage matrix.
