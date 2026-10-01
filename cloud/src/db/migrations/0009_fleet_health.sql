CREATE TABLE "box_health" (
	"box_id" uuid NOT NULL,
	"path" text NOT NULL,
	"status" text DEFAULT 'unknown' NOT NULL,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"last_checked_at" timestamp with time zone,
	"last_ok_at" timestamp with time zone,
	"last_error" text,
	"release" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "box_health_path_ck" CHECK (path in ('direct', 'router')),
	CONSTRAINT "box_health_status_ck" CHECK (status in ('ok', 'failing', 'unknown'))
);
--> statement-breakpoint
CREATE TABLE "box_health_checks" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"box_id" uuid NOT NULL,
	"path" text NOT NULL,
	"ok" boolean NOT NULL,
	"http_status" integer,
	"latency_ms" integer,
	"error" text,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "box_health_checks_path_ck" CHECK (path in ('direct', 'router'))
);
--> statement-breakpoint
CREATE TABLE "box_idle_notices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"box_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"idle_since" timestamp with time zone NOT NULL,
	"sent_at" timestamp with time zone NOT NULL,
	CONSTRAINT "box_idle_notices_kind_ck" CHECK (kind in ('suspend_warning', 'delete_warning'))
);
--> statement-breakpoint
CREATE TABLE "edge_stats" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"replica" text NOT NULL,
	"requests" integer NOT NULL,
	"server_errors" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fleet_alerts" (
	"key" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"state" text NOT NULL,
	"subject" text NOT NULL,
	"box_id" uuid,
	"detail" jsonb,
	"first_fired_at" timestamp with time zone NOT NULL,
	"last_fired_at" timestamp with time zone NOT NULL,
	"last_notified_at" timestamp with time zone,
	"notify_count" integer DEFAULT 0 NOT NULL,
	"suppressed_count" integer DEFAULT 0 NOT NULL,
	"resolved_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fleet_alerts_state_ck" CHECK (state in ('firing', 'resolved'))
);
--> statement-breakpoint
CREATE TABLE "monitor_readings" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"subject" text NOT NULL,
	"value" double precision,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "monitor_readings_kind_ck" CHECK (kind in ('spend', 'cert', 'router_5xx'))
);
--> statement-breakpoint
ALTER TABLE "box_health" ADD CONSTRAINT "box_health_box_id_boxes_id_fk" FOREIGN KEY ("box_id") REFERENCES "public"."boxes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "box_health_checks" ADD CONSTRAINT "box_health_checks_box_id_boxes_id_fk" FOREIGN KEY ("box_id") REFERENCES "public"."boxes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "box_idle_notices" ADD CONSTRAINT "box_idle_notices_box_id_boxes_id_fk" FOREIGN KEY ("box_id") REFERENCES "public"."boxes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fleet_alerts" ADD CONSTRAINT "fleet_alerts_box_id_boxes_id_fk" FOREIGN KEY ("box_id") REFERENCES "public"."boxes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "box_health_box_path_uq" ON "box_health" USING btree ("box_id","path");--> statement-breakpoint
CREATE INDEX "box_health_checks_box_idx" ON "box_health_checks" USING btree ("box_id","checked_at");--> statement-breakpoint
CREATE INDEX "box_health_checks_time_idx" ON "box_health_checks" USING btree ("checked_at");--> statement-breakpoint
CREATE UNIQUE INDEX "box_idle_notices_period_uq" ON "box_idle_notices" USING btree ("box_id","kind","idle_since");--> statement-breakpoint
CREATE INDEX "edge_stats_time_idx" ON "edge_stats" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "fleet_alerts_state_idx" ON "fleet_alerts" USING btree ("state");--> statement-breakpoint
CREATE INDEX "monitor_readings_kind_idx" ON "monitor_readings" USING btree ("kind","subject","created_at");
--> statement-breakpoint
-- AgentDash (SC-10, GH #771): the edge router's request counts for the
-- router-5xx alert. The router's role (cloud_edge) has no table privilege;
-- it may only add one clamped row per flush through this function.
CREATE FUNCTION "edge_record_stats"("p_replica" text, "p_requests" integer, "p_server_errors" integer) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
	r integer := least(greatest(coalesce(p_requests, 0), 0), 10000000);
BEGIN
	INSERT INTO edge_stats (replica, requests, server_errors)
	VALUES (left(coalesce(nullif(p_replica, ''), 'unknown'), 64), r, least(greatest(coalesce(p_server_errors, 0), 0), r));
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "edge_record_stats"(text, integer, integer) FROM PUBLIC;
--> statement-breakpoint
-- History pruning for the runtime role (cloud_app has no DELETE): only
-- box_health_checks, edge_stats and monitor_readings rows, and never rows
-- younger than one day, whatever the caller asks for.
CREATE FUNCTION "prune_fleet_history"("p_older_than_seconds" integer) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
	cutoff timestamptz := now() - make_interval(secs => greatest(coalesce(p_older_than_seconds, 2592000), 86400));
	n integer;
	total integer := 0;
BEGIN
	DELETE FROM box_health_checks WHERE checked_at < cutoff;
	GET DIAGNOSTICS n = ROW_COUNT;
	total := total + n;
	DELETE FROM edge_stats WHERE created_at < cutoff;
	GET DIAGNOSTICS n = ROW_COUNT;
	total := total + n;
	DELETE FROM monitor_readings WHERE created_at < cutoff;
	GET DIAGNOSTICS n = ROW_COUNT;
	total := total + n;
	RETURN total;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "prune_fleet_history"(integer) FROM PUBLIC;
--> statement-breakpoint
-- A visit to a suspended box is human activity: besides queueing the resume
-- job (as in 0005), it restarts the idle clock, under the box's row lock, so
-- the idle sweep's move to pending_delete (which requires the clock unchanged
-- since it read the box) cannot race a wake. Same signature: grants are kept.
CREATE OR REPLACE FUNCTION "edge_request_resume"("p_slug" text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
	b uuid;
BEGIN
	SELECT id INTO b FROM boxes WHERE slug = p_slug AND state = 'suspended' FOR UPDATE;
	IF b IS NULL THEN
		RETURN false;
	END IF;
	UPDATE boxes SET last_human_request_at = now() WHERE id = b;
	INSERT INTO jobs (box_id, kind, payload) VALUES (b, 'resume', '{"requestedBy":"edge"}'::jsonb)
	ON CONFLICT DO NOTHING;
	RETURN true;
END;
$$;