import Constants from "expo-constants";
import { CONFIG } from "./config";
import { getNodeId } from "./identity";
import { RUNTIME } from "./runtimeConfig";
import { enqueuePing, peekBatch, dropIds, bumpTry, queueSize } from "./queue"

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

export async function sendPing(extra?: Record<string, any>) {
    try {
        const node_id = await getNodeId();
        const session_id = (Constants as any).sessionId ?? "expo-session";



        const payload = {
            node_id,
            session_id,
            t_client: Date.now(),
            seq: ++seq,

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

async function postPing(payload: Record<string, any>) {
    try {
        const res = await fetch(CONFIG.ingestPingUrl, {
            method: "POST",
            headers: headers(),
            body: JSON.stringify(payload),
        });
        const body = await res.text();
        return { ok: res.ok, status: res.status, statusText: res.statusText, body };
    } catch (e: any) {
        return { ok: false, status: -1, statusText: "INGEST_ERROR", body: String(e?.message ?? e) };
    }
}

export async function flushPingQueue(opts?: { batchSize?: number }) {
    const batchSize = opts?.batchSize ?? 10;
    const batch = await peekBatch(batchSize);

    if (batch.length === 0) {
        return { ok: true, sent: 0, remaining: 0 };
    }

    let sent = 0;
    const toDrop: string[] = [];

    for (const item of batch) {
        try {
            const r = await postPing(item.payload);

            if (r.ok) {
                toDrop.push(item.id);
                sent += 1;
            } else {
                await bumpTry(item.id);
                // Stop flushing on first failure to avoid hammering the backend/offline state
                return {
                    ok: false,
                    sent,
                    remaining: await queueSize(),
                    lastError: r,
                };
            }
        } catch (e: any) {
            await bumpTry(item.id);
            return {
                ok: false,
                sent,
                remaining: await queueSize(),
                lastError: { ok: false, status: -1, body: String(e?.message ?? e) },
            };
        }
    }

    await dropIds(toDrop);

    return {
        ok: true,
        sent,
        remaining: await queueSize(),
    };
}

