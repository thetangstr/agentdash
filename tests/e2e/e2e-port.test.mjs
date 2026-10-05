import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { RESERVED_E2E_SERVER_PORTS, resolveE2eServerPort } from "./e2e-port.ts";

// Node 24 type-strips the .ts import natively — no build step needed for
// these node:test cases, which CI runs via `pnpm run test:launch-signoff`.

const saved = process.env.PAPERCLIP_E2E_PORT;
afterEach(() => {
  if (saved === undefined) delete process.env.PAPERCLIP_E2E_PORT;
  else process.env.PAPERCLIP_E2E_PORT = saved;
});

describe("resolveE2eServerPort", () => {
  test("returns the caller's default when PAPERCLIP_E2E_PORT is unset", () => {
    delete process.env.PAPERCLIP_E2E_PORT;
    assert.equal(resolveE2eServerPort(3399), 3399);
    assert.equal(resolveE2eServerPort(3451), 3451);
  });

  test("returns an explicit PAPERCLIP_E2E_PORT when set", () => {
    process.env.PAPERCLIP_E2E_PORT = "3401";
    assert.equal(resolveE2eServerPort(3399), 3401);
  });

  for (const reserved of RESERVED_E2E_SERVER_PORTS) {
    test(`refuses explicit PAPERCLIP_E2E_PORT=${reserved} with a clear error`, () => {
      process.env.PAPERCLIP_E2E_PORT = String(reserved);
      assert.throws(
        () => resolveE2eServerPort(3399),
        (err) =>
          err instanceof Error &&
          err.message.includes(`port ${reserved}`) &&
          err.message.includes("live local instance") &&
          err.message.includes("PAPERCLIP_E2E_PORT"),
      );
    });

    test(`refuses a hardcoded default of ${reserved}`, () => {
      delete process.env.PAPERCLIP_E2E_PORT;
      assert.throws(() => resolveE2eServerPort(reserved), /live local instance/);
    });
  }

  test("rejects an explicit port below 1024 or above 65535", () => {
    for (const bad of ["80", "65536", "99999"]) {
      process.env.PAPERCLIP_E2E_PORT = bad;
      assert.throws(
        () => resolveE2eServerPort(3399),
        (err) => err instanceof Error && err.message.includes("Invalid e2e server port"),
      );
    }
  });

  test("non-numeric or non-positive env falls back to the caller's default", () => {
    for (const bad of ["", "abc", "0", "-5"]) {
      process.env.PAPERCLIP_E2E_PORT = bad;
      assert.equal(resolveE2eServerPort(3399), 3399);
    }
  });

  test("rejects a caller default outside the valid range", () => {
    delete process.env.PAPERCLIP_E2E_PORT;
    assert.throws(() => resolveE2eServerPort(80), /Invalid e2e server port 80/);
  });
});
