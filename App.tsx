import React, { useCallback, useEffect, useRef, useState } from "react";
import {
    SafeAreaView,
    Text,
    View,
    Button,
    ScrollView,
    TextInput,
    Pressable,
    StyleSheet,
} from "react-native";
import { AppState } from "react-native";

import { sendPing, flushPingQueue } from "./src/emitter";
import { fetchStatusBundle, setParticipantLabel } from "./src/statusClient";

import {
    sendCommitmentMade,
    sendCommitmentKept,
    sendPresenceAttested,
    newCommitmentId,
} from "./src/semanticEmitter";
import {
    loadOpenCommitments,
    saveOpenCommitments,
    type StoredOpenCommitment,
} from "./src/openCommitmentsStore";

function clamp01(x: number) {
    return Math.max(0, Math.min(1, x));
}

function bar(x: number, width = 20) {
    const n = Math.round(clamp01(x) * width);
    return "▮".repeat(n) + " ".repeat(width - n);
}

function meter(label: string, value: number, width = 12) {
    const v = Number.isFinite(value) ? clamp01(value) : 0;
    return `${label.padEnd(9)} ${bar(v, width)} ${v.toFixed(2)}`;
}

function parse01(s: string, fallback: number) {
    const v = Number(String(s ?? "").trim());
    if (!Number.isFinite(v)) return fallback;
    return clamp01(v);
}

function fmt(n: any, digits = 3) {
    const x = Number(n);
    if (!Number.isFinite(x)) return "—";
    return x.toFixed(digits);
}

type TrendPoint = { bucket: string; dev_total: number; tau: number };

// Reusable Components
const Card = ({ children, style }: { children: React.ReactNode; style?: any }) => (
    <View style={[styles.card, style]}>{children}</View>
);

const SectionHeader = ({ children }: { children: React.ReactNode }) => (
    <Text style={styles.sectionHeader}>{children}</Text>
);

