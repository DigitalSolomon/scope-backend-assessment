/**
 * ScopeBot evals: real Gemini calls, graded automatically.
 *
 * Each case in evals/cases/*.json is a CSV plus what a correct proposal must
 * contain. A case runs the real pipeline (parse -> context -> Gemini ->
 * server verification) against the sample schedule in
 * src/data/assessment-data.ts, so it needs a GEMINI_API_KEY but no database,
 * writes nothing, and is repeatable.
 *
 *   npm run evals                 every case once
 *   npm run evals -- shift fuzzy  only cases whose file name contains a word
 *   EVAL_RUNS=3 npm run evals     each case three times (models vary run to run)
 *   GEMINI_THINKING_LEVEL=low npm run evals     score another configuration
 *
 * Results are printed, and saved to evals/results/<model>__<level>.{json,md}.
 * A filtered run updates only those cases in the saved scorecard.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "~/env";
import { clockTimesIn, formatClock } from "~/lib/format";
import { runAgent, type AgentOutcome } from "~/server/reconcile/agent";
import type { StoredShowtime } from "~/server/reconcile/context";
import { CsvError } from "~/server/reconcile/csv";
import type { ChangeDraft } from "~/server/reconcile/plan";
import type { ChangeKind } from "~/types/assessment";
import { HEADER, prepare, type Prepared } from "../tests/fixture";

// ------------------------------------------------------------ case format

interface ChangeMatch {
  kind?: ChangeKind;
  /** Exact stored/canonical title. */
  title?: string;
  /** Exact room name on the proposed change. */
  room?: string;
  /** Field changes that must be present: field -> new value (ISO for times). */
  sets?: Record<string, string>;
  /** Regular expression the explanation must match. */
  explains?: string;
}

interface EvalCase {
  /** What a reviewer would call this scenario. */
  title: string;
  /** Which requirement it protects (shown in the scorecard). */
  checks: string;
  /** CSV data rows under the standard header… */
  rows?: string[];
  /** …or complete CSV text, line by line (custom headers, delimiters)… */
  csv?: string[];
  /** …or a file, relative to the repository root. */
  csvFile?: string;
  /** Changes to the sample schedule before the upload, by showtime id. */
  schedule?: Record<string, Partial<StoredShowtime>>;
  /** Films already in the catalog (at any theater) that resemble titles in the file. */
  catalog?: string[];
  /** If set: propose once, then send this reviewer feedback; the second proposal is graded. */
  feedback?: string;
  expect: {
    /** Exact number of changes of each listed kind. Kinds not listed are not constrained. */
    counts?: Partial<Record<ChangeKind, number>>;
    /** Changes that must be proposed. */
    changes?: ChangeMatch[];
    /** Changes that must not be proposed. */
    absent?: ChangeMatch[];
    /** Regular expressions; each must match one of the warnings shown to the reviewer. */
    warnings?: string[];
    /** How many archive proposals must start ticked (only those a reviewer's feedback asked for should). */
    tickedArchives?: number;
    /** Regular expression ScopeBot's message must match / must not match. */
    message?: string;
    messageNot?: string;
    /** "rule" for a case that should not need the model. Default "agent". */
    source?: "agent" | "rule";
  };
}

// ------------------------------------------------------------ grading

const matches = (d: ChangeDraft, m: ChangeMatch) =>
  (!m.kind || d.kind === m.kind) &&
  (!m.title || d.movieTitle === m.title) &&
  (!m.room || d.auditorium === m.room) &&
  (!m.sets || Object.entries(m.sets).every(([f, v]) => d.diffs.some((x) => x.field === f && x.newValue === v))) &&
  (!m.explains || new RegExp(m.explains, "i").test(d.explanation));

const describe = (m: ChangeMatch) =>
  [m.kind, m.title, m.room && `in ${m.room}`, m.sets && `setting ${JSON.stringify(m.sets)}`, m.explains && `explained as /${m.explains}/`]
    .filter(Boolean)
    .join(" ");

