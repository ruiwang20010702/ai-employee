DROP TABLE IF EXISTS decision_review_events;
ALTER TABLE decision_reviews DROP COLUMN IF EXISTS decision_sha256;
