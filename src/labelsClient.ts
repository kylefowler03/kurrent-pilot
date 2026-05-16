// ============================================================================
// labelsClient.ts — bulk participant-label resolution
// ============================================================================
// Per Migration 019a. Wraps get_participant_labels_v1 (bulk read RPC).
// Single-call resolves a batch of node_keys → labels for sub-card rendering.
//
// Existing single-label write path remains in statusClient.setParticipantLabel
// (now returns the canonicalized stored row in its `row` field per M019a).
// This file ONLY covers reads.
//
// Conventions:
//   - `body` is the failure-discriminator field name (matches the newer fetch
//     clients: luminClient, openCommitmentsClient, incomingCommitmentsClient,
//     eventsClient). Do NOT rename to `error`.
//   - `CONFIG` is imported as a single uppercase object, never as named members.
//   - Defensive coercion on all jsonb fields per established convention.
// ============================================================================

import { CONFIG } from "./config";

function authHeaders() {
  const anon = CONFIG.supabaseAnonKey || "";
  return {
    apikey: anon,
    Authorization: `Bearer ${anon}`,
  };
}

export type ParticipantLabel = {
  node_key: string;
  label: string;
  note: string | null;
};

export type FetchLabelsResult =
  | { ok: true; labels: ParticipantLabel[] }
  | { ok: false; status: number; body: string };

/**
 * Bulk-resolve labels for a list of node_keys.
 *
 * - De-dupes + filters empty strings before round-tripping.
 * - Empty / all-empty input returns `{ ok: true, labels: [] }` with no
 *   network call (saves one round trip per empty render).
 * - Unmatched node_keys are silently omitted from the response per the
 *   server-side Q7 ratification. Callers should fall back to truncated
 *   node_key rendering when a key is missing from the result map.
 */
export async function fetchParticipantLabels(
  nodeKeys: string[]
): Promise<FetchLabelsResult> {
  if (!nodeKeys || nodeKeys.length === 0) {
    return { ok: true, labels: [] };
  }

  const uniqueKeys = Array.from(
    new Set(
      nodeKeys.filter((k): k is string => typeof k === "string" && k.length > 0)
    )
  ).sort();

  if (uniqueKeys.length === 0) {
    return { ok: true, labels: [] };
  }

  try {
    const url = `${CONFIG.supabaseUrl}/rest/v1/rpc/get_participant_labels_v1`;

    const res = await fetch(url, {
      method: "POST",
      headers: {
        ...authHeaders(),
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ p_node_keys: uniqueKeys }),
    });

    const text = await res.text();
    if (!res.ok) {
      return { ok: false, status: res.status, body: text };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return {
        ok: false,
        status: 500,
        body: `non-JSON response from get_participant_labels_v1: ${text.slice(
          0,
          200
        )}`,
      };
    }

    if (!Array.isArray(parsed)) {
      return {
        ok: false,
        status: 500,
        body: `expected array from get_participant_labels_v1, got ${typeof parsed}`,
      };
    }

    const labels: ParticipantLabel[] = parsed.map((raw: any) => ({
      node_key: String(raw?.node_key ?? ""),
      label: String(raw?.label ?? ""),
      note: raw?.note == null ? null : String(raw.note),
    }));

    return { ok: true, labels };
  } catch (e: any) {
    return { ok: false, status: -1, body: String(e?.message ?? e) };
  }
}
