// src/supabase.ts
import "react-native-url-polyfill/auto";
import { createClient } from "@supabase/supabase-js";
import { CONFIG } from "./config";

export const supabase = createClient(CONFIG.supabaseUrl, CONFIG.supabaseAnonKey, {
    auth: {
        // IMPORTANT: do not force AsyncStorage/SecureStore here.
        // Web will use localStorage automatically.
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
    },
});
