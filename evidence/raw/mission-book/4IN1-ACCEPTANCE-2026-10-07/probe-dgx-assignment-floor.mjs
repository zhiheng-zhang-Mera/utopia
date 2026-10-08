// Independent probe: is the ENGINEERING review independence floor keyed on a caller-declared role STRING?
// If it is, the same review task with a different (or misspelled) role loses the floor - the domain profile's own
// `required_reviewer_roles` is never consulted.
import {assignParticipant} from 'file:///D:/utopia-4in1-verify/contracts/deliberative-governance-v2/assignment.mjs';
import {DOMAIN_PROFILES} from 'file:///D:/utopia-4in1-verify/contracts/deliberative-governance-v2/profiles.mjs';

const author = {participant_ref: 'p-author', agent_ref: 'agent-a', session_ref: 'sess-a', physical_host_ref: 'HOST-MECH', environment_ref: 'env-a', toolchain_ref: 'tc-a', conflict_of_interest: false, authored_node_refs: ['node-1']};
const sameHostReviewer = {...author, participant_ref: 'p-reviewer-same-host', agent_ref: 'agent-b', session_ref: 'sess-b', authored_node_refs: []};
const candidates = [{participant_ref: 'p-reviewer-same-host', facts_ref: 'facts:r', ready: true, roles: ['DOMAIN_REVIEW', 'REVIEW'], capabilities: ['review.evidence.read'], ...sameHostReviewer}];
const base = {task_ref: 'task:1', problem_node_ref: 'node-1', domain: 'ENGINEERING', required_capabilities: ['review.evidence.read'], independence_floor: {}, origin: author};

console.log('profile required_reviewer_roles for ENGINEERING =', JSON.stringify(DOMAIN_PROFILES.ENGINEERING.required_reviewer_roles));
for (const role of ['DOMAIN_REVIEW', 'REVIEW', 'DOMAIN_REVIEEW', 'CONTRIBUTOR']) {
  const out = assignParticipant({...base, role}, structuredClone(candidates));
  const rejected = out.rejected_or_unavailable_reason.find(r => r.participant_ref === 'p-reviewer-same-host');
  console.log(`role=${role.padEnd(16)} selected=${String(out.selected_participant).padEnd(22)} floor.host_independence=${String(out.required_independence_profile.host_independence).padEnd(5)} reason=${rejected?.reason ?? 'NONE'}`);
}
