import {
  INBOUND_FILTER_CATEGORIES,
  type InboundFilterCategory,
  type InboundFilterDecision,
} from "@paperclipai/shared";

/**
 * AgentDash-MK: the standing filter on the return path.
 *
 * ## What this is, and what it is not
 *
 * The system's core security property is asymmetric trust. Outbound (harness →
 * agent) is unrestricted, because the harness is the trusted party. Inbound
 * (agent → harness, or agent → human) passes a gate, because an AgentDash agent
 * lives in a shared organization and is continuously exposed to other people's
 * agents' output. Anything travelling back is a potential injection channel
 * into the machine holding the real credentials.
 *
 * Until this file, the gate was per-action: the approvals service deciding
 * individual actions. This is a STANDING filter on the content itself, so
 * material is evaluated whether or not it happens to be attached to an action
 * anybody remembered to gate.
 *
 * **Framing and filtering are different controls and both apply.** Framing —
 * `frameUntrustedBridgeResult`, `frameUntrustedAgentAnswer` — tells the reader
 * what it is reading. Filtering decides whether it travels at all. This file
 * adds the second; it removes nothing from the first, and content that passes
 * is framed exactly as before.
 *
 * ## Why there is no model in this loop
 *
 * The lesson this architecture keeps re-learning is that **a rule binds only
 * when it sits at a chokepoint with a decidable predicate. Prose in a context
 * window is not a control, even when it is our prose.** A filter implemented as
 * "ask a model whether this looks like an injection" is a filter that can be
 * argued out of filtering by the very content it is inspecting — the attacker
 * writes the prompt, and the prompt is the thing being classified.
 *
 * So every rule below is a structural or lexical predicate over the content:
 * does it contain a permission-grant shape, does it claim to be a system
 * message, does it try to close the frame that wraps it, is a declared-required
 * field absent. Where a question is genuinely undecidable — "is this figure
 * plausible" — this file does not attempt it and does not pretend to. The
 * escalation default covers that ground: the doubtful case goes to a human.
 *
 * ## The honest limit
 *
 * A lexical rule set is a blocklist, and blocklists are never complete. Novel
 * phrasings will pass. What this buys is that the *known* shapes of a return-path
 * injection — the ones that work today, and the ones an attacker reaches for
 * first — stop at a chokepoint rather than arriving wrapped in a frame that
 * politely asks a model not to obey them. It is a real reduction in blast
 * radius, not a proof of safety, and the approvals gate behind it is what makes
 * the residue survivable.
 *
 * The error direction is deliberate: **false escalations cost a person a
 * minute; false passes cost a laptop.**
 */

/**
 * Above this, the rules are not run.
 *
 * Not a performance tuning knob. Regex evaluation over unbounded attacker-chosen
 * input is itself an attack surface, and the alternative to a ceiling is
 * "classification takes as long as the content wants it to". Content over the
 * ceiling escalates: refusing to classify is not the same as classifying as
 * safe, and this is the point in the file where those two are kept apart.
 */
export const INBOUND_FILTER_MAX_CLASSIFIABLE_CHARS = 100_000;

/**
 * Content that claims to be percent-encoded but cannot be decoded.
 *
 * Canonicalization is part of classification: `%3Csystem%3E` has to be seen for
 * what it is, or every rule below is one `encodeURIComponent` call away from
 * useless. When the decode fails, the honest statement is that we do not know
 * what the content says — so it escalates rather than being classified on its
 * surface form.
 */
const PERCENT_ESCAPE = /%[0-9A-Fa-f]{2}/;

type Rule = {
  id: string;
  category: InboundFilterCategory;
  /** Decidable, over already-canonicalized forms. No judgement, no model. */
  test: (forms: ContentForms) => boolean;
};

type ContentForms = {
  /** As it arrived. */
  raw: string;
  /**
   * Raw plus its percent-decoded form, concatenated, lowercased, with runs of
   * whitespace collapsed. Concatenated rather than replaced so an attacker
   * cannot hide from a rule by encoding *part* of the payload — both readings
   * are checked at once.
   */
  normalized: string;
};

const ANY = (patterns: RegExp[]) => (forms: ContentForms) =>
  patterns.some((pattern) => pattern.test(forms.normalized));

/**
 * The rules.
 *
 * Each is a shape, not a topic. "Contains the word urgent" is a topic and would
 * be noise; "contains a block that closes the untrusted frame wrapping it" is a
 * shape, and there is no legitimate reason for an answer to contain one.
 */
