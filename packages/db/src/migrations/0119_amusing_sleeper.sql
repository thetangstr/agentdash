CREATE TABLE "project_access" (
	"project_id" uuid NOT NULL,
	"principal_type" text NOT NULL,
	"principal_id" text NOT NULL,
	"granted_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_access_project_id_principal_type_principal_id_pk" PRIMARY KEY("project_id","principal_type","principal_id")
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "created_by_user_id" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "created_by_user_id" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "visibility" text DEFAULT 'company' NOT NULL;--> statement-breakpoint
ALTER TABLE "project_access" ADD CONSTRAINT "project_access_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "projects_company_name_unique_idx" ON "projects" USING btree ("company_id",lower("name")) WHERE "projects"."archived_at" is null;--> statement-breakpoint
-- A3 backfill: existing rows belong to each company's first admin. Generic
-- rather than a hardcoded id; post-0117 every human admin row says 'admin'.
UPDATE "projects" p SET "created_by_user_id" = (
  SELECT m."principal_id" FROM "company_memberships" m
  WHERE m."company_id" = p."company_id" AND m."principal_type" = 'user'
    AND m."membership_role" = 'admin' AND m."status" = 'active'
  ORDER BY m."created_at" ASC LIMIT 1
) WHERE p."created_by_user_id" IS NULL;
--> statement-breakpoint
UPDATE "agents" a SET "created_by_user_id" = (
  SELECT m."principal_id" FROM "company_memberships" m
  WHERE m."company_id" = a."company_id" AND m."principal_type" = 'user'
    AND m."membership_role" = 'admin' AND m."status" = 'active'
  ORDER BY m."created_at" ASC LIMIT 1
) WHERE a."created_by_user_id" IS NULL;
