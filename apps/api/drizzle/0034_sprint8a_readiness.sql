-- Sprint 8a (ADR-036): sign-in limits shared by every API server, so the API can run on more than one.
CREATE TABLE IF NOT EXISTS throttle_hits (
  key varchar(255) PRIMARY KEY,
  hits integer NOT NULL DEFAULT 0,
  window_ends_at timestamptz NOT NULL,
  blocked_until timestamptz
);
CREATE INDEX IF NOT EXISTS throttle_hits_window_idx ON throttle_hits (window_ends_at);
