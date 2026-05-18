// ============================================================================
// src/attestedEventsStore.ts — Migration 019c
// ============================================================================
// Per-event presence-attestation cache. Mirrors the partial unique index +
// `get_existing_presence_attestation_v1` RPC introduced in the M019c SQL
// migration, plus the 23505 → 409 translator added to the
// ingest_semantic_ping Edge Function.
//
// AsyncStorage shape:
//   key:   `kurrent:attested:<event_code>`     (event_code is lowercase
//                                                per M014 normalization)
//   value: JSON { first_attestation_at: string | null, bucket: number | null }
//
// Used by App.tsx to:
//   - Disable the "I showed up" button when an event_code has already been
//     attested by this device.
//   - Surface an inline "Attested at HH:MM" status line.
//
// Populated by App.tsx after each presence.attested call:
//   - 200 OK            → { first_attestation_at = new Date().toISOString(),
//                           bucket = server-acked time_bucket }
//   - 409 already_attested → { first_attestation_at, bucket }
//                            from the Edge Function's body
//                            (canonical values from
//                            get_existing_presence_attestation_v1).
//
// House style: dumb storage; the screen orchestrates writes. Matches
// `openCommitmentsStore.ts` posture.
// ============================================================================

import AsyncStorage from "@react-native-async-storage/async-storage";

const KEY_PREFIX = "kurrent:attested:";

export type AttestedRecord = {
    first_attestation_at: string | null;
    bucket: number | null;
};

function parseRecord(raw: unknown): AttestedRecord | null {
    if (!raw || typeof raw !== "object") return null;
    const r = raw as Record<string, unknown>;
    return {
        first_attestation_at:
            typeof r.first_attestation_at === "string" ? r.first_attestation_at : null,
        bucket: typeof r.bucket === "number" ? r.bucket : null,
    };
}

/** Write a single event's attestation record. Best-effort; errors swallowed. */
export async function markAttested(
    event_code: string,
    rec: AttestedRecord,
): Promise<void> {
    if (!event_code) return;
    try {
        await AsyncStorage.setItem(KEY_PREFIX + event_code, JSON.stringify(rec));
    } catch {
        // Best-effort cache.
    }
}

/** Read a single event's record. Returns null on miss or malformed value. */
export async function getAttested(
    event_code: string,
): Promise<AttestedRecord | null> {
    if (!event_code) return null;
    try {
        const raw = await AsyncStorage.getItem(KEY_PREFIX + event_code);
        if (!raw) return null;
        return parseRecord(JSON.parse(raw));
    } catch {
        return null;
    }
}

/** Read all attestation records on the device. Used at mount for fast-paint. */
export async function getAttestedMap(): Promise<Record<string, AttestedRecord>> {
    const result: Record<string, AttestedRecord> = {};
    try {
        const allKeys = await AsyncStorage.getAllKeys();
        const ours = allKeys.filter((k) => k.startsWith(KEY_PREFIX));
        if (ours.length === 0) return result;
        const pairs = await AsyncStorage.multiGet(ours);
        for (const [key, raw] of pairs) {
            if (!raw) continue;
            try {
                const parsed = parseRecord(JSON.parse(raw));
                if (!parsed) continue;
                const event_code = key.slice(KEY_PREFIX.length);
                if (event_code) result[event_code] = parsed;
            } catch {
                // skip malformed entry
            }
        }
    } catch {
        // best-effort
    }
    return result;
}
