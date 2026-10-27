export type Role = "owner" | "admin" | "doctor";
export type Period = "morning" | "afternoon" | "night" | "dawn";
export interface User {
  id: string;
  name: string;
  email: string;
  role: Role;
  doctor_id: string | null;
  active?: boolean;
  approval_status?: "approved" | "pending" | "rejected";
  can_manage_schedule?: boolean;
}
export interface Doctor {
  id: string;
  name: string;
  crm: string | null;
  crm_uf?: string | null;
  specialty: string;
  active: boolean;
  user_id: string | null;
  color: string;
}
export interface Assignment {
  id: string;
  doctor_id: string;
  doctor_name: string;
  doctor_color: string;
  offer_id: string | null;
}
export interface Shift {
  month_locked?:boolean;
  id: string;
  date: string;
  start_time: string;
  end_time: string;
  period: Period;
  unit: string;
  notes?: string;
  capacity: number | null;
  available_vacancies: number;
  pending_vacancies: number;
  source: string | null;
  needs_review: boolean;
  assignments: Assignment[];
}
export interface Offer {
  id: string;
  assignment_id: string;
  from_doctor_id: string;
  from_name: string;
  to_doctor_id: string | null;
  to_name: string | null;
  status: "open" | "accepted" | "cancelled";
  created_at: string;
  accepted_at: string | null;
  date: string;
  start_time: string;
  end_time: string;
  period: Period;
  unit: string;
  note: string;
}
export interface Audit {
  id: string;
  action: string;
  actor_name: string;
  description: string;
  created_at: string;
  metadata: Record<string, unknown>;
}
export interface Dashboard {
  shifts: Shift[];
  doctors: Doctor[];
  offers: Offer[];
  audit: Audit[];
  locked: boolean;
  user: User;
  stats: { shifts: number; hours: number; doctors: number; openOffers: number };
}
export interface Invite {
  id: string;
  email: string;
  name: string;
  role: Role;
  doctor_id: string | null;
  expires_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
}
export interface Team {
  users: User[];
  invites: Invite[];
}
export interface ReportRow {
  doctor_id: string;
  name: string;
  crm: string | null;
  turns: number;
  hours: number;
  days: string[];
  morning: number;
  afternoon: number;
  night: number;
  dawn: number;
  shifts: {
    date: string;
    start_time: string;
    end_time: string;
    unit: string;
    period: Period;
  }[];
}
export interface Report {
  month: string;
  locked: boolean;
  totals: {
    doctors: number;
    shifts: number;
    assignments: number;
    hours: number;
  };
  rows: ReportRow[];
}
export interface Auth {
  user: User;
  doctor: Doctor | null;
  registration?: Registration | null;
}
export interface Registration {
 id:string; user_id:string; name:string; email:string; crm:string; crm_uf:string;
 status:"pending"|"approved"|"rejected"; matched_doctor_id:string|null; matched_doctor_name:string|null;
 created_at:string; decided_at:string|null; decision_note:string|null;
 candidates?:Array<{id:string;name:string;crm:string|null;crm_uf?:string|null;user_id?:string|null;active?:boolean}>;
}
export type CorrectionType="profile"|"add_assignment"|"remove_assignment"|"change_assignment";
export interface Correction {
 id:string;user_id:string;doctor_id:string;doctor_name:string;type:CorrectionType;
 status:"pending"|"approved"|"rejected"|"cancelled";reason:string;
 proposed:Record<string,unknown>;before:Record<string,unknown>;created_at:string;
 decided_at:string|null;decided_by_name:string|null;decision_note:string|null;
}
export type Page = "schedule" | "offers" | "team" | "reports" | "audit" | "corrections";
