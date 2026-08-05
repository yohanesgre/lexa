-- Revoke the repo-public dev seed key shipped in scripts/seed-dev.sql (audit fix).
DELETE FROM api_keys WHERE name = 'dev-local' OR id = 'seed-key-01';
