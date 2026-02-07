// src/identity.ts
import { kvGet, kvSet } from "./storage";

const KEY = "kurrent_install_id_v1";

function uuidv4(): string {
    // Minimal UUID generator (good enough for pilot)
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === "x" ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    });
}

export async function getNodeId(): Promise<string> {
    let id = await kvGet(KEY);
    if (!id) {
        id = uuidv4();
        await kvSet(KEY, id);
    }
    return id;
}
