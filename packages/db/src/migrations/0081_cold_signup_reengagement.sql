-- cold-signup re-engagement email (#228)
-- Tracks which users have received the one-time "your CoS is waiting" email
-- so we send it at most once per user.
CREATE TABLE reengagement_emails (
  id          uuid      PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     text      NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  sent_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT  reengagement_emails_user_id_key UNIQUE (user_id)
);

CREATE INDEX reengagement_emails_sent_at_idx ON reengagement_emails (sent_at);
