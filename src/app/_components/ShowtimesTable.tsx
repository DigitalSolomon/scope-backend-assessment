"use client";

import { formatShowtime } from "~/lib/format";
import type {
  ApiShowtime,
  MovieStatus,
  ShowtimeSortField,
  ShowtimeStatus,
} from "~/types/assessment";

type SortOrder = "asc" | "desc";

interface ShowtimesTableProps {
  showtimes: ApiShowtime[];
  showTheaterColumn: boolean;
  movieStatusOptions: readonly MovieStatus[];
  statusOptions: readonly ShowtimeStatus[];
  searchQuery: string;
  onSearchChange: (value: string) => void;
  sortField: ShowtimeSortField;
  sortOrder: SortOrder;
  onSort: (field: ShowtimeSortField) => void;
  onMovieStatusChange: (showtime: ApiShowtime, status: MovieStatus) => void;
  onStatusChange: (showtime: ApiShowtime, status: ShowtimeStatus) => void;
  loading?: boolean;
}

/**
 * Presentational table. Search and sort are controlled by the page and
 * executed server-side; edit controls appear only on rows where the user is
 * an admin at that row's theater.
 */
export function ShowtimesTable({
  showtimes,
  showTheaterColumn,
  movieStatusOptions,
  statusOptions,
  searchQuery,
  onSearchChange,
  sortField,
  sortOrder,
  onSort,
  onMovieStatusChange,
  onStatusChange,
  loading,
}: ShowtimesTableProps) {
  const formatDateTime = formatShowtime;

  const SortIcon = ({ field }: { field: ShowtimeSortField }) => {
    if (sortField !== field) return <span className="ml-1 text-gray-500">↕</span>;
    return <span className="ml-1">{sortOrder === "asc" ? "↑" : "↓"}</span>;
  };

  const SortableTh = ({ field, label }: { field: ShowtimeSortField; label: string }) => (
    <th className="cursor-pointer px-4 py-3 hover:bg-gray-700" onClick={() => onSort(field)}>
      {label} <SortIcon field={field} />
    </th>
  );

  const columnCount = 10 + (showTheaterColumn ? 1 : 0);

  return (
    <div className="w-full">
      <div className="mb-4">
        <input
          type="text"
          placeholder="Search by movie title..."
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          className="w-full rounded-lg border border-gray-600 bg-gray-800 px-4 py-2 text-white placeholder-gray-400 focus:border-purple-500 focus:outline-none focus:ring-2 focus:ring-purple-500"
        />
      </div>

      <div
        className={`overflow-x-auto rounded-lg border border-gray-700 transition-opacity ${
          loading ? "opacity-60" : ""
        }`}
      >
        <table className="w-full text-left text-sm">
          <thead className="bg-gray-800 text-xs uppercase text-gray-400">
            <tr>
              {showTheaterColumn && <SortableTh field="theaterName" label="Theater" />}
              <SortableTh field="movieTitle" label="Movie Title" />
              <SortableTh field="movieStatus" label="Movie Status" />
              <th className="px-4 py-3">Auditorium</th>
              <SortableTh field="startTime" label="Start Time" />
              <SortableTh field="endTime" label="End Time" />
              <th className="px-4 py-3">Language</th>
              <th className="px-4 py-3">Format</th>
              <th className="px-4 py-3">Rating</th>
              <th className="px-4 py-3">Status</th>
              <SortableTh field="lastUpdated" label="Last Updated" />
            </tr>
          </thead>
          <tbody>
            {showtimes.length === 0 ? (
              <tr>
                <td colSpan={columnCount} className="px-4 py-8 text-center text-gray-400">
                  {loading ? "Loading…" : "No showtimes found"}
                </td>
              </tr>
            ) : (
              showtimes.map((showtime) => {
                const canEdit = showtime.role === "admin";
                return (
                  <tr
                    key={showtime.id}
                    className={`border-b border-gray-700 hover:bg-gray-800 ${
                      showtime.status === "archived" ? "opacity-50" : ""
                    }`}
                  >
                    {showTheaterColumn && (
                      <td className="px-4 py-3 text-gray-300">
                        {showtime.theaterName}
                        <span className="ml-1 text-[10px] uppercase text-gray-500">
                          {showtime.role}
                        </span>
                      </td>
                    )}
                    <td className="px-4 py-3 font-medium text-white">{showtime.movieTitle}</td>
                    <td className="px-4 py-3 text-gray-300">
                      {canEdit ? (
                        <select
                          value={showtime.movieStatus}
                          onChange={(e) =>
                            onMovieStatusChange(showtime, e.target.value as MovieStatus)
                          }
                          className="rounded border border-gray-600 bg-gray-800 px-2 py-1 text-xs text-white focus:border-purple-500 focus:outline-none focus:ring-2 focus:ring-purple-500"
                        >
                          {movieStatusOptions.map((o) => (
                            <option key={o} value={o}>
                              {o}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span className="rounded-full bg-gray-700 px-2 py-1 text-xs text-gray-200">
                          {showtime.movieStatus}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-gray-300">{showtime.auditorium}</td>
                    <td className="px-4 py-3 text-gray-300">{formatDateTime(showtime.startTime)}</td>
                    <td className="px-4 py-3 text-gray-300">{formatDateTime(showtime.endTime)}</td>
                    <td className="px-4 py-3 text-gray-300">{showtime.language}</td>
                    <td className="px-4 py-3 text-gray-300">{showtime.format}</td>
                    <td className="px-4 py-3 text-gray-300">{showtime.rating}</td>
                    <td className="px-4 py-3">
                      {canEdit ? (
                        <select
                          value={showtime.status}
                          onChange={(e) => onStatusChange(showtime, e.target.value as ShowtimeStatus)}
                          className="rounded border border-gray-600 bg-gray-800 px-2 py-1 text-xs text-white focus:border-purple-500 focus:outline-none focus:ring-2 focus:ring-purple-500"
                        >
                          {statusOptions.map((o) => (
                            <option key={o} value={o}>
                              {o}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span
                          className={`rounded-full px-2 py-1 text-xs font-medium ${
                            showtime.status === "active"
                              ? "bg-green-900 text-green-300"
                              : showtime.status === "inactive"
                                ? "bg-amber-900 text-amber-300"
                                : "bg-gray-700 text-gray-400"
                          }`}
                        >
                          {showtime.status}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-gray-300">{formatDateTime(showtime.lastUpdated)}</td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
