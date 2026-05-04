// ============================================================================
// src/luminClient.ts
// ============================================================================
// Read-only client for LUMIN balance + recent issuances.
//
// Calls public.get_lumin_state_v1(p_node_key text) via PostgREST RPC.
// Mirrors the auth + URL pattern of statusClient.ts's setParticipantLabel.
//
// Numeric coercion note:
//   PostgREST serializes numeric/bigint types as STRINGS by default to
//   preserve precision (e.g. "0.600000", not 0.6). All numeric fields are
//   coerced to JS numbers in the normalize* helpers — display code can
//   trust the LuminState shape without per-render parsing.
// ============================================================================

import { CONFIG } from "./config";
import { getNodeId } from "./identity";

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export type LuminIssuance = {
    id: number;
    amount: number;                    // already-coerced
    issued_at_bucket: number;
    created_at: string;                // ISO timestamp
    status: "active" | "redeemed" | "transferred" | string;
    event_type: string;                // e.g. "commitment.kept"
    commitment_id: string | null;
    capped: boolean;
};

export type LuminState = {
    node_key: string;
    balance_active: number;
    total_ever_issued: number;
    active_count: number;
    recent_issuances: LuminIssuance[];
};

export type LuminStateResult =
    | { ok: true; state: LuminState }
    | { ok: false; status: number; body: string };

// ----------------------------------------------------------------------------
// Auth (same triad as statusClient.ts; no x-pilot-key — RPC goes through
// PostgREST, not Edge Functions)
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

function normalizeIssuance(raw: any): LuminIssuance {
    return {
        id: toNumber(raw?.id),
        amount: toNumber(raw?.amount),
        issued_at_bucket: toNumber(raw?.issued_at_bucket),
        created_at: String(raw?.created_at ?? ""),
        status: String(raw?.status ?? ""),
        event_type: String(raw?.event_type ?? ""),
        commitment_id: raw?.commitment_id == null ? null : String(raw.commitment_id),
        capped: Boolean(raw?.capped),
    };
}

function normalizeState(raw: any): LuminState {
    return {
        node_key: String(raw?.node_key ?? ""),
        balance_active: toNumber(raw?.balance_active),
        total_ever_issued: toNumber(raw?.total_ever_issued),
        active_count: toNumber(raw?.active_count),
        recent_issuances: Array.isArray(raw?.recent_issuances)
            ? raw.recent_issuances.map(normalizeIssuance)
            : [],
    };
}

// ----------------------------------------------------------------------------
// Fetch
// ----------------------------------------------------------------------------

/**
 * Fetch this device's LUMIN state. Returns balance + last 5 issuances.
 * Read-only; safe to call from a polling loop.
 */
export async function fetchLuminState(): Promise<LuminStateResult> {
    try {
        const nodeKey = await getNodeId();
        const url = `${CONFIG.supabaseUrl}/rest/v1/rpc/get_lumin_state_v1`;

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
        return { ok: true, state: normalizeState(parsed) };
    } catch (e: any) {
        return {
            ok: false,
            status: -1,
            body: String(e?.message ?? e),
        };
    }
}
