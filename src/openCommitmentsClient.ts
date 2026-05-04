/**
 * Migration 008-client — fetch this node's open commitments from the server.
 *
 * Sibling to `luminClient.ts` (Migration 007). Same auth pattern, same
 * defensive numeric coercion at the boundary (PostgREST serializes numerics
 * as strings, so we normalize once on the way in).
 *
 * The RPC is read-only (SECURITY DEFINER, GRANT EXECUTE TO anon), defined
 * in `migrations/008_get_open_commitments_v1.sql`. Failures are returned as
 * a discriminated union so callers can render an error box without throwing.
 *
 * Why pass `nodeKey` as a parameter rather than importing identity:
 *   App.tsx already holds the node_key for display in the "This Node" card.
 *   Passing it in keeps this module independent of the identity layer and
 *   matches how `luminClient.ts` is wired in Migration 007.
 */

import { supabaseUrl, supabaseAnonKey } from "./config";

export interface OpenCommitment {
    commitment_id: string;
    description: string;
    scope_weight: number;        // numeric; PostgREST returns string-numeric
    due_bucket: number;          // bigint; PostgREST returns string
    to_party: string | null;
    made_at: string;             // ISO timestamptz
    made_ping_id: number | null; // bigint or null
}

export interface OpenCommitmentsState {
    node_key: string;
    open_count: number;
    commitments: OpenCommitment[];
}

export type FetchOpenResult =
    | { ok: true; state: OpenCommitmentsState }
    | { ok: false; status: number; error: string };

// ---- Boundary coercions ----

const toNumber = (v: unknown): number => {
    if (typeof v === "number") return v;
    if (typeof v === "string") {
        const n = Number(v);
        return Number.isFinite(n) ? n : 0;
    }
    return 0;
};

const toNullableNumber = (v: unknown): number | null => {
    if (v === null || v === undefined) return null;
    if (typeof v === "number") return v;
    if (typeof v === "string") {
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
    }
    return null;
};

const normalizeCommitment = (raw: any): OpenCommitment => ({
    commitment_id: String(raw?.commitment_id ?? ""),
    description:   String(raw?.description ?? ""),
    scope_weight:  toNumber(raw?.scope_weight),
    due_bucket:    toNumber(raw?.due_bucket),
    to_party:      raw?.to_party === null || raw?.to_party === undefined
                       ? null
                       : String(raw.to_party),
    made_at:       String(raw?.made_at ?? ""),
    made_ping_id:  toNullableNumber(raw?.made_ping_id),
});

// ---- Fetch ----

export async function fetchOpenCommitments(nodeKey: string): Promise<FetchOpenResult> {
    if (!nodeKey || typeof nodeKey !== "string") {
        return { ok: false, status: 0, error: "nodeKey is required" };
    }

    const url = `${supabaseUrl}/rest/v1/rpc/get_open_commitments_v1`;

    let resp: Response;
    try {
        resp = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "apikey": supabaseAnonKey,
                "Authorization": `Bearer ${supabaseAnonKey}`,
            },
            body: JSON.stringify({ p_node_key: nodeKey }),
        });
    } catch (e: any) {
        return { ok: false, status: 0, error: `network error: ${e?.message ?? String(e)}` };
    }

    const text = await resp.text();

    if (!resp.ok) {
        return { ok: false, status: resp.status, error: text || `HTTP ${resp.status}` };
    }

    let parsed: any;
    try {
        parsed = JSON.parse(text);
    } catch (e: any) {
        return {
            ok: false,
            status: resp.status,
            error: `parse error: ${text.slice(0, 200)}`,
        };
    }

    const commitmentsRaw: any[] = Array.isArray(parsed?.commitments)
        ? parsed.commitments
        : [];

    const state: OpenCommitmentsState = {
        node_key:    String(parsed?.node_key ?? nodeKey),
        open_count:  toNumber(parsed?.open_count),
        commitments: commitmentsRaw.map(normalizeCommitment),
    };

    return { ok: true, state };
}
