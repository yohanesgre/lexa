-- Fix stale herald_models kind inferred from single provider kind (pre per-model inference).
-- OpenCode Go /v1/models returns no kind; correct mapping per https://opencode.ai/docs/go
-- herald_models has no updated_at column (see 0017), so only fix kind here.
UPDATE herald_models SET kind='anthropic_compatible' WHERE lower(model_id) LIKE 'minimax-%' AND kind != 'anthropic_compatible';
UPDATE herald_models SET kind='anthropic_compatible' WHERE lower(model_id) LIKE 'qwen%' AND kind != 'anthropic_compatible';
UPDATE herald_models SET kind='openai_responses' WHERE lower(model_id) LIKE 'muse-%' AND kind != 'openai_responses';
UPDATE herald_models SET kind='openai_responses' WHERE lower(model_id) LIKE 'grok-%' AND kind != 'openai_responses';
UPDATE herald_models SET kind='openai_responses' WHERE lower(model_id) LIKE 'gpt-%' AND kind != 'openai_responses';
