// ============================================================================
// src/inviteClient.ts
// ============================================================================
// Client for the invite-gating RPCs introduced by Migration 019d.
//
// Two operations:
//   - redeemInviteCode(code, nodeKey)  → public.redeem_invite_code_v1
//   - checkMembership(nodeKey)         → public.is_member_v1
//
// Both RPCs return jsonb (a single JSON object, not a row set). They are
// SECURITY DEFINER + anon EXECUTE-grantable, so we hit them through
// PostgREST with the standard anon auth pair — NO x-pilot-key, that header
// is only consumed by the Edge Function family (semanticEmitter, statusClient,
// ingest_ping).
//
// Architectural posture:
//   - Mirrors openCommitmentsClient.ts / luminClient.ts (POST to
//     /rest/v1/rpc/<func> with `p_<param>` body).
//   - Errors surface as typed `{ ok: false, error: <code> }` objects.
//     Server-shape errors (`format_invalid`, `not_found`, etc.) and
//     transport errors (HTTP non-200, fetch throw) both flow through the
//     discriminated union. The caller never has to try/catch.
//   - Distinct from the semanticEmitter family: there, failure carries
//     `status` + free-text `error`; here the error codes are a finite set
//     enumerated by the SQL RPC. Both shapes are deliberate.
// ============================================================================

import { CONFIG } from "./config";

// ----------------------------------------------------------------------------
// Auth (mirrors openCommitmentsClient.ts exactly)
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
// redeem_invite_code_v1
// ----------------------------------------------------------------------------

/**
 * Canonical error codes returned by `redeem_invite_code_v1` per Migration
 * 019d SQL definition. The server canonicalizes input via
 *   translate(upper(trim(p_code)), 'OIL', '011')
 * before any check, so `format_invalid` only fires for codes that are
 * structurally wrong (length / charset) after canonicalization.
 */
export type RedeemErrorCode =
    | "format_invalid"               // input fails Crockford CHECK after canonicalization
    | "node_key_already_redeemed"    // this device's node_key already redeemed (any code)
    | "already_redeemed"             // the code itself is valid but already claimed by someone else
    | "not_found"                    // no row in invite_codes_v1 with that code
    | "transport";                   // HTTP non-200, network throw, or unparseable body

export type RedeemSuccess = {
    ok: true;
    code: string;                              // canonicalized form, post-translate
    redeemed_at: string;                       // ISO timestamptz (server-set)
    created_at: string;                        // ISO timestamptz (when code was minted)
    created_by_node_key: string | null;        // null = system-minted (seed code)
};

export type RedeemFailure = {
    ok: false;
    error: RedeemErrorCode;
    /** HTTP status (or -1 for fetch throw); useful for diagnostics. */
    status: number;
    /** Raw body for non-`ok` server responses; useful for unexpected shapes. */
    raw?: any;
};

export type RedeemResult = RedeemSuccess | RedeemFailure;

/**
 * Attempt to redeem an invite code for the given node_key. Never throws.
 * On a successful redemption: caller is expected to write the local
 * AsyncStorage gate flag via inviteRedeemedStore.markInviteRedeemed().
 *
 * Idempotency note: re-calling with the same (code, nodeKey) after a
 * successful redemption returns { ok: false, error: "node_key_already_redeemed" }
 * — NOT a success. The server's per-node_key partial-unique index makes
 * the second call structurally impossible to succeed. The cache flag
 * obviates a re-call in normal flow.
 */
