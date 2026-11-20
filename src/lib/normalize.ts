/**
 * Identity keys for fuzzy-but-deterministic matching.
 *
 * NFKC alone is not enough: it maps U+2011 (non-breaking hyphen, used in the
 * sample CSV's "Spider‑Man") to U+2010, not to "-". So dash, quote and space
 * variants are folded explicitly before punctuation is stripped.
 *
 * Kept dependency-free so the seed script can import it directly.
 */
const DASHES = /[‐-―−﹘﹣－]/g;
const QUOTES = /[‘’‚‛′`´“”„‟″]/g;
const SPACES = /[   -​  　﻿]/g;

export function normalizeKey(value: string): string {
  return value
    .normalize("NFKC")
    .replace(DASHES, "-")
    .replace(QUOTES, "'")
    .replace(SPACES, " ")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** Clean display value: same folding, but case and punctuation preserved. */
export function cleanText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(DASHES, "-")
    .replace(QUOTES, "'")
    .replace(SPACES, " ")
    .trim()
    .replace(/\s+/g, " ");
}
