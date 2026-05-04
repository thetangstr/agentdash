CREATE TABLE "cos_onboarding_states" (
	"conversation_id" uuid PRIMARY KEY NOT NULL,
	"phase" text DEFAULT 'goals' NOT NULL,
	"goals" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"proposal_message_id" uuid,
	"turns_in_phase" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cos_onboarding_states" ADD CONSTRAINT "cos_onboarding_states_conversation_id_assistant_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."assistant_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cos_onboarding_states" ADD CONSTRAINT "cos_onboarding_states_proposal_message_id_assistant_messages_id_fk" FOREIGN KEY ("proposal_message_id") REFERENCES "public"."assistant_messages"("id") ON DELETE set null ON UPDATE no action;