// AgentDash: Feed API client
import { api } from "./client";

export interface FeedEvent {
  id: string;
  type: string;
  title: string;
  actorAgentId?: string | null;
  actorUserId?: string | null;
  refType?: string | null;
  refId?: string | null;
  at: string;
  meta?: Record<string, unknown>;
}

export interface FeedPage {
  events: FeedEvent[];
  nextCursor: string | null;
}

export const feedApi = {
  list: (
    companyId: string,
    opts: { cursor?: string | null; limit?: number } = {},
  ) => {
    const qs = new URLSearchParams();
    if (opts.cursor) qs.set("cursor", opts.cursor);
    if (opts.limit) qs.set("limit", String(opts.limit));
    const query = qs.toString();
    return api.get<FeedPage>(
      `/companies/${companyId}/feed${query ? `?${query}` : ""}`,
    );
  },
};
