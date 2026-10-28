-- 0031_recovery_requests.sql
-- Operational admission ledger for self-service password recovery (Workers).
-- One conditional INSERT (server/auth-recovery.ts) checks all three rolling
-- limits atomically: 1/address/60s, 5/address/hour, 10/IP/10min. Only accepted
-- requests get a row; subjects are SHA-256 hashes, requested_at is epoch
-- seconds, and the Worker maintenance tick purges rows past the 1h horizon.
CREATE TABLE recovery_requests (
  id           TEXT PRIMARY KEY,
  address_hash TEXT NOT NULL,
  ip_hash      TEXT NOT NULL,
  requested_at INTEGER NOT NULL
);

CREATE INDEX recovery_requests_address_time_idx ON recovery_requests(address_hash, requested_at);
CREATE INDEX recovery_requests_ip_time_idx ON recovery_requests(ip_hash, requested_at);
CREATE INDEX recovery_requests_time_idx ON recovery_requests(requested_at);
