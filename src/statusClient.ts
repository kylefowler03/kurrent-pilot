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
