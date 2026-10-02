// Single-execution assignment guard (RS-202, covering the gate's idempotency requirement).
//
// The workbook's completion gate requires that anti-flap AND single-execution/idempotency be PROVABLE,
// and its review list names "重复调度" and "双执行" as attacks. The audit found the VOCABULARY for this
// already exists - presence's PENDING_STATES carries CONFIRMED_SUCCEEDED/CONFIRMED_FAILED and
// fleet-routing carries ASSIGNMENT_STATES_TRANSFERABLE_ON_DROPOUT - but no guard used them, so nothing
// actually prevented two devices from picking up the same subject.
//
// The guarantee here is deliberately narrow and structural: for a given subject, at most ONE device
// holds an active claim, and a repeated claim from the SAME device with the SAME idempotency key is
// IDEMPOTENT rather than a second execution. That is the difference between a retry and a double run.
export const ASSIGNMENT_CONTRACT_VERSION = 1;

export const CLAIM_OUTCOMES = Object.freeze(['CLAIMED', 'IDEMPOTENT', 'ALREADY_CLAIMED', 'TRANSFERRED', 'RELEASED', 'REFUSED']);

export function createAssignmentGuard({ now = () => Date.now() } = {}) {
  /** subjectRef -> { deviceRef, idempotency_key, at, epoch } */
  const claims = new Map();
  const counters = { claims: 0, idempotent: 0, refused: 0, transferred: 0, released: 0 };

  function claim({ subjectRef, deviceRef, idempotencyKey = null } = {}) {
    counters.claims += 1;
    const existing = claims.get(subjectRef) ?? null;

    if (existing) {
      // The SAME device retrying the SAME operation is a retry, not a second execution. Answering with
      // the ORIGINAL claim rather than a fresh one is what makes the operation idempotent.
      const sameDevice = existing.deviceRef === deviceRef;
      const sameKey = idempotencyKey !== null && existing.idempotency_key === idempotencyKey;
      if (sameDevice && sameKey) {
        counters.idempotent += 1;
        return Object.freeze({
          assignment_version: ASSIGNMENT_CONTRACT_VERSION, outcome: 'IDEMPOTENT', idempotent: true,
          double_execution: false, subject_ref: subjectRef, device_ref: existing.deviceRef,
          claimed_at_ms: existing.at, epoch: existing.epoch,
        });
      }
      // Anything else is a genuine second claim on a live subject, and it is refused. This is the
      // double-execution case, and refusing it is the whole point of the guard.
      counters.refused += 1;
      return Object.freeze({
        assignment_version: ASSIGNMENT_CONTRACT_VERSION, outcome: 'ALREADY_CLAIMED', idempotent: false,
        double_execution: false, subject_ref: subjectRef, device_ref: deviceRef,
        held_by: existing.deviceRef, detail: `${subjectRef} is already held by ${existing.deviceRef}`,
      });
    }

    const record = Object.freeze({ deviceRef, idempotency_key: idempotencyKey, at: now(), epoch: 1 });
    claims.set(subjectRef, record);
    return Object.freeze({
      assignment_version: ASSIGNMENT_CONTRACT_VERSION, outcome: 'CLAIMED', idempotent: false,
      double_execution: false, subject_ref: subjectRef, device_ref: deviceRef,
      claimed_at_ms: record.at, epoch: record.epoch,
    });
  }

  /**
   * Move a claim to another device. Only the CURRENT holder may hand it on, so a stale or invented
   * transfer cannot steal a live claim - the device-dropout path in the workbook depends on exactly
   * this, and the epoch is bumped so the previous holder's late retry is no longer idempotent.
   */
  function transfer({ subjectRef, fromDeviceRef, toDeviceRef } = {}) {
    const existing = claims.get(subjectRef) ?? null;
    if (!existing || existing.deviceRef !== fromDeviceRef) {
      counters.refused += 1;
      return Object.freeze({
        assignment_version: ASSIGNMENT_CONTRACT_VERSION, outcome: 'REFUSED', transferred: false,
        subject_ref: subjectRef, detail: existing ? `${subjectRef} is held by ${existing.deviceRef}, not ${String(fromDeviceRef)}` : `${subjectRef} is not claimed`,
      });
    }
    const record = Object.freeze({ deviceRef: toDeviceRef, idempotency_key: existing.idempotency_key, at: now(), epoch: existing.epoch + 1 });
    claims.set(subjectRef, record);
    counters.transferred += 1;
    return Object.freeze({
      assignment_version: ASSIGNMENT_CONTRACT_VERSION, outcome: 'TRANSFERRED', transferred: true,
      subject_ref: subjectRef, device_ref: toDeviceRef, from_device_ref: fromDeviceRef, epoch: record.epoch,
    });
  }

  /** Release by the current holder only, so a stale holder cannot free work someone else is running. */
  function release({ subjectRef, deviceRef } = {}) {
    const existing = claims.get(subjectRef) ?? null;
    if (!existing || existing.deviceRef !== deviceRef) {
      counters.refused += 1;
      return Object.freeze({ assignment_version: ASSIGNMENT_CONTRACT_VERSION, outcome: 'REFUSED', released: false, subject_ref: subjectRef, detail: 'only the current holder may release' });
    }
    claims.delete(subjectRef);
    counters.released += 1;
    return Object.freeze({ assignment_version: ASSIGNMENT_CONTRACT_VERSION, outcome: 'RELEASED', released: true, subject_ref: subjectRef, device_ref: deviceRef });
  }

  return Object.freeze({
    claim, transfer, release,
    holder: subjectRef => claims.get(subjectRef)?.deviceRef ?? null,
    epoch: subjectRef => claims.get(subjectRef)?.epoch ?? null,
    active: () => claims.size,
    stats: () => Object.freeze({ ...counters }),
  });
}
