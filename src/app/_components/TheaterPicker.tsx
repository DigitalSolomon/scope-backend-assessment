"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "~/lib/api";
import { useDebounce } from "~/lib/hooks/useDebounce";
import type { ApiTheater } from "~/types/assessment";

interface TheaterPickerProps {
  userId: string | null;
  value: ApiTheater | null; // null = all accessible theaters
  onChange: (theater: ApiTheater | null) => void;
  disabled?: boolean;
}

/**
 * Searchable theater scope. A user may belong to thousands of theaters, so
 * options come from /api/theaters?q=… (trigram-indexed) instead of one big
 * <select>.
 */
export function TheaterPicker({ userId, value, onChange, disabled }: TheaterPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<ApiTheater[]>([]);
  const [loading, setLoading] = useState(false);
  const debounced = useDebounce(query, 200);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || !userId) return;
    const controller = new AbortController();
    setLoading(true);
    const qs = new URLSearchParams({ limit: "25", ...(debounced ? { q: debounced } : {}) });
    api<{ theaters: ApiTheater[] }>(`/api/theaters?${qs.toString()}`, {
      userId,
      signal: controller.signal,
    })
      .then(({ theaters }) => setOptions(theaters))
      .catch(() => undefined)
      .finally(() => !controller.signal.aborted && setLoading(false));
    return () => controller.abort();
  }, [open, debounced, userId]);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const pick = (theater: ApiTheater | null) => {
    onChange(theater);
    setOpen(false);
    setQuery("");
  };

  return (
    <div ref={boxRef} className="relative w-72">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between rounded-lg border border-gray-600 bg-gray-800 px-3 py-2 text-left text-sm text-white focus:border-purple-500 focus:outline-none focus:ring-2 focus:ring-purple-500 disabled:opacity-50"
      >
        <span className="truncate">
          {value ? value.name : "All accessible theaters"}
          {value && (
            <span className="ml-2 text-xs text-gray-400">
              {value.role === "admin" ? "admin" : "employee"}
            </span>
          )}
        </span>
        <span className="ml-2 text-gray-500">▾</span>
      </button>

      {open && (
        <div className="absolute z-40 mt-1 w-full rounded-lg border border-gray-600 bg-gray-900 shadow-xl">
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search theaters by name or city…"
            className="w-full rounded-t-lg border-b border-gray-700 bg-gray-800 px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none"
          />
          <ul className="max-h-72 overflow-y-auto py-1 text-sm">
            <li>
              <button
                type="button"
                onClick={() => pick(null)}
                className="w-full px-3 py-2 text-left text-gray-200 hover:bg-gray-800"
              >
                All accessible theaters
              </button>
            </li>
            {options.map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  onClick={() => pick(t)}
                  className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left hover:bg-gray-800 ${
                    value?.id === t.id ? "bg-gray-800" : ""
                  }`}
                >
                  <span className="min-w-0">
                    <span className="block truncate text-white">{t.name}</span>
                    <span className="block truncate text-xs text-gray-500">{t.location}</span>
                  </span>
                  <span
                    className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${
                      t.role === "admin" ? "bg-purple-900 text-purple-200" : "bg-gray-700 text-gray-300"
                    }`}
                  >
                    {t.role}
                  </span>
                </button>
              </li>
            ))}
            {!loading && options.length === 0 && (
              <li className="px-3 py-2 text-gray-500">No matching theaters</li>
            )}
            {loading && <li className="px-3 py-2 text-gray-500">Searching…</li>}
          </ul>
        </div>
      )}
    </div>
  );
}
