/**
 * UTOPIA · Rooms · Skill Discovery Lab — bridge to the Wave 1 city core.
 *
 * The SKILL.md format and the tar reader already live in the promoted city module
 * `city/02-engineering/02-worker-gateway/skill-intake`. This lab must never carry
 * a second copy of either, so it imports them from there and re-exports the small
 * surface it needs.
 */

import { parseSkillText, renderSkillDocument } from '../../../../city/02-engineering/02-worker-gateway/skill-intake/format.mjs';

export { parseSkillText, renderSkillDocument };

export default { parseSkillText, renderSkillDocument };
