-- Run after server/schema.sql. Contains no source PDF or identifying fixtures.
CREATE TABLE IF NOT EXISTS escala.import_reviews (
 issue_id text PRIMARY KEY,
 resolved_at timestamptz NOT NULL DEFAULT now(),
 resolved_by uuid NOT NULL REFERENCES escala.users(id),
 note text NOT NULL CHECK (length(btrim(note)) BETWEEN 3 AND 1000)
);
CREATE TABLE IF NOT EXISTS escala.doctor_merges (
 source_doctor_id uuid PRIMARY KEY REFERENCES escala.doctors(id),
 target_doctor_id uuid NOT NULL REFERENCES escala.doctors(id),
 source_name text NOT NULL,
 target_name text NOT NULL,
 reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 1000),
 merged_by uuid NOT NULL REFERENCES escala.users(id),
 merged_at timestamptz NOT NULL DEFAULT now(),
 metadata jsonb NOT NULL DEFAULT '{}',
 CHECK (source_doctor_id <> target_doctor_id)
);
CREATE INDEX IF NOT EXISTS doctor_merges_target ON escala.doctor_merges(target_doctor_id);
