import Constants from "expo-constants";
import { CONFIG } from "./config";
import { getNodeId } from "./identity";
import { enqueuePing, peekBatch, dropIds, bumpTry, queueSize } from "./queue";

let seq = 0;

function platform() {
    return Constants.platform?.ios
        ? "ios"
        : Constants.platform?.android
            ? "android"
            : "web";
}

function headers() {
    return {
        "Content-Type": "application/json",
        "x-pilot-key": CONFIG.pilotKey,
    } as Record<string, string>;
}

function short(s: string, n = 400) {
    if (!s) return s;
    return s.length <= n ? s : s.slice(0, n) + "…";
}

export async function sendPing(extra?: Record<string, any>) {
    try {
        const node_key = await getNodeId(); // NOTE: treat getNodeId() as node_key (proxy identity)
        const session_id = (Constants as any).sessionId ?? "expo-session";

        const payload = {
            // IMPORTANT: backend expects node_key, not node_id
            node_key,
            session_id,
            t_client: Date.now(),
            seq: ++seq,

            // Helpful for debugging in DB
            client_version: extra?.client_version ?? `expo_${platform()}`,
            app: {
                version: Constants.expoConfig?.version ?? "0.0.0",
                platform: platform(),
            },

            vector: {
                mode: extra?.mode ?? "pilot",
                intent: extra?.intent ?? 0.5,
            },

            // defaults until you compute real values
            stability_score: extra?.stability_score ?? 0.5,
            confidence: extra?.confidence ?? 0.5,
            noise_class: extra?.noise_class ?? "medium",

            meta: { schema: 1 },
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

        console.log(
            `[flush] item id=${flushId} itemId=${itemId} http=${res.status} ok=${res.ok} body=${short(body)}`
        );

        return { ok: res.ok, status: res.status, statusText: res.statusText, body };
    } catch (e: any) {
        const msg = String(e?.message ?? e);
        console.log(`[flush] item id=${flushId} itemId=${itemId} INGEST_ERROR ${msg}`);
        return { ok: false, status: -1, statusText: "INGEST_ERROR", body: msg };
    }
}

export async function flushPingQueue(opts?: { batchSize?: number }) {
    const batchSize = opts?.batchSize ?? 10;

    const before = await queueSize();
    const batch = await peekBatch(batchSize);

    const flushId = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
    console.log(`[flush] start id=${flushId} batchSize=${batchSize} queuedBefore=${before} batch=${batch.length}`);

    if (batch.length === 0) {
        console.log(`[flush] noop id=${flushId} queuedBefore=${before}`);
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
    console.log(`[flush] done id=${flushId} sent=${sent} dropped=${toDrop.length} queuedAfter=${after}`);

    return {
        ok: true,
        sent,
        remaining: after,
    };
}
