// Why does REPLAY refuse? Reproduce it with the control surface actually held open, and print the FULL detail.
import {readFileSync} from 'node:fs';
import WebSocket from 'ws';
const CITY = 'http://172.31.12.151:4310';
const cfg = JSON.parse(readFileSync('C:/ProgramData/Utopia/host/city/local-config.json', 'utf8'));
const H = {'X-City-Api-Version': '0', 'X-City-Schema-Version': '0', Authorization: 'Bearer ' + cfg.token, 'Content-Type': 'application/json'};
const ask = async (p, body) => { const r = await fetch(CITY + '/api/v0/' + p, {method: body ? 'POST' : 'GET', headers: H, body: body ? JSON.stringify(body) : undefined}); const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {} return {status: r.status, body: j, text: t}; };

const socket = new WebSocket(CITY.replace('http', 'ws') + '/api/v0/events/stream?apiVersion=0&schemaVersion=0&clientRef=rex890-dev-surface&clientLabel=REX-890%20development%20surface', ['city-token.' + Buffer.from(cfg.token).toString('base64url')]);
await new Promise((yes, no) => { socket.on('open', yes); socket.on('error', no); });
console.log('surface open');
await new Promise(r => setTimeout(r, 1500));

const list = (await ask('research/campaigns')).body;
const id = list.receipts[0].campaignId;
const detail = (await ask('research/campaigns/' + id)).body;
console.log('campaign', id, detail.campaign.state, 'runs', detail.campaign.runs.length);
for (const probe of [
  {sourceCampaignId: id, sourceRunIndex: 0, mode: 'REPLAY'},
  {sourceCampaignId: id, sourceRunIndex: 0, mode: 'REPLAY', disabledMechanisms: []},
  {sourceCampaignId: id, sourceRunIndex: 0, mode: 'ABLATION', disabledMechanisms: ['alternate-device']},
]) {
  const r = await ask('research/replays', probe);
  console.log(JSON.stringify(probe), '->', r.status, r.text.slice(0, 400));
}
console.log('--- what the replay route says it accepts ---');
console.log(JSON.stringify((await ask('research/replays')).body).slice(0, 900));
socket.close();
