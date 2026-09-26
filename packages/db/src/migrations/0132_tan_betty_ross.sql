CREATE TABLE "github_repo_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"project_workspace_id" uuid NOT NULL,
	"repo_full_name" text NOT NULL,
	"repo_owner" text NOT NULL,
	"repo_name" text NOT NULL,
	"default_branch" text,
	"credential_source" text DEFAULT 'pat' NOT NULL,
	"secret_id" uuid,
	"github_app_installation_id" text,
	"validation" jsonb,
	"validated_at" timestamp with time zone,
	"connected_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "github_repo_connections" ADD CONSTRAINT "github_repo_connections_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_repo_connections" ADD CONSTRAINT "github_repo_connections_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_repo_connections" ADD CONSTRAINT "github_repo_connections_project_workspace_id_project_workspaces_id_fk" FOREIGN KEY ("project_workspace_id") REFERENCES "public"."project_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_repo_connections" ADD CONSTRAINT "github_repo_connections_secret_id_company_secrets_id_fk" FOREIGN KEY ("secret_id") REFERENCES "public"."company_secrets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "github_repo_connections_company_idx" ON "github_repo_connections" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "github_repo_connections_project_idx" ON "github_repo_connections" USING btree ("company_id","project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "github_repo_connections_workspace_uq" ON "github_repo_connections" USING btree ("project_workspace_id");