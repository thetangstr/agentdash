-- AgentDash (GH #836 security review): rate_events is pruned. The runtime
-- role (cloud_app) has no DELETE anywhere, so pruning goes through this
-- SECURITY DEFINER function, owned by the migrating owner (cloud_owner in
-- split mode). It deletes only rate_events rows, and never rows younger than
-- one hour (the longest limit window), whatever the caller asks for, so it
-- cannot be used to clear a limit that is still counting.
CREATE FUNCTION "prune_rate_events"("p_older_than_seconds" integer) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
	n integer;
BEGIN
	DELETE FROM rate_events
	 WHERE created_at < now() - make_interval(secs => greatest(coalesce(p_older_than_seconds, 3600), 3600));
	GET DIAGNOSTICS n = ROW_COUNT;
	RETURN n;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "prune_rate_events"(integer) FROM PUBLIC;
