-- Views converted to security_invoker=true:

-- field_dashboard_latest_v1

-- field_status_bundle_v1

-- field_snapshot_latest_v1

-- reference_state_latest_v1

-- Tables locked down: RLS enabled + revoked anon/authenticated on the “state/ingest” tables

-- Materialized views: revoked anon/authenticated via revoke all on table ...

-- Functions: fixed SET search_path = pg_catalog, public across the core pipeline

-- Cron: restricted anon/authenticated access

-- Auth: leaked password protection enabled
 
 
 
 SELECT fh.time_bucket,
    fr.coherence_regime,
    fw.field_weather,
    fh.n_nodes,
    fh.thin,
    fh.w_eff,
    fh.dominance,
    fh.sigma_w,
    fh.ref_k_raw,
    fa.flags AS anomaly_flags,
    fa.top_nodes AS anomaly_top_nodes
   FROM field_health_v2 fh
     LEFT JOIN field_regime_v1 fr USING (time_bucket)
     LEFT JOIN field_weather_v1 fw USING (time_bucket)
     LEFT JOIN field_anomalies_v1 fa USING (time_bucket);

SELECT fh.time_bucket,
    fr.coherence_regime,
    fw.field_weather,
    fh.n_nodes,
    fh.thin,
    fh.w_eff,
    fh.dominance,
    fh.sigma_w,
    fh.ref_k_raw,
    fa.flags AS anomaly_flags,
    fa.top_nodes AS anomaly_top_nodes
   FROM field_health_v2 fh
     LEFT JOIN field_regime_v1 fr USING (time_bucket)
     LEFT JOIN field_weather_v1 fw USING (time_bucket)
     LEFT JOIN field_anomalies_v1 fa USING (time_bucket);

SELECT time_bucket,
    n_nodes,
    thin,
    w_eff,
    dominance,
    sigma_w,
    ref_k_raw,
    ref_k_weighted,
    ref_dispersion_weighted,
    ref_n_samples,
    ref_kind,
    coherence_regime,
    field_weather,
    weather_stability,
    field_quality_0_1
   FROM field_snapshot_v1
  ORDER BY time_bucket DESC
 LIMIT 1;

SELECT time_bucket,
    ref_stability,
    ref_confidence,
    ref_noise_class,
    dispersion,
    n_samples,
    computed_at
   FROM reference_state
  ORDER BY computed_at DESC
 LIMIT 1;

CREATE OR REPLACE FUNCTION public.tick_field_latest_v1()
 RETURNS void
 LANGUAGE plpgsql
AS $function$
declare
  bucket_ms bigint := 300000;
  b_now bigint := floor(extract(epoch from now()) * 1000 / bucket_ms);
  b bigint := b_now - 1;
begin
  perform public.tick_field_for_bucket_v1(b);

  -- snapshot overlays after tick
  perform public.refresh_field_stats_v1();

  -- NEW: log governance changes if any
  perform public.log_governance_gate_if_changed_v1();
end;
$function$
