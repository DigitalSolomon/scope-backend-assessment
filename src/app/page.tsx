"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, streamApi } from "~/lib/api";
import { useDebounce } from "~/lib/hooks/useDebounce";
import { useMockSession } from "~/lib/mock-session";
import {
  MOVIE_STATUSES,
  SHOWTIME_STATUSES,
  type ApiShowtime,
  type ApiTheater,
  type MovieStatus,
  type ApiUploadDetail,
  type ReconcileEvent,
  type ShowtimeFacets,
  type ShowtimeSearchResponse,
  type ShowtimeSortField,
  type ShowtimeStatus,
} from "~/types/assessment";
import { FileUpload } from "./_components/FileUpload";
import { FilterBar } from "./_components/FilterBar";
import { ReconcileModal, type ReconcilePhase } from "./_components/ReconcileModal";
import { emptyProgress, type ReconcileProgress } from "./_components/ThinkingPanel";
import { QueryInspector } from "./_components/QueryInspector";
import { UploadHistory } from "./_components/UploadHistory";
import { ThinkingToggle, type ThinkingMode } from "./_components/ThinkingToggle";
import { ShowtimesTable } from "./_components/ShowtimesTable";
import { TheaterPicker } from "./_components/TheaterPicker";

const emptyFacets: ShowtimeFacets = {
  formats: [],
  languages: [],
  ratings: [],
  auditoriums: [],
  movieStatuses: [],
};
const initialFilters = {
  status: "all" as "active" | "inactive" | "archived" | "all",
  format: "",
  language: "",
  rating: "",
  auditorium: "",
  movieStatus: "",
  startDate: "",
  endDate: "",
};
const PAGE_SIZE = 50;