/** Problems with a proposal; empty means the case passed. */
function grade(c: EvalCase, p: Prepared, out: AgentOutcome): string[] {
  const problems: string[] = [];
  const { drafts } = out;
  const e = c.expect;

  // Checks specific to this case.
  for (const [kind, want] of Object.entries(e.counts ?? {})) {
    const got = drafts.filter((d) => d.kind === kind).length;
    if (got !== want) problems.push(`expected ${want} ${kind}, got ${got}`);
  }
  for (const m of e.changes ?? []) if (!drafts.some((d) => matches(d, m))) problems.push(`missing: ${describe(m)}`);
  for (const m of e.absent ?? []) if (drafts.some((d) => matches(d, m))) problems.push(`should not propose: ${describe(m)}`);
  for (const w of e.warnings ?? []) {
    if (!out.warnings.some((x) => new RegExp(w, "i").test(x))) problems.push(`no warning matching /${w}/`);
  }
  if (e.tickedArchives !== undefined && out.preselectedArchives.length !== e.tickedArchives) {
    problems.push(`expected ${e.tickedArchives} ticked archive(s), got ${out.preselectedArchives.length}`);
  }
  if (e.message && !new RegExp(e.message, "i").test(out.message)) problems.push(`message does not match /${e.message}/`);
  if (e.messageNot && new RegExp(e.messageNot, "i").test(out.message)) problems.push(`message matches /${e.messageNot}/`);

  // Checks every proposal must pass.
  const wantSource = e.source ?? "agent";
  if (out.source !== wantSource) problems.push(`answered by ${out.source}${out.error ? ` (${out.error})` : ""}, expected ${wantSource}`);
  const covered = new Set(drafts.flatMap((d) => d.csvRows));
  for (const r of p.rows) if (!covered.has(r.row)) problems.push(`row ${r.row} has no decision`);
  const text = [out.message, out.summary, ...drafts.map((d) => d.explanation)].join("\n");
  if (/\bst-[a-z]{2}-\d+/.test(text)) problems.push("mentions an internal id");
  if (/\b(all set|already (been )?applied|i(?:'ve| have) applied|has been applied)\b/i.test(out.message)) {
    problems.push("message claims changes were applied before review");
  }
  const byRow = new Map(p.rows.map((r) => [r.row, r]));
  for (const d of drafts) {
    const s = d.showtimeId ? p.ctx.storedById.get(d.showtimeId) : undefined;
    const own = new Set(
      [d.startTime, d.endTime, s?.startTime, s?.endTime, ...d.csvRows.flatMap((n) => [byRow.get(n)?.startTime, byRow.get(n)?.endTime])]
        .filter((v): v is string => Boolean(v))
        .map(formatClock),
    );
    // The model's sentence comes first; server-written notes (in parentheses) may name other showtimes.
    const sentence = d.explanation.split(" (")[0]!;
    if (clockTimesIn(sentence).some((t) => !own.has(t))) problems.push(`explanation quotes a time that is not this showtime's: "${sentence}"`);
  }
  const stated = /\b(\d+)\s+(?:proposed\s+)?changes?\b/i.exec(out.message);
  const actual = drafts.filter((d) => ["add", "update", "reactivate"].includes(d.kind) || (d.kind === "archive" && out.preselectedArchives.includes(d.showtimeId ?? ""))).length;
  if (stated && Number(stated[1]) !== actual) problems.push(`message says ${stated[1]} changes, proposal has ${actual}`);
  return problems;
}

// ------------------------------------------------------------ running

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CASES = join(ROOT, "evals/cases");

function csvOf(c: EvalCase): string {
  if (c.csvFile) return readFileSync(join(ROOT, c.csvFile), "utf8");
  if (c.csv) return c.csv.join("\n") + "\n";
  return [HEADER, ...(c.rows ?? [])].join("\n") + "\n";
}

/** What the model is shown as its previous proposal on a feedback run (same shape the app sends). */
const previous = (out: AgentOutcome) =>
  out.drafts.map((d) => ({
    kind: d.kind, rows: d.csvRows, showtimeId: d.showtimeId, title: d.movieTitle, auditorium: d.auditorium, explanation: d.explanation,
    ...(d.kind === "archive" ? { selected: out.preselectedArchives.includes(d.showtimeId ?? "") } : {}),
  }));

interface RunResult {
  pass: boolean;
  problems: string[];
  seconds: number;
  model: string | null;
  thinkingLevel: string | null;
  kinds: Record<string, number>;
  message: string;
}

async function runOnce(c: EvalCase): Promise<RunResult> {
  const started = Date.now();
  try {
    const p = prepare(csvOf(c), { patch: c.schedule, catalog: c.catalog });
    let out = await runAgent(p.ctx, p.rows, p.invalid);
    if (c.feedback) out = await runAgent(p.ctx, p.rows, p.invalid, { text: c.feedback, previous: previous(out) });
    const problems = grade(c, p, out);
    const kinds: Record<string, number> = {};
    for (const d of out.drafts) kinds[d.kind] = (kinds[d.kind] ?? 0) + 1;
    return { pass: problems.length === 0, problems, seconds: (Date.now() - started) / 1000, model: out.model, thinkingLevel: out.thinkingLevel, kinds, message: out.message };
  } catch (e) {
    const why = e instanceof CsvError ? `the CSV was rejected: ${e.message}` : e instanceof Error ? e.message : String(e);
    return { pass: false, problems: [why], seconds: (Date.now() - started) / 1000, model: null, thinkingLevel: null, kinds: {}, message: "" };
  }
}

async function pool<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)]! : 0;
};

