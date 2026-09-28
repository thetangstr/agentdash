// AgentDash (SC-7, GH #768): the front door's logic (spec §1, §5.1).
//
//   signup      /start: checks, then a single-use 30-minute magic link by email.
//               Nothing is reserved or provisioned before the link is used.
//   verify      the link: proves the email, creates the box (one Free box per
//               verified email) and asks for provisioning through the queue,
//               where the kill switch, waitlist mode and the daily cap apply.
//   boxesMine   what the progress page shows, for the session's account.
//   resend      a new verify link for a pending signup, or the claim link again.
//   find        /find: links to an email's workspaces, by email only.
//   release     approved waitlist entries get their job once the gates open.
//   readyMail   the claim-link email for every box that reached awaiting_claim.
//
// Every answer that could tell a stranger whether an email has an account is
// the same for both cases; the difference is only in what gets mailed.
import { randomBytes } from "node:crypto";
import { and, asc, eq, gt, inArray, isNull, ne, sql } from "drizzle-orm";
import type { CloudConfig } from "../config.js";
import { sha256Hex } from "../crypto.js";
import type { CloudDb } from "../db/client.js";
import { accounts, boxEvents, boxes, cloudSessions, emailTokens, jobs, signupRequests, waitlist, type BoxState } from "../db/schema.js";
import { claimLinkForBox } from "../jobs/claim.js";
import { requestProvision, type ProvisionRequestResult } from "../jobs/queue.js";
import type { Logger } from "../logger.js";
import { isReservedSlug, SlugRefused, validateNewSlug } from "../railway/slug.js";
import { capabilities } from "../capabilities.js";
import { settingsService } from "../settings.js";
import { emailDomain, hasMx, isDisposableDomain, isFreemail, type MxResolver, normaliseEmail } from "./email-policy.js";
import { emails, type Mailer, MailNotConfigured } from "./mailer.js";
import { LIMITS, takeHit } from "./rate-limit.js";
import { verifyTurnstile } from "./turnstile.js";

export const MAGIC_LINK_MINUTES = 30;
export const SESSION_HOURS = 24;
/** Per-IP boxes a day and per-domain boxes a day (spec §5.1). */
export const BOXES_PER_IP_PER_DAY = 1;
export const BOXES_PER_DOMAIN_PER_DAY = 5;
/** After this long provisioning, the progress page says it is slow and promises the email (spec §1). */
export const SLOW_AFTER_MS = 5 * 60_000;

const DAY_MS = 86_400_000;
const LIVE_BOX_STATES: BoxState[] = ["requested", "waitlisted", "provisioning", "awaiting_claim", "active", "suspended", "failed", "pending_delete", "cleanup"];
const BOX_CREATE_LOCK = 768_001;
/**
 * GH #836 review: an unverified signup may not hold a name forever. One
 * email or one address gets at most this many unverified signups for the
 * same name, and resending never stretches one signup's hold past MAX_HOLD_MS.
 */
export const MAX_SLUG_HOLDS = 3;
export const MAX_HOLD_MS = 2 * 3_600_000;

export type Refusal = { ok: false; status: number; code: string; error: string };
const refuse = (status: number, code: string, error: string): Refusal => ({ ok: false, status, code, error });

export interface Visitor {
  /** The visitor's address, as best known. */
  ip: string | null;
  /** True when the address came from www's authenticated proxy header. */
  viaProxy: boolean;
}

export interface FrontDoorDeps {
  db: CloudDb;
  log: Logger;
  config: Pick<CloudConfig, "edgeDomain" | "dataKeys" | "frontDoor">;
  mailer: Mailer;
  /** For Turnstile. */
  fetch?: typeof fetch;
  resolveMx?: MxResolver;
  now?: () => Date;
}

export type SlugCheck = { available: true } | { available: false; reason: "invalid" | "reserved" | "taken"; message: string };

/** The progress page's phases. */
export type Phase = "waitlisted" | "approved" | "provisioning" | "ready" | "active" | "suspended" | "failed" | "closing";