export default function Home() {
  const { users, user, userId, setUserId, signOut, error: sessionError } = useMockSession();

  const [theater, setTheater] = useState<ApiTheater | null>(null);
  const [filters, setFilters] = useState(initialFilters);
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounce(search, 300);
  const [sortField, setSortField] = useState<ShowtimeSortField>("startTime");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("asc");
  const [explain, setExplain] = useState(false);

  const [rows, setRows] = useState<ApiShowtime[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [totalCapped, setTotalCapped] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [facets, setFacets] = useState<ShowtimeFacets>(emptyFacets);
  const [reloadKey, setReloadKey] = useState(0);

  const [reconcile, setReconcile] = useState<{
    open: boolean;
    phase: ReconcilePhase;
    fileName: string;
    upload: ApiUploadDetail | null;
    error: string | null;
  }>({ open: false, phase: "thinking", fileName: "", upload: null, error: null });
  const [progress, setProgress] = useState<ReconcileProgress>(emptyProgress);
  // ScopeBot's thinking mode. Starts at the server's default; the reviewer can switch per upload.
  const [scopebot, setScopebot] = useState<{ aiConnected: boolean; thinkingLevel: string } | null>(null);
  const [chosenMode, setChosenMode] = useState<ThinkingMode | null>(null);
  useEffect(() => {
    api<{ scopebot?: { aiConnected: boolean; thinkingLevel: string } }>("/api/health")
      .then((d) => setScopebot(d.scopebot ?? null))
      .catch(() => undefined);
  }, []);
  const defaultMode: ThinkingMode = scopebot?.thinkingLevel === "low" || scopebot?.thinkingLevel === "minimal" ? "quick" : "thorough";
  const mode = chosenMode ?? defaultMode;
  // Only sent when it differs from the server default, so a deployer's GEMINI_THINKING_LEVEL still applies.
  const thinkingLevel = mode === defaultMode ? undefined : mode === "quick" ? "low" : "medium";
  const [historyKey, setHistoryKey] = useState(0);
  const refreshHistory = () => setHistoryKey((k) => k + 1);
  // The analysis in flight: its stream, its upload id (from the `started` event), and whether Cancel was pressed.
  const analysisRef = useRef<{ abort: AbortController; uploadId: string | null; cancelled: boolean; retryOf: ApiUploadDetail | null } | null>(null);

  const isAdminHere = theater?.role === "admin";
  const hasTheaters = (user?.theaterCount ?? 0) > 0;

  // Reset scope when switching users.
  useEffect(() => {
    setTheater(null);
    setFilters(initialFilters);
    setSearch("");
  }, [userId]);

  // Query string for the search endpoint, built from all filter state.
  const queryString = useMemo(() => {
    const qs = new URLSearchParams();
    if (theater) qs.set("theaterId", theater.id);
    if (debouncedSearch.trim()) qs.set("q", debouncedSearch.trim());
    if (filters.status !== "all") qs.set("status", filters.status);
    if (filters.format) qs.set("format", filters.format);
    if (filters.language) qs.set("language", filters.language);
    if (filters.rating) qs.set("rating", filters.rating);
    if (filters.auditorium) qs.set("auditorium", filters.auditorium);
    if (filters.movieStatus) qs.set("movieStatus", filters.movieStatus);
    if (filters.startDate) qs.set("from", filters.startDate);
    if (filters.endDate) qs.set("to", filters.endDate);
    qs.set("sort", sortField);
    qs.set("order", sortOrder);
    qs.set("limit", String(PAGE_SIZE));
    if (explain) qs.set("explain", "1");
    return qs.toString();
  }, [theater, debouncedSearch, filters, sortField, sortOrder, explain]);

  // First page: refetch whenever the query changes.
  useEffect(() => {
    if (!userId || !hasTheaters) {
      setRows([]);
      setTotal(null);
      setNextCursor(null);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    api<ShowtimeSearchResponse>(`/api/showtimes?${queryString}`, {
      userId,
      signal: controller.signal,
    })
      .then((res) => {
        setRows(res.rows);
        setTotal(res.total);
        setTotalCapped(res.totalCapped ?? false);
        setNextCursor(res.nextCursor);
      })
      .catch((e: Error) => {
        if (!controller.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [userId, hasTheaters, queryString, reloadKey]);

  // Filter dropdown options for the current scope.
  useEffect(() => {
    if (!userId || !hasTheaters) {
      setFacets(emptyFacets);
      return;
    }
    const controller = new AbortController();
    const qs = theater ? `?theaterId=${encodeURIComponent(theater.id)}` : "";
    api<ShowtimeFacets>(`/api/showtimes/facets${qs}`, { userId, signal: controller.signal })
      .then(setFacets)
      .catch(() => undefined);
    return () => controller.abort();
  }, [userId, hasTheaters, theater, reloadKey]);

  const loadingMore = useRef(false);
  const loadMore = useCallback(async () => {
    if (!nextCursor || !userId || loadingMore.current) return;
    loadingMore.current = true;
    try {
      const res = await api<ShowtimeSearchResponse>(
        `/api/showtimes?${queryString}&cursor=${encodeURIComponent(nextCursor)}`,
        { userId },
      );
      setRows((current) => [...current, ...res.rows]);
      setNextCursor(res.nextCursor);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      loadingMore.current = false;
    }
  }, [nextCursor, userId, queryString]);

  const handleSort = (field: ShowtimeSortField) => {
    if (sortField === field) setSortOrder((o) => (o === "asc" ? "desc" : "asc"));
    else {
      setSortField(field);
      setSortOrder("asc");
    }
  };

  const patchShowtime = async (
    showtime: ApiShowtime,
    body: { status?: ShowtimeStatus; movieStatus?: MovieStatus },
  ) => {
    if (!userId) return;
    // Optimistic update; movie status is movie-level, so update every row of that film.
    setRows((current) =>
      current.map((r) => {
        if (body.status && r.id === showtime.id) return { ...r, status: body.status };
        if (body.movieStatus && r.movieId === showtime.movieId) return { ...r, movieStatus: body.movieStatus };
        return r;
      }),
    );
    try {
      await api(`/api/showtimes/${encodeURIComponent(showtime.id)}`, { userId, method: "PATCH", body });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Update failed");
      setReloadKey((k) => k + 1);
    }
  };

  // ------------------------------------------------ CSV upload → ScopeBot review → apply
  const openReconcile = (patch: Partial<typeof reconcile>) => setReconcile((r) => ({ ...r, ...patch }));
  const failReconcile = (e: unknown) => {
    openReconcile({ phase: "error", error: e instanceof Error ? e.message : "Something went wrong." });
    refreshHistory();
  };

  /** Tell the server to stop, then drop the stream. Before `started` arrives there is no id yet; the event handler finishes the job. */
  const sendCancel = (run: NonNullable<typeof analysisRef.current>) => {
    if (!run.uploadId || !userId) return;
    run.abort.abort();
    const retryOf = run.retryOf;
    void api<{ cancelled: boolean; upload: ApiUploadDetail }>(`/api/uploads/${run.uploadId}/cancel`, { userId, method: "POST" })
      .then(async ({ cancelled, upload }) => {
        if (cancelled) return;
        // It finished just before the cancel landed.
        if (retryOf) openReconcile({ upload, phase: "review", error: null });
        else if (upload.status === "pending_review") {
          await api(`/api/uploads/${upload.id}/discard`, { userId, method: "POST" });
        }
      })
      .catch(() => undefined)
      .finally(refreshHistory);
  };

  const handleStopAnalysis = () => {
    const run = analysisRef.current;
    if (!run || run.cancelled) return;
    run.cancelled = true;
    // Update the UI right away; the server catches up within a couple of seconds.
    if (run.retryOf) openReconcile({ upload: run.retryOf, phase: "review", error: null });
    else setReconcile((r) => ({ ...r, open: false }));
    sendCancel(run);
  };

  const startAnalysis = (retryOf: ApiUploadDetail | null) => {
    analysisRef.current?.abort.abort();
    const run = { abort: new AbortController(), uploadId: null, cancelled: false, retryOf };
    analysisRef.current = run;
    return run;
  };

  // Streamed progress: every event (including heartbeats) proves the connection is alive.
  const onProgressEvent = (e: ReconcileEvent) => {
    const run = analysisRef.current;
    if (e.type === "started" && run) {
      run.uploadId = e.uploadId;
      if (run.cancelled) sendCancel(run);
    }
    setProgress((p) => {
      const next = { ...p, lastEventAt: Date.now() };
      if (e.type === "step") next.steps = { ...p.steps, [e.key]: { state: e.state, label: e.label } };
      else if (e.type === "thought") next.thoughts = [...p.thoughts, e.text];
      return next;
    });
  };

  const finishAnalysis = (upload: ApiUploadDetail) => {
    refreshHistory();
    if (upload.status === "failed") {
      openReconcile({ upload, phase: "error", error: `I couldn't use that file: ${upload.error ?? "unknown error"}` });
    } else openReconcile({ upload, phase: "review", error: null });
  };

  /** From the upload history: resume a proposal that is awaiting review, or look at a past upload. */
  const openUpload = async (summary: { id: string }) => {
    if (!userId) return;
    try {
      const upload = await api<ApiUploadDetail>(`/api/uploads/${summary.id}`, { userId });
      const resume = upload.status === "pending_review" && isAdminHere;
      setReconcile({ open: true, phase: resume ? "review" : "view", fileName: upload.fileName, upload, error: null });
    } catch (e) {
      setError((e as Error).message);
    }
  };

  /** An analysis whose worker died (e.g. the tab was closed mid-run on a cold server) can be cleared. */
  const clearStuckUpload = async (summary: { id: string }) => {
    if (!userId) return;
    await api(`/api/uploads/${summary.id}/cancel`, { userId, method: "POST" }).catch(() => undefined);
    refreshHistory();
  };

  const handleFileSelect = async (content: string, fileName: string) => {
    if (!theater || !userId) return;
    setProgress(emptyProgress());
    setReconcile({ open: true, phase: "thinking", fileName, upload: null, error: null });
    const run = startAnalysis(null);
    try {
      const upload = await streamApi("/api/uploads", {
        userId,
        body: { theaterId: theater.id, fileName, csv: content, thinkingLevel },
        onEvent: onProgressEvent,
        signal: run.abort.signal,
      });
      if (!run.cancelled) finishAnalysis(upload);
    } catch (e) {
      if (!run.cancelled) failReconcile(e);
    }
  };

  const handleRetry = async (feedback: string) => {
    if (!reconcile.upload || !userId) return;
    setProgress(emptyProgress());
    openReconcile({ phase: "thinking" });
    const run = startAnalysis(reconcile.upload);
    try {
      const upload = await streamApi(`/api/uploads/${reconcile.upload.id}/retry`, {
        userId,
        body: { feedback, thinkingLevel },
        onEvent: onProgressEvent,
        signal: run.abort.signal,
      });
      if (!run.cancelled) finishAnalysis(upload);
    } catch (e) {
      if (!run.cancelled) failReconcile(e);
    }
  };

  const handleConfirm = async (rejectedChangeIds: string[]) => {
    if (!reconcile.upload || !userId) return;
    openReconcile({ phase: "applying" });
    try {
      const upload = await api<ApiUploadDetail>(`/api/uploads/${reconcile.upload.id}/apply`, {
        userId,
        method: "POST",
        body: { rejectedChangeIds },
      });
      openReconcile({ upload, phase: "done" });
      setReloadKey((k) => k + 1);
      refreshHistory();
    } catch (e) {
      failReconcile(e);
    }
  };

  const handleCancelReconcile = async () => {
    const id = reconcile.upload?.id;
    setReconcile((r) => ({ ...r, open: false }));
    if (id && userId) {
      await api(`/api/uploads/${id}/discard`, { userId, method: "POST" }).catch(() => undefined);
      refreshHistory();
    }
  };

  const handleClearSchedule = async () => {
    if (!theater || !userId) return;
    if (!confirm(`Archive all showtimes at ${theater.name}?`)) return;
    try {
      await api(`/api/theaters/${encodeURIComponent(theater.id)}/clear-schedule`, {
        userId,
        method: "POST",
      });
      setReloadKey((k) => k + 1);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const activeOnPage = rows.filter((r) => r.status === "active").length;

  return (
    <main className="min-h-screen bg-gradient-to-b from-[#1a0b2e] to-[#0f0720]">
      <div className="container mx-auto px-4 py-8">
        <div className="mb-8 flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h1 className="mb-2 text-4xl font-bold text-white">Theater Showtimes Manager</h1>
            <p className="text-gray-400">Upload partner CSV files to manage showtimes</p>
          </div>

          <div className="w-full max-w-md rounded-lg border border-gray-700 bg-gray-900 p-4">
            <p className="text-xs uppercase text-gray-500">Session</p>
            <div className="mt-2 flex flex-col gap-3">
              <select
                value={userId ?? ""}
                onChange={(e) => setUserId(e.target.value)}
                className="w-full rounded-lg border border-gray-600 bg-gray-800 px-3 py-2 text-sm text-white focus:border-purple-500 focus:outline-none focus:ring-2 focus:ring-purple-500"
              >
                <option value="" disabled>
                  {users.length ? "Select a user" : "Loading users…"}
                </option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name} ({u.adminCount ? `admin at ${u.adminCount}` : "employee"}
                    {u.theaterCount - u.adminCount > 0 && u.adminCount
                      ? `, employee at ${u.theaterCount - u.adminCount}`
                      : ""}
                    )
                  </option>
                ))}
              </select>
              {sessionError && <div className="text-sm text-red-400">{sessionError}</div>}
              {user ? (
                <div className="text-sm text-gray-400">
                  <div className="flex items-center justify-between">
                    <span>{user.email}</span>
                    {theater && (
                      <span
                        className={`rounded-full px-2 py-1 text-xs font-medium ${
                          isAdminHere ? "bg-purple-900 text-purple-200" : "bg-gray-700 text-gray-200"
                        }`}
                      >
                        {theater.role} here
                      </span>
                    )}
                  </div>
                  <div className="mt-1 text-xs text-gray-500">
                    Theaters: {user.theaterCount.toLocaleString()} · admin at{" "}
                    {user.adminCount.toLocaleString()}
                  </div>
                </div>
              ) : (
                <div className="text-sm text-gray-500">No user selected.</div>
              )}
              <button
                onClick={signOut}
                className="rounded-lg border border-gray-600 px-3 py-2 text-xs font-semibold text-gray-300 transition hover:bg-gray-800"
              >
                Clear selection
              </button>
            </div>
          </div>
        </div>

        <div className="mb-6 flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2">
            <label className="text-xs font-semibold uppercase text-gray-400">Theater Scope</label>
            <TheaterPicker
              userId={userId}
              value={theater}
              onChange={setTheater}
              disabled={!hasTheaters}
            />
          </div>

          <FileUpload onFileSelect={(c, n) => void handleFileSelect(c, n)} disabled={!isAdminHere} />
          <ThinkingToggle
            value={mode}
            onChange={setChosenMode}
            disabled={!isAdminHere}
            aiConnected={scopebot?.aiConnected ?? true}
          />

          <button
            onClick={handleClearSchedule}
            disabled={!isAdminHere}
            className="rounded-lg border border-red-600 px-6 py-3 font-semibold text-red-400 transition hover:bg-red-950 disabled:opacity-50"
          >
            Clear Schedule
          </button>

          <div className="ml-auto text-right text-sm text-gray-400">
            {total !== null && (
              <>
                {total.toLocaleString()}
                {totalCapped ? "+" : ""} matching showtimes
                {!theater ? " across theaters" : ""}
                <div className="text-xs text-gray-500">
                  showing {rows.length.toLocaleString()} · {activeOnPage} active on this page
                </div>
              </>
            )}
          </div>
        </div>

        {user && hasTheaters && !theater && (
          <div className="mb-6 rounded-lg border border-gray-700 bg-gray-900 p-4 text-sm text-gray-400">
            Pick a single theater to upload a CSV or clear its schedule. Edit controls appear on rows at
            theaters where you are an admin.
          </div>
        )}
        {theater && !isAdminHere && (
          <div className="mb-6 rounded-lg border border-gray-700 bg-gray-900 p-4 text-sm text-gray-400">
            You are an employee at {theater.name}, so this theater is read-only. Admins can upload CSVs
            and update statuses.
          </div>
        )}
        {error && (
          <div className="mb-6 rounded-lg border border-red-800 bg-red-950/40 p-4 text-sm text-red-300">
            {error}
          </div>
        )}

        {user && !hasTheaters ? (
          <div className="rounded-lg border border-gray-700 bg-gray-900 p-8 text-center text-gray-400">
            This user does not belong to any theaters yet.
          </div>
        ) : (
          <>
            <FilterBar
              status={filters.status}
              format={filters.format}
              language={filters.language}
              rating={filters.rating}
              auditorium={filters.auditorium}
              movieStatus={filters.movieStatus}
              startDate={filters.startDate}
              endDate={filters.endDate}
              onFilterChange={setFilters}
              availableFormats={facets.formats}
              availableLanguages={facets.languages}
              availableRatings={facets.ratings}
              availableAuditoriums={facets.auditoriums}
              availableMovieStatuses={facets.movieStatuses}
            />

            <div className="rounded-lg border border-gray-700 bg-gray-900 p-6">
              <ShowtimesTable
                showtimes={rows}
                showTheaterColumn={!theater}
                movieStatusOptions={MOVIE_STATUSES}
                statusOptions={SHOWTIME_STATUSES}
                searchQuery={search}
                onSearchChange={setSearch}
                sortField={sortField}
                sortOrder={sortOrder}
                onSort={handleSort}
                onMovieStatusChange={(st, movieStatus) => void patchShowtime(st, { movieStatus })}
                onStatusChange={(st, status) => void patchShowtime(st, { status })}
                loading={loading}
              />
              {nextCursor && (
                <div className="mt-4 text-center">
                  <button
                    onClick={() => void loadMore()}
                    className="rounded-lg border border-gray-600 px-6 py-2 text-sm font-medium text-gray-200 transition hover:bg-gray-800"
                  >
                    Load {PAGE_SIZE} more
                  </button>
                </div>
              )}
            </div>
          </>
        )}

        {theater && userId && (
          <div className="mt-6">
            <UploadHistory
              userId={userId}
              theaterId={theater.id}
              canReview={isAdminHere}
              refreshKey={historyKey}
              onOpen={(u) => void openUpload(u)}
              onCancelStuck={(u) => void clearStuckUpload(u)}
            />
          </div>
        )}

        <QueryInspector explain={explain} onExplainChange={setExplain} />

        <ReconcileModal
          open={reconcile.open}
          phase={reconcile.phase}
          fileName={reconcile.fileName}
          theaterName={theater?.name ?? ""}
          upload={reconcile.upload}
          error={reconcile.error}
          progress={progress}
          quick={mode === "quick"}
          onCancel={() => void handleCancelReconcile()}
          onStopAnalysis={handleStopAnalysis}
          onConfirm={(ids) => void handleConfirm(ids)}
          onRequestFeedback={() => openReconcile({ phase: "feedback" })}
          onRetry={(feedback) => void handleRetry(feedback)}
          onCloseFeedback={() => openReconcile({ phase: "review" })}
          onClose={() => setReconcile((r) => ({ ...r, open: false }))}
        />
      </div>
    </main>
  );
}
