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
};
