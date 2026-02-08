// src/statusClient.ts
import { CONFIG } from "./config";
import { getNodeId } from "./identity";

export async function fetchStatusBundle() {
  const nodeKey = await getNodeId();
  const url = `${CONFIG.statusUrl}?node_key=${encodeURIComponent(nodeKey)}`;

  const res = await fetch(url, {
    method: "GET",
    headers: {
      "x-pilot-key": CONFIG.pilotKey,
    },
  });


  const text = await res.text();

  return {
    ok: res.ok,
    status: res.status,
    body: text,
    json: (() => {
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    })(),
  };
}

export async function fetchIngestHealth() {
  try {
    const url =
      `${CONFIG.supabaseUrl}/rest/v1/field_ingest_health_v1` +
      `?select=*`;

    const res = await fetch(url, {
      method: "GET",
      headers: {
        apikey: CONFIG.supabaseAnonKey,
        Authorization: `Bearer ${CONFIG.supabaseAnonKey}`,
        "x-pilot-key": CONFIG.pilotKey, // harmless for REST; keeps consistency
      },
    });

    const text = await res.text();
    if (!res.ok) {
      return { ok: false, status: res.status, body: text };
    }

    const json = JSON.parse(text);
    // view returns an array with one row
    return { ok: true, status: res.status, json: json?.[0] ?? null };
  } catch (e: any) {
    return { ok: false, status: -1, body: String(e?.message ?? e) };
  }
}
