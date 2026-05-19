// ============================================================================
// src/inviteRedeemedStore.ts
// ============================================================================
// Local-only persistence of "this device has cleared the invite gate".
//
// Why this exists:
//   - The server's invite_codes_v1 table is canonical: a node_key is a
//     member iff a row exists with redeemed_by_node_key = nodeKey.
//   - But the device needs a fast, offline-safe way to know "should I
//     render the gate screen?" on every cold boot — otherwise every
//     launch pays a round-trip latency and a network-failure renders
//     the gate even for legitimate members.
//   - So: write a local flag after a successful `redeem_invite_code_v1`
//     call (or after a successful `is_member_v1` probe at boot in the
//     grandfather path). Read it at app start. Server remains source of
//     truth; cache only suppresses the gate, never opens access.
//
// Storage: same kvGet/kvSet that identity.ts + openCommitmentsStore.ts use
//   (src/storage.ts). Best-effort; never throws.
//
// Eviction: none. The flag survives until the user uninstalls the app
//   (which mints a new node_key anyway). A wiped cache on a real member's
//   device self-heals on the next boot via the is_member_v1 probe.
//
// Convention note: M019c (attestedEventsStore) uses colon-namespaced keys
//   (`kurrent:attested:<event_code>`); the older M008/M019a stores use
//   underscore + `_v1` (`kurrent_open_commitments_v1`). This file follows
//   M019c convention per the Brief v12 §6 spec. See README for the
//   deliberate non-collapse.
// ============================================================================

import { kvGet, kvSet } from "./storage";

const FLAG_KEY = "kurrent:invite_redeemed";
const META_KEY = "kurrent:invite_redemption_meta";

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

/**
 * Metadata captured at redemption (or at grandfather detection via
 * is_member_v1). Optional Profile-card affordance: surface "joined via X on
 * Y" — not consumed in v1, stored for forward use.
 */
export type InviteRedemptionMeta = {
    redeemed_code: string;
    joined_at: string;                  // ISO timestamptz (server's redeemed_at)
    invited_by_node_key: string | null; // null = system-minted (seed code)
};

function isMeta(x: any): x is InviteRedemptionMeta {
    return (
        x &&
        typeof x.redeemed_code === "string" &&
        typeof x.joined_at === "string" &&
        (x.invited_by_node_key === null || typeof x.invited_by_node_key === "string")
    );
}

// ----------------------------------------------------------------------------
// Flag — primary gate signal
// ----------------------------------------------------------------------------

/**
 * Returns true iff the local cache reports this device has cleared the
 * invite gate. Returns false on any failure (fail-closed; the gate will
 * show, and the boot-time is_member_v1 probe in App.tsx will either heal
 * the cache or confirm the user really is not a member).
 */
export async function loadInviteRedeemed(): Promise<boolean> {
    try {
        const raw = await kvGet(FLAG_KEY);
        return raw === "true";
    } catch {
        return false;
    }
}

/**
 * Mark this device as having cleared the gate. Persists both the flag
 * and (if provided) the redemption metadata. Best-effort; never throws.
 */
export async function markInviteRedeemed(
    meta?: InviteRedemptionMeta,
): Promise<void> {
    try {
        await kvSet(FLAG_KEY, "true");
        if (meta) {
            await kvSet(META_KEY, JSON.stringify(meta));
        }
    } catch {
        // best-effort
    }
}

// ----------------------------------------------------------------------------
// Meta — secondary, for future Profile-card affordance
// ----------------------------------------------------------------------------

/**
 * Returns the stored redemption metadata if present and valid. Returns
 * null on any failure or if no meta was stored. Not consumed by the
 * gate logic — purely for future "you joined via X" UI.
 */
export async function loadInviteRedemptionMeta(): Promise<InviteRedemptionMeta | null> {
    try {
        const raw = await kvGet(META_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        return isMeta(parsed) ? parsed : null;
    } catch {
        return null;
    }
}
