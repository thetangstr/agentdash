ALTER TABLE "invite_codes" ADD COLUMN "purpose" text DEFAULT 'self_hosted' NOT NULL;--> statement-breakpoint
ALTER TABLE "invite_codes" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "invite_codes" ADD COLUMN "consumed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "invite_codes" ADD COLUMN "consumed_by_account_id" uuid;--> statement-breakpoint
ALTER TABLE "invite_codes" ADD COLUMN "consumed_box_id" uuid;--> statement-breakpoint
ALTER TABLE "signup_requests" ADD COLUMN "hosted_invite_id" uuid;--> statement-breakpoint
ALTER TABLE "invite_codes" ADD CONSTRAINT "invite_codes_consumed_by_account_id_accounts_id_fk" FOREIGN KEY ("consumed_by_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite_codes" ADD CONSTRAINT "invite_codes_consumed_box_id_boxes_id_fk" FOREIGN KEY ("consumed_box_id") REFERENCES "public"."boxes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signup_requests" ADD CONSTRAINT "signup_requests_hosted_invite_id_invite_codes_id_fk" FOREIGN KEY ("hosted_invite_id") REFERENCES "public"."invite_codes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite_codes" ADD CONSTRAINT "invite_codes_purpose_ck" CHECK (purpose in ('self_hosted', 'hosted_beta'));--> statement-breakpoint
ALTER TABLE "invite_codes" ADD CONSTRAINT "invite_codes_consumption_ck" CHECK ((
      ("invite_codes"."consumed_at" is null and "invite_codes"."consumed_by_account_id" is null and "invite_codes"."consumed_box_id" is null)
      or ("invite_codes"."purpose" = 'hosted_beta' and "invite_codes"."consumed_at" is not null and "invite_codes"."consumed_by_account_id" is not null and "invite_codes"."consumed_box_id" is not null)
    ));