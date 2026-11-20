/**
 * Showtimes are wall-clock schedule times (the sample data's 16:00 is a 4 PM
 * matinee), so they are shown exactly as stored rather than converted to the
 * viewer's or the theater's timezone. One formatter family keeps the table,
 * the review cards and ScopeBot's explanations in agreement.
 */
const fmt = (iso: string, opts: Intl.DateTimeFormatOptions) =>
  iso ? new Date(iso).toLocaleString("en-US", { ...opts, timeZone: "UTC" }) : "";

/** "Mar 15, 06:00 PM" (tables and cards). */
export const formatShowtime = (iso: string) =>
  fmt(iso, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** "6:00 PM" (sentences). */
export const formatClock = (iso: string) => fmt(iso, { hour: "numeric", minute: "2-digit" });

/** "Mar 15" */
export const formatDay = (iso: string) => fmt(iso, { month: "short", day: "numeric" });

/** "Mar 15, 6:00 PM" (sentences). */
export const formatWhen = (iso: string) => `${formatDay(iso)}, ${formatClock(iso)}`;

/** Clock times written in a sentence, normalised to "6:00 PM". */
export function clockTimesIn(text: string): string[] {
  return [...text.matchAll(/\b(\d{1,2}):(\d{2})\s*([AaPp])\.?\s?[Mm]\b/g)].map(
    (m) => `${Number(m[1])}:${m[2]} ${m[3]!.toUpperCase()}M`,
  );
}
