// ============================================================================
// src/semanticEmitter.ts
// ============================================================================
// Direct-fire client for the ingest_semantic_ping Edge Function.
//
// Architectural posture (deliberate divergence from src/emitter.ts):
//   - Carrier pings (emitter.ts) are high-cadence and use a persisted queue
//     ("never lose signal"). They tolerate eventual delivery.
//   - Semantic pings are user-initiated, low-cadence, and ORDER-SENSITIVE
//     (commitment.kept must arrive AFTER commitment.made or the next-tick
//     compute pass logs an orphan). A queue's stop-on-failure + reorder
//     would hide failures from the user and break match semantics.
//
// So: each call is a single POST. Success/failure is surfaced to the caller,
// who is expected to render it. Layer a retry mechanism later if pilot
// members report flakiness — don't pre-build it.
//
// Auth: same triad as emitter.ts — Authorization Bearer <anonKey> + apikey
// + x-pilot-key. The Edge Function gateway requires the bearer; the function
// body gates on x-pilot-key.
// ============================================================================

import { CONFIG } from "./config";
import { getNodeId } from "./identity";

// ----------------------------------------------------------------------------
// Constants
// ----------------------------------------------------------------------------

// Must match server: const bucketMs = 300000 in functions/ingest_semantic_ping/index.ts
const BUCKET_MS = 300_000;

// ----------------------------------------------------------------------------
// Time bucket helpers
// ----------------------------------------------------------------------------

/** 5-minute time bucket containing `now`. */
export function currentBucket(): number {
    return Math.floor(Date.now() / BUCKET_MS);
}

/** 5-minute bucket `msFromNow` milliseconds after `now`. Negative => past. */
export function bucketAt(msFromNow: number): number {
    return Math.floor((Date.now() + msFromNow) / BUCKET_MS);
}

// ----------------------------------------------------------------------------
// Auth headers (mirrors emitter.ts and statusClient.ts pattern)
// ----------------------------------------------------------------------------

function authHeaders(): Record<string, string> {
    const anon = CONFIG.supabaseAnonKey ?? "";
    const h: Record<string, string> = {
        "Content-Type": "application/json",
        "x-pilot-key": CONFIG.pilotKey ?? "",
    };
    if (anon) {
        h["Authorization"] = `Bearer ${anon}`;
        h["apikey"] = anon;
    }
    return h;
}

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export type SemanticType =
    | "commitment.made"
    | "commitment.kept"
    | "presence.attested"
    | "commitment.acknowledged";

export type SemanticOk = {
    ok: true;
    status: number;            // HTTP status
    id: string;                // semantic_pings_v1 row id
    time_bucket: number;       // 5-min bucket the row was filed under
    serverStatus: string;      // "pending" on insert
    note?: string;             // human-readable next-tick hint
    raw: any;                  // full server json (for debug / Last-Ping panel)
};

export type SemanticErr = {
    ok: false;
    status: number;            // HTTP status, or -1 for network/throw
    error: string;             // server-provided error or thrown message
    raw: any;                  // body or null
};

export type SemanticResult = SemanticOk | SemanticErr;

// ----------------------------------------------------------------------------
// Core POST
// ----------------------------------------------------------------------------

async function postSemantic(
    type: SemanticType,
    payload: Record<string, unknown>,
): Promise<SemanticResult> {
    try {
        const node_key = await getNodeId();

        const body = {
            node_key,
            type,
            payload,
            client_version: "expo_semantic_v1",
        };

        const res = await fetch(CONFIG.ingestSemanticPingUrl, {
            method: "POST",
            headers: authHeaders(),
            body: JSON.stringify(body),
        });

        const text = await res.text();
        let json: any = null;
        try {
            json = JSON.parse(text);
        } catch {
            // non-JSON body; keep null
        }

        if (!res.ok || !json?.ok) {
            return {
                ok: false,
                status: res.status,
                error:
                    (json && typeof json.error === "string" && json.error) ||
                    text ||
                    `HTTP ${res.status}`,
                raw: json ?? text,
            };
        }

        return {
            ok: true,
            status: res.status,
            id: String(json.id),
            time_bucket: Number(json.time_bucket),
            serverStatus: String(json.status),
            note: typeof json.note === "string" ? json.note : undefined,
            raw: json,
        };
    } catch (e: any) {
        return {
            ok: false,
            status: -1,
            error: String(e?.message ?? e),
            raw: null,
        };
    }
}

