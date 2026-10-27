-- Explicit staffing demand, independent from private administrative notes.
ALTER TABLE escala.shifts ADD COLUMN IF NOT EXISTS capacity integer CHECK(capacity >= 0 AND capacity <= 500);
UPDATE escala.shifts SET capacity=(regexp_match(notes,'Capacidade de referência: ([0-9]+) médicos'))[1]::integer
WHERE capacity IS NULL AND notes ~ 'Capacidade de referência: [0-9]+ médicos';
CREATE TABLE IF NOT EXISTS escala.vacancy_requests (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), shift_id uuid NOT NULL REFERENCES escala.shifts(id),
 doctor_id uuid NOT NULL REFERENCES escala.doctors(id), user_id uuid NOT NULL REFERENCES escala.users(id),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','cancelled')),
 snapshot jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 decided_at timestamptz, decided_by uuid REFERENCES escala.users(id), decision_note text,
 assignment_id uuid REFERENCES escala.assignments(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS vacancy_requests_one_pending ON escala.vacancy_requests(shift_id,doctor_id) WHERE status='pending';
CREATE INDEX IF NOT EXISTS vacancy_requests_shift_pending ON escala.vacancy_requests(shift_id) WHERE status='pending';
