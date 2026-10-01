# Paper evidence — response latency and backpressure under concurrent multi-device AI requests

PAIR_STATUS: SYNCHRONIZED
FACT: INCIDENT_ID=MULTI-DEVICE-AI-CONCURRENCY-LATENCY-2026-10-01
FACT: OBSERVATION_DATE=2026-10-01
FACT: EVIDENCE_LEVEL=USER_FIELD_OBSERVATION
FACT: ROOT_CAUSE_CONFIRMED=false
FACT: IMPLEMENTATION_STATUS=NOT_IMPLEMENTED
FACT: CITY_PLAN_STATUS=NOT_COMMITTED
FACT: PRETREATMENT_CLASS=OBSERVABILITY_AND_BACKPRESSURE
FACT: MULTI_DEVICE_PARALLEL_INPUT_EXPECTED=true

## Evidence summary

The user reported a real multi-device field observation: perceived response speed decreases when different devices issue requests concurrently to the same AI service/logical assistant.

The evidence currently establishes only a field symptom worth testing. It does not establish the provider's internal backend scheduling behavior, and in particular it does not justify a claim that devices on one account compete for a single compute worker. Missing evidence includes:

- per-request Utopia queue wait;
- provider TTFT and provider total time;
- local executor wait/run time;
- provider throttling or concurrency rejection reasons;
- controlled same-device serial vs cross-device concurrent samples.

The machine-readable incident summary is stored at
`evidence/raw/multi-device-ai-concurrency-2026-10-01/incident-summary.json`.

## Direct risk to Utopia

If multiple embodiments can directly push work to external AI or local executors without unified admission:

1. normal provider queueing may be misclassified as failure;
2. timeout-driven duplicate submission can create retry storms;
3. the same action may execute from multiple devices;
4. writes to the same resource may race;
5. low-priority heavy work may crowd out interactive work;
6. the user sees only “slow” and cannot tell whether the wait is inside Utopia, the local host, or the provider.

## Learned design rules

Candidate pre-treatment directions:

- admission control / queue / backpressure;
- per-provider / per-channel concurrency budgets;
- action identity + idempotency + execution lease;
- bounded retry + backoff, with no unbounded request cloning;
- separate queue wait, local execution, provider TTFT, and provider total time;
- expose typed waiting states to the user;
- provider/API/device switching remains subject to existing user-confirmation policy.

These are **design lessons, not implemented capabilities**. Default concurrency thresholds, priority algorithms, and exact module boundaries remain open for later design and experiment.

## Testable hypothesis

Future Utopia telemetry can test:

> Explicit admission/backpressure should reduce duplicate execution, retry count, and tail latency under multi-device concurrency, while separating “Utopia is slow” from “the provider is slow.”

This record intentionally preserves uncertainty rather than presenting user-perceived latency as verified provider behavior.
