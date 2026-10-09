-- 0028_assistant_settings_vision_model.sql — revive the per-project vision
-- agent model (W1c). The vision agent is the model Assistant calls to analyze
-- every attached image (internal `analyze_image` delegation, suppressed from the
-- member-facing stream). Nullable and empty by default: nothing is preconfigured,
-- and while unset this project's image attach stays disabled (VISION_NOT_CONFIGURED
-- 409). CURRENT PHASE: whenever set, images ALWAYS route through it (delegate),
-- even when the primary model is multimodal; the per-model inline capability is
-- the later target. Additive column — a plain ALTER (same shape as 0022/0024).
ALTER TABLE assistant_settings ADD COLUMN vision_model TEXT;
