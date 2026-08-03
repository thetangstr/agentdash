CREATE TABLE "external_channel_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"external_event_id" text NOT NULL,
	"event_type" text,
	"binding_id" uuid,
	"approval_revision" integer,
	"processing_state" text DEFAULT 'claimed' NOT NULL,
	"payload_digest" text,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "human_channel_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"agent_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"external_tenant_id" text,
	"external_user_id" text NOT NULL,
	"external_conversation_id" text,
	"metadata" jsonb,
	"verified_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "external_channel_events" ADD CONSTRAINT "external_channel_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_channel_events" ADD CONSTRAINT "external_channel_events_binding_id_human_channel_bindings_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."human_channel_bindings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "human_channel_bindings" ADD CONSTRAINT "human_channel_bindings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "human_channel_bindings" ADD CONSTRAINT "human_channel_bindings_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "external_channel_events_provider_company_event_uq" ON "external_channel_events" USING btree ("provider","company_id","external_event_id");--> statement-breakpoint
CREATE INDEX "external_channel_events_company_created_idx" ON "external_channel_events" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "human_channel_bindings_active_external_uq" ON "human_channel_bindings" USING btree ("company_id","provider","external_user_id") WHERE "human_channel_bindings"."revoked_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "human_channel_bindings_active_user_uq" ON "human_channel_bindings" USING btree ("company_id","provider","user_id") WHERE "human_channel_bindings"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "human_channel_bindings_provider_lookup_idx" ON "human_channel_bindings" USING btree ("provider","external_user_id");