/**
 * Which task types need something the NODE must implement, and which capability a node advertises for it.
 *
 * This is its own module because both sides of the same rule need it and neither may import the other: the gateway
 * decides whether a target is eligible at dispatch time, and the execution backend decides whether a node may claim a
 * queued task. Those are two different moments in the same decision, and splitting the vocabulary across them is how
 * they drift apart.
 *
 * The rule exists because of a measured failure, not a worry. On the first real deployment, an owner remote operation
 * was handed to a machine running an older agent; that agent fell through to its legacy path and reported a
 * truthful-looking `{bytes, operation}` receipt for a question it had never been asked. The City REJECTED it
 * (RECEIPT_OPERATION_MISMATCH), which is the contract doing its job - but the Owner should never have been able to
 * send it, and "the target was eligible" was the lie that let it happen.
 *
 * A node that does not advertise the capability is not broken and is not penalised: it is simply not offered the task,
 * and the refusal names the missing capability rather than silently queueing forever.
 */
export const NODE_TASK_CAPABILITIES = Object.freeze({
  // The node half of the owner remote operation: spawn with shell:false, bounded output, timeout, cancellation.
  OWNER_REMOTE_OPERATION: 'city.remote-operation.v1',
  // The node half of the agent-job channel: an agent that can read a request and send back a report. A reference node
  // that only knows the mechanical task types must never be handed one, for the same measured reason as above.
  AGENT_JOB: 'city.agent-job.v1',
});

/** Does this node implement what this task type needs? A task type with no node-side requirement needs nothing. */
export function nodeSupportsTask(task, node) {
  const needed = NODE_TASK_CAPABILITIES[task?.type];
  if (!needed) return true;
  return Array.isArray(node?.capabilities) && node.capabilities.includes(needed);
}

/** The capabilities a task of this type requires of a node, appended to the fleet-wide baseline. */
export function requiredCapabilitiesForTask(type, baseline = []) {
  const needed = NODE_TASK_CAPABILITIES[type];
  return needed ? [...baseline, needed] : [...baseline];
}
