// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { forbiddenTokenOffsets } from "../../../scripts/docs/forbidden-tokens.mjs";
import { NoCompaniesStartPage } from "./UnprefixedBoardRedirect";

vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ companies: [], selectedCompany: null, loading: false }) }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("first-run public content", () => {
  it("offers a neutral prompt with human approval and sourcing safeguards, and working manual setup", () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      act(() => root.render(<MemoryRouter initialEntries={["/guides"]}><Routes>
        <Route path="/guides" element={<NoCompaniesStartPage />} />
        <Route path="/company-create" element={<h1>Create company</h1>} />
      </Routes></MemoryRouter>));
      const prose = container.textContent ?? "";
      expect(forbiddenTokenOffsets(prose).length).toBe(0);
      expect(prose).toMatch(/human approv/i);
      expect(prose).toMatch(/source/i);
      const manual = [...container.querySelectorAll("button")].find((button) => /New Company/i.test(button.textContent ?? ""));
      expect(manual).toBeDefined();
      act(() => manual!.click());
      expect(container.querySelector("h1")?.textContent).toBe("Create company");
    } finally {
      act(() => root.unmount());
    }
  });
});
