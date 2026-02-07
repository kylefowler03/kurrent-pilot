import Constants from "expo-constants";

type Extra = { pilotKey?: string };

const extra = (Constants.expoConfig?.extra ?? {}) as Extra;

export const RUNTIME = {
    pilotKey: extra.pilotKey ?? "",
};