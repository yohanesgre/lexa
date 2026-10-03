-- 0024_assistant_call_log_cached_write_in.sql — cache-write token attribution.
--
-- The provider usage payload distinguishes cache reads from cache writes
-- (Anthropic/OpenRouter `inputTokenDetails.cacheWriteTokens`). The call-log
-- cost formula already discounts both from fresh input and prices cache writes
-- at `assistant_model_prices.cached_write_price`; without a stored count a
-- DO-computed (non-explicit) cost could not be reproduced from the row.
-- Additive column, so a plain ALTER (no CHECK change, no rebuild required) —
-- same shape as 0022.
ALTER TABLE assistant_call_logs ADD COLUMN cached_write_in INTEGER NOT NULL DEFAULT 0;