export async function redeemInviteCode(
    code: string,
    nodeKey: string,
): Promise<RedeemResult> {
    try {
        const url = `${CONFIG.supabaseUrl}/rest/v1/rpc/redeem_invite_code_v1`;
        const res = await fetch(url, {
            method: "POST",
            headers: authHeaders(),
            body: JSON.stringify({
                p_code: code,
                p_redeeming_node_key: nodeKey,
            }),
        });

        const text = await res.text();
        let json: any = null;
        try {
            json = JSON.parse(text);
        } catch {
            // non-JSON body
        }

        if (!res.ok) {
            return {
                ok: false,
                error: "transport",
                status: res.status,
                raw: json ?? text,
            };
        }

        // PostgREST returns the jsonb directly as the response body (not
        // wrapped). For an `ok:true` row the shape is exactly what the RPC
        // returns; for `ok:false` likewise. Defensive parse on `ok`.
        if (json && json.ok === true) {
            return {
                ok: true,
                code: String(json.code ?? ""),
                redeemed_at: String(json.redeemed_at ?? ""),
                created_at: String(json.created_at ?? ""),
                created_by_node_key:
                    json.created_by_node_key == null
                        ? null
                        : String(json.created_by_node_key),
            };
        }

        // Server-shape failure. Narrow to the known error set; anything
        // unexpected falls through to "transport" so the UI can still
        // render something sane.
        const serverErr = json?.error;
        const known: RedeemErrorCode[] = [
            "format_invalid",
            "node_key_already_redeemed",
            "already_redeemed",
            "not_found",
        ];
        const error: RedeemErrorCode =
            typeof serverErr === "string" && (known as string[]).includes(serverErr)
                ? (serverErr as RedeemErrorCode)
                : "transport";

        return {
            ok: false,
            error,
            status: res.status,
            raw: json ?? text,
        };
    } catch (e: any) {
        return {
            ok: false,
            error: "transport",
            status: -1,
            raw: String(e?.message ?? e),
        };
    }
}

// ----------------------------------------------------------------------------
// is_member_v1
// ----------------------------------------------------------------------------

export type MembershipMember = {
    is_member: true;
    node_key: string;
    joined_at: string;                  // ISO timestamptz (redeemed_at on the row)
    redeemed_code: string;
    invited_by_node_key: string | null; // null = system-minted (seed / grandfather)
};

export type MembershipNonMember = {
    is_member: false;
    node_key: string;
};

export type MembershipUnknown = {
    /** Discriminator: neither member nor confirmed-non-member; treat as gated. */
    is_member: null;
    /** HTTP status (or -1 for fetch throw). */
    status: number;
    raw?: any;
};

export type MembershipResult =
    | MembershipMember
    | MembershipNonMember
    | MembershipUnknown;

/**
 * Probe membership for the given node_key. Never throws.
 *
 * Three terminal states:
 *   - `is_member: true`  → render app; mark local cache.
 *   - `is_member: false` → render gate screen.
 *   - `is_member: null`  → transport failure; render gate screen
 *                          (fail-closed; a real member can still redeem
 *                          interactively once network is back, or boot
 *                          again to retry the probe).
 *
 * The fail-closed default is deliberate. Alternative ("fail-open with
 * banner") would let a non-member access the app on any network failure;
 * the gate is meant to be unambiguous. A grandfathered member who is
 * offline on first launch sees the gate once, gets back online, and the
 * next boot's probe heals it. A redeemed member's cache flag bypasses the
 * probe entirely, so this only affects the truly-first launch.
 */
export async function checkMembership(
    nodeKey: string,
): Promise<MembershipResult> {
    try {
        const url = `${CONFIG.supabaseUrl}/rest/v1/rpc/is_member_v1`;
        const res = await fetch(url, {
            method: "POST",
            headers: authHeaders(),
            body: JSON.stringify({ p_node_key: nodeKey }),
        });

        const text = await res.text();
        let json: any = null;
        try {
            json = JSON.parse(text);
        } catch {
            // non-JSON body
        }

        if (!res.ok) {
            return { is_member: null, status: res.status, raw: json ?? text };
        }

        if (json && json.is_member === true) {
            return {
                is_member: true,
                node_key: String(json.node_key ?? nodeKey),
                joined_at: String(json.joined_at ?? ""),
                redeemed_code: String(json.redeemed_code ?? ""),
                invited_by_node_key:
                    json.invited_by_node_key == null
                        ? null
                        : String(json.invited_by_node_key),
            };
        }

        if (json && json.is_member === false) {
            return {
                is_member: false,
                node_key: String(json.node_key ?? nodeKey),
            };
        }

        // Unexpected shape (e.g. RPC removed, server bug). Treat as
        // unknown / fail-closed.
        return { is_member: null, status: res.status, raw: json ?? text };
    } catch (e: any) {
        return {
            is_member: null,
            status: -1,
            raw: String(e?.message ?? e),
        };
    }
}
