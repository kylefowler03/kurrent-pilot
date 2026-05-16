// ============================================================================
// useLabels.ts — React hook for bulk participant-label resolution
// ============================================================================
// Per Migration 019a. Wraps fetchParticipantLabels with React state + stale-
// fetch guard.
//
// Pattern: caller passes an array of node_keys (any length, may contain
// duplicates or empty strings). Hook returns `{ labels, isLoading, error }`.
// Refetches when the *set* of node_keys changes (de-dup + sort + join makes
// the cache key stable across re-renders that have the same input set).
//
// No persistent cache — in-memory only. Own-label fast-paint is handled
// separately via the *Local AsyncStorage helpers in identity.ts.
// ============================================================================

import { useEffect, useRef, useState } from "react";
import { fetchParticipantLabels } from "./labelsClient";

export type LabelMap = Record<string, string>;

export type UseLabelsResult = {
  labels: LabelMap;
  isLoading: boolean;
  error: string | null;
};

export function useLabels(nodeKeys: string[]): UseLabelsResult {
  const [labels, setLabels] = useState<LabelMap>({});
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  // Stable cache key: filter empties + dedupe + sort + join. Identical
  // inputs across re-renders produce identical cacheKey → effect skips.
  const cacheKey = Array.from(
    new Set(
      (nodeKeys ?? []).filter(
        (k): k is string => typeof k === "string" && k.length > 0
      )
    )
  )
    .sort()
    .join("|");

  // Generation counter so a stale in-flight call doesn't overwrite a fresher
  // one. Matches the lookupGeneration pattern from App.tsx event lookup.
  const generationRef = useRef(0);

  useEffect(() => {
    if (cacheKey.length === 0) {
      setLabels({});
      setIsLoading(false);
      setError(null);
      return;
    }

    const myGeneration = ++generationRef.current;
    setIsLoading(true);
    setError(null);

    const keys = cacheKey.split("|");

    fetchParticipantLabels(keys).then((r) => {
      if (myGeneration !== generationRef.current) return; // stale

      if (!r.ok) {
        setError(`${r.status}: ${r.body}`);
        setIsLoading(false);
        return;
      }

      const next: LabelMap = {};
      for (const row of r.labels) {
        if (row.node_key && row.label) {
          next[row.node_key] = row.label;
        }
      }
      setLabels(next);
      setIsLoading(false);
    });
  }, [cacheKey]);

  return { labels, isLoading, error };
}

/**
 * Inline render helper. Returns the friendly label when known, otherwise a
 * truncated node_key (matching App.tsx's existing `truncateNodeKey` shape).
 *
 * Use everywhere a raw node_key would otherwise be shown to a human.
 */
export function labelOrTruncated(nodeKey: string, labels: LabelMap): string {
  if (!nodeKey) return "?";
  const lbl = labels[nodeKey];
  if (typeof lbl === "string" && lbl.length > 0) return lbl;
  if (nodeKey.length <= 12) return nodeKey;
  return nodeKey.slice(0, 8) + "…" + nodeKey.slice(-4);
}
