import { CONFIG } from "./config";
import { getNodeId } from "./identity";

export async function fetchStatusBundle() {
  const nodeKey = await getNodeId();
  const url =
    `${CONFIG.supabaseUrl}/functions/v1/status?node_key=${encodeURIComponent(nodeKey)}`;

  const res = await fetch(url, {
    method: "GET",
    headers: {
      "Authorization": `Bearer ${CONFIG.supabaseAnonKey}`,
      "apikey": CONFIG.supabaseAnonKey,
      "x-pilot-key": CONFIG.pilotKey,
      "Content-Type": "application/json",
    },
  });

  const text = await res.text();

  return {
    ok: res.ok,
    status: res.status,
    body: text,
    json: (() => {
      try { return JSON.parse(text); } catch { return null; }
    })(),
  };
}
