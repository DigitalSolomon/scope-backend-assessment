/** A user's role is per theater: the same person can be admin at one theater and employee at another. */
export type MemberRole = "admin" | "employee";
export type ShowtimeStatus = "active" | "inactive" | "archived";
export type MovieStatus = "approved" | "draft" | "flagged" | "needs-review";

export const SHOWTIME_STATUSES: readonly ShowtimeStatus[] = ["active", "inactive", "archived"];
export const MOVIE_STATUSES: readonly MovieStatus[] = ["approved", "draft", "flagged", "needs-review"];

export interface Theater {
  id: string;
  name: string;
  location: string;
  timezone: string;
}

export interface TheaterMembership {
  theaterId: string;
  role: MemberRole;
}

/** Seed-data shape (src/data/assessment-data.ts). */
export interface AssessmentUser {
  id: string;
  name: string;
  email: string;
  memberships: TheaterMembership[];
}

// ------------------------------------------------------------ API shapes

export interface ApiUser {
  id: string;
  name: string;
  email: string;
  theaterCount: number;
  adminCount: number;
}

export interface ApiTheater extends Theater {
  role: MemberRole;
}

export interface ApiShowtime {
  id: string;
  theaterId: string;
  theaterName: string;
  movieId: string;
  movieTitle: string;
  movieStatus: MovieStatus;
  rating: string;
  auditorium: string;
  startTime: string;
  endTime: string;
  language: string;
  format: string;
  status: ShowtimeStatus;
  lastUpdated: string;
  /** The requesting user's role at this showtime's theater. */
  role: MemberRole;
}

export type ShowtimeSortField =
  | "movieTitle"
  | "startTime"
  | "endTime"
  | "lastUpdated"
  | "theaterName"
  | "movieStatus";

export interface QueryPlanSummary {
  planningMs: number;
  executionMs: number;
  /** Scan nodes from the plan: which tables were read and through which index. */
  scans: { node: string; relation?: string; index?: string; rows?: number }[];
  usesSeqScan: boolean;
}

export interface ShowtimeSearchResponse {
  rows: ApiShowtime[];
  nextCursor: string | null;
  /** Only computed for the first page; capped (see totalCapped). */
  total: number | null;
  /** True when there are more matches than the count cap, i.e. "10,000+". */
  totalCapped?: boolean;
  timing: { queryMs: number; countMs: number | null };
  plan?: QueryPlanSummary;
}

export type UploadStatus =
  | "received"
  | "analyzing"
  | "pending_review"
  | "applying"
  | "applied"
  | "partially_applied"
  | "discarded"
  | "failed";

export type ChangeKind =
  | "add"
  | "update"
  | "archive"
  | "reactivate"
  | "unchanged"
  | "duplicate"
  | "invalid";

/** One proposed reconciliation action, as reviewed in the UI. */
export interface ApiChange {
  id: string;
  kind: ChangeKind;
  csvRows: number[];
  showtimeId: string | null;
  movieTitle: string;
  auditorium: string;
  startTime: string;
  endTime: string;
  language: string;
  format: string;
  rating: string;
  explanation: string;
  confidence: number | null;
  source: "agent" | "rule";
  decision: "pending" | "accepted" | "rejected";
  diffs: FieldDiff[];
  applyError: string | null;
}

export interface ApiUploadSummary {
  id: string;
  theaterId: string;
  uploadedBy: string | null;
  uploadedByName: string | null;
  fileName: string;
  rowCount: number | null;
  status: UploadStatus;
  error: string | null;
  addsCount: number;
  updatesCount: number;
  archivesCount: number;
  appliedCount: number;
  failedCount: number;
  createdAt: string;
  analyzedAt: string | null;
  completedAt: string | null;
}

export interface ApiUploadEvent {
  id: number;
  kind: "status" | "error" | "feedback" | "note";
  status: UploadStatus | null;
  message: string | null;
  actorId: string | null;
  createdAt: string;
}

export interface ApiUploadDetail extends ApiUploadSummary {
  /** ScopeBot's line to the reviewer. */
  botMessage: string | null;
  summary: string | null;
  warnings: string[];
  model: string | null;
  /** "agent" when an LLM produced the proposal, "rule" for the fallback. */
  source: "agent" | "rule";
  /** The model's thought summaries, when available. */
  thoughts: string[];
  /** Proposed changes in the same shape the preview modal renders. */
  changes: PreviewChanges;
  /** Every proposed action, including unchanged / duplicate / invalid rows. */
  items: ApiChange[];
  events: ApiUploadEvent[];
}

// ------------------------------------------------ streamed upload progress

export type ReconcileStepKey = "received" | "parsed" | "context" | "model" | "verify" | "saved";

/** Newline-delimited JSON events streamed by POST /api/uploads and /retry. */
export type ReconcileEvent =
  | { type: "step"; key: ReconcileStepKey; state: "active" | "done" | "warn"; label: string }
  | { type: "thought"; text: string }
  | { type: "ping"; elapsedMs: number }
  | { type: "result"; upload: ApiUploadDetail }
  | { type: "error"; error: string; status?: number };

export interface ShowtimeFacets {
  formats: string[];
  languages: string[];
  ratings: string[];
  auditoriums: string[];
  movieStatuses: string[];
}

export interface Showtime {
  id: string;
  theaterId: string;
  movieTitle: string;
  movieStatus: MovieStatus;
  auditorium: string;
  startTime: string;
  endTime: string;
  language: string;
  format: string;
  rating: string;
  lastUpdated: string;
  status: ShowtimeStatus;
}

export interface FieldDiff {
  field: string;
  oldValue: string;
  newValue: string;
}

export interface ShowtimeUpdate {
  id: string;
  movieTitle: string;
  startTime: string;
  endTime: string;
  diffs: FieldDiff[];
}

export interface ShowtimeAdd {
  movieTitle: string;
  auditorium: string;
  startTime: string;
  endTime: string;
  language: string;
  format: string;
  rating: string;
}

export interface ShowtimeArchive {
  id: string;
  movieTitle: string;
  startTime: string;
  endTime: string;
}

export interface PreviewChanges {
  adds: ShowtimeAdd[];
  updates: ShowtimeUpdate[];
  archives: ShowtimeArchive[];
}
