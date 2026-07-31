import { Router } from "express";
import type { Request } from "express";
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companies } from "@paperclipai/db";
import { verifyHumanChannelBindingSchema } from "@paperclipai/shared";
import { badRequest, forbidden, serviceUnavailable } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { accessService } from "../services/access.js";
import { requireProductProfile } from "../services/companies.js";
import { humanChannelService } from "../services/human-channels.js";
import { whatsappPairingLink } from "../services/whatsapp-connector.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

/**
 * Providers that may still be bound by asserting an external id.
 *
 * Empty, and it should stay that way. Membership here means "we accept an
 * identity this caller merely claims" — which is only defensible for a provider
 * whose ids are unguessable AND unforgeable, and none are. Telegram and
 * WhatsApp have verified ceremonies; Teams needs one before it is switched on.
 */
const SELF_ASSERTABLE_PROVIDERS = new Set<string>();

export function humanChannelRoutes(db: Db) {
  const router = Router();
  const channels = humanChannelService(db);
  const access = accessService(db);

  async function requireProfileCompany(req: Request, companyId: string) {
    assertCompanyAccess(req, companyId);
    const company = await db
      .select({ id: companies.id, productProfile: companies.productProfile })
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0] ?? null);
    return requireProductProfile(company, "agentdash_mk");
  }

  function requireBoardUser(req: Request) {
    assertBoard(req);
    if (!req.actor.userId) throw forbidden("Board user access required");
    return req.actor.userId;
  }

  async function isAdministrator(req: Request, companyId: string) {
    if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return true;
    return access.canUser(companyId, req.actor.userId, "agents:create");
  }

  /** A human's own bindings. Identity comes from the session, never the body. */
  router.get("/companies/:companyId/me/channels", async (req, res) => {
    const companyId = req.params.companyId as string;
    await requireProfileCompany(req, companyId);
    const userId = requireBoardUser(req);
    const all = await channels.listForCompany(companyId);
    res.json({ bindings: all.filter((binding) => binding.userId === userId) });
  });

  /**
   * Start a Telegram pairing.
   *
   * Returns a deep link, never the raw token: the link is the only thing the
   * user should ever handle, and echoing the token separately invites it into a
   * log line or a copy-paste that the link itself would not reach.
   *
   * WHO gets paired is the authenticated caller, full stop. The body is not
   * read — a `userId` here would let one member mint a link that binds THEIR
   * Telegram account to another member's agent.
   */
  router.post("/companies/:companyId/me/channels/telegram/pairing", async (req, res) => {
    const companyId = req.params.companyId as string;
    await requireProfileCompany(req, companyId);
    const userId = requireBoardUser(req);

    // Checked before minting. A link to `https://t.me/undefined?start=…` looks
    // like it works and never will, and spending a token on it would burn the
    // user's one outstanding challenge on an unusable link.
    const botUsername = process.env.TELEGRAM_BOT_USERNAME?.trim();
    if (!botUsername) {
      throw serviceUnavailable(
        "Telegram pairing is not configured: TELEGRAM_BOT_USERNAME is unset",
      );
    }

    const { token, expiresAt } = await channels.mintPairingChallenge(companyId, {
      userId,
      provider: "telegram",
    });

    res.status(201).json({
      deepLink: `https://t.me/${botUsername}?start=${token}`,
      expiresAt: expiresAt.toISOString(),
    });
  });

  /**
   * Start a WhatsApp pairing.
   *
   * Same shape as Telegram's, and the same rule about identity: the link
   * prefills a message the user sends FROM their handset, and that inbound
   * message is what proves they hold the number. No surface anywhere accepts a
   * phone number a human typed — numbers are guessable, and a mis-paired
   * binding leaks both the content of approvals and the authority to decide
   * them.
   */
  router.post("/companies/:companyId/me/channels/whatsapp/pairing", async (req, res) => {
    const companyId = req.params.companyId as string;
    await requireProfileCompany(req, companyId);
    const userId = requireBoardUser(req);

    const businessNumber = process.env.WHATSAPP_BUSINESS_NUMBER?.trim();
    if (!businessNumber) {
      throw serviceUnavailable(
        "WhatsApp pairing is not configured: WHATSAPP_BUSINESS_NUMBER is unset",
      );
    }

    const { token, expiresAt } = await channels.mintPairingChallenge(companyId, {
      userId,
      provider: "whatsapp",
    });

    res.status(201).json({
      deepLink: whatsappPairingLink(businessNumber, token),
      expiresAt: expiresAt.toISOString(),
    });
  });

  /**
   * Complete a pairing. The provider identity is supplied, but WHO it binds to
   * is always the authenticated caller — accepting a userId here would let one
   * member attach a provider account to someone else's agent.
   */
  router.post(
    "/companies/:companyId/me/channels",
    validate(verifyHumanChannelBindingSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await requireProfileCompany(req, companyId);
      const userId = requireBoardUser(req);

      // An ALLOWLIST, not a blocklist, and the distinction is the whole point.
      //
      // This guard began as "reject telegram", then became "reject telegram or
      // whatsapp", and teams stayed spoofable through both edits — because a
      // blocklist defaults every new provider to accepting an identity the
      // caller merely asserts. A member could name a colleague's Teams id and
      // receive that person's approvals.
      //
      // Inverted, the default is refusal: a provider added to
      // HUMAN_CHANNEL_PROVIDERS cannot self-assert until someone deliberately
      // opts it in here, and the test iterates the enum so that choice is
      // visible in review rather than implied by omission.
      //
      // The set is currently empty. Every provider has, or needs, a ceremony
      // that proves the caller controls the account.
      if (!SELF_ASSERTABLE_PROVIDERS.has(req.body.provider)) {
        throw badRequest(
          `${req.body.provider} cannot be paired by asserting an identity; ` +
            "it must be paired through a ceremony that verifies the account",
        );
      }

      const binding = await channels.verifyBinding(companyId, {
        provider: req.body.provider,
        userId,
        externalTenantId: req.body.externalTenantId ?? null,
        externalUserId: req.body.externalUserId,
        externalConversationId: req.body.externalConversationId ?? null,
        metadata: req.body.metadata ?? null,
      });
      res.status(201).json({ binding });
    },
  );

  /** A human may revoke their own binding; an administrator may revoke any. */
  router.post("/companies/:companyId/channel-bindings/:bindingId/revoke", async (req, res) => {
    const companyId = req.params.companyId as string;
    const bindingId = req.params.bindingId as string;
    await requireProfileCompany(req, companyId);
    const userId = requireBoardUser(req);

    const existing = (await channels.listForCompany(companyId)).find(
      (binding) => binding.id === bindingId,
    );
    if (existing && existing.userId !== userId && !(await isAdministrator(req, companyId))) {
      throw forbidden("Only the bound user or an administrator can revoke this binding");
    }

    res.json({ binding: await channels.revokeBinding(companyId, bindingId, { actorUserId: userId }) });
  });

  /** Administrator view of every binding in the company, for audit. */
  router.get("/companies/:companyId/channel-bindings", async (req, res) => {
    const companyId = req.params.companyId as string;
    await requireProfileCompany(req, companyId);
    requireBoardUser(req);
    if (!(await isAdministrator(req, companyId))) {
      throw forbidden("Listing company channel bindings requires administrator access");
    }
    res.json({ bindings: await channels.listForCompany(companyId) });
  });

  return router;
}
