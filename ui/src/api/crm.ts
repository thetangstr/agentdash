// AgentDash: CRM API stub
const stub = async () => ({ data: [] as unknown[] });

export const crmApi = {
  pipeline: async (companyId: string) => stub(),
  accounts: async (companyId: string) => stub(),
  deals: async (companyId: string) => stub(),
  leads: async (companyId: string) => stub(),
  partners: async (companyId: string) => stub(),
  hubspotConfig: async (companyId: string) => ({ configured: false }),
  createAccount: async (companyId: string, data: unknown) => stub(),
  createDeal: async (companyId: string, data: unknown) => stub(),
  createLead: async (companyId: string, data: unknown) => stub(),
  createPartner: async (companyId: string, data: unknown) => stub(),
  updateAccount: async (companyId: string, id: string, data: unknown) => stub(),
  updateDeal: async (companyId: string, id: string, data: unknown) => stub(),
  updateLead: async (companyId: string, id: string, data: unknown) => stub(),
  updatePartner: async (companyId: string, id: string, data: unknown) => stub(),
  deleteAccount: async (companyId: string, id: string) => stub(),
  deleteDeal: async (companyId: string, id: string) => stub(),
  deleteLead: async (companyId: string, id: string) => stub(),
  deletePartner: async (companyId: string, id: string) => stub(),
};
