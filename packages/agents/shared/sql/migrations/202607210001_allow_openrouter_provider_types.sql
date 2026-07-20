-- OpenRouter discovery exposes provider slugs beyond the original native
-- integrations. Keep structural validation while allowing those catalog values.
ALTER TABLE system.llm_providers
  DROP CONSTRAINT IF EXISTS llm_providers_provider_type_check;

ALTER TABLE system.llm_providers
  ADD CONSTRAINT llm_providers_provider_type_check
  CHECK (provider_type ~ '^[a-z0-9][a-z0-9_-]*$') NOT VALID;

ALTER TABLE system.llm_providers
  VALIDATE CONSTRAINT llm_providers_provider_type_check;
