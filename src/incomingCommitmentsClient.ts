// ============================================================================
// src/incomingCommitmentsClient.ts
// ============================================================================
// Read-only client for commitments OWED TO this node — i.e. open commitments
// where `to_party = my_node_key` rather than `committer = my_node_key`.
//
// Calls public.get_incoming_commitments_v1(p_node_key text) via PostgREST RPC.
// Mirrors the auth + URL + identity pattern of openCommitmentsClient.ts
// (Migration 008) and luminClient.ts (Migration 007).
//
// Shape difference from OpenCommitment: this surfaces `committer` (the giver
// of the promise), and omits `to_party` (it's always the caller — implicit).
// Numeric fields are coerced to JS numbers at the boundary, same as siblings.
// ============================================================================

import { CONFIG } from "./config";
import { getNodeId } from "./identity";

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export type IncomingCommitment = {
    commitment_id: string;
    description: string;
    committer: string;           // KEY DIFFERENCE vs OpenCommitment: the giver
    scope_weight: number;        // numeric; PostgREST returns string-numeric
    due_bucket: number;          // bigint; PostgREST returns string
    made_at: string;             // ISO timestamptz
    made_ping_id: number | null; // bigint or null
};

export type IncomingCommitmentsState = {
    node_key: string;
    open_count: number;
    commitments: IncomingCommitment[];
};

export type FetchIncomingResult =
    | { ok: true; state: IncomingCommitmentsState }
    | { ok: false; status: number; body: string };

// ----------------------------------------------------------------------------
// Auth (same triad as luminClient.ts / openCommitmentsClient.ts)
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
// Normalization (defensive coercion of PostgREST string-numerics)
// ----------------------------------------------------------------------------

function toNumber(v: unknown, fallback = 0): number {
    if (v === null || v === undefined) return fallback;
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? n : fallback;
}

function toNullableNumber(v: unknown): number | null {
    if (v === null || v === undefined) return null;
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? n : null;
}

function normalizeCommitment(raw: any): IncomingCommitment {
    return {
        commitment_id: String(raw?.commitment_id ?? ""),
        description:   String(raw?.description ?? ""),
        committer:     String(raw?.committer ?? ""),
        scope_weight:  toNumber(raw?.scope_weight),
        due_bucket:    toNumber(raw?.due_bucket),
        made_at:       String(raw?.made_at ?? ""),
        made_ping_id:  toNullableNumber(raw?.made_ping_id),
    };
}

function normalizeState(raw: any, nodeKeyFallback: string): IncomingCommitmentsState {
    return {
        node_key:    String(raw?.node_key ?? nodeKeyFallback),
        open_count:  toNumber(raw?.open_count),
        commitments: Array.isArray(raw?.commitments)
            ? raw.commitments.map(normalizeCommitment)
            : [],
    };
}

// ----------------------------------------------------------------------------
// Fetch
// ----------------------------------------------------------------------------

/**
 * Fetch open commitments owed TO this node. Read-only; safe to call from a
 * polling loop. The recipient cannot resolve someone else's commitment — only
 * the committer's "I kept it" tap matters — so this returns view-only data.
 */
export async function fetchIncomingCommitments(): Promise<FetchIncomingResult> {
    try {
        const nodeKey = await getNodeId();
        const url = `${CONFIG.supabaseUrl}/rest/v1/rpc/get_incoming_commitments_v1`;

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
