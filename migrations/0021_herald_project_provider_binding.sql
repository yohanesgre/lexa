-- Herald project provider binding (exp-20): per-project primary provider/model.
ALTER TABLE herald_settings ADD COLUMN provider_id TEXT REFERENCES herald_providers(id) ON DELETE SET NULL;
ALTER TABLE herald_settings ADD COLUMN primary_model_id TEXT;
