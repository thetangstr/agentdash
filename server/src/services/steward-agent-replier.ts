import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, authUsers } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { conversationService } from "./conversations.js";
import { dispatchLLM } from "./dispatch-llm.js";

/**
 * AgentDash-MK: answers a steward's inbound channel message as their agent.
 *
 * Telegram was approve/reject only — an inbound message was logged and dropped,
 * so the channel was a notification surface rather than a conversation. This
 * makes it bidirectional.
 *
 * The reply is a plain `dispatchLLM` call against durable conversation history,
 * not a summon of the agent's own runtime. That is deliberate for this slice:
 * an agent run is minutes long and a chat reply is seconds, so routing chat
 * through the run queue would make the channel feel broken. Escalating a
 * message into real agent work is a wakeup, and it belongs in its own slice.
 */

/** How much history to send. Enough for continuity, bounded so cost is stable. */
const HISTORY_LIMIT = 20;

export interface StewardAgentReplierDeps {
  /** Injectable so tests never reach the network. */
  llm?: (input: {
    system: string;
    messages: Array<{ role: "user" | "assistant"; content: string }>;
  }) => Promise<string>;
}

export interface ChannelBindingRef {
  id: string;
  companyId: string;
  userId: string;
  agentId: string;
  provider: string;
}

export function stewardAgentReplier(db: Db, deps: StewardAgentReplierDeps = {}) {
  const conversations = conversationService(db);
  const llm = deps.llm ?? ((input) => dispatchLLM(input));

  /**
   * One conversation per binding, found by a deterministic title.
   *
   * Keyed to the BINDING rather than the human or the agent: revoking and
   * re-pairing produces a new binding, and the new channel should not inherit
   * the transcript of the old one — the identity that was verified is different
   * even when the person is the same.
   */
  async function conversationForBinding(binding: ChannelBindingRef) {
    const title = `${binding.provider}:${binding.id}`;
    const existing = await conversations.findByCompany(binding.companyId, { title });
    if (existing) return existing;
    const created = await conversations.create({
      companyId: binding.companyId,
      userId: binding.userId,
      title,
    });

    // The binding owner is registered as a participant so the transcript is
    // visible to them in the web app; a channel conversation they cannot read
    // is a side channel.
    //
    // Guarded, not attempted-and-caught: `assistant_conversation_participants`
    // has a foreign key to the auth users table, while channel bindings key on
    // durable text principals that deliberately do NOT — the same decision
    // `agent_stewardships` makes, so a principal survives an account being
    // deleted. A synthetic principal (the `local_trusted` board, a service
    // account) has no auth row, and inserting for it would fail the whole
    // reply. Checking first keeps the participant row an enhancement rather
    // than a precondition; the conversation is still found by its title.
    const hasAuthUser = await db
      .select({ id: authUsers.id })
      .from(authUsers)
      .where(eq(authUsers.id, binding.userId))
      .then((rows) => rows.length > 0);
    if (hasAuthUser) {
      await conversations.addParticipant(created.id, binding.userId, "owner");
    }
    return created;
  }

  function systemPrompt(agentName: string, agentRole: string) {
    return [
      `You are ${agentName}, the ${agentRole} agent in an AgentDash workspace.`,
      "You are replying to your human steward over a chat channel.",
      "Be brief and specific — this is a phone-sized surface.",
      "Answer from the conversation history. If you do not have the information, say so plainly rather than inventing it.",
      "You cannot approve your own requests; if the steward asks you to, tell them the decision is theirs.",
      "No greetings, no preamble, no markdown headings.",
    ].join(" ");
  }

  /**
   * Produce a reply and persist both halves.
   *
   * Returns null when there is nothing to say, so the caller can skip the
   * outbound send rather than deliver an empty message.
   */
  async function reply(binding: ChannelBindingRef, inboundText: string): Promise<string | null> {
    const text = inboundText.trim();
    if (!text) return null;

    const agent = await db
      .select({ name: agents.name, role: agents.role, status: agents.status })
      .from(agents)
      .where(eq(agents.id, binding.agentId))
      .then((rows) => rows[0] ?? null);
    if (!agent) return null;
    if (agent.status === "terminated") {
      // A terminated agent has no standing to answer for the company.
      return null;
    }

    const conversation = await conversationForBinding(binding);

    // Persist the human's message BEFORE generating. If generation fails, the
    // question is still on the record and the next turn has the context — a
    // reply that never arrived is recoverable, a question that was never stored
    // is not.
    await conversations.postMessage({
      conversationId: conversation.id,
      authorKind: "user",
      authorId: binding.userId,
      body: text,
      companyId: binding.companyId,
    });

    const history = await conversations.paginate(conversation.id, { limit: HISTORY_LIMIT });
    // `paginate` returns newest-first; a transcript reads oldest-first.
    const messages = history
      .slice()
      .reverse()
      .map((message) => ({
        role: message.role === "agent" ? ("assistant" as const) : ("user" as const),
        content: String(message.content ?? ""),
      }))
      .filter((message) => message.content.length > 0);

    let answer: string;
    try {
      answer = await llm({ system: systemPrompt(agent.name, agent.role), messages });
    } catch (error) {
      logger.warn(
        { err: error, bindingId: binding.id, agentId: binding.agentId },
        "steward agent reply generation failed",
      );
      return null;
    }

    const trimmed = answer.trim();
    if (!trimmed) return null;

    await conversations.postMessage({
      conversationId: conversation.id,
      authorKind: "agent",
      authorId: binding.agentId,
      body: trimmed,
      companyId: binding.companyId,
    });

    return trimmed;
  }

  return { reply, conversationForBinding };
}
