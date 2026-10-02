import type { UIAdapterModule } from "../types";
import { buildHermesConfig } from "hermes-paperclip-adapter/ui";
import { SchemaConfigFields } from "../schema-config-fields";
import { createHermesStdoutParser, parseHermesStdoutLine } from "./parse-stdout";

export const hermesLocalUIAdapter: UIAdapterModule = {
  type: "hermes_local",
  label: "Hermes Agent",
  // AgentDash: structured transcript parser (stream-json + legacy -Q text).
  parseStdoutLine: parseHermesStdoutLine,
  createStdoutParser: createHermesStdoutParser,
  ConfigFields: SchemaConfigFields,
  buildAdapterConfig: buildHermesConfig,
};
