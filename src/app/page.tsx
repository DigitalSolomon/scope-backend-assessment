"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { assessmentData } from "~/data/assessment-data";
import { api, ApiError } from "~/lib/api";
import { useDebounce } from "~/lib/hooks/useDebounce";
import { useMockSession } from "~/lib/mock-session";
import {
  MOVIE_STATUSES,
  SHOWTIME_STATUSES,
  type ApiShowtime,
  type ApiTheater,
  type MovieStatus,
  type PreviewChanges,
  type ShowtimeFacets,
  type ShowtimeSearchResponse,
  type ShowtimeSortField,
  type ShowtimeStatus,
} from "~/types/assessment";
import { FileUpload } from "./_components/FileUpload";
import { FilterBar } from "./_components/FilterBar";
import { PreviewModal } from "./_components/PreviewModal";
import { QueryInspector } from "./_components/QueryInspector";
import { ShowtimesTable } from "./_components/ShowtimesTable";
import { TheaterPicker } from "./_components/TheaterPicker";

const emptyPreview: PreviewChanges = { adds: [], updates: [], archives: [] };
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

  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  const [previewData, setPreviewData] = useState<PreviewChanges>(emptyPreview);

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

  // CSV upload and preview are still mocked; the AI reconciliation flow replaces this next.
  const handleFileSelect = (_content: string) => {
    setPreviewData(
      (theater && assessmentData.previewChangesByTheater[theater.id]) ?? emptyPreview,
    );
    setIsPreviewOpen(true);
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

          <FileUpload onFileSelect={handleFileSelect} disabled={!isAdminHere} />

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

        <QueryInspector explain={explain} onExplainChange={setExplain} />

        <PreviewModal
          isOpen={isPreviewOpen}
          onClose={() => setIsPreviewOpen(false)}
          onConfirm={() => setIsPreviewOpen(false)}
          changes={previewData}
          isApplying={false}
        />
      </div>
    </main>
  );
}
