import { createContext, useContext } from "react";

// AgentDash: the issue prefixes of the companies the viewer can see, used to decide
// which bare `PREFIX-123` tokens in markdown are issue references. CompanyProvider
// supplies it: an empty list until companies load. It lives apart from
// CompanyContext so MarkdownBody can read it without requiring a CompanyProvider
// (null outside one means "no company context").
export const IssuePrefixesContext = createContext<readonly string[] | null>(null);

export function useIssuePrefixes(): readonly string[] | null {
  return useContext(IssuePrefixesContext);
}
