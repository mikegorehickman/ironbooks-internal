export interface KanbanBookkeeper {
  id: string;
  full_name: string;
  avatar_url: string | null;
}

export interface KanbanCard {
  id: string;
  client_name: string;
  jurisdiction: string;
  state_province: string | null;
  stripe_detected: boolean;
  stripe_connected: boolean;
  stripe_pending: boolean;
  stripe_request_sent_at: string | null;
  stripe_link_sent_by: string | null;
  stripe_link_sent_at: string | null;
  due_date: string | null;
  note_count: number;
  bookkeeper: KanbanBookkeeper | null;
  latest_coa_job: { id: string; status: string } | null;
  latest_reclass_job: { id: string; status: string; month_closed_at?: string | null } | null;
}

export interface KanbanColumn {
  cards: KanbanCard[];
  total: number;
}

export type OnboardingStage =
  | "needs_cleanup"
  | "coa_in_progress"
  | "reclass_in_progress"
  | "review"
  | "awaiting_stripe";

export type MomStage = "month_open" | "in_progress" | "review_send" | "month_closed";
