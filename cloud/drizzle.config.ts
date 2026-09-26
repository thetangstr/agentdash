import { defineConfig } from "drizzle-kit";

// AgentDash: the control plane's own schema and migrations. Never points at
// packages/db (the box schema).
export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
  dialect: "postgresql",
});
