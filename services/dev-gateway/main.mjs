import { createGateway } from './server.mjs';
const app=await createGateway({host:process.env.CITY_HOST||'127.0.0.1',port:Number(process.env.CITY_PORT||4310),dir:process.env.CITY_DATA||'.runtime',token:process.env.CITY_TOKEN,nodeToken:process.env.CITY_NODE_TOKEN,discoveryEnabled:process.env.CITY_DISCOVERY_DISABLED!=='1'});
console.log('Utopia Gateway '+app.url);
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{await app.close();process.exit(0);});
