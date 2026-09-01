CREATE TABLE "connector_send_executions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"approval_id" uuid NOT NULL,
	"connection_id" uuid,
	"requested_by_agent_id" uuid,
	"provider" text NOT NULL,
	"object_type" text NOT NULL,
	"operation" text NOT NULL,
	"payload_digest" text NOT NULL,
	"outcome" text NOT NULL,
	"external_id" text,
	"reason" text,
	"executed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb
);
--> statement-breakpoint
ALTER TABLE "connector_send_executions" ADD CONSTRAINT "connector_send_executions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_send_executions" ADD CONSTRAINT "connector_send_executions_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_send_executions" ADD CONSTRAINT "connector_send_executions_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_send_executions" ADD CONSTRAINT "connector_send_executions_requested_by_agent_id_agents_id_fk" FOREIGN KEY ("requested_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "connector_send_executions_approval_uq" ON "connector_send_executions" USING btree ("approval_id");--> statement-breakpoint
CREATE INDEX "connector_send_executions_company_idx" ON "connector_send_executions" USING btree ("company_id","outcome");