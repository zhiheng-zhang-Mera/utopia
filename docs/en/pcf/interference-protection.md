# Approved local queue protection

[中文](../../zh-CN/pcf/interference-protection.md)

createFabricService accepts an explicit protection controller configuration with settings, a bounded observer and a synchronous current-authority callback. It is disabled by default. A fresh measured target miss may reduce only this service's future parallelism or refuse its batch/background starts. It does not kill arbitrary processes, buy cloud execution, change quality or pretend to preempt non-preemptible work. Existing owned children continue through their bounded cancellation/exit path.

Unknown/stale observations request remeasurement; revoked authority blocks new protected dispatch. Sampling is bounded to 250 ms; cooldown/dwell and a generation fence prevent oscillation or late actuation after user disable. Disabling restores the previously approved local queue limit and background admission. This is reversible queue control, not a hard realtime guarantee. The observer must identify its actual source; injected component fixtures do not prove foreground application responsiveness.

Actual protection on/off foreground SLO, resource contention and user-device evidence remain NOT_RUN. Those checks belong to the single complete-flow opposite-host handoff, not separate component acceptance.
