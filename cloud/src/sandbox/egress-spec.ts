// AgentDash: typed egress spec for the per-company sandbox (spike R3).
//
// The schema is the contract shared by the control plane, the image
// (egress.spec.json) and the evidence record — the allow-list is part of the
// spec and is reported in run evidence, so it must be a typed value, not a
// rendered string.
//
// Rendering has exactly one implementation: cloud/sandbox/render-egress.mjs,
// which also ships inside the image (the image cannot import this package).
// renderEgressRuleset() therefore shells out to that file rather than
// re-implementing it — every test of this module exercises the artifact the
// sandbox actually loads.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const HOST_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i;
const IPV4_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const CIDR4_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\/\d{1,2}$/;
const IDENT_RE = /^[a-z_][a-z0-9_-]*$/;

export const egressAllowRuleSchema = z
  .object({
    hosts: z.array(z.string().regex(HOST_RE)).optional(),
    cidrs: z.array(z.string().regex(CIDR4_RE)).optional(),
    ports: z.array(z.number().int().min(1).max(65535)).min(1),
    proto: z.enum(["tcp", "udp"]).default("tcp"),
    /**
     * A host that may legitimately not resolve yet (e.g. a sink endpoint
     * pending a mint service). Rendered as a comment, not a rule — the
     * omission is visible in the rendered ruleset and in evidence.
     */
    optional: z.boolean().default(false),
  })
  .strict()
  .refine((r) => (r.hosts?.length ?? 0) + (r.cidrs?.length ?? 0) > 0, {
    message: "allow rule needs hosts or cidrs",
  });

export const egressIdentitySchema = z
  .object({
    user: z.string().regex(IDENT_RE),
    dns: z.boolean().default(true),
    allow: z.array(egressAllowRuleSchema).default([]),
  })
  .strict();

export const egressSpecSchema = z
  .object({
    version: z.literal(1),
    table: z
      .string()
      .regex(/^[a-z_][a-z0-9_]*$/)
      .default("sandbox_egress"),
    dnsServers: z.array(z.string().regex(IPV4_RE)).default([]),
    identities: z.record(z.string().regex(IDENT_RE), egressIdentitySchema),
  })
  .strict();

export type EgressAllowRule = z.infer<typeof egressAllowRuleSchema>;
export type EgressIdentity = z.infer<typeof egressIdentitySchema>;
export type EgressSpec = z.infer<typeof egressSpecSchema>;

/** Spec plus the apply-time resolution results the renderer needs. */
export interface ResolvedEgressSpec extends EgressSpec {
  resolved: {
    /** identity name -> numeric uid (from `id -u` at apply time) */
    uids: Record<string, number>;
    /** allow-listed hostname -> resolved IPv4 addresses */
    hosts: Record<string, string[]>;
  };
}

const RENDERER = fileURLToPath(new URL("../../sandbox/render-egress.mjs", import.meta.url));

/**
 * Render the nftables ruleset for a resolved spec. Runs the in-image renderer
 * so the control plane and the sandbox can never drift on rule text.
 * Throws (non-zero exit) on any input the schema missed — the renderer
 * re-validates as defence in depth.
 */
export function renderEgressRuleset(spec: ResolvedEgressSpec): string {
  return execFileSync(process.execPath, [RENDERER], {
    input: JSON.stringify(spec),
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
}

/** sha256 of the canonical spec — what run evidence reports (R8). */
export function egressSpecDigest(spec: EgressSpec): string {
  // `resolved` is apply-time data, not part of the allow-list contract.
  const { resolved: _resolved, ...base } = spec as EgressSpec & { resolved?: unknown };
  const canonical = JSON.stringify(egressSpecSchema.parse(base));
  return createHash("sha256").update(canonical).digest("hex");
}
