import { startAgent } from './agent.mjs';
const agent=await startAgent({url:process.env.CITY_URL||'http://127.0.0.1:4310',token:process.env.CITY_NODE_TOKEN,workspace:process.env.CITY_WORKSPACE||'.runtime/workspace'});
console.log('City Node Reference Agent started');
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{await agent.stop();process.exit(0);});