const MetricRow = ({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) => (
    <Text style={[styles.metricRow, mono && styles.mono]}>
        <Text style={styles.metricLabel}>{label}: </Text>
        <Text style={styles.metricValue}>{value}</Text>
    </Text>
);

const CollapsibleSection = ({
    title,
    subtitle,
    isOpen,
    onToggle,
    children
}: {
    title: string;
    subtitle?: string;
    isOpen: boolean;
    onToggle: () => void;
    children: React.ReactNode;
}) => (
    <Card>
        <Pressable onPress={onToggle} style={styles.collapsibleHeader}>
            <View>
                <Text style={styles.collapsibleTitle}>
                    {isOpen ? '▼' : '▶'} {title}
                </Text>
                {subtitle && <Text style={styles.collapsibleSubtitle}>{subtitle}</Text>}
            </View>
        </Pressable>
        {isOpen && <View style={styles.collapsibleContent}>{children}</View>}
    </Card>
);

export default function App() {
    // core
    const [emitting, setEmitting] = useState(false);
    const [lastPing, setLastPing] = useState<any>(null);

    // Auto-emitter state
    const [autoEmitCount, setAutoEmitCount] = useState(0);
    const [autoEmitLastAt, setAutoEmitLastAt] = useState<string>("—");

    // participant label UI
    const [labelText, setLabelText] = useState("");
    const [labelSaving, setLabelSaving] = useState(false);
    const [labelMsg, setLabelMsg] = useState<string | null>(null);

    // status (must be declared BEFORE any derived variables)
    const [statusJson, setStatusJson] = useState<any>(null);
    const [statusErr, setStatusErr] = useState<string | null>(null);
    const [statusLoading, setStatusLoading] = useState(false);
    const [lastRefreshedAt, setLastRefreshedAt] = useState<string>("—");

    // instrumentation controls
    const [baseKText, setBaseKText] = useState("0.25");
    const [jitterAmpText, setJitterAmpText] = useState("0.00");
    const [confText, setConfText] = useState("0.90");
    const [noiseClass, setNoiseClass] = useState<"low" | "medium" | "high">("low");

    // ---- Semantic ping UI state (Migration 005) ----
    const [commitDescription, setCommitDescription] = useState("");
    const [commitDueMinText, setCommitDueMinText] = useState("60");
    const [commitScopeWeightText, setCommitScopeWeightText] = useState("");
    const [commitSending, setCommitSending] = useState(false);

    const [keptIdText, setKeptIdText] = useState("");

    const [presenceEventIdText, setPresenceEventIdText] = useState("");
    const [presenceSending, setPresenceSending] = useState(false);

    const [openCommitments, setOpenCommitments] = useState<StoredOpenCommitment[]>([]);

    type LastSemantic =
        | { ok: true; kind: string; id: string; time_bucket: number; note?: string }
        | { ok: false; kind: string; status: number; error: string };

    const [lastSemantic, setLastSemantic] = useState<LastSemantic | null>(null);

    // debug UI
    const [showDebug, setShowDebug] = useState(false);
    const [showFieldDetails, setShowFieldDetails] = useState(false);

    // Derived: node data
    const devSeries = statusJson?.node?.node_deviation_series ?? [];
    const dev =
        statusJson?.node?.node_deviation_latest ??
        statusJson?.node?.node_deviation_latest_stable ?? null;
    const ts = statusJson?.node?.trust_state ?? null;

    // Derived: field bundle (new unified status)
    const F = statusJson?.field ?? null;
    const cadence1h = F?.cadence_1h ?? null;
    const coherence1h = F?.coherence_1h ?? null;
    const vitality1h = F?.vitality_1h ?? null;
    const continuity1h = F?.continuity_1h ?? null;
    const expansionHints1h = F?.expansion_hints_1h ?? null;
    const fieldSummary1h = F?.summary_1h ?? null;
    const govGate1h = F?.governance_gate_1h ?? null;
    const lastGateEvent = F?.governance_gate_last_event ?? null;
    const weather = statusJson?.field?.weather ?? null;
    const vr = statusJson?.field?.vote_readiness_latest ?? null;

    // Trend buffer (last N buckets)
    const TREND_N = 24;
    const [trend, setTrend] = useState<TrendPoint[]>([]);

    // Prevent overlapping refreshes
    const refreshingRef = useRef(false);

    const refreshStatus = useCallback(async () => {
        if (refreshingRef.current) return;
        refreshingRef.current = true;

        setStatusLoading(true);
        setStatusErr(null);

        try {
            const r = await fetchStatusBundle();
            if (!r?.ok || !r?.json) {
                setStatusErr(`Status failed: ${r?.status ?? "?"} ${r?.body ?? ""}`.trim());
                return;
            }

            setStatusJson(r.json);
            setLastRefreshedAt(new Date().toISOString());

            // Update trend (trust + latest deviation)
            const ts0 = r.json?.node?.trust_state;
            const dev0 = r.json?.node?.node_deviation_latest;
            if (ts0 && dev0) {
                const point: TrendPoint = {
                    bucket: String(dev0.time_bucket ?? ts0.last_bucket ?? ""),
                    dev_total: Number(dev0.dev_total ?? 0),
                    tau: Number(ts0.tau ?? 0),
                };

                setTrend((prev) => {
                    const next = prev.filter((p) => p.bucket !== point.bucket).concat(point);
                    return next.slice(-TREND_N);
                });
            }
        } catch (e: any) {
            setStatusErr(`Status threw: ${e?.message ?? String(e)}`);
        } finally {
            setStatusLoading(false);
            refreshingRef.current = false;
        }
    }, []);

    // Auto-refresh status (60s, no overlap)
    useEffect(() => {
        let cancelled = false;
        let t: any;

        const loop = async () => {
            if (cancelled) return;
            await refreshStatus();
            if (cancelled) return;
            t = setTimeout(loop, 60000);
        };

        loop();
        return () => {
            cancelled = true;
            if (t) clearTimeout(t);
        };
    }, [refreshStatus]);

    const saveMyLabel = useCallback(async () => {
        const nodeKey = statusJson?.node?.node_key;
        if (!nodeKey) {
            setLabelMsg("No node_key yet (refresh status first).");
            return;
        }

        const label = String(labelText ?? "").trim();
        if (!label) {
            setLabelMsg("Enter a label first.");
            return;
        }

        setLabelSaving(true);
        setLabelMsg(null);

        const r = await setParticipantLabel(nodeKey, label, "set from app");
        if (!r.ok) {
            setLabelMsg(`Save failed: ${r.status} ${r.body ?? ""}`.trim());
        } else {
            setLabelMsg("Saved ✅");
            await refreshStatus();
        }

        setLabelSaving(false);
    }, [labelText, refreshStatus, statusJson]);

    // Auto emitter loop (3s) - FIXED scoping + no overlap
    useEffect(() => {
        if (!emitting) return;

        let alive = true;
        let busy = false;

        const tick = async () => {
            if (!alive) return;
            if (busy) return;
            busy = true;

            let r: any = null;

            try {
                const baseK = parse01(baseKText, 0.25);
                const amp = parse01(jitterAmpText, 0.0);
                const conf = parse01(confText, 0.9);

                const jitteredK =
                    amp > 0 ? Math.max(0, Math.min(1, baseK + (Math.random() * 2 - 1) * amp)) : baseK;

                r = await sendPing({
                    mode: "pilot",
                    intent: 0.5,
                    stability_score: jitteredK,
                    confidence: conf,
                    noise_class: noiseClass,
                });

                if (!r?.ok) {
                    console.log("[auto_emit] sendPing failed", r);
                } else {
                    setAutoEmitCount((c) => c + 1);
                    setAutoEmitLastAt(new Date().toISOString());
                }
            } catch (e: any) {
                console.log("[auto_emit] exception", e?.message ?? String(e));
                console.log("[auto_emit] tick", { emitting, busy, alive, at: new Date().toISOString() });
                console.log("[auto_emit] result", r);
            } finally {
                busy = false;
            }
        };

        tick();
        const interval = setInterval(tick, 3000);

        return () => {
            alive = false;
            clearInterval(interval);
        };
    }, [emitting, baseKText, jitterAmpText, confText, noiseClass]);

    // Flush queue loop + app foreground flush
    useEffect(() => {
        const interval = setInterval(() => {
            flushPingQueue({ batchSize: 10 });
        }, 5000);

        const sub = AppState.addEventListener("change", (state) => {
            if (state === "active") {
                flushPingQueue({ batchSize: 25 });
                refreshStatus();
            }
        });

        return () => {
            clearInterval(interval);
            sub.remove();
        };
    }, [refreshStatus]);


    // ---- Semantic ping handlers (Migration 005) ----

    // Load persisted open commitments on mount
    useEffect(() => {
        let cancelled = false;
        (async () => {
            const stored = await loadOpenCommitments();
            if (!cancelled) setOpenCommitments(stored);
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    const onPressCommit = useCallback(async () => {
        const desc = commitDescription.trim();
        if (!desc) {
            setLastSemantic({ ok: false, kind: "commitment.made", status: 0, error: "Description is required" });
            return;
        }
        if (desc.length > 500) {
            setLastSemantic({ ok: false, kind: "commitment.made", status: 0, error: "Description must be ≤500 chars" });
            return;
        }

        const dueMin = Number(commitDueMinText);
        if (!Number.isFinite(dueMin) || dueMin <= 0) {
            setLastSemantic({ ok: false, kind: "commitment.made", status: 0, error: "Due-in must be > 0 minutes" });
            return;
        }

        let scope_weight: number | undefined = undefined;
        const sw = commitScopeWeightText.trim();
        if (sw.length > 0) {
            const n = Number(sw);
            if (!Number.isFinite(n) || n < 0 || n > 1) {
                setLastSemantic({ ok: false, kind: "commitment.made", status: 0, error: "scope_weight must be 0..1 if set" });
                return;
            }
            scope_weight = n;
        }

        setCommitSending(true);
        try {
            const commitment_id = newCommitmentId();
            const due_in_ms = Math.round(dueMin * 60_000);
            const due_bucket = Math.floor((Date.now() + due_in_ms) / 300_000);

            const r = await sendCommitmentMade({
                commitment_id,
                description: desc,
                due_in_ms,
                scope_weight,
            });

            if (r.ok) {
                const newEntry: StoredOpenCommitment = {
                    commitment_id,
                    description: desc,
                    due_bucket,
                    made_at: new Date().toISOString(),
                };
                setOpenCommitments((prev) => {
                    const next = [newEntry, ...prev];
                    saveOpenCommitments(next);
                    return next;
                });
                setLastSemantic({ ok: true, kind: "commitment.made", id: r.id, time_bucket: r.time_bucket, note: r.note });
                setCommitDescription("");
                setCommitScopeWeightText("");
            } else {
                setLastSemantic({ ok: false, kind: "commitment.made", status: r.status, error: r.error });
            }
        } finally {
            setCommitSending(false);
        }
    }, [commitDescription, commitDueMinText, commitScopeWeightText]);

    const onPressKept = useCallback(async (commitmentIdRaw: string) => {
        const id = (commitmentIdRaw ?? "").trim();
        if (!id) return;

        const r = await sendCommitmentKept({ commitment_id: id });
        if (r.ok) {
            setOpenCommitments((prev) => {
                const next = prev.filter((c) => c.commitment_id !== id);
                saveOpenCommitments(next);
                return next;
            });
            setKeptIdText((prev) => (prev.trim() === id ? "" : prev));
            setLastSemantic({ ok: true, kind: "commitment.kept", id: r.id, time_bucket: r.time_bucket, note: r.note });
        } else {
            setLastSemantic({ ok: false, kind: "commitment.kept", status: r.status, error: r.error });
        }
    }, []);

    const onPressPresence = useCallback(async () => {
        const event_id = presenceEventIdText.trim();
        if (!event_id) return;

        setPresenceSending(true);
        try {
            const r = await sendPresenceAttested({ event_id });
            if (r.ok) {
                setLastSemantic({ ok: true, kind: "presence.attested", id: r.id, time_bucket: r.time_bucket, note: r.note });
                setPresenceEventIdText("");
            } else {
                setLastSemantic({ ok: false, kind: "presence.attested", status: r.status, error: r.error });
            }
        } finally {
            setPresenceSending(false);
        }
    }, [presenceEventIdText]);


    // Manual emit helpers
    const emitFixedOnce = useCallback(async () => {
        const baseK = parse01(baseKText, 0.25);
        const conf = parse01(confText, 0.9);

        const r = await sendPing({
            mode: "pilot",
            intent: 0.5,
            stability_score: baseK,
            confidence: conf,
            noise_class: noiseClass,
        });

        setLastPing(r);
        refreshStatus();
    }, [baseKText, confText, noiseClass, refreshStatus]);

    const emitJitterOnce = useCallback(async () => {
        const baseK = parse01(baseKText, 0.25);
        const amp = parse01(jitterAmpText, 0.05);
        const conf = parse01(confText, 0.9);

        const j = (Math.random() * 2 - 1) * amp;
        const k = clamp01(baseK + j);

        const r = await sendPing({
            mode: "pilot",
            intent: 0.5,
            stability_score: k,
            confidence: conf,
            noise_class: noiseClass,
        });

        setLastPing(r);
        refreshStatus();
    }, [baseKText, jitterAmpText, confText, noiseClass, refreshStatus]);

    const emitHiLoTest = useCallback(async () => {
        setEmitting(false);

        const r1 = await sendPing({
            stability_score: 0.8,
            confidence: 0.9,
            noise_class: "low",
            mode: "pilot",
            intent: 0.5,
        });

        const r2 = await sendPing({
            stability_score: 0.2,
            confidence: 0.4,
            noise_class: "high",
            mode: "pilot",
            intent: 0.5,
        });

        setLastPing({ hi: r1, lo: r2 });
        refreshStatus();
    }, [refreshStatus]);

    return (
        <SafeAreaView style={styles.container}>
            <ScrollView
                style={styles.scrollView}
                contentContainerStyle={styles.scrollContent}
                showsVerticalScrollIndicator={false}
            >
                {/* Header Controls */}
                <Card>
                    <SectionHeader>Controls</SectionHeader>

                    <View style={styles.buttonGroup}>
                        <Button
                            title={emitting ? "Stop Emitter" : "Start Emitter"}
                            onPress={() => setEmitting((v) => !v)}
                            color={emitting ? "#dc2626" : "#059669"}
                        />
                    </View>

                    <View style={styles.infoBox}>
                        <MetricRow
                            label="Auto emit"
                            value={`count=${autoEmitCount} · last=${autoEmitLastAt}`}
                            mono
                        />
                    </View>

                    <View style={styles.buttonGroup}>
                        <Button
                            title={statusLoading ? "Refreshing..." : "Refresh Status"}
                            onPress={refreshStatus}
                            disabled={statusLoading}
                        />
                    </View>

                    <View style={styles.infoBox}>
                        <MetricRow label="Last refreshed" value={lastRefreshedAt} mono />
                        <MetricRow
                            label="Last computed"
                            value={`${statusJson?.refresh?.refreshed_at ?? "—"} · bucket ${statusJson?.refresh?.field_bucket ?? "—"} · ${statusJson?.refresh?.refresh_ms ?? "—"}ms`}
                            mono
                        />
                    </View>

                    {statusErr && (
                        <View style={styles.errorBox}>
                            <Text style={styles.errorText}>❌ {statusErr}</Text>
                        </View>
                    )}
                </Card>

                {/* Field Status */}
                <Card>
                    <SectionHeader>Field Status</SectionHeader>

                    {/* Weather */}
                    <View style={styles.weatherBox}>
                        <MetricRow
                            label="Weather"
                            value={weather ? `${weather.field_weather ?? "—"} (${weather.weather_stability ?? "—"})` : "—"}
                            mono
                        />
                    </View>

                    {/* Tri-signal meters */}
                    <View style={styles.metersBox}>
                        <Text style={[styles.mono, styles.meterText]}>
                            {meter("Cadence", Number(cadence1h?.cadence_score_0_1 ?? 0))}
                        </Text>
                        <Text style={[styles.mono, styles.meterText]}>
                            {meter("Coherence", Number(coherence1h?.coherence_score_0_1 ?? 0))}
                        </Text>
                        <Text style={[styles.mono, styles.meterText]}>
                            {meter("Vitality", Number(vitality1h?.vitality_score_0_1 ?? 0))}
                        </Text>
                    </View>

                    {fieldSummary1h ? (
                        <>
                            <View style={styles.summaryBox}>
                                <Text style={styles.mono}>{fieldSummary1h.summary_line}</Text>
                            </View>

                            {/* Governance */}
                            {govGate1h && (
                                <View style={styles.governanceBox}>
                                    <Text style={[styles.mono, styles.governanceStatus]}>
                                        Governance: {govGate1h.gate_open ? "✅ OPEN" : "⛔ PAUSED"} ·{" "}
                                        {govGate1h.recommended_mode ?? "—"}
                                    </Text>

                                    {/* Vote readiness (new) */}


                                    {vr && (
                                        <Text style={styles.governanceDetail}>
                                            Vote readiness:{" "}
                                            {Number(vr.vote_readiness_score_0_1 ?? 0).toFixed(3)}
                                            {" · "}
                                            {vr.ready_to_vote ? "READY ✅" : "not ready"}
                                            {" · "}
                                            {vr.vote_readiness_reason ?? "—"}
                                        </Text>
                                    )}

                                    {/* Last gate event */}
                                    {lastGateEvent?.logged_at && (
                                        <Text style={styles.governanceDetail}>
                                            last gate event:{" "}
                                            {Math.round(
                                                (Date.now() - new Date(lastGateEvent.logged_at).getTime()) / 60000
                                            )}{" "}
                                            min ago · {lastGateEvent.gate_open ? "OPEN" : "CLOSED"} ·{" "}
                                            {lastGateEvent.recommended_mode ?? "—"}
                                        </Text>
                                    )}

                                    {/* Smoothed mode */}
                                    {statusJson?.field?.governance_mode_smoothed?.smoothed_mode && (
                                        <Text style={styles.governanceDetail}>
                                            Smoothed: {statusJson.field.governance_mode_smoothed.smoothed_mode} ·
                                            {" "}last3={statusJson.field.governance_mode_smoothed.vote_like_last_3}
                                        </Text>
                                    )}
                                </View>
                            )}

                            {/* Next Action */}
                            <View style={styles.nextBox}>
                                <Text style={styles.nextLabel}>NEXT:</Text>
                                <Text style={styles.nextText}>
                                    {fieldSummary1h?.next_hint ?? expansionHints1h?.action_hint ?? "(waiting…)"}
                                    {expansionHints1h?.eta_buckets_to_exit_dominated != null
                                        ? ` (ETA ~${expansionHints1h.eta_buckets_to_exit_dominated} bucket)`
                                        : ""}
                                </Text>
                            </View>

                            {/* Stats */}
                            <View style={styles.statsBox}>
                                <Text style={styles.mono}>
                                    Active now: {fieldSummary1h?.coherence_active_now ?? continuity1h?.active_nodes_now ?? "—"}
                                </Text>
                                <Text style={styles.mono}>
                                    Seen 1h: {continuity1h?.unique_nodes_1h ?? "—"}
                                </Text>
                                <Text style={styles.mono}>
                                    Active 1h: {cadence1h?.active_nodes ?? "—"}
                                </Text>
                                <Text style={styles.mono}>
                                    Coverage 1h: {fmt(cadence1h?.coverage_pct ?? 0, 1)}%
                                </Text>
                            </View>
                        </>
                    ) : (
                        <Text style={styles.waitingText}>(waiting for field summary…)</Text>
                    )}

                    {/* Field Details Collapsible */}
                    <Pressable
                        onPress={() => setShowFieldDetails((v) => !v)}
                        style={styles.detailsToggle}
                    >
                        <Text style={styles.detailsToggleText}>
                            {showFieldDetails ? "▼" : "▶"} Field details
                        </Text>
                    </Pressable>

                    {showFieldDetails && (
                        <View style={styles.detailsContent}>
                            {/* Cadence & Silence */}
                            <View style={styles.detailSection}>
                                <Text style={styles.detailHeader}>Cadence & Silence (1h)</Text>
                                {cadence1h ? (
                                    <>
                                        <MetricRow label="Coverage" value={`${fmt(cadence1h.coverage_pct, 1)}%`} />
                                        <MetricRow label="Cadence score" value={`${fmt(cadence1h.cadence_score_0_1, 3)} (${cadence1h.cadence_regime ?? "—"})`} />
                                        <MetricRow label="Active 1h" value={String(cadence1h.active_nodes ?? "—")} />
                                        <MetricRow label="Cadence CV" value={`${fmt(cadence1h.cadence_cv, 3)} (lower = steadier)`} />
                                        <MetricRow label="Trailing silence" value={`${cadence1h.trailing_silence_buckets ?? "—"} buckets (${fmt(cadence1h.trailing_silence_pct, 1)}%)`} />

                                        <Text style={styles.subHeader}>Top contributors</Text>
                                        {(cadence1h.top_contributors ?? []).slice(0, 5).map((n: any) => (
                                            <Text key={String(n.node_key)} style={styles.contributorText}>
                                                {n.label ?? n.node_key} · pings={n.pings_total} · buckets={n.buckets_present}/12 · cov={fmt(n.coverage_pct, 1)}%
                                            </Text>
                                        ))}
                                    </>
                                ) : (
                                    <Text style={styles.waitingText}>(waiting for cadence…)</Text>
                                )}
                            </View>

                            {/* Continuity */}
                            <View style={styles.detailSection}>
                                <Text style={styles.detailHeader}>Continuity (1h)</Text>
                                {continuity1h ? (
                                    <>
                                        <MetricRow label="Seen 1h" value={String(continuity1h.unique_nodes_1h ?? "—")} />
                                        <MetricRow label="Active now" value={String(continuity1h.active_nodes_now ?? "—")} />
                                        <MetricRow label="Continuity" value={Number(continuity1h.continuity_score_0_1 ?? 0).toFixed(3)} />
                                    </>
                                ) : (
                                    <Text style={styles.waitingText}>(waiting for continuity…)</Text>
                                )}
                            </View>
                        </View>
                    )}
                </Card>

                {/* Node Status */}
                <Card>
                    <SectionHeader>This Node</SectionHeader>

                    <View style={styles.nodeInfo}>
                        <MetricRow label="node_key" value={statusJson?.node?.node_key ?? "—"} mono />
                    </View>

                    {ts ? (
                        <View style={styles.nodeMetrics}>
                            <MetricRow label="tau" value={Number(ts.tau ?? 0).toFixed(3)} />
                            <MetricRow label="k_bar" value={Number(ts.k_bar ?? 0).toFixed(3)} />
                            <MetricRow label="last_bucket" value={ts.last_bucket ?? "—"} />
                        </View>
                    ) : (
                        <Text style={styles.waitingText}>trust_state: —</Text>
                    )}

                    <Text style={styles.subSectionHeader}>Deviation (latest)</Text>
                    {dev ? (
                        <View style={styles.nodeMetrics}>
                            <MetricRow label="dev_total" value={Number(dev.dev_total ?? 0).toFixed(3)} />
                            <MetricRow label="bucket" value={dev.time_bucket ?? "—"} />
                            <MetricRow label="n" value={String(dev.n_pings ?? dev.n ?? dev.n_samples ?? "—")} />
                        </View>
                    ) : (
                        <Text style={styles.waitingText}>(waiting for first aggregation bucket…)</Text>
                    )}
                </Card>

                {/* Semantic Pings (v1) — Migration 005 */}
                <Card>
                    <SectionHeader>Semantic Pings (v1)</SectionHeader>

                    {/* I commit */}
                    <View style={styles.semanticSection}>
                        <Text style={styles.semanticHeader}>I commit</Text>
                        <Text style={styles.inputLabel}>Description (≤500 chars)</Text>
                        <TextInput
                            value={commitDescription}
                            onChangeText={setCommitDescription}
                            placeholder="What are you committing to?"
                            style={[styles.textInput, styles.textInputMulti]}
                            multiline
                            maxLength={500}
                        />
                        <Text style={styles.inputLabel}>Due in (minutes)</Text>
                        <TextInput
                            value={commitDueMinText}
                            onChangeText={setCommitDueMinText}
                            keyboardType="number-pad"
                            style={styles.textInput}
                            placeholder="60"
                        />
                        <Text style={styles.inputLabel}>Scope weight (0..1, optional)</Text>
                        <TextInput
                            value={commitScopeWeightText}
                            onChangeText={setCommitScopeWeightText}
                            keyboardType="decimal-pad"
                            style={styles.textInput}
                            placeholder="(omit for default)"
                        />
                        <View style={styles.buttonGroup}>
                            <Button
                                title={commitSending ? "Sending..." : "I commit"}
                                onPress={onPressCommit}
                                disabled={commitSending}
                            />
                        </View>
                    </View>

                    {/* I kept it */}
                    <View style={styles.semanticSection}>
                        <Text style={styles.semanticHeader}>I kept it</Text>
                        {openCommitments.length === 0 ? (
                            <Text style={styles.waitingText}>(no open commitments on this device)</Text>
                        ) : (
                            openCommitments.map((c) => (
                                <View key={c.commitment_id} style={styles.openCommitmentRow}>
                                    <Text style={styles.openCommitmentText}>{c.description}</Text>
                                    <Text style={styles.openCommitmentMeta}>
                                        id={c.commitment_id} · due_bucket={c.due_bucket} · made={c.made_at.slice(11, 19)}
                                    </Text>
                                    <Button title="I kept it" onPress={() => onPressKept(c.commitment_id)} />
                                </View>
                            ))
                        )}

                        <Text style={styles.inputLabel}>Or paste a commitment_id</Text>
                        <TextInput
                            value={keptIdText}
                            onChangeText={setKeptIdText}
                            placeholder="c_..."
                            style={styles.textInput}
                            autoCapitalize="none"
                            autoCorrect={false}
                        />
                        <View style={styles.buttonGroup}>
                            <Button
                                title="I kept it (manual)"
                                onPress={() => onPressKept(keptIdText)}
                                disabled={!keptIdText.trim()}
                            />
                        </View>
                    </View>

                    {/* I showed up */}
                    <View style={styles.semanticSection}>
                        <Text style={styles.semanticHeader}>I showed up</Text>
                        <Text style={styles.inputLabel}>Event code (organiser-shared)</Text>
                        <TextInput
                            value={presenceEventIdText}
                            onChangeText={setPresenceEventIdText}
                            placeholder="e.g. weekly-circle-2026-w18"
                            style={styles.textInput}
                            autoCapitalize="none"
                            autoCorrect={false}
                        />
                        <View style={styles.buttonGroup}>
                            <Button
                                title={presenceSending ? "Sending..." : "I showed up"}
                                onPress={onPressPresence}
                                disabled={presenceSending || !presenceEventIdText.trim()}
                            />
                        </View>
                    </View>

                    {/* Last result */}
                    {lastSemantic && (
                        <View style={lastSemantic.ok ? styles.semanticOkBox : styles.errorBox}>
                            <Text style={[styles.mono, lastSemantic.ok ? styles.semanticOkText : styles.errorText]}>
                                {lastSemantic.ok
                                    ? `✅ ${lastSemantic.kind} · id=${lastSemantic.id} · bucket=${lastSemantic.time_bucket}${lastSemantic.note ? `\n${lastSemantic.note}` : ""}`
                                    : `❌ ${lastSemantic.kind} failed (${lastSemantic.status}): ${lastSemantic.error}`}
                            </Text>
                        </View>
                    )}
                </Card>

                {/* Debug Section */}
                <CollapsibleSection
                    title="Debug"
                    subtitle="Instrumentation · Label · Trend · Series · Raw JSON"
                    isOpen={showDebug}
                    onToggle={() => setShowDebug((v) => !v)}
                >
                    <View style={styles.debugSections}>
                        {/* Label */}
                        <View style={styles.debugSection}>
                            <Text style={styles.debugSectionTitle}>Label this device</Text>
                            <MetricRow label="node_key" value={statusJson?.node?.node_key ?? "—"} mono />

                            <TextInput
                                value={labelText}
                                onChangeText={setLabelText}
                                placeholder="Device Label"
                                style={styles.textInput}
                            />

                            <View style={styles.buttonGroup}>
                                <Button
                                    title={labelSaving ? "Saving..." : "Save Label"}
                                    onPress={saveMyLabel}
                                    disabled={labelSaving}
                                />
                            </View>

                            {labelMsg && <Text style={styles.feedbackText}>{labelMsg}</Text>}
                        </View>

                        {/* Signal Controls */}
                        <View style={styles.debugSection}>
                            <Text style={styles.debugSectionTitle}>Signal Controls (Instrumentation)</Text>

                            <Text style={styles.inputLabel}>Base k (0..1)</Text>
                            <TextInput
                                value={baseKText}
                                onChangeText={setBaseKText}
                                keyboardType="decimal-pad"
                                style={styles.textInput}
                            />

                            <Text style={styles.inputLabel}>Jitter amplitude (±)</Text>
                            <TextInput
                                value={jitterAmpText}
                                onChangeText={setJitterAmpText}
                                keyboardType="decimal-pad"
                                style={styles.textInput}
                            />

                            <Text style={styles.inputLabel}>Confidence (0..1)</Text>
                            <TextInput
                                value={confText}
                                onChangeText={setConfText}
                                keyboardType="decimal-pad"
                                style={styles.textInput}
                            />

                            <Text style={styles.inputLabel}>Noise class</Text>
                            <View style={styles.buttonRow}>
                                <Button title="low" onPress={() => setNoiseClass("low")} />
                                <Button title="medium" onPress={() => setNoiseClass("medium")} />
                                <Button title="high" onPress={() => setNoiseClass("high")} />
                            </View>

                            <Text style={styles.currentSettings}>
                                Current: base={parse01(baseKText, 0.25).toFixed(3)} · amp={parse01(jitterAmpText, 0.05).toFixed(3)} · conf={parse01(confText, 0.9).toFixed(3)} · noise={noiseClass}
                            </Text>

                            <View style={styles.buttonColumn}>
                                <Button title="Emit Fixed Once" onPress={emitFixedOnce} />
                                <Button title="Emit Jitter Once" onPress={emitJitterOnce} />
                                <Button title="Hi → Low Test (2 pings)" onPress={emitHiLoTest} />
                            </View>
                        </View>

                        {/* Trend */}
                        <View style={styles.debugSection}>
                            <Text style={styles.debugSectionTitle}>Trend (last {trend.length})</Text>
                            {trend.length === 0 ? (
                                <Text style={styles.waitingText}>—</Text>
                            ) : (
                                <View style={styles.trendList}>
                                    {trend
                                        .slice()
                                        .reverse()
                                        .slice(0, 10)
                                        .map((p) => (
                                            <Text key={p.bucket} style={styles.trendItem}>
                                                {p.bucket.slice(-6)} · dev={p.dev_total.toFixed(3)} {bar(p.dev_total, 12)} · tau={p.tau.toFixed(3)}
                                            </Text>
                                        ))}
                                </View>
                            )}
                        </View>

                        {/* Deviation series */}
                        <View style={styles.debugSection}>
                            <Text style={styles.debugSectionTitle}>
                                Deviation Series (last {Math.min(12, devSeries.length)})
                            </Text>
                            {devSeries.length > 0 ? (
                                <View style={styles.seriesList}>
                                    {devSeries.slice(-12).map((r: any) => (
                                        <Text key={String(r.time_bucket)} style={styles.seriesItem}>
                                            {String(r.time_bucket).slice(-6)} · {Number(r.dev_total ?? 0).toFixed(3)} {bar(Number(r.dev_total ?? 0), 16)} · n={r.n_pings ?? r.n ?? r.n_samples ?? "—"}
                                        </Text>
                                    ))}
                                </View>
                            ) : (
                                <Text style={styles.waitingText}>No deviation series yet…</Text>
                            )}
                        </View>

                        {/* Raw JSON */}
                        <View style={styles.debugSection}>
                            <Text style={styles.debugSectionTitle}>Last Ping</Text>
                            <ScrollView horizontal style={styles.jsonScroll}>
                                <Text selectable style={styles.jsonText}>
                                    {JSON.stringify(lastPing, null, 2)}
                                </Text>
                            </ScrollView>
                        </View>

                        <View style={styles.debugSection}>
                            <Text style={styles.debugSectionTitle}>Last Status Bundle</Text>
                            <ScrollView horizontal style={styles.jsonScroll}>
                                <Text selectable style={styles.jsonText}>
                                    {JSON.stringify(statusJson, null, 2)}
                                </Text>
                            </ScrollView>
                        </View>
                    </View>
                </CollapsibleSection>
            </ScrollView>
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: '#f9fafb',
    },
    scrollView: {
        flex: 1,
    },
    scrollContent: {
        padding: 16,
        gap: 16,
    },

    // Card
    card: {
        backgroundColor: '#ffffff',
        borderRadius: 12,
        padding: 16,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.05,
        shadowRadius: 2,
        elevation: 2,
    },

    // Typography
    sectionHeader: {
        fontSize: 18,
        fontWeight: '700',
        color: '#111827',
        marginBottom: 12,
    },
    subSectionHeader: {
        fontSize: 14,
        fontWeight: '600',
        color: '#374151',
        marginTop: 16,
        marginBottom: 8,
    },
    mono: {
        fontFamily: 'Menlo',
        fontSize: 12,
    },

    // Metrics
    metricRow: {
        fontSize: 13,
        color: '#374151',
        marginBottom: 4,
    },
    metricLabel: {
        fontWeight: '500',
        color: '#6b7280',
    },
    metricValue: {
        color: '#111827',
    },

    // Boxes
    infoBox: {
        backgroundColor: '#f3f4f6',
        borderRadius: 8,
        padding: 10,
        marginVertical: 8,
    },
    errorBox: {
        backgroundColor: '#fee2e2',
        borderRadius: 8,
        padding: 10,
        marginTop: 8,
    },
    errorText: {
        color: '#991b1b',
        fontSize: 13,
    },
    weatherBox: {
        marginBottom: 12,
    },
    metersBox: {
        backgroundColor: '#f9fafb',
        borderRadius: 8,
        padding: 12,
        marginBottom: 12,
        gap: 4,
    },
    meterText: {
        fontSize: 13,
        lineHeight: 20,
    },
    summaryBox: {
        backgroundColor: '#eff6ff',
        borderRadius: 8,
        padding: 12,
        marginBottom: 12,
    },
    governanceBox: {
        backgroundColor: '#f0fdf4',
        borderRadius: 8,
        padding: 12,
        marginBottom: 12,
    },
    governanceStatus: {
        fontSize: 13,
        fontWeight: '600',
        marginBottom: 6,
    },
    governanceDetail: {
        fontSize: 11,
        color: '#6b7280',
        fontFamily: 'Menlo',
        marginTop: 2,
    },
    nextBox: {
        backgroundColor: '#fef3c7',
        borderRadius: 8,
        padding: 12,
        marginBottom: 12,
    },
    nextLabel: {
        fontSize: 11,
        fontWeight: '700',
        color: '#92400e',
        marginBottom: 4,
    },
    nextText: {
        fontSize: 13,
        color: '#78350f',
    },
    statsBox: {
        borderTopWidth: 1,
        borderTopColor: '#e5e7eb',
        paddingTop: 12,
        gap: 4,
    },

    // Buttons
    buttonGroup: {
        marginVertical: 8,
    },
    buttonRow: {
        flexDirection: 'row',
        gap: 8,
        marginTop: 8,
    },
    buttonColumn: {
        gap: 8,
        marginTop: 12,
    },

    // Collapsible
    collapsibleHeader: {
        paddingVertical: 4,
    },
    collapsibleTitle: {
        fontSize: 16,
        fontWeight: '700',
        color: '#111827',
    },
    collapsibleSubtitle: {
        fontSize: 12,
        color: '#6b7280',
        marginTop: 4,
    },
    collapsibleContent: {
        marginTop: 16,
    },

    // Details
    detailsToggle: {
        paddingVertical: 12,
        marginTop: 8,
        borderTopWidth: 1,
        borderTopColor: '#e5e7eb',
    },
    detailsToggleText: {
        fontSize: 14,
        fontWeight: '600',
        color: '#4b5563',
    },
    detailsContent: {
        marginTop: 12,
        gap: 16,
    },
    detailSection: {
        backgroundColor: '#f9fafb',
        borderRadius: 8,
        padding: 12,
    },
    detailHeader: {
        fontSize: 14,
        fontWeight: '700',
        color: '#111827',
        marginBottom: 8,
    },
    subHeader: {
        fontSize: 13,
        fontWeight: '600',
        color: '#374151',
        marginTop: 12,
        marginBottom: 6,
    },
    contributorText: {
        fontFamily: 'Menlo',
        fontSize: 11,
        color: '#4b5563',
        marginTop: 2,
    },

    // Node
    nodeInfo: {
        marginBottom: 12,
    },
    nodeMetrics: {
        backgroundColor: '#f9fafb',
        borderRadius: 8,
        padding: 10,
        gap: 4,
    },

    // Debug
    debugSections: {
        gap: 16,
    },
    debugSection: {
        backgroundColor: '#f9fafb',
        borderRadius: 8,
        padding: 12,
    },
    debugSectionTitle: {
        fontSize: 14,
        fontWeight: '700',
        color: '#111827',
        marginBottom: 12,
    },
    textInput: {
        borderWidth: 1,
        borderColor: '#d1d5db',
        borderRadius: 8,
        padding: 10,
        marginTop: 8,
        fontSize: 14,
        backgroundColor: '#ffffff',
    },
    inputLabel: {
        fontSize: 13,
        fontWeight: '500',
        color: '#374151',
        marginTop: 12,
    },
    currentSettings: {
        fontSize: 11,
        color: '#6b7280',
        fontFamily: 'Menlo',
        marginTop: 8,
        padding: 8,
        backgroundColor: '#ffffff',
        borderRadius: 6,
    },
    feedbackText: {
        fontSize: 13,
        color: '#059669',
        marginTop: 8,
    },
    trendList: {
        gap: 2,
    },
    trendItem: {
        fontFamily: 'Menlo',
        fontSize: 11,
        color: '#4b5563',
    },
    seriesList: {
        gap: 2,
    },
    seriesItem: {
        fontFamily: 'Menlo',
        fontSize: 11,
        color: '#4b5563',
    },
    jsonScroll: {
        maxHeight: 200,
    },
    jsonText: {
        fontFamily: 'Menlo',
        fontSize: 10,
        color: '#374151',
        backgroundColor: '#f3f4f6',
        padding: 8,
        borderRadius: 6,
    },
    waitingText: {
        fontSize: 13,
        color: '#9ca3af',
        fontStyle: 'italic',
    },

    // ---- Migration 005 styles ----
    semanticSection: {
        backgroundColor: '#f9fafb',
        borderRadius: 8,
        padding: 12,
        marginBottom: 12,
    },
    semanticHeader: {
        fontSize: 14,
        fontWeight: '700',
        color: '#111827',
        marginBottom: 8,
    },
    textInputMulti: {
        minHeight: 60,
        textAlignVertical: 'top',
    },
    openCommitmentRow: {
        backgroundColor: '#ffffff',
        borderRadius: 8,
        padding: 10,
        marginBottom: 8,
        borderWidth: 1,
        borderColor: '#e5e7eb',
    },
    openCommitmentText: {
        fontSize: 13,
        color: '#111827',
        marginBottom: 4,
    },
    openCommitmentMeta: {
        fontFamily: 'Menlo',
        fontSize: 10,
        color: '#6b7280',
        marginBottom: 8,
    },
    semanticOkBox: {
        backgroundColor: '#ecfdf5',
        borderRadius: 8,
        padding: 10,
        marginTop: 8,
    },
    semanticOkText: {
        color: '#065f46',
        fontSize: 12,
    },
});
