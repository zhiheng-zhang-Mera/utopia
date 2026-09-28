export const apiVersion = 0;
export const schemaVersion = 0;
export const taskTypes = ['WAIT','CREATE_TEMP_ARTIFACT','HASH_TEMP_ARTIFACT','DELETE_TEMP_ARTIFACT','CHECKPOINT_DEMO'];
export const terminal = ['COMPLETED','FAILED','CANCELLED'];
export const envelope = data => ({apiVersion,schemaVersion,...data});
export function validateCommand(body) {
  if (!body || !taskTypes.includes(body.type) || Object.keys(body).some(k=>k!=='type')) throw Object.assign(new Error('Choose a supported safe task type; parameters are not accepted.'),{status:400});
}