async function main() {
  if (!env.GEMINI_API_KEY) {
    console.error("Evals call the real model: set GEMINI_API_KEY in .env first.");
    process.exit(2);
  }
  const filters = process.argv.slice(2);
  const runs = Math.max(1, Number(process.env.EVAL_RUNS ?? 1));
  const concurrency = Math.max(1, Number(process.env.EVAL_CONCURRENCY ?? 3));
  const minPass = Number(process.env.EVAL_MIN_PASS ?? 0.9);

  const files = readdirSync(CASES).filter((f) => f.endsWith(".json")).sort();
  const cases = files
    .filter((f) => !filters.length || filters.some((w) => f.includes(w)))
    .map((f) => ({ id: f.replace(/\.json$/, ""), ...(JSON.parse(readFileSync(join(CASES, f), "utf8")) as EvalCase) }));
  if (!cases.length) {
    console.error(`No eval cases match: ${filters.join(" ")}`);
    process.exit(2);
  }
  // The agent logs fallbacks to stderr; keep the scorecard readable.
  console.error = () => undefined;

  const config = `${env.GEMINI_MODEL}, ${env.GEMINI_THINKING_LEVEL} thinking`;
  console.log(`ScopeBot evals: ${cases.length} cases x ${runs} run${runs > 1 ? "s" : ""} (${config})\n`);

  const jobs = cases.flatMap((c) => Array.from({ length: runs }, () => c));
  const results = await pool(jobs, concurrency, async (c) => {
    const r = await runOnce(c);
    console.log(`${r.pass ? "  pass" : "  FAIL"}  ${c.id.padEnd(34)} ${r.seconds.toFixed(0).padStart(3)}s${r.pass ? "" : `   ${r.problems[0]}`}`);
    return { id: c.id, ...r };
  });

  const today = new Date().toISOString();
  const fresh = cases.map((c) => {
    const mine = results.filter((r) => r.id === c.id);
    return {
      id: c.id, title: c.title, checks: c.checks, ranAt: today,
      passed: mine.filter((r) => r.pass).length, runs: mine.length,
      medianSeconds: Math.round(median(mine.map((r) => r.seconds))),
      slowestSeconds: Math.round(Math.max(...mine.map((r) => r.seconds))),
      lighterPass: mine.filter((r) => r.model && (r.model !== env.GEMINI_MODEL || r.thinkingLevel !== env.GEMINI_THINKING_LEVEL)).length,
      failures: mine.filter((r) => !r.pass).map((r) => ({ problems: r.problems, kinds: r.kinds, message: r.message })),
    };
  });
  type Row = (typeof fresh)[number];

  const passedNow = results.filter((r) => r.pass).length;
  const rate = passedNow / results.length;
  console.log(
    `\n${passedNow}/${results.length} passed (${Math.round(rate * 1000) / 10}%) · median ${Math.round(median(results.map((r) => r.seconds)))}s, slowest ${Math.round(Math.max(...results.map((r) => r.seconds)))}s`,
  );
  for (const r of fresh.filter((x) => x.failures.length)) {
    console.log(`\n${r.id}: ${r.title} (${r.passed}/${r.runs})`);
    for (const f of r.failures) console.log(`  - ${f.problems.join("; ")}\n    got ${JSON.stringify(f.kinds)} · "${f.message}"`);
  }

  // Save the scorecard for this model + thinking level. A filtered run updates
  // just those cases in the saved scorecard (handy after fixing one failure).
  const dir = join(ROOT, "evals/results");
  mkdirSync(dir, { recursive: true });
  const name = `${env.GEMINI_MODEL}__${env.GEMINI_THINKING_LEVEL}`.replace(/[^\w.-]+/g, "-");
  const file = join(dir, `${name}.json`);
  let rows: Row[] = fresh;
  if (filters.length && existsSync(file)) {
    const saved = JSON.parse(readFileSync(file, "utf8")) as { summary: { date: string }; cases: Partial<Row>[] };
    const byId = new Map(
      saved.cases.map((r) => [r.id!, { ...r, ranAt: r.ranAt ?? saved.summary.date, slowestSeconds: r.slowestSeconds ?? r.medianSeconds ?? 0 } as Row]),
    );
    for (const r of fresh) byId.set(r.id, r);
    rows = files.map((f) => byId.get(f.replace(/\.json$/, ""))).filter((r): r is Row => Boolean(r));
  }
  const total = rows.reduce((n, r) => n + r.runs, 0);
  const passed = rows.reduce((n, r) => n + r.passed, 0);
  const firstRun = rows.reduce((d, r) => (r.ranAt < d ? r.ranAt : d), today);
  const rerun = rows.filter((r) => r.ranAt.slice(0, 16) !== firstRun.slice(0, 16)).length;
  const summary = {
    date: firstRun, model: env.GEMINI_MODEL, thinkingLevel: env.GEMINI_THINKING_LEVEL, fallbackModel: env.GEMINI_FALLBACK_MODEL,
    cases: rows.length, passed, total, passRate: Math.round((passed / total) * 1000) / 10,
    medianSeconds: Math.round(median(rows.map((r) => r.medianSeconds))), slowestSeconds: Math.max(...rows.map((r) => r.slowestSeconds)),
    lighterPassRuns: rows.reduce((n, r) => n + r.lighterPass, 0), casesRerunLater: rerun,
  };
  writeFileSync(file, JSON.stringify({ summary, cases: rows }, null, 2) + "\n");
  const md = [
    `# ScopeBot evals: ${config}`,
    "",
    `Run ${summary.date.slice(0, 16).replace("T", " ")} UTC · ${summary.cases} cases · **${passed}/${total} passed (${summary.passRate}%)** · median ${summary.medianSeconds}s, slowest ${summary.slowestSeconds}s per case` +
      (summary.lighterPassRuns ? ` · ${summary.lighterPassRuns} run(s) answered by a lighter pass after a slow first attempt` : "") +
      (rerun ? ` · ${rerun} case(s) re-run individually afterwards (marked ↻)` : ""),
    "",
    "| Case | Protects | Passed | Median |",
    "| --- | --- | --- | --- |",
    ...rows.map((r) => `| ${r.title}${r.ranAt.slice(0, 16) !== firstRun.slice(0, 16) ? " ↻" : ""} | ${r.checks} | ${r.passed}/${r.runs}${r.passed === r.runs ? "" : " ⚠"} | ${r.medianSeconds}s |`),
    "",
    ...(rows.some((r) => r.failures.length)
      ? ["## Failures", "", ...rows.filter((r) => r.failures.length).map((r) => `- **${r.title}** (\`${r.id}\`): ${r.failures.map((f) => f.problems.join("; ")).join(" / ")}`), ""]
      : []),
  ].join("\n");
  writeFileSync(join(dir, `${name}.md`), md);
  console.log(`\n${filters.length ? "Updated" : "Saved"} evals/results/${name}.md (${passed}/${total} overall)`);
  process.exit(rate >= minPass ? 0 : 1);
}

void main();
