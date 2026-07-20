-- Marks the cutover point after which upgrade changes belong in ordered,
-- checksummed migrations. Existing package schema files remain bootstrap and
-- compatibility definitions for this release.
SELECT 1;
