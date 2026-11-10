import type { BatchPreviewResult, BatchStatus, BatchView } from "@paperclipai/shared";
import { api } from "./client";

/**
 * AgentDash admin powers: the batch engine (doc/api/batches.md). A preview
 * names the exact records and the change to each; confirming spends the
 * single-use handle and the server sends each record through its own route.
 */
export interface BatchPreviewInput {
  kind: string;
  ids: string[];
  change: Record<string, unknown>;
}

export const batchesApi = {
  preview: (companyId: string, input: BatchPreviewInput) =>
    api.post<BatchPreviewResult>(`/companies/${companyId}/batches/preview`, input),
  confirm: (companyId: string, batchId: string, input: { handle: string; previewDigest: string }) =>
    api.post<{ batchId: string; status: BatchStatus }>(`/companies/${companyId}/batches/${batchId}/confirm`, input),
  get: (companyId: string, batchId: string) =>
    api.get<BatchView>(`/companies/${companyId}/batches/${batchId}`),
  cancel: (companyId: string, batchId: string) =>
    api.post<BatchView>(`/companies/${companyId}/batches/${batchId}/cancel`, {}),
  /**
   * Part 5: shows the code that confirms a batch the person's own Claude
   * prepared. Browser only; the code is in this response and nowhere else.
   * Never cache, store or log it.
   */
  confirmCode: (companyId: string, batchId: string) =>
    api.post<{ code: string; expiresAt: string }>(`/companies/${companyId}/batches/${batchId}/confirm-code`, {}),
  /** Part 5: "Apply here", with the person's own session. */
  applyHere: (companyId: string, batchId: string) =>
    api.post<{ batchId: string; status: BatchStatus }>(`/companies/${companyId}/batches/${batchId}/apply-here`, {}),
};
