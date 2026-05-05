/**
 * patch-hermes-adapter.mjs
 *
 * Patches hermes-paperclip-adapter's checkApiKeys to include additional provider
 * API keys (DEEPSEEK, VERTEX, GEMINI, AZURE_OPENAI) that Hermes supports but the
 * adapter's checkApiKeys doesn't yet list. Safe to re-run.
 *
 * Patches the actual installed copies in:
 *   server/node_modules/hermes-paperclip-adapter/
 *   ui/node_modules/hermes-paperclip-adapter/
 *
 * Run automatically via root postinstall, or manually:
 *   node server/scripts/patch-hermes-adapter.mjs
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDENT = "    ";
const SP8 = "        "; // 8-space indent for providers.push lines

/**
 * Find the monorepo root by looking for packages/ directory.
 */
function findMonorepoRoot(start) {
  let dir = start;
  for (;;) {
    if (existsSync(resolve(dir, "packages"))) return dir;
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function patchFile(filePath) {
  let content = readFileSync(filePath, "utf8");

  // Already patched
  if (content.includes('has("DEEPSEEK_API_KEY")')) return false;

  // Patch 1: insert hasDeepSeek, hasVertex, hasGemini, hasAzureOpenAI BEFORE hasMiniMax
  // Original: const hasMiniMax = has("MINIMAX_API_KEY");\n    if (!hasAnthropic...
  // After:    const hasDeepSeek = ...\n    const hasVertex = ...\n    const hasGemini = ...\n    const hasAzureOpenAI = ...\n    const hasMiniMax = ...\n    if (!hasAnthropic...
  content = content.replace(
    /\n    const hasMiniMax = has\("MINIMAX_API_KEY"\);\n    if \(\!hasAnthropic/,
    `\n${INDENT}const hasDeepSeek = has("DEEPSEEK_API_KEY");\n${INDENT}const hasVertex = has("VERTEX_API_KEY");\n${INDENT}const hasGemini = has("GEMINI_API_KEY");\n${INDENT}const hasAzureOpenAI = has("AZURE_OPENAI_API_KEY");\n${INDENT}const hasMiniMax = has("MINIMAX_API_KEY");\n    if (!hasAnthropic`
  );

  // Patch 2: update the no-keys condition to include new providers
  content = content.replace(
    /if \(\!hasAnthropic && \!hasOpenRouter && \!hasOpenAI && \!hasZai && \!hasKimi && \!hasMiniMax\)/,
    "if (!hasAnthropic && !hasOpenRouter && !hasOpenAI && !hasZai && !hasKimi && !hasMiniMax && !hasDeepSeek && !hasVertex && !hasGemini && !hasAzureOpenAI)"
  );

  // Patch 3: add providers reporting (multi-line format)
  // Original:
  //   if (hasMiniMax)
  //       providers.push("MiniMax");
  //   return {
  content = content.replace(
    /(\n    if \(hasMiniMax\)\n        providers\.push\("MiniMax"\);)(\n    return \{)/,
    `$1\n    if (hasDeepSeek)\n${SP8}providers.push("DeepSeek");\n    if (hasVertex)\n${SP8}providers.push("Vertex AI");\n    if (hasGemini)\n${SP8}providers.push("Gemini");\n    if (hasAzureOpenAI)\n${SP8}providers.push("Azure OpenAI");$2`
  );

  // Patch 4: update the hint message to include new providers
  content = content.replace(
    /hint: "Set API keys in the agent's env secrets or ~\/.hermes\/\.env\. Hermes supports: ANTHROPIC_API_KEY, OPENROUTER_API_KEY, OPENAI_API_KEY, ZAI_API_KEY, KIMI_API_KEY, MINIMAX_API_KEY"/,
    `hint: "Set API keys in the agent's env secrets or ~/.hermes/.env. Hermes supports: ANTHROPIC_API_KEY, OPENROUTER_API_KEY, OPENAI_API_KEY, ZAI_API_KEY, KIMI_API_KEY, MINIMAX_API_KEY, DEEPSEEK_API_KEY, VERTEX_API_KEY, GEMINI_API_KEY, AZURE_OPENAI_API_KEY"`
  );

  writeFileSync(filePath, content, "utf8");
  return true;
}

function patchHermesAdapter() {
  const root = findMonorepoRoot(__dirname) ?? __dirname;

  // Paths to the actual installed hermes in each package's node_modules
  const targets = [
    resolve(root, "server/node_modules/hermes-paperclip-adapter/dist/server/test.js"),
    resolve(root, "ui/node_modules/hermes-paperclip-adapter/dist/server/test.js"),
  ];

  for (const target of targets) {
    if (existsSync(target)) {
      const patched = patchFile(target);
      if (patched) {
        console.log(`[patch-hermes-adapter] Patched: ${target}`);
      } else {
        console.log(`[patch-hermes-adapter] Already patched: ${target}`);
      }
    }
  }
}

patchHermesAdapter();
