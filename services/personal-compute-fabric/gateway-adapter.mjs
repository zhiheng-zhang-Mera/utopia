import {resolve} from 'node:path';
import {createFabricService} from './service.mjs';
// The existing control bearer authenticates the owner. This adapter adds no credentials.
export function validateGatewayFabricConfig(pcf,deviceId){
 if(pcf?.enabled!==true)return;
 if(pcf.approvedLocalContext?.deviceId!==deviceId)throw new Error('PCF_LOCAL_APPROVAL_REQUIRED');
}
export function createGatewayFabric({pcf,store,dir,deviceId}){
 if(pcf?.enabled!==true)return null;
 validateGatewayFabricConfig(pcf,deviceId);
 const context=Object.freeze({sessionId:'owner:'+store.cityId,deviceId});
 let active=true;
 const service=createFabricService({store,artifactRoot:resolve(dir,'pcf-artifacts'),deviceId,readAuthority:async caller=>({version:1,authorized:active&&caller.sessionId===context.sessionId&&caller.deviceId===deviceId,expiresAt:Date.now()+60000,originDeviceId:deviceId,allowedDevices:[deviceId],dataScopes:['PUBLIC'],sharingConsent:false,cloudConsent:false,budget:0})});
 return {service,context,async close(){await service.stop();active=false;}};
}