const RULES: Rule[] = [
  // -- elevated risk: the content is addressed to whatever reads it ----------
  {
    /**
     * An attempt to end the frame it is wrapped in, or to forge one.
     *
     * The single most important rule here, because it is the one aimed
     * specifically at the control that already existed: a payload carrying
     * `</untrusted-agent-answer>` is trying to make everything after it read as
     * trusted context. Nothing legitimate contains these tags — the framing
     * functions add them, so content arriving with them already present is
     * content forging our own markers.
     */
    id: "frame_escape",
    category: "elevated_risk",
    test: ANY([
      /<\/?untrusted-agent-answer>/,
      /<\/?untrusted-bridge-result>/,
      /<\/?untrusted-crm-content>/,
      /<\/?untrusted-sharepoint-content>/,
    ]),
  },
  {
    /** A claim to be a system or developer message. */
    id: "system_preamble",
    category: "elevated_risk",
    test: ANY([
      /<\/?(system|developer)>/,
      /\[\s*(system|developer)\s*\]/,
      /<\|im_start\|>/,
      /(^|\n)\s*(system|assistant|developer)\s*:/,
      /"role"\s*:\s*"(system|developer)"/,
      /\bsystem prompt\b/,
      /\byou are (now )?(chatgpt|claude|an? (ai|assistant|language model))\b/,
    ]),
  },
  {
    /** A tool call, in any of the shapes the adapters in this repo emit. */
    id: "tool_invocation",
    category: "elevated_risk",
    test: ANY([
      /<function_calls>/,
      /<invoke\s+name\s*=/,
      /<tool_(call|use)\b/,
      /"tool_(calls|use)"\s*:/,
      /<\/?antml:/,
    ]),
  },
  {
    /**
     * A grant of permission.
     *
     * The shape that matters most after frame escape, because the whole
     * authorization model is "the human decides". Content asserting that the
     * decision has already been made is content trying to skip the only step
     * that binds.
     */
    id: "permission_grant",
    category: "elevated_risk",
    test: ANY([
      /\byou (are|have been) (now )?(authori[sz]ed|permitted|allowed|approved)\b/,
      /\bpermission (is |has been )?granted\b/,
      /\bno (approval|permission|sign-?off) (is )?(required|needed|necessary)\b/,
      /\b(skip|bypass|waive)(ing|s)? (the )?(approval|permission|steward|review)\b/,
      /\bwithout (steward|human|owner) (approval|review|sign-?off)\b/,
      /--dangerously-skip-permissions/,
      /\bpre-?approved by (the )?(steward|owner|admin|board)\b/,
    ]),
  },
  {
    /** An instruction that overrides whatever the reader was already doing. */
    id: "directive_override",
    category: "elevated_risk",
    test: ANY([
      /\b(ignore|disregard|forget|override) (all |any |the |your )?(previous|prior|earlier|above|preceding|foregoing|existing)\b/,
      /\b(new|updated|revised) (instructions?|directives?|orders?)\s*:/,
      /\byour (new|real|actual) (task|instruction|job|directive) is\b/,
      /\byou must now\b/,
      /\binstead of (what|the instructions?|your instructions?)\b/,
    ]),
  },
  {
    /**
     * An action aimed at the host machine.
     *
     * The bridge's honest limit is that a local harness has its host's full
     * reach and nothing server-side can bound it. That makes the *instruction*
     * the only place a shell action can be intercepted at all.
     */
    id: "host_action",
    category: "elevated_risk",
    test: ANY([
      /\bsudo\s+\S/,
      /\brm\s+-[rf]{1,2}\b/,
      /\bcurl\b[^\n]*\|\s*(ba)?sh\b/,
      /\bchmod\s+(\+x|[0-7]{3})\b/,
      /\b(cat|less|more|copy|read)\b[^\n]*(\.ssh\/|\.aws\/credentials|id_rsa|\.env\b)/,
      /\bgit\s+push\b[^\n]*--force\b/,
      /\bexport\s+(aws|openai|anthropic)_[a-z_]*key\b/,
    ]),
  },

  // -- sensitive updates: the content carries material, not a figure --------
  {
    id: "credential_material",
    category: "sensitive_update",
    test: (forms) =>
      [
        /-----begin [a-z ]*private key-----/,
        /\bakia[0-9a-z]{16}\b/,
        /\bghp_[a-z0-9]{20,}\b/,
        /\bxox[baprs]-[a-z0-9-]{10,}\b/,
        /\bsk-[a-z0-9_-]{20,}\b/,
        /\bauthorization\s*:\s*bearer\s+\S/,
        /\b(password|passphrase|secret|api[_-]?key|access[_-]?token)\s*[:=]\s*\S/,
      ].some((pattern) => pattern.test(forms.normalized)),
  },
  {
    /**
     * A national or payment identifier.
     *
     * Narrow patterns on purpose. A rule that escalates every long number would
     * escalate every deliverable, and a filter everyone routes around because it
     * fires constantly is worse than no filter — that is the reviewer-capitulation
     * failure mode arriving one layer down.
     */
    id: "personal_identifier",
    category: "sensitive_update",
    test: ANY([
      /\b\d{3}-\d{2}-\d{4}\b/,
      /\b(?:4\d{3}|5[1-5]\d{2}|3[47]\d{2}|6011)[ -]?\d{4}[ -]?\d{4}[ -]?\d{3,4}\b/,
    ]),
  },

  // -- missing context: there is nothing here to report --------------------
  {
    id: "placeholder_content",
    category: "missing_context",
    test: (forms) => /^(tbd|tba|n\/?a|none|null|unknown|pending|\?+|-+|see attached)$/.test(
      forms.raw.trim().toLowerCase(),
    ),
  },
];

