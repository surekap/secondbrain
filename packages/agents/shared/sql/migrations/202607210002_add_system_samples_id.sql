-- Older telemetry.system_samples tables predate the row identifier used by
-- the sampler's targeted latest-sample updates. Preserve every historical
-- sample while upgrading the table to the current bootstrap schema.
ALTER TABLE telemetry.system_samples
  ADD COLUMN IF NOT EXISTS sample_id BIGSERIAL;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'telemetry.system_samples'::regclass
      AND contype = 'p'
  ) THEN
    ALTER TABLE telemetry.system_samples
      ADD CONSTRAINT system_samples_pkey PRIMARY KEY (sample_id);
  END IF;
END $$;
