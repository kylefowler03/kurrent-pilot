// ============================================================================
// src/openCommitmentsStore.ts
// ============================================================================
// Local-only persistence of "open commitments made on this device".
//
// Why this exists:
//   - The server holds the canonical commitments_v1 table. It's source of truth.
//   - But the device needs a fast way to render the "I kept it" list without
//     a round-trip — and to survive app restarts (otherwise users lose the
//     list and have to remember commitment_ids by heart).
//   - In v1 we don't have a server endpoint to fetch a node's open
//     commitments. When that lands (see Continuation Brief Outstanding
//     Questions), this file becomes a cache, not the source.
//
// Storage: same kvGet/kvSet that identity.ts uses (src/storage.ts).
// Pruning: any commitments older than 30 days are dropped on load —
//   prevents unbounded growth if a user habitually makes-without-keeping.
//   Server-side aging is independent; this only affects local UX.
// ============================================================================

import { kvGet, kvSet } from "./storage";

const KEY = "kurrent_open_commitments_v1";
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export type StoredOpenCommitment = {
    commitment_id: string;
    description: string;
    due_bucket: number;
    made_at: string; // ISO timestamp
};

function isStored(x: any): x is StoredOpenCommitment {
    return (
        x &&
        typeof x.commitment_id === "string" &&
        typeof x.description === "string" &&
        typeof x.due_bucket === "number" &&
        typeof x.made_at === "string"
    );
}

/** Load and prune old entries. Returns [] on any failure. */
export async function loadOpenCommitments(): Promise<StoredOpenCommitment[]> {
    try {
        const raw = await kvGet(KEY);
        if (!raw) return [];

        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];

        const cutoff = Date.now() - MAX_AGE_MS;
        return parsed.filter(isStored).filter((c) => {
            const t = Date.parse(c.made_at);
            return Number.isFinite(t) && t >= cutoff;
        });
    } catch {
        return [];
    }
}

/** Persist. Best-effort; never throws. */
export async function saveOpenCommitments(
    list: StoredOpenCommitment[],
): Promise<void> {
    try {
        await kvSet(KEY, JSON.stringify(list));
    } catch {
        // best-effort
    }
}
