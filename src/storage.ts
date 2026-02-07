// src/storage.ts
import { Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";

/**
 * K/V storage used for node identity + ping queue.
 * For this pilot we want RELIABILITY over secrecy.
 *
 * - native (ios/android): AsyncStorage
 * - web: window.localStorage
 */

export async function kvGet(key: string): Promise<string | null> {
    try {
        if (Platform.OS === "web") {
            if (typeof window === "undefined") return null;
            return window.localStorage.getItem(key);
        }
        const v = await AsyncStorage.getItem(key);
        return v ?? null;
    } catch (e) {
        console.log(`[storage] kvGet failed key=${key} err=${String(e)}`);
        return null;
    }
}

export async function kvSet(key: string, value: string): Promise<void> {
    try {
        if (Platform.OS === "web") {
            if (typeof window === "undefined") return;
            window.localStorage.setItem(key, value);
            return;
        }
        await AsyncStorage.setItem(key, value);
    } catch (e) {
        console.log(`[storage] kvSet failed key=${key} err=${String(e)}`);
    }
}

export async function kvDel(key: string): Promise<void> {
    try {
        if (Platform.OS === "web") {
            if (typeof window === "undefined") return;
            window.localStorage.removeItem(key);
            return;
        }
        await AsyncStorage.removeItem(key);
    } catch (e) {
        console.log(`[storage] kvDel failed key=${key} err=${String(e)}`);
    }
}
