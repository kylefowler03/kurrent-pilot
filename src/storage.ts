// src/storage.ts
import { Platform } from "react-native";

let SecureStore: any = null;
if (Platform.OS !== "web") {
    // Lazy-load to avoid web bundling issues
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    SecureStore = require("expo-secure-store");
}

export async function kvGet(key: string): Promise<string | null> {
    if (Platform.OS === "web") {
        try {
            return window.localStorage.getItem(key);
        } catch {
            return null;
        }
    }

    try {
        return await SecureStore?.getItemAsync(key);
    } catch {
        return null;
    }
}

export async function kvSet(key: string, value: string): Promise<void> {
    if (Platform.OS === "web") {
        try {
            window.localStorage.setItem(key, value);
        } catch { }
        return;
    }

    try {
        await SecureStore?.setItemAsync(key, value);
    } catch { }
}

export async function kvDel(key: string): Promise<void> {
    if (Platform.OS === "web") {
        try {
            window.localStorage.removeItem(key);
        } catch { }
        return;
    }

    try {
        await SecureStore?.deleteItemAsync(key);
    } catch { }
}
