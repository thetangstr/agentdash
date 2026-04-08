import { z } from "zod";

export const connectConnectorSchema = z.object({
  redirectUri: z.string().url().optional(),
});

export type ConnectConnector = z.infer<typeof connectConnectorSchema>;

export const connectorCallbackSchema = z.object({
  code: z.string().min(1),
  state: z.string().optional(),
});

export type ConnectorCallback = z.infer<typeof connectorCallbackSchema>;
