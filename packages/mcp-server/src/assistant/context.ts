import type { PaperclipApiClient } from "../client.js";

/**
 * AgentDash assistant MCP: the per-server context the nine tools share —
 * the company they answer about and the base for deep links.
 *
 * Deep links are built from the instance's `publicBaseUrl` (advertised on
 * /api/health), never the request host — the #663 lesson. When the instance
 * does not advertise one, the API origin is the honest fallback: it is where
 * this session actually reaches the server.
 */

export interface AssistantCompany {
  id: string;
  name: string;
  issuePrefix: string;
}

export class AssistantContext {
  private companyPromise: Promise<AssistantCompany> | null = null;
  private baseUrlPromise: Promise<string> | null = null;

  constructor(
    private readonly client: PaperclipApiClient,
    private readonly configuredCompanyId: string | null,
  ) {}

  get companyId(): string {
    if (!this.configuredCompanyId) {
      throw new Error(
        "companyId is required because PAPERCLIP_COMPANY_ID (or AGENTDASH_COMPANY_ID) is not set",
      );
    }
    return this.configuredCompanyId;
  }

  async company(): Promise<AssistantCompany> {
    this.companyPromise ??= this.client
      .requestJson<AssistantCompany>("GET", `/companies/${this.companyId}`)
      .then((row) => ({
        id: row.id,
        name: row.name,
        issuePrefix: row.issuePrefix ?? "PAP",
      }));
    return this.companyPromise;
  }

  /** `https://host` with no trailing slash — the origin deep links hang off. */
  async publicBaseUrl(): Promise<string> {
    this.baseUrlPromise ??= this.client
      .requestJson<{ publicBaseUrl?: string | null }>("GET", "/health")
      .then((health) => health?.publicBaseUrl?.trim() || this.client.appBaseUrl)
      .catch(() => this.client.appBaseUrl);
    return this.baseUrlPromise;
  }

  private async prefix(): Promise<string> {
    return (await this.company()).issuePrefix;
  }

  async issueLink(ref: string): Promise<string> {
    return `${await this.publicBaseUrl()}/${await this.prefix()}/issues/${ref}`;
  }

  async projectLink(id: string): Promise<string> {
    return `${await this.publicBaseUrl()}/${await this.prefix()}/projects/${id}`;
  }

  async agentLink(id: string): Promise<string> {
    return `${await this.publicBaseUrl()}/${await this.prefix()}/agents/${id}`;
  }

  async approvalLink(id: string): Promise<string> {
    return `${await this.publicBaseUrl()}/${await this.prefix()}/approvals/${id}`;
  }

  async homeLink(): Promise<string> {
    return `${await this.publicBaseUrl()}/${await this.prefix()}/dashboard`;
  }
}
