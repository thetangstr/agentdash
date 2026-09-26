CREATE TABLE "operator_audit" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"actor" text NOT NULL,
	"ip" text,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operator_audit_kind_ck" CHECK (kind in ('setting_changed', 'admin_refused'))
);
--> statement-breakpoint
CREATE INDEX "operator_audit_kind_idx" ON "operator_audit" USING btree ("kind","created_at");--> statement-breakpoint
-- AgentDash (GH #778): allowed state transitions, enforced in the database.
-- One function for every table: TG_ARGV[0] is the state column, TG_ARGV[1] a
-- JSON object {from: [to, ...]}, TG_ARGV[2] a JSON array of initial states.
-- The maps mirror BOX_TRANSITIONS, JOB_TRANSITIONS and ACCOUNT_TRANSITIONS in
-- src/db/schema.ts; db.test.ts checks every pair against the database.
CREATE FUNCTION "cloud_enforce_state_transition"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
	col text := TG_ARGV[0];
	allowed jsonb := TG_ARGV[1]::jsonb;
	initial jsonb := TG_ARGV[2]::jsonb;
	new_state text := to_jsonb(NEW) ->> col;
	old_state text;
BEGIN
	IF TG_OP = 'INSERT' THEN
		IF NOT (initial ? new_state) THEN
			RAISE EXCEPTION 'illegal initial %.%: %', TG_TABLE_NAME, col, new_state
				USING ERRCODE = 'check_violation';
		END IF;
		RETURN NEW;
	END IF;
	old_state := to_jsonb(OLD) ->> col;
	IF new_state IS DISTINCT FROM old_state
		AND NOT (COALESCE(allowed -> old_state, '[]'::jsonb) ? new_state) THEN
		RAISE EXCEPTION 'illegal %.% transition: % -> %', TG_TABLE_NAME, col, old_state, new_state
			USING ERRCODE = 'check_violation';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "boxes_state_transition" BEFORE INSERT OR UPDATE OF "state" ON "boxes"
FOR EACH ROW EXECUTE FUNCTION "cloud_enforce_state_transition"(
	'state',
	'{"requested":["waitlisted","provisioning","failed","deleted"],"waitlisted":["provisioning","deleted"],"provisioning":["awaiting_claim","failed"],"awaiting_claim":["active","failed","cleanup"],"active":["suspended","pending_delete"],"suspended":["active","pending_delete"],"pending_delete":["deleted"],"failed":["provisioning","cleanup"],"cleanup":["deleted","failed"],"deleted":[]}',
	'["requested","waitlisted"]'
);
--> statement-breakpoint
CREATE TRIGGER "jobs_state_transition" BEFORE INSERT OR UPDATE OF "state" ON "jobs"
FOR EACH ROW EXECUTE FUNCTION "cloud_enforce_state_transition"(
	'state',
	'{"queued":["running","dead"],"running":["queued","succeeded","failed","dead"],"failed":["queued","dead"],"succeeded":[],"dead":[]}',
	'["queued"]'
);
--> statement-breakpoint
CREATE TRIGGER "accounts_status_transition" BEFORE INSERT OR UPDATE OF "status" ON "accounts"
FOR EACH ROW EXECUTE FUNCTION "cloud_enforce_state_transition"(
	'status',
	'{"pending_verification":["active","blocked","deleted"],"active":["blocked","deleted"],"blocked":["active","deleted"],"deleted":[]}',
	'["pending_verification"]'
);
--> statement-breakpoint
-- AgentDash (GH #778): audit tables are append-only against APPLICATION
-- CODE. These triggers (like the state-transition triggers above) stop a
-- buggy or careless query issued by the service; they do NOT stop a
-- compromised connection. The service connects as the role that owns these
-- tables, and an owner (no superuser needed) can ALTER TABLE ... DISABLE
-- TRIGGER, DROP TRIGGER, CREATE OR REPLACE the trigger functions, or DROP
-- TABLE box_events outright. Real tamper resistance needs the owner/runtime
-- role split (migrations as the owner, the service as a role with only
-- INSERT/SELECT on the audit tables and no ownership), tracked for SC-2.
CREATE FUNCTION "cloud_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION '% is append-only: % refused', TG_TABLE_NAME, TG_OP
		USING ERRCODE = 'insufficient_privilege';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "box_events_append_only" BEFORE UPDATE OR DELETE ON "box_events"
FOR EACH ROW EXECUTE FUNCTION "cloud_append_only"();
--> statement-breakpoint
CREATE TRIGGER "box_events_no_truncate" BEFORE TRUNCATE ON "box_events"
FOR EACH STATEMENT EXECUTE FUNCTION "cloud_append_only"();
--> statement-breakpoint
CREATE TRIGGER "operator_audit_append_only" BEFORE UPDATE OR DELETE ON "operator_audit"
FOR EACH ROW EXECUTE FUNCTION "cloud_append_only"();
--> statement-breakpoint
CREATE TRIGGER "operator_audit_no_truncate" BEFORE TRUNCATE ON "operator_audit"
FOR EACH STATEMENT EXECUTE FUNCTION "cloud_append_only"();
--> statement-breakpoint
-- No effect today: PUBLIC never held these privileges, and the owner's are
-- not affected by a REVOKE from PUBLIC. Kept only as a statement of intent;
-- the runtime role in the SC-2 role split is where the grant is withheld.
REVOKE UPDATE, DELETE, TRUNCATE ON "box_events", "operator_audit" FROM PUBLIC;
