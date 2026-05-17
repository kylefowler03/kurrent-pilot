// ============================================================================
// eventsClient.ts — Migration 013
// ============================================================================
// Drop-in client module for the events_v1 RPCs added in Migration 012:
//   - createEvent({ label, expires_at, quorum_threshold?, hosting_lumin_threshold? })
//       → mints a new event with a fresh event_code, returns metadata.
//   - getEvent({ event_code })
//       → reads an event's current state (host, label, attendee counts,
//         quorum status, hosting-LUMIN status). Returns { event: null } if
//         the event_code doesn't exist.
//
// Conventions matched against existing newer fetch clients (luminClient,
// openCommitmentsClient, incomingCommitmentsClient):
//   - Failure discriminator field is `body`, NOT `error` (the older
//     semanticEmitter family uses `error`).
//   - createEvent calls getNodeId() internally — no nodeKey parameter at
//     the call site.
//   - Defensive coercion via inline String(...) / toNumber(...) /
//     typeof === "string" patterns. Matches incomingCommitmentsClient's
//     post-Migration 011 house style.
//   - No external dependencies beyond the existing CONFIG and getNodeId
//     imports.
// ============================================================================

import { CONFIG } from "./config";
import { getNodeId } from "./identity";

// ----------------------------------------------------------------------------
// Defensive coercion helpers
// ----------------------------------------------------------------------------

function toNumber(raw: unknown): number {
    return typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
}

function toNullableString(raw: unknown): string | null {
    return typeof raw === "string" ? raw : null;
}

// ----------------------------------------------------------------------------
// Result shapes
// ----------------------------------------------------------------------------

export type EventDetails = {
    event_code: string;
    host: string;
    label: string;
    created_at: string;
    expires_at: string;
    quorum_threshold: number;
    quorum_met_at: string | null;
    hosting_lumin_threshold: number;
    host_lumin_issued_at: string | null;
    attendee_count_resolved: number;
    non_host_attendee_count_resolved: number;
    // ---- Migration 019b: claimed-count surfacing ----
    // Distinct node_keys with status IN ('pending','resolved') for
    // presence.attested pings matching this event_code. Pre-quorum
    // attestations surface here before Pass 5 flips them to resolved.
    attendee_count_claimed: number;
    non_host_attendee_count_claimed: number;
};

export type CreateEventResult =
    | {
        ok: true;
        event_code: string;
        event_id: number;
        host: string;
        label: string;
        created_at: string;
        expires_at: string;
        quorum_threshold: number;
        hosting_lumin_threshold: number;
    }
    | { ok: false; status: number; body: string };

export type GetEventResult =
    | { ok: true; event: EventDetails }
    | { ok: true; event: null }
    | { ok: false; status: number; body: string };

// ----------------------------------------------------------------------------
// createEvent
// ----------------------------------------------------------------------------

export async function createEvent(args: {
    label: string;
    /** ISO-8601 timestamp string. Must be in the future and within 7 days. */
    expires_at: string;
    /** Default 3, range [2, 50]. */
    quorum_threshold?: number;
    /** Default 5, range [2, 50]. */
    hosting_lumin_threshold?: number;
}): Promise<CreateEventResult> {
    const node_key = await getNodeId();

    const url = `${CONFIG.supabaseUrl}/rest/v1/rpc/create_event_v1`;
    const body: Record<string, unknown> = {
        p_node_key: node_key,
        p_label: args.label,
        p_expires_at: args.expires_at,
    };
    if (args.quorum_threshold !== undefined) {
        body.p_quorum_threshold = args.quorum_threshold;
    }
    if (args.hosting_lumin_threshold !== undefined) {
        body.p_hosting_lumin_threshold = args.hosting_lumin_threshold;
    }

    let resp: Response;
    try {
        resp = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                apikey: CONFIG.supabaseAnonKey,
                Authorization: `Bearer ${CONFIG.supabaseAnonKey}`,
            },
            body: JSON.stringify(body),
        });
    } catch (e: unknown) {
        const msg =
            e instanceof Error ? e.message : typeof e === "string" ? e : "fetch failed";
        return { ok: false, status: 0, body: msg };
    }

    if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        return { ok: false, status: resp.status, body: text };
    }

    const raw = (await resp.json().catch(() => null)) as Record<string, unknown> | null;
    if (!raw || typeof raw !== "object") {
        return { ok: false, status: resp.status, body: "malformed create_event_v1 response" };
    }

    return {
        ok: true,
        event_code: String(raw?.event_code ?? ""),
        event_id: toNumber(raw?.event_id),
        host: String(raw?.host ?? ""),
        label: String(raw?.label ?? ""),
        created_at: String(raw?.created_at ?? ""),
        expires_at: String(raw?.expires_at ?? ""),
        quorum_threshold: toNumber(raw?.quorum_threshold),
        hosting_lumin_threshold: toNumber(raw?.hosting_lumin_threshold),
    };
}

// ----------------------------------------------------------------------------
// getEvent
// ----------------------------------------------------------------------------

export async function getEvent(args: {
    event_code: string;
}): Promise<GetEventResult> {
    const url = `${CONFIG.supabaseUrl}/rest/v1/rpc/get_event_v1`;
    const body = { p_event_code: args.event_code };

    let resp: Response;
    try {
        resp = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                apikey: CONFIG.supabaseAnonKey,
                Authorization: `Bearer ${CONFIG.supabaseAnonKey}`,
            },
            body: JSON.stringify(body),
        });
    } catch (e: unknown) {
        const msg =
            e instanceof Error ? e.message : typeof e === "string" ? e : "fetch failed";
        return { ok: false, status: 0, body: msg };
    }

    if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        return { ok: false, status: resp.status, body: text };
    }

    // PostgREST returns the bare jsonb value. For get_event_v1, that's either
    // the event-metadata object (when found) or JSON null (when no row
    // matches the event_code). The bare-null case is a legitimate "not found"
    // — we surface it as { ok: true, event: null } so callers can render an
    // empty state without treating it as an error.
    const raw = await resp.json().catch(() => undefined);
    if (raw === null) {
        return { ok: true, event: null };
    }
    if (!raw || typeof raw !== "object") {
        return { ok: false, status: resp.status, body: "malformed get_event_v1 response" };
    }

    const r = raw as Record<string, unknown>;
    return {
        ok: true,
        event: {
            event_code: String(r?.event_code ?? ""),
            host: String(r?.host ?? ""),
            label: String(r?.label ?? ""),
            created_at: String(r?.created_at ?? ""),
            expires_at: String(r?.expires_at ?? ""),
            quorum_threshold: toNumber(r?.quorum_threshold),
            quorum_met_at: toNullableString(r?.quorum_met_at),
            hosting_lumin_threshold: toNumber(r?.hosting_lumin_threshold),
            host_lumin_issued_at: toNullableString(r?.host_lumin_issued_at),
            attendee_count_resolved: toNumber(r?.attendee_count_resolved),
            non_host_attendee_count_resolved: toNumber(r?.non_host_attendee_count_resolved),
        },
    };
}
