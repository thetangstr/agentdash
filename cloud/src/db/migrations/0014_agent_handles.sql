CREATE TABLE "agent_handles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"signup_request_id" uuid,
	"ip" text,
	"expires_at" timestamp with time zone NOT NULL,
	"connect_challenge_id" text,
	"connect_sealed" text,
	"connect_expires_at" timestamp with time zone,
	"connect_requests" integer DEFAULT 0 NOT NULL,
	"connected_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_handles" ADD CONSTRAINT "agent_handles_signup_request_id_signup_requests_id_fk" FOREIGN KEY ("signup_request_id") REFERENCES "public"."signup_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_handles_token_hash_uq" ON "agent_handles" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_handles_signup_request_uq" ON "agent_handles" USING btree ("signup_request_id");