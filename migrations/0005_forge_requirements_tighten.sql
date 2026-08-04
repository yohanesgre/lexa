-- Tighten the Requirements builtin: checklist-only output, no design
-- proposals or background (the model was replacing whole documents with
-- 10k-char design specs). Idempotent — 0001/0004 already carry the same
-- text, so this is a no-op on fresh installs and only rewrites DBs that
-- applied the earlier migrations before the tighten.

UPDATE forge_skills SET
  instructions = 'Write only the task''s requirements — what must hold when it''s done. One concrete, verifiable condition per checkbox item (- [ ]). No design proposals or background. Output only the checklist.'
WHERE id = 'requirements' AND is_builtin = 1;
