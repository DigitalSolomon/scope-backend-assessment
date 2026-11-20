"use client";

import { useState } from "react";
import { useRequestLog } from "~/lib/api";

interface QueryInspectorProps {
  explain: boolean;
  onExplainChange: (value: boolean) => void;
}

/**
 * Developer panel: live API traffic and, with "Explain" on, the Postgres plan
 * for the latest showtimes search, so you can see which indexes were used.
 */
export function QueryInspector({ explain, onExplainChange }: QueryInspectorProps) {
  const log = useRequestLog();
  const [open, setOpen] = useState(true);
  const latestPlan = log.find((e) => e.plan)?.plan;

  return (
    <div className="mt-6 rounded-lg border border-gray-700 bg-gray-950 text-xs text-gray-300">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-800 px-4 py-2">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="font-semibold uppercase tracking-wide text-gray-400 hover:text-gray-200"
        >
          {open ? "▾" : "▸"} Query inspector
        </button>
        <label className="flex cursor-pointer items-center gap-2 text-gray-400">
          <input
            type="checkbox"
            checked={explain}
            onChange={(e) => onExplainChange(e.target.checked)}
            className="accent-purple-500"
          />
          Explain search queries (EXPLAIN ANALYZE)
        </label>
      </div>

      {open && (
        <div className="grid gap-4 p-4 lg:grid-cols-2">
          <div>
            <p className="mb-2 font-semibold text-gray-400">Recent API requests</p>
            <div className="overflow-x-auto">
              <table className="w-full font-mono text-[11px]">
                <thead className="text-left text-gray-500">
                  <tr>
                    <th className="pr-2">status</th>
                    <th className="pr-2">request</th>
                    <th className="pr-2 text-right">rows</th>
                    <th className="pr-2 text-right">db ms</th>
                    <th className="text-right">total ms</th>
                  </tr>
                </thead>
                <tbody>
                  {log.length === 0 && (
                    <tr>
                      <td colSpan={5} className="py-2 text-gray-600">
                        No requests yet
                      </td>
                    </tr>
                  )}
                  {log.map((e) => (
                    <tr key={e.id} className="border-t border-gray-900 align-top">
                      <td
                        className={`py-1 pr-2 ${
                          typeof e.status === "number" && e.status < 400 ? "text-green-400" : "text-red-400"
                        }`}
                      >
                        {e.status}
                      </td>
                      <td className="max-w-[28rem] break-all py-1 pr-2 text-gray-300">
                        <span className="text-gray-500">{e.method} </span>
                        {decodeURIComponent(e.url)}
                      </td>
                      <td className="py-1 pr-2 text-right">{e.rows ?? ""}</td>
                      <td className="py-1 pr-2 text-right">{e.serverMs ?? ""}</td>
                      <td className="py-1 text-right">{e.clientMs}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div>
            <p className="mb-2 font-semibold text-gray-400">Latest search plan</p>
            {!explain && !latestPlan && (
              <p className="text-gray-600">Turn on “Explain” to see the query plan for each search.</p>
            )}
            {latestPlan && (
              <>
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <span
                    className={`rounded-full px-2 py-0.5 font-medium ${
                      latestPlan.usesSeqScan ? "bg-amber-900 text-amber-200" : "bg-green-900 text-green-200"
                    }`}
                  >
                    {latestPlan.usesSeqScan ? "Includes a sequential scan" : "Index scans only"}
                  </span>
                  <span className="text-gray-500">
                    planning {latestPlan.planningMs.toFixed(2)} ms · execution{" "}
                    {latestPlan.executionMs.toFixed(2)} ms
                  </span>
                </div>
                <table className="w-full font-mono text-[11px]">
                  <thead className="text-left text-gray-500">
                    <tr>
                      <th className="pr-2">node</th>
                      <th className="pr-2">table</th>
                      <th className="pr-2">index</th>
                      <th className="text-right">rows</th>
                    </tr>
                  </thead>
                  <tbody>
                    {latestPlan.scans.map((s, i) => (
                      <tr key={i} className="border-t border-gray-900">
                        <td className={`py-1 pr-2 ${s.node === "Seq Scan" ? "text-amber-300" : "text-gray-200"}`}>
                          {s.node}
                        </td>
                        <td className="py-1 pr-2">{s.relation ?? ""}</td>
                        <td className="py-1 pr-2 text-purple-300">{s.index ?? ""}</td>
                        <td className="py-1 text-right">{s.rows ?? ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="mt-2 text-gray-600">
                  On small tables Postgres often prefers a sequential scan because it is cheaper. Seed the
                  scale dataset to see the indexes chosen.
                </p>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
