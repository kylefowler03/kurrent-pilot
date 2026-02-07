import React, { useCallback, useEffect, useRef, useState } from "react";
import {
    SafeAreaView,
    Text,
    View,
    Button,
    ScrollView,
    TextInput,
    Pressable,
} from "react-native";
import { AppState } from "react-native";

import { sendPing, flushPingQueue } from "./src/emitter";
import { fetchStatusBundle } from "./src/statusClient";

function clamp01(x: number) {
    return Math.max(0, Math.min(1, x));
}

function bar(x: number, width = 20) {
    const n = Math.round(clamp01(x) * width);
    return "▮".repeat(n) + " ".repeat(width - n);
}

function parse01(s: string, fallback: number) {
    const v = Number(String(s ?? "").trim());
    if (!Number.isFinite(v)) return fallback;
    return clamp01(v);
}

type TrendPoint = { bucket: string; dev_total: number; tau: number };

export default function App() {
    // core
    const [emitting, setEmitting] = useState(false);
    const [lastPing, setLastPing] = useState<any>(null);

    // status
    const [statusJson, setStatusJson] = useState<any>(null);
    const [statusErr, setStatusErr] = useState<string | null>(null);
    const [statusLoading, setStatusLoading] = useState(false);
    const [lastRefreshedAt, setLastRefreshedAt] = useState<string>("—");

    // NEW: manual signal controls (instrumentation)
    const [baseKText, setBaseKText] = useState("0.25");
    const [jitterAmpText, setJitterAmpText] = useState("0.05");
    const [confText, setConfText] = useState("0.90");
    const [noiseClass, setNoiseClass] = useState<"low" | "medium" | "high">("low");

    // debug UI
    const [showDebug, setShowDebug] = useState(false);

    // derived views from status bundle
    const devSeries = statusJson?.node?.node_deviation_series ?? [];
    const dev =
        statusJson?.node?.node_deviation_latest ??
        statusJson?.node?.node_deviation_latest_stable ??
        null;
    const ref = statusJson?.node?.reference_for_node ?? null;
    const ts = statusJson?.node?.trust_state ?? null;

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

    // Auto-refresh status (no overlap)
    useEffect(() => {
        let cancelled = false;
        let t: any;

        const loop = async () => {
            if (cancelled) return;
            await refreshStatus();
            if (cancelled) return;
            t = setTimeout(loop, 10000);
        };

        loop();
        return () => {
            cancelled = true;
            if (t) clearTimeout(t);
        };
    }, [refreshStatus]);

    // Emitter loop (uses your manual control values)
    useEffect(() => {
        if (!emitting) return;

        const interval = setInterval(() => {
            const baseK = parse01(baseKText, 0.25);
            const conf = parse01(confText, 0.9);

            // "auto emitter" = stable fixed pings around baseK (no jitter)
            sendPing({
                mode: "pilot",
                intent: 0.5,
                stability_score: baseK,
                confidence: conf,
                noise_class: noiseClass,
            });
        }, 3000);

        return () => clearInterval(interval);
    }, [emitting, baseKText, confText, noiseClass]);

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

        const j = (Math.random() * 2 - 1) * amp; // [-amp, +amp]
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
        <SafeAreaView style={{ flex: 1 }}>
            <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 12 }}>
                {/* Controls */}
                <View style={{ gap: 10 }}>
                    <Button
                        title={emitting ? "Stop Emitter" : "Start Emitter"}
                        onPress={() => setEmitting((v) => !v)}
                    />

                    {/* Manual signal controls */}
                    <View style={{ marginTop: 6, padding: 10, borderWidth: 1, borderRadius: 10 }}>
                        <Text style={{ fontWeight: "700", marginBottom: 8 }}>Signal Controls (Instrumentation)</Text>

                        <Text>Base k (0..1)</Text>
                        <TextInput
                            value={baseKText}
                            onChangeText={setBaseKText}
                            keyboardType="decimal-pad"
                            style={{ borderWidth: 1, borderRadius: 8, padding: 8, marginTop: 6 }}
                        />

                        <Text style={{ marginTop: 10 }}>Jitter amplitude (±)</Text>
                        <TextInput
                            value={jitterAmpText}
                            onChangeText={setJitterAmpText}
                            keyboardType="decimal-pad"
                            style={{ borderWidth: 1, borderRadius: 8, padding: 8, marginTop: 6 }}
                        />

                        <Text style={{ marginTop: 10 }}>Confidence (0..1)</Text>
                        <TextInput
                            value={confText}
                            onChangeText={setConfText}
                            keyboardType="decimal-pad"
                            style={{ borderWidth: 1, borderRadius: 8, padding: 8, marginTop: 6 }}
                        />

                        <Text style={{ marginTop: 10 }}>Noise class</Text>
                        <View style={{ flexDirection: "row", gap: 8, marginTop: 6 }}>
                            <Button title="low" onPress={() => setNoiseClass("low")} />
                            <Button title="medium" onPress={() => setNoiseClass("medium")} />
                            <Button title="high" onPress={() => setNoiseClass("high")} />
                        </View>
                        <Text style={{ marginTop: 6, fontSize: 12 }}>
                            Current: base={parse01(baseKText, 0.25).toFixed(3)} amp={parse01(jitterAmpText, 0.05).toFixed(3)} conf=
                            {parse01(confText, 0.9).toFixed(3)} noise={noiseClass}
                        </Text>

                        <View style={{ marginTop: 10, gap: 8 }}>
                            <Button title="Emit Fixed Once" onPress={emitFixedOnce} />
                            <Button title="Emit Jitter Once" onPress={emitJitterOnce} />
                            <Button title="Hi → Low Test (2 pings)" onPress={emitHiLoTest} />
                        </View>
                    </View>

                    <Button
                        title={statusLoading ? "Refreshing..." : "Refresh Status"}
                        onPress={refreshStatus}
                        disabled={statusLoading}
                    />

                    <Text style={{ fontSize: 12 }}>
                        Last refreshed: {lastRefreshedAt}
                    </Text>

                    {statusErr ? (
                        <Text style={{ marginTop: 6 }}>❌ {statusErr}</Text>
                    ) : null}
                </View>

                {/* Telemetry summary */}
                <View style={{ marginTop: 14, padding: 10, borderWidth: 1, borderRadius: 10 }}>
                    <Text style={{ fontWeight: "700" }}>Telemetry</Text>

                    {ts ? (
                        <>
                            <Text>node_key: {statusJson?.node?.node_key ?? "—"}</Text>
                            <Text>tau: {Number(ts.tau ?? 0).toFixed(3)}</Text>
                            <Text>k_bar: {Number(ts.k_bar ?? 0).toFixed(3)}</Text>
                            <Text>last_bucket: {ts.last_bucket ?? "—"}</Text>
                        </>
                    ) : (
                        <Text>trust_state: —</Text>
                    )}

                    <Text style={{ marginTop: 8, fontWeight: "700" }}>Field</Text>
                    {ref ? (
                        <>
                            <Text>ref_stability: {Number(ref.ref_stability ?? 0).toFixed(3)}</Text>
                            <Text>ref_confidence: {Number(ref.ref_confidence ?? 0).toFixed(3)}</Text>
                            <Text>dispersion: {Number(ref.dispersion ?? 0).toFixed(3)}</Text>
                        </>
                    ) : (
                        <Text>Field: (waiting for reference row…)</Text>
                    )}

                    <Text style={{ marginTop: 8, fontWeight: "700" }}>Deviation</Text>
                    {dev ? (
                        <>
                            <Text>dev_total: {Number(dev.dev_total ?? 0).toFixed(3)}</Text>
                            <Text>bucket: {dev.time_bucket ?? "—"}</Text>
                            <Text>n_samples: {dev.n_samples ?? "—"}</Text>
                        </>
                    ) : (
                        <Text>Deviation: (waiting for first aggregation bucket…)</Text>
                    )}
                </View>

                {/* Trend (compact, single source of truth) */}
                <View style={{ marginTop: 14, padding: 10, borderWidth: 1, borderRadius: 10 }}>
                    <Text style={{ fontWeight: "700" }}>Trend (last {trend.length})</Text>
                    {trend.length === 0 ? (
                        <Text>—</Text>
                    ) : (
                        trend
                            .slice()
                            .reverse()
                            .map((p) => (
                                <Text key={p.bucket} style={{ fontFamily: "Menlo", fontSize: 12 }}>
                                    {p.bucket.slice(-6)}  dev={p.dev_total.toFixed(3)} {bar(p.dev_total, 12)}  tau={p.tau.toFixed(3)}
                                </Text>
                            ))
                    )}
                </View>

                {/* Deviation series (last 12) */}
                <View style={{ marginTop: 14, padding: 10, borderWidth: 1, borderRadius: 10 }}>
                    <Text style={{ fontWeight: "700" }}>Deviation Series (last {Math.min(12, devSeries.length)})</Text>
                    {devSeries.length > 0 ? (
                        <View style={{ marginTop: 6 }}>
                            {devSeries.slice(-12).map((r: any) => (
                                <Text key={String(r.time_bucket)} style={{ fontFamily: "Menlo", fontSize: 12 }}>
                                    {String(r.time_bucket).slice(-6)}  {Number(r.dev_total ?? 0).toFixed(3)}  {bar(Number(r.dev_total ?? 0), 16)}  n={r.n_samples}
                                </Text>
                            ))}
                        </View>
                    ) : (
                        <Text style={{ marginTop: 6 }}>No deviation series yet…</Text>
                    )}
                </View>

                {/* Debug panel (collapsible) */}
                <View style={{ marginTop: 14 }}>
                    <Pressable
                        onPress={() => setShowDebug((v) => !v)}
                        style={{ padding: 10, borderWidth: 1, borderRadius: 10 }}
                    >
                        <Text style={{ fontWeight: "700" }}>
                            {showDebug ? "▼ Debug (tap to collapse)" : "▶ Debug (tap to expand)"}
                        </Text>
                        <Text style={{ fontSize: 12, marginTop: 4 }}>
                            Last Ping + Last Status Bundle JSON
                        </Text>
                    </Pressable>

                    {showDebug ? (
                        <View style={{ marginTop: 10 }}>
                            <Text style={{ fontWeight: "700" }}>Last Ping</Text>
                            <Text selectable style={{ fontFamily: "Menlo", fontSize: 12 }}>
                                {JSON.stringify(lastPing, null, 2)}
                            </Text>

                            <Text style={{ fontWeight: "700", marginTop: 16 }}>Last Status Bundle</Text>
                            <Text selectable style={{ fontFamily: "Menlo", fontSize: 12 }}>
                                {JSON.stringify(statusJson, null, 2)}
                            </Text>
                        </View>
                    ) : null}
                </View>
            </ScrollView>
        </SafeAreaView>
    );
}
