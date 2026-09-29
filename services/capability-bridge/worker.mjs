import {parentPort,workerData} from 'node:worker_threads';
import {invokeAdapter} from './adapters.mjs';
try{parentPort.postMessage({result:await invokeAdapter(workerData.capabilityId,workerData.operationId,workerData.input)});}
catch(error){parentPort.postMessage({errorCode:typeof error.code==='string'&&/^[A-Z][A-Z0-9_]{1,60}$/.test(error.code)?error.code:'INVALID_INPUT'});}
