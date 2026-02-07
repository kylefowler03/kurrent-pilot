// src/identity.ts
import { kvGet, kvSet } from "./storage";
import { Platform } from "react-native";

const NODE_KEY = "kurrent_install_id_v1";
const LABEL_KEY = "kurrent_participant_label_v1";

function uuidv4(): string {
    // Minimal UUID generator (good enough for pilot)
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === "x" ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    });
}

/**
 * Provisional node identity (device install scoped).
 * Should be stable across restarts unless storage is unavailable or cleared.
 */
export async function getNodeId(): Promise<string> {
    console.log(`[identity] Platform.OS=${Platform.OS}`);

    let id: string | null = null;
    try {
        id = await kvGet(NODE_KEY);
    } catch (e) {
        console.log(`[identity] kvGet(${NODE_KEY}) threw: ${String(e)}`);
    }

    console.log(`[identity] existing node_id from storage: ${id ?? "<null>"}`);

    if (!id) {
        const newId = uuidv4();
        console.log(`[identity] generating NEW node_id: ${newId}`);

        try {
            await kvSet(NODE_KEY, newId);
        } catch (e) {
            console.log(`[identity] kvSet(${NODE_KEY}) threw: ${String(e)}`);
            // return generated id even if storage write failed (but expect it may change next run)
            return newId;
        }

        // Re-read to confirm it stuck (helps detect broken storage)
        let confirm: string | null = null;
        try {
            confirm = await kvGet(NODE_KEY);
        } catch (e) {
            console.log(`[identity] kvGet confirm threw: ${String(e)}`);
        }
        console.log(`[identity] confirm node_id from storage: ${confirm ?? "<null>"}`);

        return confirm || newId;
    }

    return id;
}

/** Local-only label (for debug UX). Remote label is stored in public.participant_labels_v1 via RPC later. */
export async function getParticipantLabelLocal(): Promise<string | null> {
    try {
        const v = await kvGet(LABEL_KEY);
        return v && v.trim().length ? v.trim() : null;
    } catch (e) {
        console.log(`[identity] kvGet(${LABEL_KEY}) threw: ${String(e)}`);
        return null;
    }
}

export async function setParticipantLabelLocal(label: string): Promise<void> {
    try {
        await kvSet(LABEL_KEY, (label ?? "").trim());
    } catch (e) {
        console.log(`[identity] kvSet(${LABEL_KEY}) threw: ${String(e)}`);
    }
}
