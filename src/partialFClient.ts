// ============================================================================
// src/partialFClient.ts
// ============================================================================
// Read-only client for the device's partial-F obligation ranking.
//
// Calls public.get_partial_f_v1(p_node_key text) via PostgREST RPC.
// Mirrors the auth + URL + identity pattern of luminClient.ts / openCommitmentsClient.ts.
//
// RPC name lowercase note:
//   The SQL function is declared `get_partial_F_v1` (uppercase F per
//   Vibe-Mechanics Spec §3.4 naming), but PostgreSQL identifier folding
//   stores it as `get_partial_f_v1` in pg_proc and PostgREST routes by the
//   folded name. The URL path uses lowercase. (See feedback memory
//   `feedback_postgres_identifier_folding.md`.)
//
// Numeric coercion note (same as luminClient / openCommitmentsClient):
//   PostgREST serializes numeric/bigint types as STRINGS by default to
//   preserve precision (e.g. "9999999999", not 9999999999). All numeric
//   fields are coerced to JS numbers in the normalize* helpers — display
//   code can trust the PartialFState shape without per-render parsing.
//
// Response shape source-of-truth: migration 018_partial_F_rpc.sql §1
//   (lines 159-186). Each obligation has 10 fields; the wrapper has 6.
//
// Failure posture:
//   - Never throws. Network/transport failures and unexpected response
//     shapes both surface as `{ ok: false, status, body }`.
//   - On failure the caller is expected to render no badges (per M020 §3
//     secondary call: silent absence > visible warning for a non-essential
//     affordance).
// ============================================================================

import { CONFIG } from "./config";
import { getNodeId } from "./identity";

// ----------------------------------------------------------------------------
// Types — mirror M018 jsonb shape exactly
// ----------------------------------------------------------------------------

export type ObligationType = "own_overdue_commitment" | "incoming_unacknowledged";

export type Obligation = {
    type: ObligationType;
    ref_id: string;              // commitment_id
    weight: number;              // scope_weight, 0..1
    age_buckets: number;         // bigint; PostgREST returns string
    score: number;               // weight × age_buckets; PostgREST returns string
    description: string;
    committer: string;           // node_key of the committer
    to_party: string | null;     // node_key of recipient (or null for network)
    due_bucket: number;          // bigint
    created_bucket: number;      // bigint
};

export type PartialFState = {
    node_key: string;
    current_bucket: number;      // bigint
    computed_at: string;         // ISO timestamptz
    partial_f_total: number;     // numeric
    obligation_count: number;    // bigint
    obligations: Obligation[];   // pre-sorted by score DESC, age_buckets DESC, ref_id ASC
};

export type FetchPartialFResult =
    | { ok: true; state: PartialFState }
    | { ok: false; status: number; body: string };

// ----------------------------------------------------------------------------
// Auth (identical to openCommitmentsClient.ts)
// ----------------------------------------------------------------------------

function authHeaders(): Record<string, string> {
    const anon = CONFIG.supabaseAnonKey || "";
    return {
        apikey: anon,
        Authorization: `Bearer ${anon}`,
        "Content-Type": "application/json",
        Accept: "application/json",
    };
}

// ----------------------------------------------------------------------------
// Normalization — defensive coercion of PostgREST string-numerics
// ----------------------------------------------------------------------------

function toNumber(v: unknown, fallback = 0): number {
    if (v === null || v === undefined) return fallback;
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? n : fallback;
}

function normalizeObligationType(v: unknown): ObligationType {
    // Defensive: unexpected values default to own_overdue_commitment (the
    // less-load-bearing branch for downstream logic). A wrong type doesn't
    // crash the UI; it just slightly mis-categorizes one row.
    return v === "incoming_unacknowledged"
        ? "incoming_unacknowledged"
        : "own_overdue_commitment";
}

function normalizeObligation(raw: any): Obligation {
    return {
        type: normalizeObligationType(raw?.type),
        ref_id: String(raw?.ref_id ?? ""),
        weight: toNumber(raw?.weight),
        age_buckets: toNumber(raw?.age_buckets),
        score: toNumber(raw?.score),
        description: String(raw?.description ?? ""),
        committer: String(raw?.committer ?? ""),
        to_party: raw?.to_party == null ? null : String(raw.to_party),
        due_bucket: toNumber(raw?.due_bucket),
        created_bucket: toNumber(raw?.created_bucket),
    };
}

function normalizeState(raw: any, nodeKeyFallback: string): PartialFState {
    return {
        node_key: String(raw?.node_key ?? nodeKeyFallback),
        current_bucket: toNumber(raw?.current_bucket),
        computed_at: String(raw?.computed_at ?? ""),
        partial_f_total: toNumber(raw?.partial_f_total),
        obligation_count: toNumber(raw?.obligation_count),
        obligations: Array.isArray(raw?.obligations)
            ? raw.obligations.map(normalizeObligation)
            : [],
    };
}

// ----------------------------------------------------------------------------
// Fetch
// ----------------------------------------------------------------------------

/**
 * Fetch this device's partial-F obligation ranking. Returns the full
 * pre-sorted list (highest score first) for the node identified by
 * getNodeId().
 *
 * Read-only; safe to call from a polling loop. STABLE on the server side,
 * so PostgreSQL caches within a single statement; client-side caching is
 * the caller's concern (M020 keeps the last result in component state and
 * refreshes on a 60s loop + AppState foreground hook).
 */
export async function fetchPartialF(): Promise<FetchPartialFResult> {
    try {
        const nodeKey = await getNodeId();
        // Lowercase per pg_proc identifier folding (see file header).
        const url = `${CONFIG.supabaseUrl}/rest/v1/rpc/get_partial_f_v1`;

        const res = await fetch(url, {
            method: "POST",
            headers: authHeaders(),
            body: JSON.stringify({ p_node_key: nodeKey }),
        });

        const text = await res.text();
        if (!res.ok) {
            return { ok: false, status: res.status, body: text };
        }

        const parsed = JSON.parse(text);
        return { ok: true, state: normalizeState(parsed, nodeKey) };
    } catch (e: any) {
        return {
            ok: false,
            status: -1,
            body: String(e?.message ?? e),
        };
    }
}
