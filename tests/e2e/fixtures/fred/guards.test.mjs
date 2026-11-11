import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
const fixture=fileURLToPath(new URL("./claude.mjs",import.meta.url));
const fence=fileURLToPath(new URL("./network-fence.mjs",import.meta.url));
test("the fake agent refuses an ordinary non-fixture launch before tools can run",()=>{
 const result=spawnSync(process.execPath,[fixture],{env:{PATH:process.env.PATH},encoding:"utf8",timeout:5000,input:""});
 assert.notEqual(result.status,0);assert.equal(result.stdout,"");
 assert.match(result.stderr,/AssertionError/);
});
test("the inherited Node fence rejects external fetch and TCP before network access",()=>{
 const code='import assert from "node:assert/strict";import net from "node:net";assert.throws(()=>fetch("https://example.invalid/"),/forbids external fetch/);assert.throws(()=>net.connect({host:"example.invalid",port:443}),/forbids non-loopback/);console.log("external operations refused");';
 const result=spawnSync(process.execPath,["--import",fence,"--input-type=module","--eval",code],{env:{PATH:process.env.PATH},encoding:"utf8",timeout:5000});
 assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/external operations refused/);
});

test("storage guard preserves reserve and bounds explicitly authorized reuse growth",async()=>{
 const {assertFixtureStorage}=await import("./storage-guard.mjs");
 const GiB=1024**3;
 assert.doesNotThrow(()=>assertFixtureStorage({initialFreeBytes:30.2*GiB,freeBytes:30.17*GiB,reused:true}));
 assert.throws(()=>assertFixtureStorage({initialFreeBytes:30.2*GiB,freeBytes:30.01*GiB,reused:true}),/reserve/);
 assert.throws(()=>assertFixtureStorage({initialFreeBytes:30.2*GiB,freeBytes:30.14*GiB,reused:true}),/50 MiB/);
 assert.doesNotThrow(()=>assertFixtureStorage({initialFreeBytes:30.4*GiB,freeBytes:30.2*GiB,reused:false}));
});