export interface BoxView {
  slug: string;
  url: string;
  state: BoxState;
  phase: Phase;
  /** 0-4, the provisioning steps the page shows; null when not provisioning. */
  stepIndex: number | null;
  slow: boolean;
  /** Only while the box waits for its claim. */
  claimUrl: string | null;
  createdAt: string;
}

/** Provisioner step names (railway/provisioner.ts) to the five steps the page shows. */
const STEP_INDEX: Record<string, number> = {
  reserve: 0, project: 0,
  postgres: 1,
  web: 2, variables: 2, snapshots: 2, service_settings: 2,
  deploy: 3,
  health: 4, publish: 4,
};

function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export function frontDoor(deps: FrontDoorDeps) {
  const { db, log, config, mailer } = deps;
  const fd = config.frontDoor;
  const now = () => deps.now?.() ?? new Date();
  const site = fd.siteUrl;
  const boxUrl = (slug: string) => `https://${slug}.${config.edgeDomain}`;

  async function send(message: Parameters<Mailer["send"]>[0]): Promise<void> {
    await mailer.send(message);
    log.info("front-door email sent", { mailKind: message.kind });
  }

  /**
   * Mail that must not fail the request, and (GH #836 review) is not awaited
   * by the public routes, so an address with an account answers in the same
   * time as one without.
   */
  async function sendQuietly(message: Parameters<Mailer["send"]>[0]): Promise<void> {
    try {
      await send(message);
    } catch (err) {
      log.error("front-door email failed", { err, mailKind: message.kind });
    }
  }

  async function issueToken(accountId: string, purpose: "verify" | "find"): Promise<{ id: string; token: string; expiresAt: Date }> {
    const token = newToken();
    const expiresAt = new Date(now().getTime() + MAGIC_LINK_MINUTES * 60_000);
    const [row] = await db.insert(emailTokens).values({ accountId, purpose, tokenHash: sha256Hex(token), expiresAt }).returning({ id: emailTokens.id });
    return { id: row!.id, token, expiresAt };
  }

  /** The magic link: the token rides in the fragment, so it is never sent to a server or logged by one. */
  const magicLink = (token: string) => `${site}/start/verify#token=${token}`;

  async function liveBoxes(accountId: string) {
    return await db.select().from(boxes).where(and(eq(boxes.accountId, accountId), inArray(boxes.state, LIVE_BOX_STATES)));
  }

  async function checkSlug(slug: string, forAccountId?: string): Promise<SlugCheck> {
    try {
      validateNewSlug(slug);
    } catch (err) {
      if (err instanceof SlugRefused) {
        return isReservedSlug(slug)
          ? { available: false, reason: "reserved", message: "That name is reserved. Try another." }
          : { available: false, reason: "invalid", message: "Use 3 to 16 lowercase letters, numbers or dashes, starting with a letter." };
      }
      throw err;
    }
    const [box] = await db.select({ id: boxes.id }).from(boxes).where(eq(boxes.slug, slug)).limit(1);
    if (box) return { available: false, reason: "taken", message: "That name is taken. Try another." };
    const [pending] = await db
      .select({ id: signupRequests.id })
      .from(signupRequests)
      .where(and(
        eq(signupRequests.slug, slug),
        isNull(signupRequests.verifiedAt),
        gt(signupRequests.expiresAt, now()),
        ...(forAccountId ? [ne(signupRequests.accountId, forAccountId)] : []),
      ))
      .limit(1);
    if (pending) return { available: false, reason: "taken", message: "That name is taken. Try another." };
    return { available: true };
  }

  /** Boxes created in the last day from this address (signups that became boxes). */
  async function boxesFromIpToday(ip: string): Promise<number> {
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(signupRequests)
      .where(and(eq(signupRequests.ip, ip), sql`${signupRequests.boxId} is not null`, gt(signupRequests.verifiedAt, new Date(now().getTime() - DAY_MS))));
    return row?.n ?? 0;
  }

  async function boxesForDomainToday(domain: string): Promise<number> {
    const rows = (await db.execute(sql`
      select count(*)::int as n from boxes b join accounts a on a.id = b.account_id
       where b.created_at > ${new Date(now().getTime() - DAY_MS).toISOString()}::timestamptz and split_part(a.email::text, '@', 2) = ${domain}`)) as unknown as Array<{ n: number }>;
    return rows[0]?.n ?? 0;
  }

  async function createSession(accountId: string): Promise<{ token: string; maxAgeSeconds: number }> {
    const token = newToken();
    await db.insert(cloudSessions).values({ accountId, tokenHash: sha256Hex(token), expiresAt: new Date(now().getTime() + SESSION_HOURS * 3_600_000) });
    return { token, maxAgeSeconds: SESSION_HOURS * 3600 };
  }

  async function sessionAccount(token: string | null) {
    if (!token) return null;
    const [row] = await db
      .select({ account: accounts })
      .from(cloudSessions)
      .innerJoin(accounts, eq(accounts.id, cloudSessions.accountId))
      .where(and(eq(cloudSessions.tokenHash, sha256Hex(token)), gt(cloudSessions.expiresAt, now())));
    if (!row || row.account.status !== "active") return null;
    return row.account;
  }

  async function botCheck(token: unknown, ip: string | null): Promise<boolean> {
    if (!fd.turnstileSecret) return true;
    return await verifyTurnstile(fd.turnstileSecret, token, ip, { fetch: deps.fetch });
  }

  return {
    checkSlug,
    sessionAccount,

    /** What the pages need to render before any call: the Turnstile site key and whether new signups wait. */
    async publicConfig() {
      const s = await settingsService(db).getAll();
      const provisioningOff = !s.provisioning_enabled || !capabilities.claimTrackingReady;
      return {
        turnstileSiteKey: fd.turnstileSiteKey,
        signupOpen: mailer.configured !== false,
        waitlist: provisioningOff || s.waitlist_mode || !fd.turnstileSecret,
        edgeDomain: config.edgeDomain,
      };
    },

    async signup(body: Record<string, unknown>, visitor: Visitor): Promise<{ ok: true } | Refusal> {
      if (mailer.configured === false) return refuse(503, "signup_unavailable", "Signup is not open yet. Try again soon.");
      const email = normaliseEmail(body.email);
      if (!email) return refuse(400, "invalid_email", "Enter a valid email address.");
      const workspaceName = typeof body.workspaceName === "string" ? body.workspaceName.trim() : "";
      if (workspaceName.length < 2 || workspaceName.length > 80) return refuse(400, "invalid_name", "Give your workspace a name of 2 to 80 characters.");
      const slug = typeof body.slug === "string" ? body.slug.trim().toLowerCase() : "";
      if (body.acceptTerms !== true) return refuse(400, "terms_required", "Accept the terms to continue.");

      if (!(await botCheck(body.turnstileToken, visitor.ip))) {
        return refuse(400, "bot_check_failed", "We could not confirm you are human. Reload the page and try again.");
      }
      if (visitor.ip && !(await takeHit(db, LIMITS.signupPerIp, visitor.ip))) {
        return refuse(429, "rate_limited", "Too many signups from your network. Try again in an hour.");
      }

      const domain = emailDomain(email);
      if (isDisposableDomain(domain, { extra: fd.disposableExtra, allow: fd.disposableAllow })) {
        return refuse(400, "disposable_email", "Use a permanent email address; temporary inboxes are not accepted.");
      }
      if (!(await hasMx(domain, { resolve: deps.resolveMx }))) {
        return refuse(400, "no_mx", `${domain} does not receive email. Check the address.`);
      }

      const slugCheck = await checkSlug(slug);
      if (!slugCheck.available) return refuse(slugCheck.reason === "taken" ? 409 : 400, `slug_${slugCheck.reason}`, slugCheck.message);

      {
        const [holds] = await db
          .select({ n: sql<number>`count(*)::int` })
          .from(signupRequests)
          .innerJoin(accounts, eq(accounts.id, signupRequests.accountId))
          .where(and(
            eq(signupRequests.slug, slug),
            isNull(signupRequests.verifiedAt),
            visitor.ip ? sql`(${accounts.email} = ${email} or ${signupRequests.ip} = ${visitor.ip})` : sql`${accounts.email} = ${email}`,
          ));
        if ((holds?.n ?? 0) >= MAX_SLUG_HOLDS) {
          return refuse(429, "slug_hold_limit", "You have asked for this name several times without confirming. Check your inbox for the link, or pick another name.");
        }
      }
      if (visitor.ip && (await boxesFromIpToday(visitor.ip)) >= BOXES_PER_IP_PER_DAY) {
        return refuse(429, "ip_daily_limit", "A workspace was already created from your network today. Try again tomorrow.");
      }
      if (!isFreemail(domain) && (await boxesForDomainToday(domain)) >= BOXES_PER_DOMAIN_PER_DAY) {
        return refuse(429, "domain_daily_limit", `Too many workspaces were created for ${domain} today. Try again tomorrow.`);
      }
      if (!(await takeHit(db, LIMITS.signupPerEmail, email))) {
        return refuse(429, "rate_limited", "We already sent you a few links. Check your inbox, or try again in an hour.");
      }

      await db.insert(accounts).values({ email, signupIp: visitor.ip }).onConflictDoNothing();
      const [acct] = await db.select().from(accounts).where(eq(accounts.email, email));
      if (!acct) throw new Error("account upsert failed");
      // Same answer as a new signup: a blocked or deleted address learns nothing, and gets nothing.
      if (acct.status === "blocked" || acct.status === "deleted") {
        log.info("signup from a blocked or deleted account ignored", { accountId: acct.id });
        return { ok: true };
      }

      try {
        if (acct.status === "active" && (await liveBoxes(acct.id)).length > 0) {
          const t = await issueToken(acct.id, "find");
          void sendQuietly(emails.alreadyHaveBox(email, { link: magicLink(t.token) }));
          return { ok: true };
        }
        const t = await issueToken(acct.id, "verify");
        await db.insert(signupRequests).values({
          accountId: acct.id,
          emailTokenId: t.id,
          slug,
          workspaceName,
          ip: visitor.ip,
          unverifiedHuman: !fd.turnstileSecret,
          expiresAt: t.expiresAt,
        });
        void sendQuietly(emails.verify(email, { link: magicLink(t.token), slug }));
      } catch (err) {
        if (err instanceof MailNotConfigured) return refuse(503, "signup_unavailable", "Signup is not open yet. Try again soon.");
        throw err;
      }
      return { ok: true };
    },

    /**
     * Use a magic link. Single use: the token is marked used in the same
     * statement that checks it is unused and unexpired.
     */
    async verify(token: unknown): Promise<
      | { ok: true; session: { token: string; maxAgeSeconds: number }; outcome: "box_requested" | "existing" | "signed_in"; provisioning?: ProvisionRequestResult }
      | Refusal
    > {
      if (typeof token !== "string" || !/^[A-Za-z0-9_-]{20,100}$/.test(token)) return refuse(400, "link_invalid", "This link is not valid.");
      const hash = sha256Hex(token);
      const [used] = await db
        .update(emailTokens)
        .set({ usedAt: now() })
        .where(and(eq(emailTokens.tokenHash, hash), isNull(emailTokens.usedAt), gt(emailTokens.expiresAt, now())))
        .returning();
      if (!used) {
        const [row] = await db.select().from(emailTokens).where(eq(emailTokens.tokenHash, hash));
        if (!row) return refuse(400, "link_invalid", "This link is not valid.");
        if (row.usedAt) return refuse(410, "link_used", "This link was already used. Each link works once.");
        return refuse(410, "link_expired", "This link has expired. Links work for 30 minutes.");
      }
      const [acct] = await db.select().from(accounts).where(eq(accounts.id, used.accountId));
      if (!acct || acct.status === "blocked" || acct.status === "deleted") return refuse(400, "link_invalid", "This link is not valid.");
      if (acct.status === "pending_verification") {
        await db.update(accounts).set({ status: "active", emailVerifiedAt: now(), updatedAt: now() }).where(eq(accounts.id, acct.id));
      }

      if (used.purpose === "find") {
        return { ok: true, session: await createSession(acct.id), outcome: "signed_in" };
      }

      const [request] = await db.select().from(signupRequests).where(eq(signupRequests.emailTokenId, used.id));
      if (!request) return { ok: true, session: await createSession(acct.id), outcome: "signed_in" };

      // One Free box per verified email; the per-IP and per-domain daily limits
      // are checked again here, under one lock, because they count boxes.
      const created = await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(${BOX_CREATE_LOCK})`);
        const existing = await tx.select({ id: boxes.id }).from(boxes).where(and(eq(boxes.accountId, acct.id), inArray(boxes.state, LIVE_BOX_STATES)));
        if (existing.length) return { kind: "existing" as const };
        if (request.ip && (await boxesFromIpToday(request.ip)) >= BOXES_PER_IP_PER_DAY) return { kind: "refused" as const, refusal: refuse(429, "ip_daily_limit", "A workspace was already created from your network today. Sign up again tomorrow.") };
        const domain = emailDomain(acct.email);
        if (!isFreemail(domain) && (await boxesForDomainToday(domain)) >= BOXES_PER_DOMAIN_PER_DAY) {
          return { kind: "refused" as const, refusal: refuse(429, "domain_daily_limit", `Too many workspaces were created for ${domain} today. Sign up again tomorrow.`) };
        }
        const [taken] = await tx.select({ id: boxes.id }).from(boxes).where(eq(boxes.slug, request.slug));
        if (taken) return { kind: "refused" as const, refusal: refuse(409, "slug_taken", "Someone took that name while you were confirming. Start again with another name.") };
        const [box] = await tx.insert(boxes).values({ accountId: acct.id, slug: request.slug }).returning({ id: boxes.id });
        await tx.update(signupRequests).set({ verifiedAt: now(), boxId: box!.id }).where(eq(signupRequests.id, request.id));
        await tx.insert(boxEvents).values({ boxId: box!.id, kind: "box_created", actor: "signup", detail: { by: "front_door", botCheck: !request.unverifiedHuman } });
        return { kind: "created" as const, boxId: box!.id };
      });

      const session = await createSession(acct.id);
      if (created.kind === "refused") return created.refusal;
      if (created.kind === "existing") return { ok: true, session, outcome: "existing" };

      const provisioning = await requestProvision(db, created.boxId, { actor: "signup", requireApproval: request.unverifiedHuman });
      log.info("signup verified", { slug: request.slug, outcome: provisioning.outcome, reason: provisioning.outcome === "waitlisted" ? provisioning.reason : null });
      if (provisioning.outcome === "waitlisted") {
        const t = await issueToken(acct.id, "find");
        await sendQuietly(emails.waitlisted(acct.email, { slug: request.slug, progressLink: magicLink(t.token) }));
      }
      return { ok: true, session, outcome: "box_requested", provisioning };
    },

    async boxesMine(accountId: string): Promise<{ email: string; boxes: BoxView[] }> {
      const [acct] = await db.select().from(accounts).where(eq(accounts.id, accountId));
      const rows = await db.select().from(boxes).where(and(eq(boxes.accountId, accountId), ne(boxes.state, "deleted"))).orderBy(asc(boxes.createdAt));
      const [entry] = await db
        .select()
        .from(waitlist)
        .where(and(eq(waitlist.accountId, accountId), inArray(waitlist.state, ["waiting", "approved"])))
        .limit(1);
      const views: BoxView[] = [];
      for (const b of rows) {
        let phase: Phase;
        let stepIndex: number | null = null;
        let slow = false;
        let claimUrl: string | null = null;
        switch (b.state) {
          case "requested":
          case "waitlisted":
            phase = entry?.state === "approved" ? "approved" : "waitlisted";
            break;
          case "provisioning": {
            phase = "provisioning";
            const [job] = await db
              .select({ step: jobs.step, startedAt: jobs.startedAt, createdAt: jobs.createdAt })
              .from(jobs)
              .where(and(eq(jobs.boxId, b.id), eq(jobs.kind, "provision")))
              .orderBy(sql`${jobs.createdAt} desc`)
              .limit(1);
            stepIndex = job?.step ? (STEP_INDEX[job.step] ?? 0) : 0;
            const since = job?.startedAt ?? job?.createdAt ?? b.updatedAt;
            slow = now().getTime() - since.getTime() > SLOW_AFTER_MS;
            break;
          }
          case "awaiting_claim":
            phase = "ready";
            claimUrl = claimLinkForBox(b, { dataKeys: config.dataKeys, edgeDomain: config.edgeDomain, email: acct!.email });
            break;
          case "active":
            phase = "active";
            break;
          case "suspended":
            phase = "suspended";
            break;
          case "failed":
            phase = "failed";
            break;
          default:
            phase = "closing";
        }
        views.push({ slug: b.slug, url: boxUrl(b.slug), state: b.state, phase, stepIndex, slow, claimUrl, createdAt: b.createdAt.toISOString() });
      }
      return { email: acct?.email ?? "", boxes: views };
    },

    /**
     * Resend. With a session: the claim link of a box waiting for its claim.
     * With an email: a fresh verify link for its newest pending signup. The
     * box itself is never touched (spec §3.5 step 6).
     */
    async resend(input: { email?: unknown; accountId?: string | null }, visitor: Visitor): Promise<{ ok: true } | Refusal> {
      if (visitor.ip && !(await takeHit(db, LIMITS.resendPerIp, visitor.ip))) return refuse(429, "rate_limited", "Too many requests. Try again in an hour.");
      if (input.accountId) {
        const [acct] = await db.select().from(accounts).where(eq(accounts.id, input.accountId));
        if (!acct) return { ok: true };
        if (!(await takeHit(db, LIMITS.resendPerEmail, acct.email))) return refuse(429, "rate_limited", "We already re-sent it a few times. Check your inbox, or try again in an hour.");
        for (const b of await liveBoxes(acct.id)) {
          if (b.state !== "awaiting_claim") continue;
          const claimUrl = claimLinkForBox(b, { dataKeys: config.dataKeys, edgeDomain: config.edgeDomain, email: acct.email });
          if (claimUrl) void sendQuietly(emails.ready(acct.email, { claimUrl, slug: b.slug, publicUrl: boxUrl(b.slug) }));
        }
        return { ok: true };
      }
      const email = normaliseEmail(input.email);
      if (!email) return refuse(400, "invalid_email", "Enter a valid email address.");
      if (!(await takeHit(db, LIMITS.resendPerEmail, email))) return refuse(429, "rate_limited", "We already re-sent it a few times. Check your inbox, or try again in an hour.");
      const [acct] = await db.select().from(accounts).where(eq(accounts.email, email));
      if (!acct || acct.status === "blocked" || acct.status === "deleted") return { ok: true };
      const [pending] = await db
        .select()
        .from(signupRequests)
        .where(and(eq(signupRequests.accountId, acct.id), isNull(signupRequests.verifiedAt)))
        .orderBy(sql`${signupRequests.createdAt} desc`)
        .limit(1);
      if (!pending) return { ok: true };
      // The name must still be free for this person.
      if (!(await checkSlug(pending.slug, acct.id)).available) return { ok: true };
      // The hold never stretches past MAX_HOLD_MS from the signup.
      const holdEnds = new Date(pending.createdAt.getTime() + MAX_HOLD_MS);
      if (holdEnds.getTime() <= now().getTime()) return { ok: true };
      const t = await issueToken(acct.id, "verify");
      const expiresAt = t.expiresAt < holdEnds ? t.expiresAt : holdEnds;
      await db.update(emailTokens).set({ expiresAt }).where(eq(emailTokens.id, t.id));
      await db.update(signupRequests).set({ emailTokenId: t.id, expiresAt }).where(eq(signupRequests.id, pending.id));
      void sendQuietly(emails.verify(email, { link: magicLink(t.token), slug: pending.slug }));
      return { ok: true };
    },

    async find(body: Record<string, unknown>, visitor: Visitor): Promise<{ ok: true } | Refusal> {
      if (mailer.configured === false) return refuse(503, "unavailable", "This is not available yet. Try again soon.");
      const email = normaliseEmail(body.email);
      if (!email) return refuse(400, "invalid_email", "Enter a valid email address.");
      if (!(await botCheck(body.turnstileToken, visitor.ip))) {
        return refuse(400, "bot_check_failed", "We could not confirm you are human. Reload the page and try again.");
      }
      if (visitor.ip && !(await takeHit(db, LIMITS.findPerIp, visitor.ip))) return refuse(429, "rate_limited", "Too many requests. Try again in an hour.");
      if (!(await takeHit(db, LIMITS.findPerEmail, email))) return { ok: true };
      const [acct] = await db.select().from(accounts).where(eq(accounts.email, email));
      // Unknown or unverified addresses get nothing: /find never mails a stranger.
      if (!acct || acct.status !== "active") return { ok: true };
      const rows = await liveBoxes(acct.id);
      try {
        if (!rows.length) {
          void sendQuietly(emails.findNone(email, { startUrl: `${site}/start` }));
          return { ok: true };
        }
        const t = await issueToken(acct.id, "find");
        const note = (s: BoxState) =>
          s === "active" ? "sign in there" : s === "awaiting_claim" ? "ready: open it from the link below" : s === "suspended" ? "paused: visiting it wakes it" : "being set up";
        void sendQuietly(emails.find(email, { signInLink: magicLink(t.token), boxes: rows.map((b) => ({ slug: b.slug, url: boxUrl(b.slug), note: note(b.state) })) }));
      } catch (err) {
        if (err instanceof MailNotConfigured) return refuse(503, "unavailable", "This is not available yet. Try again soon.");
        throw err;
      }
      return { ok: true };
    },

    /** After an operator approves a waitlist entry: tell the person, with a link to the progress page. */
    async notifyApproved(accountId: string, slug: string, provisioning: boolean): Promise<void> {
      const [acct] = await db.select().from(accounts).where(eq(accounts.id, accountId));
      if (!acct || acct.status !== "active") return;
      const t = await issueToken(acct.id, "find");
      await sendQuietly(emails.approved(acct.email, { slug, signInLink: magicLink(t.token), provisioning }));
    },

    /**
     * Approved entries whose box still waits (provisioning was off, or the
     * daily cap was spent when they were approved) get their job once the
     * gates open, oldest approval first. Stops at the first box that has to
     * keep waiting: the gate that held it holds the rest.
     */
    async releaseApproved(limit = 20): Promise<Array<{ slug: string; outcome: string }>> {
      const rows = await db
        .select({ boxId: boxes.id, slug: boxes.slug })
        .from(waitlist)
        .innerJoin(boxes, and(eq(boxes.accountId, waitlist.accountId), eq(boxes.state, "waitlisted")))
        .where(eq(waitlist.state, "approved"))
        .orderBy(asc(waitlist.approvedAt))
        .limit(limit);
      const out: Array<{ slug: string; outcome: string }> = [];
      for (const r of rows) {
        const result = await requestProvision(db, r.boxId, { actor: "waitlist-release", approved: true });
        out.push({ slug: r.slug, outcome: result.outcome });
        if (result.outcome === "waitlisted") break;
      }
      return out;
    },

    /** The ready email (spec §1 step 5): once per box, when it reaches awaiting_claim with a claim code. */
    async sendReadyEmails(): Promise<number> {
      const rows = await db
        .select({ box: boxes, email: accounts.email })
        .from(boxes)
        .innerJoin(accounts, eq(accounts.id, boxes.accountId))
        .where(and(
          eq(boxes.state, "awaiting_claim"),
          sql`${boxes.claimCodeEnc} is not null`,
          sql`not exists (select 1 from box_events e where e.box_id = ${boxes.id} and e.kind = 'ready_email_sent')`,
        ))
        .limit(50);
      let sent = 0;
      for (const { box, email } of rows) {
        const claimUrl = claimLinkForBox(box, { dataKeys: config.dataKeys, edgeDomain: config.edgeDomain, email });
        if (!claimUrl) continue;
        try {
          await send(emails.ready(email, { claimUrl, slug: box.slug, publicUrl: boxUrl(box.slug) }));
        } catch (err) {
          log.error("ready email failed; retried on the next pass", { err, slug: box.slug });
          continue;
        }
        await db.insert(boxEvents).values({ boxId: box.id, kind: "ready_email_sent", actor: "front-door", detail: {} });
        sent += 1;
      }
      return sent;
    },
  };
}

export type FrontDoor = ReturnType<typeof frontDoor>;
