import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeBleLocator, encodeBleAdvertisement, startBle } from '../platform/windows/ble.mjs';
test('Windows manufacturer payload prefixes locator with canonical UUID bytes',()=>{
 assert.equal(encodeBleAdvertisement('192.168.1.5',4310).toString('hex'),'6f9a00016c534b92a31975746f70696101c0a8010510d6');
});
test('BLE locator contains exactly version IPv4 and big-endian port',()=>{
 assert.deepEqual([...encodeBleLocator('192.168.1.5',4310)],[1,192,168,1,5,16,214]);
 for(const host of ['localhost','0.0.0.0','999.1.1.1','::1'])assert.throws(()=>encodeBleLocator(host,4310));
 assert.throws(()=>encodeBleLocator('192.168.1.5',65536));
});
test('non-Windows adapter reports software platform error rather than hardware evidence',async()=>{
 const states=[];const adapter=await startBle({host:'192.168.1.5',port:4310,platform:'linux',onStatus:s=>states.push(s)});
 assert.equal(states[0].state,'ERROR');await adapter.close();
});
