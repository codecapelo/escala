CREATE SCHEMA IF NOT EXISTS escala;
CREATE TABLE IF NOT EXISTS escala.doctors (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL CHECK(length(name) BETWEEN 2 AND 180),
 crm text, specialty text NOT NULL DEFAULT 'Telemedicina', color text NOT NULL DEFAULT '#147d83', active boolean NOT NULL DEFAULT true,
 source_key text UNIQUE, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS escala.users (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, email text NOT NULL UNIQUE,
 password_hash text, role text NOT NULL CHECK(role IN ('owner','admin','doctor')),
 doctor_id uuid UNIQUE REFERENCES escala.doctors(id), active boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now(), CHECK(role <> 'doctor' OR doctor_id IS NOT NULL)
);
CREATE TABLE IF NOT EXISTS escala.sessions (
 token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES escala.users(id), expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS escala.invites (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), token_hash text NOT NULL UNIQUE,
 email text NOT NULL, name text NOT NULL, role text NOT NULL CHECK(role IN ('owner','admin','doctor')),
 doctor_id uuid REFERENCES escala.doctors(id), created_by uuid REFERENCES escala.users(id),
 kind text NOT NULL DEFAULT 'invite' CHECK(kind IN ('invite','reset')), expires_at timestamptz NOT NULL,
 accepted_at timestamptz, revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS escala.months (
 month text PRIMARY KEY CHECK(month ~ '^20[0-9]{2}-(0[1-9]|1[0-2])$'), locked boolean NOT NULL DEFAULT false,
 locked_by uuid REFERENCES escala.users(id), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS escala.shifts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), date date NOT NULL, start_time time NOT NULL, end_time time NOT NULL,
 period text NOT NULL CHECK(period IN ('morning','afternoon','night','dawn')),
 unit text NOT NULL DEFAULT 'Amil • Telemedicina', notes text NOT NULL DEFAULT '', source text,
 source_key text UNIQUE, needs_review boolean NOT NULL DEFAULT false, cancelled_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), CHECK(start_time <> end_time)
);
CREATE TABLE IF NOT EXISTS escala.assignments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), shift_id uuid NOT NULL REFERENCES escala.shifts(id),
 doctor_id uuid NOT NULL REFERENCES escala.doctors(id), created_at timestamptz NOT NULL DEFAULT now(), removed_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS assignments_active_unique ON escala.assignments(shift_id,doctor_id) WHERE removed_at IS NULL;
CREATE TABLE IF NOT EXISTS escala.offers (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), assignment_id uuid NOT NULL REFERENCES escala.assignments(id),
 from_doctor_id uuid NOT NULL REFERENCES escala.doctors(id), to_doctor_id uuid REFERENCES escala.doctors(id),
 status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','accepted','cancelled')),
 note text NOT NULL DEFAULT '', created_by uuid REFERENCES escala.users(id), accepted_by uuid REFERENCES escala.users(id),
 created_at timestamptz NOT NULL DEFAULT now(), accepted_at timestamptz, cancelled_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS offers_one_open ON escala.offers(assignment_id) WHERE status='open';
CREATE TABLE IF NOT EXISTS escala.audit (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), actor_id uuid REFERENCES escala.users(id), actor_name text NOT NULL,
 action text NOT NULL, description text NOT NULL, metadata jsonb NOT NULL DEFAULT '{}',
 related_doctors uuid[] NOT NULL DEFAULT '{}', month text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION escala.protect_audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Audit records are append-only'; END; $$;
DROP TRIGGER IF EXISTS audit_immutable ON escala.audit;
CREATE TRIGGER audit_immutable BEFORE UPDATE OR DELETE ON escala.audit FOR EACH ROW EXECUTE FUNCTION escala.protect_audit();
CREATE TABLE IF NOT EXISTS escala.rate_limits (
 key text PRIMARY KEY, attempts integer NOT NULL DEFAULT 1, reset_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS escala.imports (
 sha256 text PRIMARY KEY, filename text NOT NULL, imported_at timestamptz NOT NULL DEFAULT now(), summary jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS shifts_date ON escala.shifts(date) WHERE cancelled_at IS NULL;
CREATE INDEX IF NOT EXISTS assignments_doctor ON escala.assignments(doctor_id) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS sessions_expiry ON escala.sessions(expires_at);
CREATE INDEX IF NOT EXISTS audit_month ON escala.audit(month,created_at DESC);
CREATE INDEX IF NOT EXISTS offers_status ON escala.offers(status);
