ALTER TABLE "agent_templates" ADD COLUMN "department_id" uuid;--> statement-breakpoint
ALTER TABLE "goals" ADD COLUMN "priority" text DEFAULT 'medium';--> statement-breakpoint
ALTER TABLE "goals" ADD COLUMN "target_date" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_templates" ADD CONSTRAINT "agent_templates_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE no action ON UPDATE no action;