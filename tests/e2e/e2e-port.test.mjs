import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, describe, test } from "node:test";
import { transformSync } from "esbuild";

// The helper is .ts like its sibling e2e-db-port.ts, but package engines allow
// Node >=20 and type-stripping only exists on 22.18+/24 — so transpile it with
// esbuild (a repo devDependency, the same transform Playwright applies) and
// import the plain-JS result. Keeps this file runnable via plain `node --test`.
const source = readFileSync(new URL("./e2e-port.ts", import.meta.url), "utf8");
const { code } = transformSync(source, { loader: "ts", format: "esm" });
const { RESERVED_E2E_SERVER_PORTS, resolveE2eServerPort, assertSafeE2eBaseUrl } =
  await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);

const saved = {
  PAPERCLIP_E2E_PORT: process.env.PAPERCLIP_E2E_PORT,
  PAPERCLIP_E2E_ALLOW_LIVE_TARGET: process.env.PAPERCLIP_E2E_ALLOW_LIVE_TARGET,
};
afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
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

describe("assertSafeE2eBaseUrl", () => {
  const noOptIn = () => delete process.env.PAPERCLIP_E2E_ALLOW_LIVE_TARGET;

  test("accepts loopback URLs on free ports and returns them verbatim", () => {
    noOptIn();
    for (const ok of [
      "http://127.0.0.1:3399",
      "http://localhost:3451/",
      "http://[::1]:4400",
      "http://127.0.0.1",
    ]) {
      assert.equal(assertSafeE2eBaseUrl(ok), ok);
    }
  });

  for (const reserved of RESERVED_E2E_SERVER_PORTS) {
    test(`refuses http://127.0.0.1:${reserved}`, () => {
      noOptIn();
      assert.throws(
        () => assertSafeE2eBaseUrl(`http://127.0.0.1:${reserved}`),
        (err) =>
          err instanceof Error &&
          err.message.includes(`port ${reserved}`) &&
          err.message.includes("live local instance"),
      );
    });
  }

  test("refuses non-loopback hosts, even on free ports", () => {
    noOptIn();
    for (const bad of [
      "http://192.168.1.10:4000",
      "https://staging.example.com:4400",
      "http://100.64.0.14:3399",
    ]) {
      assert.throws(
        () => assertSafeE2eBaseUrl(bad),
        (err) => err instanceof Error && err.message.includes("not loopback"),
      );
    }
  });

  test("reports both reasons when a non-loopback host also uses a reserved port", () => {
    noOptIn();
    assert.throws(
      () => assertSafeE2eBaseUrl("http://10.0.0.5:3199"),
      /not loopback and port 3199 belongs to a live local instance/,
    );
  });

  test("PAPERCLIP_E2E_ALLOW_LIVE_TARGET=1 is the explicit opt-in", () => {
    process.env.PAPERCLIP_E2E_ALLOW_LIVE_TARGET = "1";
    assert.equal(
      assertSafeE2eBaseUrl("https://staging.example.com:3199"),
      "https://staging.example.com:3199",
    );
  });

  test("the opt-in is exact — other values do not bypass", () => {
    process.env.PAPERCLIP_E2E_ALLOW_LIVE_TARGET = "yes";
    assert.throws(() => assertSafeE2eBaseUrl("http://127.0.0.1:3300"), /live local instance/);
  });

  test("rejects URLs that do not parse", () => {
    noOptIn();
    assert.throws(() => assertSafeE2eBaseUrl("not a url"), /Invalid e2e base URL/);
    assert.throws(() => assertSafeE2eBaseUrl(""), /Invalid e2e base URL/);
  });
});
