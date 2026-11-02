CREATE INDEX "cost_events_company_created_id_idx" ON "cost_events" USING btree ("company_id","created_at","id");--> statement-breakpoint
CREATE INDEX "heartbeat_runs_company_updated_id_idx" ON "heartbeat_runs" USING btree ("company_id","updated_at","id");--> statement-breakpoint
CREATE INDEX "issue_comments_company_created_id_idx" ON "issue_comments" USING btree ("company_id","created_at","id");--> statement-breakpoint
CREATE INDEX "issues_company_updated_id_idx" ON "issues" USING btree ("company_id","updated_at","id");