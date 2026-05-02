CREATE TABLE "assistant_conversation_participants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"role" varchar(32) DEFAULT 'member' NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_read_message_id" uuid,
	CONSTRAINT "acp_conversation_user_unique" UNIQUE("conversation_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "assistant_messages" ADD COLUMN "card_kind" varchar(32);--> statement-breakpoint
ALTER TABLE "assistant_messages" ADD COLUMN "card_payload" jsonb;--> statement-breakpoint
ALTER TABLE "assistant_conversation_participants" ADD CONSTRAINT "assistant_conversation_participants_conversation_id_assistant_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."assistant_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_conversation_participants" ADD CONSTRAINT "assistant_conversation_participants_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_conversation_participants" ADD CONSTRAINT "assistant_conversation_participants_last_read_message_id_assistant_messages_id_fk" FOREIGN KEY ("last_read_message_id") REFERENCES "public"."assistant_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "acp_conversation_idx" ON "assistant_conversation_participants" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "acp_user_idx" ON "assistant_conversation_participants" USING btree ("user_id");