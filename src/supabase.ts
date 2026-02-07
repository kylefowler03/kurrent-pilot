// src/supabase.ts
import "react-native-url-polyfill/auto";
import { createClient } from "@supabase/supabase-js";
import { CONFIG } from "./config";

export const supabase = createClient(CONFIG.supabaseUrl, CONFIG.supabaseAnonKey, {
    auth: {
        persistSession: false,        // since you're anon-only right now
        autoRefreshToken: false,
        detectSessionInUrl: true,
    },
});
