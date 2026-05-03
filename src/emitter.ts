// src/emitter.ts
import Constants from "expo-constants";
import { CONFIG } from "./config";
import { getNodeId } from "./identity";
import { enqueuePing, peekBatch, dropIds, bumpTry, queueSize } from "./queue";

let seq = 0;

// Toggle to see detailed flush/item logs.
// Keep false for normal operation (no spam).
const DEBUG_FLUSH = false;

function platform() {
    return Constants.platform?.ios
        ? "ios"
        : Constants.platform?.android
            ? "android"
            : "web";
}

// --- Flush logging throttle (prevents terminal spam) ---
let FLUSH_DONE_COUNT = 0;
// Log only every N successful flushes (unless DEBUG_FLUSH=true)
const FLUSH_DONE_EVERY = 25;

/**
 * Supabase Edge Functions gateway requires Authorization by default.
 * We satisfy it using the Supabase ANON key (not service role).
 *
 * Required headers for Edge Functions:
 * - Authorization: Bearer <anonKey>
 * - apikey: <anonKey>
 *
 * We also keep your pilot gate header.
 */
function headers() {
    const anonKey = CONFIG.supabaseAnonKey ?? "";

    const h: Record<string, string> = {
        "Content-Type": "application/json",
        "x-pilot-key": CONFIG.pilotKey ?? "",
    };

    // Only attach Supabase auth headers if we have an anon key configured.
    // (If you later set verify_jwt=false in the function config, these are still harmless.)
    if (anonKey) {
        h["Authorization"] = `Bearer ${anonKey}`;
        h["apikey"] = anonKey;
    }

    return h;
}

function short(s: string, n = 400) {
    if (!s) return s;
    return s.length <= n ? s : s.slice(0, n) + "…";
}

export async function sendPing(extra?: Record<string, any>) {
    try {
        const node_key = await getNodeId(); // proxy identity
        const session_id = (Constants as any).sessionId ?? "expo-session";

        const payload = {
            // IMPORTANT: backend expects node_key, not node_id
            node_key,
            session_id,
            t_client: Date.now(),
            seq: ++seq,

            // Helpful for debugging in DB (this one IS persisted)
            client_version: extra?.client_version ?? `expo_${platform()}`,

            // These are not persisted in your current pings schema, but may be useful in Edge logs
            app: {
                version: Constants.expoConfig?.version ?? "0.0.0",
                platform: platform(),
            },

            vector: {
                mode: extra?.mode ?? "pilot",
                intent: extra?.intent ?? 0.5,
            },

            stability_score: extra?.stability_score ?? 0.5,
            confidence: extra?.confidence ?? 0.5,
            noise_class: extra?.noise_class ?? "medium",

            // Not persisted in pings table; safe to include for later / edge logging
            meta: {
                schema: 1,
                client_platform: platform(),
                expo_owner: (Constants as any)?.expoConfig?.owner ?? null,
                expo_slug: (Constants as any)?.expoConfig?.slug ?? null,
                expo_release_channel: (Constants as any)?.expoConfig?.releaseChannel ?? null,
                app_version: Constants.expoConfig?.version ?? null,
                app_id:
                    (Constants as any)?.expoConfig?.ios?.bundleIdentifier ??
                    (Constants as any)?.expoConfig?.android?.package ??
                    null,
            },

            ...extra,
        };

        // 1) Always persist first (never lose signal)
        const queued = await enqueuePing(payload);

        // 2) Attempt immediate flush
        const flush = await flushPingQueue({ batchSize: 10 });

        return {
            ok: true,
            status: 200,
            statusText: "QUEUED",
            body: JSON.stringify({ queued_id: queued.id, flush }, null, 2),
            payloadSent: payload,
        };
    } catch (e: any) {
        return {
            ok: false,
            status: -1,
            statusText: "EMITTER_ERROR",
            body: String(e?.message ?? e),
        };
    }
}

export async function fetchStatus() {
    try {
        const res = await fetch(CONFIG.statusUrl, {
            method: "GET",
            headers: headers(),
        });
        const body = await res.text();
        return { ok: res.ok, status: res.status, statusText: res.statusText, body };
    } catch (e: any) {
        return { ok: false, status: -1, statusText: "STATUS_ERROR", body: String(e?.message ?? e) };
    }
}

async function postPing(payload: Record<string, any>, flushId: string, itemId: string) {
    try {
        const res = await fetch(CONFIG.ingestPingUrl, {
            method: "POST",
            headers: headers(),
            body: JSON.stringify(payload),
        });

        const body = await res.text();

        if (DEBUG_FLUSH) {
            console.log(
                `[flush] item id=${flushId} itemId=${itemId} http=${res.status} ok=${res.ok} body=${short(body)}`
            );
        }

        return { ok: res.ok, status: res.status, statusText: res.statusText, body };
    } catch (e: any) {
        const msg = String(e?.message ?? e);
        if (DEBUG_FLUSH) console.log(`[flush] item id=${flushId} itemId=${itemId} INGEST_ERROR ${msg}`);
        return { ok: false, status: -1, statusText: "INGEST_ERROR", body: msg };
    }
}

export async function flushPingQueue(opts?: { batchSize?: number }) {
    const batchSize = opts?.batchSize ?? 10;

    const before = await queueSize();
    const batch = await peekBatch(batchSize);

    const flushId = `${Date.now()}_${Math.random().toString(16).slice(2)}`;

    // No noisy logs unless debugging
    if (DEBUG_FLUSH) {
        console.log(
            `[flush] start id=${flushId} batchSize=${batchSize} queuedBefore=${before} batch=${batch.length}`
        );
    }

    // If nothing queued, do nothing (no log spam)
    if (batch.length === 0) {
        if (DEBUG_FLUSH) console.log(`[flush] noop id=${flushId} queuedBefore=${before}`);
        return { ok: true, sent: 0, remaining: before };
    }

    let sent = 0;
    const toDrop: string[] = [];

    for (const item of batch) {
        try {
            const r = await postPing(item.payload, flushId, item.id);

            if (r.ok) {
                toDrop.push(item.id);
                sent += 1;
            } else {
                await bumpTry(item.id);

                const remainingNow = await queueSize();
                // Keep this visible even when DEBUG_FLUSH=false (it's a real signal)
                console.log(
                    `[flush] stop id=${flushId} sent=${sent} remainingNow=${remainingNow} lastErrorHttp=${r.status} body=${short(
                        r.body
                    )}`
                );

                // Stop flushing on first failure to avoid hammering backend/offline state
                return {
                    ok: false,
                    sent,
                    remaining: remainingNow,
                    lastError: r,
                };
            }
        } catch (e: any) {
            await bumpTry(item.id);
            const remainingNow = await queueSize();
            const msg = String(e?.message ?? e);

            // Keep this visible even when DEBUG_FLUSH=false
            console.log(`[flush] exception id=${flushId} sent=${sent} remainingNow=${remainingNow} err=${msg}`);

            return {
                ok: false,
                sent,
                remaining: remainingNow,
                lastError: { ok: false, status: -1, statusText: "FLUSH_EXCEPTION", body: msg },
            };
        }
    }

    await dropIds(toDrop);

    const after = await queueSize();

    if (DEBUG_FLUSH) {
        console.log(`[flush] done id=${flushId} sent=${sent} dropped=${toDrop.length} queuedAfter=${after}`);
    }

    return {
        ok: true,
        sent,
        remaining: after,
    };
}
