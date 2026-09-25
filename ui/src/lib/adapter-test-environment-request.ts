// AgentDash (security): the body AgentConfigForm sends to
// POST /companies/:companyId/adapters/:type/test-environment.
//
// In edit mode the form resends the agent's stored config, which may carry a
// command, env or cwd an instance admin set. Naming the agent lets the server
// compare those fields against the STORED row, so an unchanged value does not
// require instance admin. Create mode has no stored row, so it sends no id.
export function buildTestEnvironmentRequest(input: {
  isCreate: boolean;
  agentId?: string | null;
  adapterConfig: Record<string, unknown>;
  environmentId?: string | null;
}): { adapterConfig: Record<string, unknown>; environmentId: string | null; agentId?: string } {
  const environmentId =
    typeof input.environmentId === "string" && input.environmentId.length > 0 ? input.environmentId : null;
  const body: { adapterConfig: Record<string, unknown>; environmentId: string | null; agentId?: string } = {
    adapterConfig: input.adapterConfig,
    environmentId,
  };
  if (!input.isCreate && input.agentId) body.agentId = input.agentId;
  return body;
}
