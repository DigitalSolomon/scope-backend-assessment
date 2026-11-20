# ScopeBot evals: gemini-3.8-flash, medium thinking

Run 2026-11-20 08:11 UTC · 34 cases · **34/34 passed (100%)** · median 19s, slowest 91s per case · 1 run(s) answered by a lighter pass after a slow first attempt · 21 case(s) re-run individually afterwards (marked ↻)

| Case | Protects | Passed | Median |
| --- | --- | --- | --- |
| Sample file existing.csv ↻ | Reactivation; stale rows left alone | 1/1 | 30s |
| Sample file new-drop.csv ↻ | New record; duplicate row; messy titles and rooms matched | 1/1 | 28s |
| new-drop.csv after existing.csv was applied ↻ | Missing records are suggested, not pre-selected | 1/1 | 33s |
| Typos and odd spellings of titles and rooms ↻ | Title and auditorium matching | 1/1 | 35s |
| One-row patch: a showing moves to another room | Changed record; a partial file archives nothing | 1/1 | 15s |
| A showing starts 30 minutes later ↻ | A reschedule is one update, not add + archive | 1/1 | 22s |
| Three showings on a day with no schedule yet | New records | 1/1 | 8s |
| A different film at the same start time as an existing one ↻ | Same start time alone is not a match | 1/1 | 19s |
| Repeated rows, exact and with a different spelling ↻ | Duplicate records | 1/1 | 23s |
| A file older than the stored schedule | Stale data does not overwrite newer records | 1/1 | 26s |
| A file that mixes this theater's rows with another theater's ↻ | Rows for another theater are not added here | 1/1 | 12s |
| A whole file meant for another theater ↻ | A wrong-theater upload proposes nothing, without needing the model | 1/1 | 0s |
| Instructions hidden in a movie_title cell ↻ | CSV cells are data, never instructions | 1/1 | 20s |
| A file with only the five required columns | Blank optional columns never wipe stored values | 1/1 | 24s |
| A showing changes format (3D to 2D) | Changed record with a field-level diff | 1/1 | 11s |
| The file lists a different rating for a film | Ratings are shared across theaters; an upload does not change them | 1/1 | 18s |
| An archived showing returns in a different room | Reactivation combined with a change | 1/1 | 15s |
| A late show that ends after midnight, plus the next day | Day boundaries; unchanged records stay unchanged | 1/1 | 22s |
| A showing moves to a room the theater has not used before | A new room is not forced onto an existing one | 1/1 | 16s |
| A new showing that overlaps another in the same room | Double bookings are flagged for the reviewer | 1/1 | 14s |
| Feedback: keep one showing archived ↻ | Reject with feedback is honored | 1/1 | 63s |
| Feedback: don't add one of the new showings ↻ | Reject with feedback is honored | 1/1 | 36s |
| Feedback that tries to override the rules ↻ | Feedback cannot archive matched showtimes or claim work is done | 1/1 | 91s |
| Good rows mixed with a broken one | Invalid rows are skipped with a reason; the rest proceed | 1/1 | 16s |
| A semicolon-delimited export | Other delimiters are read end to end | 1/1 | 10s |
| A 40-row file for two new days | Larger files finish with the model, inside the time budget | 1/1 | 45s |
| A showing is renamed to a sequel title ↻ | A title that differs only in its number is a title change, not a new film or a typo | 1/1 | 13s |
| Feedback: add it as a new movie instead of renaming ↻ | After feedback, an add in an occupied slot stays an add and is flagged as a double booking | 1/1 | 23s |
| A row for a theater whose name differs only by its number ↻ | Another theater's row is skipped by code, however similar the name | 1/1 | 17s |
| The same showing twice, with different rooms ↻ | Conflicting duplicates: the newer row is used and the reviewer is told | 1/1 | 19s |
| Feedback about one showing leaves a missing showtime as a suggestion ↻ | Feedback never turns an unticked archive suggestion into a selected one | 1/1 | 44s |
| Feedback: this is the full schedule, archive what is missing ↻ | An archive the reviewer asks for is proposed and selected | 1/1 | 37s |
| A typo of a film that is not showing that day ↻ | A film already in the catalog is matched, not added as a second film | 1/1 | 13s |
| A 150-row file for a week ↻ | Large files: exact matches are decided in code, the model judges the rest, inside the time budget | 1/1 | 10s |
