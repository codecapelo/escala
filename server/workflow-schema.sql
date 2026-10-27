-- Additive workflow migration. Existing accounts retain approved access.
ALTER TABLE escala.doctors ADD COLUMN IF NOT EXISTS crm_uf text;
ALTER TABLE escala.users ADD COLUMN IF NOT EXISTS approval_status text NOT NULL DEFAULT 'approved';
ALTER TABLE escala.users ADD COLUMN IF NOT EXISTS can_manage_schedule boolean NOT NULL DEFAULT false;
ALTER TABLE escala.users DROP CONSTRAINT IF EXISTS users_check;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='escala.users'::regclass AND conname='users_approval_status') THEN
  ALTER TABLE escala.users ADD CONSTRAINT users_approval_status CHECK (approval_status IN ('approved','pending','rejected'));
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='escala.users'::regclass AND conname='users_approved_doctor_link') THEN
  ALTER TABLE escala.users ADD CONSTRAINT users_approved_doctor_link CHECK (role<>'doctor' OR approval_status<>'approved' OR doctor_id IS NOT NULL);
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='escala.users'::regclass AND conname='users_unapproved_unlinked') THEN
  ALTER TABLE escala.users ADD CONSTRAINT users_unapproved_unlinked CHECK (approval_status='approved' OR (role='doctor' AND doctor_id IS NULL AND NOT can_manage_schedule));
 END IF;
END $$;
CREATE TABLE IF NOT EXISTS escala.registrations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id uuid NOT NULL UNIQUE REFERENCES escala.users(id),
 name text NOT NULL CHECK(length(name) BETWEEN 2 AND 180), email text NOT NULL,
 crm text NOT NULL CHECK(length(crm) BETWEEN 1 AND 40), crm_uf text NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
 matched_doctor_id uuid REFERENCES escala.doctors(id),
 created_at timestamptz NOT NULL DEFAULT now(), decided_at timestamptz,
 decided_by uuid REFERENCES escala.users(id), decision_note text
);
CREATE TABLE IF NOT EXISTS escala.corrections (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES escala.users(id),
 doctor_id uuid NOT NULL REFERENCES escala.doctors(id),
 type text NOT NULL CHECK(type IN ('profile','add_assignment','remove_assignment','change_assignment')),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','cancelled')),
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 3 AND 1000),
 proposed jsonb NOT NULL, before jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), decided_at timestamptz,
 decided_by uuid REFERENCES escala.users(id), decision_note text
);
CREATE INDEX IF NOT EXISTS registrations_status ON escala.registrations(status,created_at);
CREATE INDEX IF NOT EXISTS corrections_user ON escala.corrections(user_id,status,created_at);
CREATE INDEX IF NOT EXISTS corrections_status ON escala.corrections(status,created_at);
-- Transfers: an acceptance waits for administrative approval ('pending').
ALTER TABLE escala.offers ADD COLUMN IF NOT EXISTS requested_doctor_id uuid REFERENCES escala.doctors(id);
ALTER TABLE escala.offers ADD COLUMN IF NOT EXISTS requested_by uuid REFERENCES escala.users(id);
ALTER TABLE escala.offers ADD COLUMN IF NOT EXISTS requested_at timestamptz;
ALTER TABLE escala.offers ADD COLUMN IF NOT EXISTS approved_by uuid REFERENCES escala.users(id);
ALTER TABLE escala.offers ADD COLUMN IF NOT EXISTS approved_at timestamptz;
ALTER TABLE escala.offers ADD COLUMN IF NOT EXISTS decision_note text;
ALTER TABLE escala.offers DROP CONSTRAINT IF EXISTS offers_status_check;
ALTER TABLE escala.offers ADD CONSTRAINT offers_status_check CHECK(status IN ('open','pending','accepted','cancelled'));
DROP INDEX IF EXISTS escala.offers_one_open;
CREATE UNIQUE INDEX IF NOT EXISTS offers_one_active ON escala.offers(assignment_id) WHERE status IN ('open','pending');
-- Saved schedule models (a week pattern or a whole month snapshot).
CREATE TABLE IF NOT EXISTS escala.schedule_templates (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 name text NOT NULL CHECK(length(btrim(name)) BETWEEN 2 AND 80),
 kind text NOT NULL CHECK(kind IN ('week','month')),
 source_ref text NOT NULL, slots jsonb NOT NULL,
 created_by uuid REFERENCES escala.users(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS schedule_templates_name ON escala.schedule_templates(lower(btrim(name)));
-- Directed offers: only this doctor (plus the offerer and administrators) can see and accept it.
ALTER TABLE escala.offers ADD COLUMN IF NOT EXISTS target_doctor_id uuid REFERENCES escala.doctors(id);
