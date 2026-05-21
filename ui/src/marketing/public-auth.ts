type DeploymentMode = "local_trusted" | "authenticated";

export function isAuthenticatedDeployment(mode: DeploymentMode | undefined) {
  return mode === "authenticated";
}

export function isPublicVisitorLoggedIn(input: {
  deploymentMode: DeploymentMode | undefined;
  hasSession: boolean;
}) {
  if (input.deploymentMode === "local_trusted") return true;
  if (input.deploymentMode === "authenticated") return input.hasSession;
  return false;
}

