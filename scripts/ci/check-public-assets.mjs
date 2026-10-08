#!/usr/bin/env node
// AgentDash: scan every shipped file, not only docs or visible DOM. A report
// names files and counts only; it must never echo private source or matches.
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { fileURLToPath } from "node:url";
import { forbiddenTokenOffsets, FORBIDDEN_TOKENS, sha256 } from "../docs/forbidden-tokens.mjs";

// Reviewed compatibility exceptions, not a token allowlist. The value must
// occur in this exact existing executable-code context and chunk family.
// Docs/prose still use the unmodified deny policy. Do not widen these to a
// whole identifier, file or dependency; new contexts require review.
const MAIN_CHUNK = /^assets\/index-[\w-]+\.js$/;
export const PUBLIC_ASSET_CODE_CONTEXTS = [
  { context: "profile-enum", syntax: "array", file: MAIN_CHUNK, token: FORBIDDEN_TOKENS[2], before: /\["default","$/, after: /^"\]/ },
  { context: "profile-onboarding-field", syntax: "property:productProfile", file: MAIN_CHUNK, token: FORBIDDEN_TOKENS[2], before: /productProfile:"$/, after: /^",/ },
  { context: "issue-origin-schema", syntax: "call:originKind", file: MAIN_CHUNK, token: FORBIDDEN_TOKENS[11], before: /originKind:[\w$]+\("$/, after: /^_request"\)\.optional\(\)/ },
  { context: "issue-origin-comparison", syntax: "binary:originKind", file: MAIN_CHUNK, token: FORBIDDEN_TOKENS[11], before: /\.originKind[!=]=="$/, after: /^_request"&&/ },
  { context: "issue-origin-id-validation", syntax: "property:message", file: MAIN_CHUNK, token: FORBIDDEN_TOKENS[11], before: /message:"originId is required when originKind is $/, after: /^_request",path:\["originId"\]/ },
  { context: "issue-origin-kind-validation", syntax: "property:message", file: MAIN_CHUNK, token: FORBIDDEN_TOKENS[11], before: /message:"originKind must be $/, after: /^_request when originId is provided",path:\["originKind"\]/ },
  { context: "scalar-matlab-keyword", syntax: "property:built_in", file: /^assets\/ApiReference-[\w-]+\.js$/, token: FORBIDDEN_TOKENS[13], before: /hilb invhilb magic pascal $/, after: /^er toeplitz vander wilkinson / },
];

// The repo already depends on TypeScript. Parse executable JS rather than
// allowing a code-shaped fragment embedded in a template string or comment.
function literalContexts(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (source.parseDiagnostics.length) return [];
  const literals = [];
  function visit(node) {
    if (ts.isStringLiteral(node)) {
      const parent = node.parent;
      let syntax = null;
      if (ts.isArrayLiteralExpression(parent)) syntax = "array";
      if (ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) syntax = `property:${parent.name.text}`;
      if (ts.isBinaryExpression(parent) && ts.isPropertyAccessExpression(parent.left)) syntax = `binary:${parent.left.name.text}`;
      if (ts.isCallExpression(parent)) {
        let ancestor = parent.parent;
        while (ancestor && !ts.isPropertyAssignment(ancestor) && !ts.isStatement(ancestor)) ancestor = ancestor.parent;
        if (ancestor && ts.isPropertyAssignment(ancestor) && ts.isIdentifier(ancestor.name)) syntax = `call:${ancestor.name.text}`;
      }
      if (syntax) literals.push({ start: node.getStart(source), end: node.end, syntax });
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return literals;
}

export function scanPublicAssets(directory, tokens = FORBIDDEN_TOKENS, contexts = PUBLIC_ASSET_CODE_CONTEXTS) {
  let scanned = 0;
  const findings = [];
  const classified = [];
  function visit(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file);
      else {
        scanned += 1;
        const rel = path.relative(directory, file).split(path.sep).join("/");
        const text = readFileSync(file, "utf8");
        let count = 0;
        const offsets = forbiddenTokenOffsets(text, tokens);
        const literals = offsets.length && contexts.some((rule) => rule.file.test(rel)) ? literalContexts(rel, text) : [];
        for (const offset of offsets) {
          const accepted = contexts.find((rule) => rule.file.test(rel)
            && literals.some((literal) => literal.start < offset && literal.end > offset && literal.syntax === rule.syntax)
            && sha256(text.slice(offset, offset + rule.token.length).toLowerCase()) === rule.token.sha256
            && rule.before.test(text.slice(Math.max(0, offset - 200), offset))
            && rule.after.test(text.slice(offset + rule.token.length, offset + rule.token.length + 200)));
          if (accepted) {
            const previous = classified.find((entry) => entry.file === rel && entry.context === accepted.context);
            if (previous) previous.count += 1;
            else classified.push({ file: rel, context: accepted.context, count: 1 });
          } else count += 1;
        }
        if (count) findings.push({ file: rel, count });
      }
    }
  }
  visit(directory);
  if (!scanned) throw new Error("Public asset output is empty");
  return { scanned, findings, classified };
}

function realOrResolved(file) {
  try { return realpathSync(file); } catch { return path.resolve(file); }
}

if (process.argv[1] && realOrResolved(process.argv[1]) === realOrResolved(fileURLToPath(import.meta.url))) {
  const directory = path.resolve(process.argv[2] ?? "ui/dist");
  const { scanned, findings, classified } = scanPublicAssets(directory);
  for (const entry of classified) console.log(`${entry.file}: ${entry.count} classified (${entry.context})`);
  if (findings.length) {
    for (const finding of findings) console.error(`${finding.file}: ${finding.count} forbidden-token occurrence(s)`);
    process.exitCode = 1;
  } else {
    const classifiedCount = classified.reduce((sum, entry) => sum + entry.count, 0);
    console.log(`Public assets content scan: ${scanned} files, 0 unexplained matches, ${classifiedCount} classified code-context matches.`);
  }
}
