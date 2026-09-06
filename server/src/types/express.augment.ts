export {};

declare global {
  namespace Express {
    interface Request {
      actor: {
        type: "board" | "agent" | "none";
        userId?: string;
        userName?: string | null;
        userEmail?: string | null;
        agentId?: string;
        companyId?: string;
        companyIds?: string[];
        memberships?: Array<{
          companyId: string;
          membershipRole?: string | null;
          status?: string;
        }>;
        isInstanceAdmin?: boolean;
        keyId?: string;
        /** AgentDash (Company Evaluator, D11): what kind of principal the agent key mints. */
        principalKind?: "agent" | "evaluator";
        /** AgentDash (Company Evaluator, D11): a read-only principal — non-safe requests are refused unless allowlisted. */
        readOnly?: boolean;
        /** Set only for the `bridge_endpoint` source: which enrolled machine this is. */
        bridgeEndpointId?: string;
        runId?: string;
        source?:
          | "local_implicit"
          | "session"
          | "board_key"
          | "agent_key"
          | "agent_jwt"
          // AgentDash-MK: a human's enrolled local machine. Reaches ONLY the
          // bridge poll/result/decline routes — see BRIDGE_ENDPOINT_ROUTES.
          | "bridge_endpoint"
          | "none";
      };
    }
  }
}
