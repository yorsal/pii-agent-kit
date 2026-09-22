/**
 * Merge/arbitrate PII matches produced by multiple detectors.
 *
 * Arbitration rules (in order):
 *   1. Regex wins over NER when spans overlap exactly.
 *   2. For overlapping spans from different detectors, the longer span wins.
 *   3. On ties, the higher-confidence score wins.
 *   4. Non-overlapping spans are kept as-is.
 */

import type { PiiMatch } from '../types.js';

/** A single arbitration decision, useful for logging or auditing. */
export interface MergeDecision {
  kept: PiiMatch[];
  dropped: PiiMatch[];
}

interface IndexedMatch {
  match: PiiMatch;
  index: number;
}

/** Returns whether `a` overlaps `b` (open or closed intervals). */
function overlaps(a: PiiMatch, b: PiiMatch): boolean {
  return a.start < b.end && b.start < a.end;
}

/**
 * Score a match for arbitration: longer span wins, then higher score, then
 * regex over ner. The returned number is a tuple-encoded comparison key so
 * we can use simple `<`/`>` operators.
 */
function arbitrateScore(m: PiiMatch): [number, number, number] {
  const length = m.end - m.start;
  const sourceBoost = m.source === 'regex' ? 1 : 0;
  const score = m.score ?? (m.source === 'regex' ? 1 : 0);
  return [length, score, sourceBoost];
}

function compareScores(a: PiiMatch, b: PiiMatch): number {
  const [la, sa, ra] = arbitrateScore(a);
  const [lb, sb, rb] = arbitrateScore(b);
  if (la !== lb) return la - lb;
  if (sa !== sb) return sa - sb;
  return ra - rb;
}

/**
 * Merge a list of matches from any number of detectors.
 *
 * Stable: matches are deduplicated by `(type, start, end, value)` first to
 * avoid double-counting when both detectors fire on the same span.
 */
export function mergeMatches(matches: PiiMatch[]): MergeDecision {
  const kept: PiiMatch[] = [];
  const dropped: PiiMatch[] = [];

  // Dedupe identical matches so a regex+NER double-fire on the same span
  // does not get counted twice.
  const seen = new Set<string>();
  const unique: PiiMatch[] = [];
  for (const m of matches) {
    const key = `${m.type}|${m.start}|${m.end}|${m.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(m);
  }

  // Sort by start, then end (longer first via custom comparator).
  const sorted: IndexedMatch[] = unique
    .map((m, index) => ({ match: m, index }))
    .sort((a, b) => a.match.start - b.match.start || (b.match.end - b.match.start) - (a.match.end - a.match.start));

  for (const { match } of sorted) {
    const conflict = kept.find((k) => overlaps(k, match));
    if (!conflict) {
      kept.push(match);
      continue;
    }
    if (compareScores(match, conflict) > 0) {
      dropped.push(conflict);
      kept.push(match);
    } else {
      dropped.push(match);
    }
  }

  // Restore deterministic ordering for downstream consumers.
  kept.sort((a, b) => a.start - b.start);
  dropped.sort((a, b) => a.start - b.start);
  return { kept, dropped };
}
