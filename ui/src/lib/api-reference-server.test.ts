import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import {
  INSTANCE_URL_PLACEHOLDER,
  PUBLIC_SITE_HOSTS,
  referenceInstanceUrl,
  referenceOperationSlug,
  referenceServers,
} from "./api-reference-server";

const REPO_ROOT = [process.cwd(), path.join(process.cwd(), "..")].find((candidate) =>
  existsSync(path.join(candidate, "docs", "docs.json")),
)!;

describe("API reference: which instance 'try it' points at", () => {
  it("on an instance, prefills the instance's address (publicBaseUrl, else the origin)", () => {
    expect(referenceInstanceUrl("acme.example.com", "https://acme.example.com/")).toBe("https://acme.example.com");
    expect(referenceInstanceUrl("localhost", "http://localhost:3100")).toBe("http://localhost:3100");
    const servers = referenceServers("https://acme.example.com");
    expect(servers).toEqual([
      expect.objectContaining({ url: "{instanceUrl}", variables: { instanceUrl: expect.objectContaining({ default: "https://acme.example.com" }) } }),
    ]);
  });

  it("on the public site, prefills nothing and asks for the reader's instance", () => {
    for (const host of PUBLIC_SITE_HOSTS) {
      expect(referenceInstanceUrl(host, "https://some-other-box.example")).toBeNull();
      expect(referenceInstanceUrl(host.toUpperCase(), `https://${host}`)).toBeNull();
    }
    const [server] = referenceServers(null);
    expect(server!.variables.instanceUrl.default).toBe(INSTANCE_URL_PLACEHOLDER);
    expect(server!.description).toMatch(/Enter its address/);
  });

  it("matches the server the committed OpenAPI document declares", () => {
    const yaml = readFileSync(path.join(REPO_ROOT, "docs", "api", "openapi.yaml"), "utf8");
    expect(yaml).toContain('url: "{instanceUrl}"');
    expect(yaml).toContain(`default: ${INSTANCE_URL_PLACEHOLDER}`);
  });
});

describe("API reference: operation anchors", () => {
  it("anchors an operation by its contract operationId, so the resource pages can link to it", () => {
    expect(referenceOperationSlug({ operationId: "getCompany", method: "get", path: "/api/companies/{companyId}" })).toBe("getCompany");
  });

  it("falls back to Scalar's own METHOD+path form when there is no operationId", () => {
    expect(referenceOperationSlug({ method: "post", path: "/api/x" })).toBe("POST/api/x");
  });

  it("every contract route has an operationId, so no contract anchor uses the fallback", () => {
    const contract = JSON.parse(readFileSync(path.join(REPO_ROOT, "docs", "api", "contract.json"), "utf8")) as {
      routes: Array<{ operationId?: string }>;
    };
    for (const route of contract.routes) expect(route.operationId).toMatch(/^[a-zA-Z][a-zA-Z0-9]*$/);
  });
});