function normalize(raw: string): ContentForms {
  let decoded = raw;
  if (PERCENT_ESCAPE.test(raw)) {
    // Throws URIError on a malformed sequence. Deliberately not caught here:
    // the caller turns it into `classification_incomplete`, which escalates.
    decoded = decodeURIComponent(raw);
  }
  const normalized = `${raw}\n${decoded}`.toLowerCase().replace(/[ \t]+/g, " ");
  return { raw, normalized };
}

function decide(
  contentChars: number,
  findings: Array<{ id: string; category: InboundFilterCategory }>,
): InboundFilterDecision {
  const categories = INBOUND_FILTER_CATEGORIES.filter((category) =>
    findings.some((finding) => finding.category === category),
  );
  return {
    verdict: findings.length > 0 ? "escalate" : "pass",
    categories,
    ruleIds: Array.from(new Set(findings.map((finding) => finding.id))).sort(),
    contentChars,
  };
}

/**
 * Fail closed.
 *
 * Every path that cannot complete a classification lands here, and every one of
 * them escalates. A filter that fails open is not a filter — it is a filter
 * shaped hole that appears exactly when something unusual arrives, which is the
 * only time it mattered.
 */
function unclassifiable(
  contentChars: number,
  category: InboundFilterCategory = "elevated_risk",
): InboundFilterDecision {
  return {
    verdict: "escalate",
    categories: [category],
    ruleIds: ["classification_incomplete"],
    contentChars,
  };
}

/**
 * Classify one piece of return-path content.
 *
 * Pure and synchronous: no I/O, no model, no clock. That is what makes the
 * verdict reproducible for a reviewer looking at the same bytes a week later,
 * and it is why the function can sit inside a database write path without
 * introducing a new way for that write to fail.
 *
 * `requiredContext` is the caller's declaration of what must accompany the
 * content — provenance fields, source kinds. An absent one is `missing_context`
 * rather than a thrown error, because the answer to "this arrived without a
 * source" is a human looking at it, not a 500 for the agent that sent it.
 */
export function classifyInboundContent(input: {
  content: unknown;
  requiredContext?: Record<string, unknown>;
}): InboundFilterDecision {
  try {
    const { content, requiredContext } = input;

    const findings: Array<{ id: string; category: InboundFilterCategory }> = [];
    for (const [key, value] of Object.entries(requiredContext ?? {})) {
      if (value === null || value === undefined || (typeof value === "string" && !value.trim())) {
        findings.push({ id: `required_field_absent:${key}`, category: "missing_context" });
      }
    }

    if (typeof content !== "string") {
      // Not a string at all: there is nothing to run a predicate over, and
      // guessing is the behaviour this function exists to avoid.
      return unclassifiable(0);
    }
    if (content.length > INBOUND_FILTER_MAX_CLASSIFIABLE_CHARS) {
      return unclassifiable(content.length);
    }
    if (!content.trim()) {
      return decide(content.length, [
        ...findings,
        { id: "empty_content", category: "missing_context" },
      ]);
    }

    let forms: ContentForms;
    try {
      forms = normalize(content);
    } catch {
      // Claims to be percent-encoded, is not decodable. We cannot see its true
      // form, so we cannot certify it.
      return unclassifiable(content.length);
    }

    for (const rule of RULES) {
      if (rule.test(forms)) findings.push({ id: rule.id, category: rule.category });
    }
    return decide(content.length, findings);
  } catch {
    // The catch-all. A rule that throws — a bad regex added later, a value
    // shape nobody anticipated — must not become a pass. The one outcome this
    // function will not produce is "an error happened, so the content went
    // through".
    const chars = typeof input.content === "string" ? input.content.length : 0;
    return unclassifiable(chars);
  }
}
