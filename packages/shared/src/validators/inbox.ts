import { z } from "zod";

export const inboxListQuerySchema = z.object({
  status: z.enum(["pending", "approved", "rejected", "all"]).default("all"),
  agentId: z.string().uuid().optional(),
  search: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export type InboxListQuery = z.infer<typeof inboxListQuerySchema>;

export const inboxRejectSchema = z.object({
  reason: z.string().min(1).max(1000),
});

export type InboxReject = z.infer<typeof inboxRejectSchema>;
