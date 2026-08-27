-- Backfill legacy kind alias 'openai-chat' and 'openai' → openai_compatible; 'anthropic' → anthropic_compatible.
-- herald_models and herald_call_logs carried invalid kind values that bypassed app-level validation
-- and caused provider.ts else-branch (anthropic wire) to hit OpenAI endpoint → 500 → 502.
UPDATE herald_models SET kind = 'openai_compatible' WHERE kind IN ('openai-chat','openai');
UPDATE herald_models SET kind = 'anthropic_compatible' WHERE kind IN ('anthropic','anthropic-chat');
UPDATE herald_call_logs SET kind = 'openai_compatible' WHERE kind IN ('openai-chat','openai');
UPDATE herald_call_logs SET kind = 'anthropic_compatible' WHERE kind IN ('anthropic','anthropic-chat');