// ----------------------------------------------------------------------------
// Typed senders — one per supported v1 type
// ----------------------------------------------------------------------------

export type CommitmentMadeArgs = {
    /** Client-generated id. Use newCommitmentId(). Persisted locally so user can later "I kept it". */
    commitment_id: string;

    /** 1..500 chars per server validation. */
    description: string;

    /** Milliseconds from now until due. Converted to a 5-min due_bucket on send. */
    due_in_ms: number;

    /** 0..1; if omitted, server compute pass uses its default. */
    scope_weight?: number;

    /** Counterparty node_key, or omit for "to the network". */
    to?: string | null;
};

export async function sendCommitmentMade(
    args: CommitmentMadeArgs,
): Promise<SemanticResult> {
    const due_bucket = bucketAt(Math.max(0, args.due_in_ms));

    const payload: Record<string, unknown> = {
        commitment_id: args.commitment_id,
        description: args.description,
        due_bucket,
    };
    if (args.scope_weight !== undefined) payload.scope_weight = args.scope_weight;
    if (args.to !== undefined && args.to !== null) payload.to = args.to;

    return postSemantic("commitment.made", payload);
}

export type CommitmentKeptArgs = {
    /** Same id used in the corresponding sendCommitmentMade. Server matches against open commitment on next tick. */
    commitment_id: string;
};

export async function sendCommitmentKept(
    args: CommitmentKeptArgs,
): Promise<SemanticResult> {
    return postSemantic("commitment.kept", {
        commitment_id: args.commitment_id,
    });
}

// ---- Migration 011: recipient-side acknowledgment ----
// Emitted by the recipient (to_party) of an open P2P commitment to confirm
// receipt. The compute pass matches the pinger's node_key against the
// commitment's to_party, so no recipient field is needed in the payload —
// the auth layer enforces who is emitting the ping.
//
// Shape mirrors sendCommitmentKept exactly (only commitment_id required).
// Distinct from canonical Type 4 mutual.acknowledgment (paired-signature),
// which remains unsupported in pilot v1.
export async function sendCommitmentAcknowledged(args: {
    commitment_id: string;
}): Promise<SemanticResult> {
    return await postSemantic(
        "commitment.acknowledged",
        { commitment_id: args.commitment_id },
    );
}

export type PresenceAttestedArgs = {
    /** Free-text event code (organiser-shared). Non-empty string. */
    event_id: string;

    /** Bucket the user attested at. Defaults to currentBucket() if omitted. */
    attended_bucket?: number;
};

// ---- Migration 013: rename event_id → event_code ----
// Aligns the client with the canonical events_v1.event_code schema
// (Migration 012). The Edge Function still accepts the legacy `event_id`
// field via its back-compat normalization, so older clients continue to
// work — but new code should use the canonical name.
//
// `attended_bucket` is now OPTIONAL server-side (the compute pass uses
// semantic_pings_v1.time_bucket which is server-set at ingest). We keep
// passing it so the stored payload retains the client's view of "when did
// I tap this", which is useful for forensic traceability on the off chance
// time_bucket and the client's clock disagree.
export async function sendPresenceAttested(args: {
    event_code: string;
}): Promise<SemanticResult> {
    return await postSemantic(
        "presence.attested",
        {
            event_code: args.event_code,
            attended_bucket: Math.floor(Date.now() / 300000),
        },
    );
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

/**
 * Generate a short, URL-safe commitment_id.
 * Format: c_<timestamp_base36>_<random6>
 * Collision space: ~2B per millisecond per timestamp prefix — vanishing for v1.
 */
export function newCommitmentId(): string {
    const t = Date.now().toString(36);
    const r = Math.random().toString(36).slice(2, 8);
    return `c_${t}_${r}`;
}
