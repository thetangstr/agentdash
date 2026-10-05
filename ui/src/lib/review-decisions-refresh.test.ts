import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { decisionsSourceKeys } from "../hooks/useDecisionsSources";
import { queryKeys } from "./queryKeys";
import { refetchAfterReviewDecision } from "./review-decisions-refresh";

describe("refetchAfterReviewDecision", () => {
  it("refetches shipped, work-products and waiting-on-you, and invalidates the decisions sources", async () => {
    const queryClient = new QueryClient();
    const refetchSpy = vi.spyOn(queryClient, "refetchQueries");
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    queryClient.setQueryData([...decisionsSourceKeys.joinRequests("company-1")], []);

    await refetchAfterReviewDecision(queryClient, "company-1", "issue-1");

    expect(refetchSpy).toHaveBeenCalledWith({ queryKey: ["shipped", "company-1"] });
    expect(refetchSpy).toHaveBeenCalledWith({ queryKey: queryKeys.issues.workProducts("issue-1") });
    expect(refetchSpy).toHaveBeenCalledWith({ queryKey: queryKeys.home.waitingOnYou("company-1") });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["decisions", "sources", "company-1"] });
    expect(
      queryClient.getQueryState([...decisionsSourceKeys.joinRequests("company-1")])?.isInvalidated,
    ).toBe(true);
  });
});
