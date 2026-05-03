// src/statusClient.ts
import { CONFIG } from "./config";
import { getNodeId } from "./identity";

// Turn these back on only when you want PostgREST view fan-out again
const ENABLE_REST_FIELD_FETCH = false;

function disabled(name: string) {
  return { ok: false as const, status: -2 as const, body: `disabled: ${name}` };
}

/** Supabase anon auth headers (required for Edge Functions when verify_jwt=true) */
function authHeaders() {
  const anon = CONFIG.supabaseAnonKey || "";
  return {
    apikey: anon,
    Authorization: `Bearer ${anon}`,
  };
}

/** Shared PostgREST: GET one row from a view */
async function restGETOne(view: string) {
  try {
    const url = `${CONFIG.supabaseUrl}/rest/v1/${view}?select=*&limit=1`;

    const res = await fetch(url, {
      method: "GET",
      headers: {
        ...authHeaders(),
        // harmless for REST; keeps consistency w/ pilot gating elsewhere
        "x-pilot-key": CONFIG.pilotKey,
        Accept: "application/json",
      },
    });

    const text = await res.text();
    if (!res.ok) return { ok: false as const, status: res.status, body: text };

    const rows = JSON.parse(text);
    return { ok: true as const, status: res.status, json: rows?.[0] ?? null };
  } catch (e: any) {
    return { ok: false as const, status: -1, body: String(e?.message ?? e) };
  }
}

/** Shared PostgREST: GET one row from a view that returns an array (same as restGETOne, kept for clarity) */
async function restGETOneArray(view: string) {
  return restGETOne(view);
}

/**
 * STATUS BUNDLE (Edge Function)
 * IMPORTANT: include Authorization/apikey or you'll get "missing authorization header"
 */
export async function fetchStatusBundle() {
  const nodeKey = await getNodeId();
  const url = `${CONFIG.statusUrl}?node_key=${encodeURIComponent(nodeKey)}`;

  const res = await fetch(url, {
    method: "GET",
    headers: {
      ...authHeaders(), // ✅ fixes 401 missing authorization header
      "x-pilot-key": CONFIG.pilotKey,
      Accept: "application/json",
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

/**
 * RPC: set participant label (PostgREST RPC)
 */
export async function setParticipantLabel(nodeKey: string, label: string, note?: string) {
  try {
    const url = `${CONFIG.supabaseUrl}/rest/v1/rpc/set_participant_label_text_v1`;

    const res = await fetch(url, {
      method: "POST",
      headers: {
        ...authHeaders(),
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        p_node_key: nodeKey,
        p_label: label,
        p_note: note ?? null,
      }),
    });

    const text = await res.text();
    if (!res.ok) return { ok: false as const, status: res.status, body: text };

    return { ok: true as const, status: res.status };
  } catch (e: any) {
    return { ok: false as const, status: -1, body: String(e?.message ?? e) };
  }
}

/**
 * OPTIONAL (currently disabled): PostgREST field views
 * Keep these exports so older code doesn't break, but they won't run unless enabled.
 */
export async function fetchIngestHealth() {
  if (!ENABLE_REST_FIELD_FETCH) return disabled("fetchIngestHealth");
  return restGETOneArray("field_ingest_health_v1");
}

export async function fetchPilotReadiness() {
  if (!ENABLE_REST_FIELD_FETCH) return disabled("fetchPilotReadiness");
  return restGETOneArray("field_pilot_readiness_latest_v1");
}

export async function fetchContinuity1h() {
  if (!ENABLE_REST_FIELD_FETCH) return disabled("fetchContinuity1h");
  return restGETOneArray("field_continuity_1h_v1");
}

export async function fetchCadence1h() {
  if (!ENABLE_REST_FIELD_FETCH) return disabled("fetchCadence1h");
  return restGETOneArray("field_cadence_score_1h_v1");
}

export async function fetchCoherence1h() {
  if (!ENABLE_REST_FIELD_FETCH) return disabled("fetchCoherence1h");
  return restGETOneArray("field_coherence_1h_v1");
}

export async function fetchVitality1h() {
  if (!ENABLE_REST_FIELD_FETCH) return disabled("fetchVitality1h");
  return restGETOneArray("field_vitality_1h_v1");
}

export async function fetchExpansionHints1h() {
  if (!ENABLE_REST_FIELD_FETCH) return disabled("fetchExpansionHints1h");
  return restGETOneArray("field_expansion_hints_1h_v1");
}

export async function fetchFieldSummary1h() {
  if (!ENABLE_REST_FIELD_FETCH) return disabled("fetchFieldSummary1h");
  return restGETOneArray("field_summary_1h_v1");
}

export async function fetchGovernanceGate1h() {
  if (!ENABLE_REST_FIELD_FETCH) return disabled("fetchGovernanceGate1h");
  return restGETOneArray("field_governance_gate_1h_v1");
}

export async function fetchGovernanceGateLastEvent() {
  if (!ENABLE_REST_FIELD_FETCH) return disabled("fetchGovernanceGateLastEvent");
  return restGETOneArray("field_governance_gate_last_event_v1");
}
