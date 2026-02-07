// src/queue.ts
import { kvGet, kvSet, kvDel } from "./storage";

const KEY = "kurrent_ping_queue_v1";

export type QueuedPing = {
    id: string;          // unique id for idempotency/debug
    created_at: number;  // client time
    payload: any;        // your ping payload
    tries: number;       // retry count
};

async function load(): Promise<QueuedPing[]> {
    const raw = await kvGet(KEY);
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

async function save(items: QueuedPing[]) {
    await kvSet(KEY, JSON.stringify(items));
}

export async function enqueuePing(payload: any): Promise<QueuedPing> {
    const item: QueuedPing = {
        id: `${Date.now()}_${Math.random().toString(16).slice(2)}`,
        created_at: Date.now(),
        payload,
        tries: 0,
    };

    const q = await load();
    q.push(item);
    await save(q);
    return item;
}

export async function peekBatch(limit = 25): Promise<QueuedPing[]> {
    const q = await load();
    return q.slice(0, limit);
}

export async function dropIds(ids: string[]) {
    if (ids.length === 0) return;
    const q = await load();
    const keep = q.filter((x) => !ids.includes(x.id));
    await save(keep);
}

export async function bumpTry(id: string) {
    const q = await load();
    const idx = q.findIndex((x) => x.id === id);
    if (idx >= 0) {
        q[idx] = { ...q[idx], tries: (q[idx].tries ?? 0) + 1 };
        await save(q);
    }
}

export async function queueSize(): Promise<number> {
    const q = await load();
    return q.length;
}

export async function clearQueue() {
    await kvDel(KEY);
}
