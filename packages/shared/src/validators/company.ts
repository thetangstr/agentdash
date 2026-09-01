import { z } from "zod";
import {
  COMPANY_PRODUCT_PROFILES,
  COMPANY_STATUSES,
  MAX_COMPANY_ATTACHMENT_MAX_BYTES,
} from "../constants.js";

const logoAssetIdSchema = z.string().uuid().nullable().optional();
const brandColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional();
const feedbackDataSharingTermsVersionSchema = z.string().min(1).nullable().optional();
const attachmentMaxBytesSchema = z
  .number()
  .int()
  .min(1)
  .max(MAX_COMPANY_ATTACHMENT_MAX_BYTES);

export const createCompanySchema = z.object({
  name: z.string().min(1),
  description: z.string().optional().nullable(),
  productProfile: z.enum(COMPANY_PRODUCT_PROFILES).optional(),
  /**
   * AgentDash-MK: an invite code that authorizes a non-default
   * `productProfile`. Authorization input only — the route strips it before
   * the company row is written, so it never reaches the database or a
   * portability export.
   */
  inviteCode: z.string().trim().min(1).max(120).optional(),
  budgetMonthlyCents: z.number().int().nonnegative().optional().default(0),
  attachmentMaxBytes: attachmentMaxBytesSchema.optional(),
});

export type CreateCompany = z.infer<typeof createCompanySchema>;

export const updateCompanySchema = createCompanySchema
  .partial()
  .extend({
    status: z.enum(COMPANY_STATUSES).optional(),
    spentMonthlyCents: z.number().int().nonnegative().optional(),
    requireBoardApprovalForNewAgents: z.boolean().optional(),
    feedbackDataSharingEnabled: z.boolean().optional(),
    feedbackDataSharingConsentAt: z.coerce.date().nullable().optional(),
    feedbackDataSharingConsentByUserId: z.string().min(1).nullable().optional(),
    feedbackDataSharingTermsVersion: feedbackDataSharingTermsVersionSchema,
    brandColor: brandColorSchema,
    logoAssetId: logoAssetIdSchema,
    attachmentMaxBytes: attachmentMaxBytesSchema.optional(),
  });

export type UpdateCompany = z.infer<typeof updateCompanySchema>;

export const updateCompanyBrandingSchema = z
  .object({
    name: z.string().min(1).optional(),
    description: z.string().nullable().optional(),
    brandColor: brandColorSchema,
    logoAssetId: logoAssetIdSchema,
  })
  .strict()
  .refine(
    (value) =>
      value.name !== undefined
      || value.description !== undefined
      || value.brandColor !== undefined
      || value.logoAssetId !== undefined,
    "At least one branding field must be provided",
  );

export type UpdateCompanyBranding = z.infer<typeof updateCompanyBrandingSchema>;

/**
 * What an AGENT may change about how the company presents itself.
 *
 * The colour and the logo, and nothing else. A company's name and description
 * are its identity — the answer to "who are we" — and that belongs with the
 * people who set direction, not with something acting on their behalf.
 *
 * This is not hypothetical. Probed on the live uat instance: a CEO-role agent
 * PATCHed the company to "RENAMED BY CEO AGENT" and rewrote its description,
 * both confirmed in the database, through two separate routes. The role check
 * was there; the field list was not, so `updateCompanyBrandingSchema` — which
 * exists for humans and legitimately carries name and description — was doing
 * double duty as the agent's permission boundary.
 *
 * `.strict()` matters here: without it an agent could send `name` and have it
 * silently pass through rather than be refused.
 */
export const agentCompanyBrandingSchema = z
  .object({
    brandColor: brandColorSchema,
    logoAssetId: logoAssetIdSchema,
  })
  .strict()
  .refine(
    (value) => value.brandColor !== undefined || value.logoAssetId !== undefined,
    "At least one branding field must be provided",
  );

export type AgentCompanyBranding = z.infer<typeof agentCompanyBrandingSchema>;
