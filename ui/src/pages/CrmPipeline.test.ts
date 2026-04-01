import { describe, expect, it } from "vitest";
import {
  buildCrmMutationPayloads,
  crmQueryKeysForCompany,
  sanitizeCurrencyToCents,
  summarizeCrmCujCoverage,
} from "./CrmPipeline";

describe("CRM helpers", () => {
  it("builds normalized CRM mutation payloads", () => {
    const payloads = buildCrmMutationPayloads({
      account: {
        name: " Acme ",
        domain: " acme.com ",
        industry: "",
        size: " mid-market ",
        stage: "customer",
      },
      deal: {
        name: " Expansion ",
        accountId: "account-1",
        stage: "proposal",
        amount: "12,500",
        currency: "",
        closeDate: "2026-05-01",
        probability: "80",
      },
      lead: {
        firstName: " Ada ",
        lastName: " Lovelace ",
        email: " ada@example.com ",
        phone: "",
        company: " Acme ",
        title: "",
        source: " outbound ",
        status: "new",
        score: "",
      },
      partner: {
        name: " Channel One ",
        type: "referral",
        contactName: " Pat ",
        contactEmail: " pat@example.com ",
        website: "",
        status: "active",
        tier: "gold",
      },
    });

    expect(payloads.account).toEqual({
      name: "Acme",
      domain: "acme.com",
      industry: null,
      size: "mid-market",
      stage: "customer",
    });
    expect(payloads.deal).toEqual({
      name: "Expansion",
      accountId: "account-1",
      stage: "proposal",
      amountCents: "1250000",
      currency: "USD",
      closeDate: "2026-05-01T00:00:00.000Z",
      probability: "80",
    });
    expect(payloads.lead).toEqual({
      firstName: "Ada",
      lastName: "Lovelace",
      email: "ada@example.com",
      phone: null,
      company: "Acme",
      title: null,
      source: "outbound",
      status: "new",
      score: null,
    });
    expect(payloads.partner).toEqual({
      name: "Channel One",
      type: "referral",
      contactName: "Pat",
      contactEmail: "pat@example.com",
      website: null,
      status: "active",
      tier: "gold",
    });
  });

  it("converts currency strings into cents", () => {
    expect(sanitizeCurrencyToCents("1,234.56")).toBe("123456");
    expect(sanitizeCurrencyToCents("")).toBeNull();
    expect(sanitizeCurrencyToCents(" 2500 ")).toBe("250000");
  });

  it("returns the CRM query keys that should be invalidated after a mutation", () => {
    expect(crmQueryKeysForCompany("company-1")).toEqual([
      ["crm", "company-1", "pipeline"],
      ["crm", "company-1", "accounts"],
      ["crm", "company-1", "deals"],
      ["crm", "company-1", "leads"],
      ["crm", "company-1", "partners"],
      ["crm", "company-1", "hubspot"],
    ]);
  });

  it("summarizes CRM CUJ coverage against the implemented actions", () => {
    expect(
      summarizeCrmCujCoverage({
        hasCreateAccount: true,
        hasCreateDeal: true,
        hasCreateLead: true,
        hasCreatePartner: true,
        hasHubspotConnect: true,
        hasHubspotSync: true,
      }),
    ).toEqual({
      supported: ["T10", "CUJ-3", "CUJ-8", "CUJ-10"],
      missing: [],
    });

    expect(
      summarizeCrmCujCoverage({
        hasCreateAccount: false,
        hasCreateDeal: true,
        hasCreateLead: false,
        hasCreatePartner: false,
        hasHubspotConnect: false,
        hasHubspotSync: false,
      }),
    ).toEqual({
      supported: ["CUJ-8"],
      missing: ["T10", "CUJ-3", "CUJ-10"],
    });
  });
});
