-- AgentDash (GH #765, SC-4): what the edge router may see and do, and nothing more.
-- The router connects as its own role (cloud_edge, created by the migrate
-- service) with SELECT on this view and EXECUTE on the two functions below,
-- no table privileges at all. The view runs with its owner's rights, so the
-- router reads these four columns without being able to read the tables.
CREATE VIEW "edge_routes" AS
	SELECT "slug", "state", "upstream_host", "edge_secret_enc"
	  FROM "boxes";
--> statement-breakpoint
-- Human activity per box (spec §4.3, §5.2), batched by the router. Only a
-- running, handed-over box is touched; health polls and the assistant
-- endpoint are excluded by the router before it calls this.
CREATE FUNCTION "edge_record_activity"("p_slugs" text[]) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
	n integer;
BEGIN
	UPDATE boxes SET last_human_request_at = now()
	 WHERE slug = ANY(p_slugs) AND state IN ('awaiting_claim', 'active');
	GET DIAGNOSTICS n = ROW_COUNT;
	RETURN n;
END;
$$;
--> statement-breakpoint
-- A visit to a suspended box asks for it to be woken (the resume job, SC-10).
-- At most one live resume job per box (jobs_one_live_per_box_kind_uq).
CREATE FUNCTION "edge_request_resume"("p_slug" text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
	b uuid;
BEGIN
	SELECT id INTO b FROM boxes WHERE slug = p_slug AND state = 'suspended';
	IF b IS NULL THEN
		RETURN false;
	END IF;
	INSERT INTO jobs (box_id, kind, payload) VALUES (b, 'resume', '{"requestedBy":"edge"}'::jsonb)
	ON CONFLICT DO NOTHING;
	RETURN true;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "edge_record_activity"(text[]) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "edge_request_resume"(text) FROM PUBLIC;
