import assert from "node:assert/strict";

// Stop our own synthetic fixture before approaching the protected storage reserve.
export function assertFixtureStorage({initialFreeBytes,freeBytes,reused}) {
  assert.ok(freeBytes>30.02*1024**3,"Fixture storage reserve approached; stop owned fixture");
  if(reused)assert.ok(initialFreeBytes-freeBytes<50*1024**2,"Owned cluster reuse exceeded its 50 MiB growth allowance");
}
