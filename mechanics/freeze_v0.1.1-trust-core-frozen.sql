-- mech_version: v0.1.1-trust-core-frozen
-- frozen_at_utc: 2026-02-10Txx:xx:xxZ
-- notes: trust-core baseline, 5-min tick, matview overlays, governance gate logging

[
  {
    "schema": "public",
    "function_name": "aggregate_pings_for_bucket",
    "ddl": "CREATE OR REPLACE FUNCTION public.aggregate_pings_for_bucket(target_bucket bigint)\n RETURNS void\n LANGUAGE plpgsql\nAS $function$\nbegin\n  insert into public.node_agg (node_key, time_bucket, k_median, n_pings)\n  select\n    node_key,\n    time_bucket,\n    percentile_cont(0.5) within group (order by (stability_score * confidence)) as k_median,\n    count(*)::int as n_pings\n  from public.pings\n  where time_bucket = target_bucket\n  group by node_key, time_bucket\n  on conflict (node_key, time_bucket) do nothing;\nend;\n$function$\n"
  },
  {
    "schema": "public",
    "function_name": "compute_field_participant_status_v1",
    "ddl": "CREATE OR REPLACE FUNCTION public.compute_field_participant_status_v1(p_bucket bigint, p_coupling_window integer DEFAULT 24)\n RETURNS void\n LANGUAGE plpgsql\nAS $function$\nbegin\n  -- require bucket exists\n  if not exists (select 1 from public.field_health_v2 where time_bucket = p_bucket) then\n    return;\n  end if;\n\n  -- best partner per node from windowed coupling (if exists)\n  with fh as (\n    select time_bucket, ref_k_raw as ref_k, sigma_w, dominance, thin\n    from public.field_health_v2\n    where time_bucket = p_bucket\n  ),\n  fr as (\n    select time_bucket, coherence_regime\n    from public.field_regime_v1\n    where time_bucket = p_bucket\n  ),\n  base as (\n    select\n      fc.time_bucket,\n      fc.node_key,\n      na.n_pings,\n      fc.k_median::double precision as k,\n      fc.w_share::double precision as w_share,\n      fc.w::double precision as w,\n      coalesce(ts.tau, 0.0)::double precision as tau,\n      ts.k_bar::double precision as k_bar,\n      nr.role\n    from public.field_contrib_v1 fc\n    join public.node_agg na\n      on na.time_bucket = fc.time_bucket and na.node_key = fc.node_key\n    left join public.trust_state ts\n      on ts.node_key = fc.node_key\n    left join public.node_roles_v1 nr\n      on nr.time_bucket = fc.time_bucket and nr.node_key = fc.node_key\n    where fc.time_bucket = p_bucket\n  ),\n  cwin as (\n    select *\n    from public.field_coupling_window_v1\n    where anchor_bucket = p_bucket\n      and window_buckets = p_coupling_window\n  ),\n  -- make coupling edges node-centric\n  edges as (\n    select\n      node_a as src,\n      node_b as dst,\n      coupling_score,\n      overlap_buckets,\n      corr_k,\n      mae_k,\n      w_pair_avg\n    from cwin\n    union all\n    select\n      node_b as src,\n      node_a as dst,\n      coupling_score,\n      overlap_buckets,\n      corr_k,\n      mae_k,\n      w_pair_avg\n    from cwin\n  ),\n  ranked as (\n    select\n      e.*,\n      row_number() over (partition by e.src order by e.coupling_score desc, e.overlap_buckets desc) as rn\n    from edges e\n  ),\n  best as (\n    select\n      src as node_key,\n      dst as best_partner,\n      coupling_score as best_coupling_score,\n      overlap_buckets as best_overlap_buckets,\n      corr_k as best_corr_k,\n      mae_k as best_mae_k,\n      w_pair_avg as best_w_pair_avg,\n      case\n        when corr_k is null then 'UNKNOWN'\n        when corr_k >= 0.3 then 'IN_PHASE'\n        when corr_k <= -0.3 then 'ANTI_PHASE'\n        else 'MIXED'\n      end as best_polarity\n    from ranked\n    where rn = 1\n  )\n  insert into public.field_participant_status_v1 (\n    time_bucket, node_key,\n    n_pings, k, w_share, w,\n    tau, k_bar,\n    role,\n    best_partner, best_coupling_score, best_overlap_buckets, best_corr_k, best_mae_k, best_w_pair_avg, best_polarity,\n    ref_k, sigma_w, dominance, thin, coherence_regime,\n    computed_at\n  )\n  select\n    b.time_bucket, b.node_key,\n    b.n_pings, b.k, b.w_share, b.w,\n    b.tau, b.k_bar,\n    b.role,\n    be.best_partner, be.best_coupling_score, be.best_overlap_buckets, be.best_corr_k, be.best_mae_k, be.best_w_pair_avg, be.best_polarity,\n    fh.ref_k, fh.sigma_w, fh.dominance, fh.thin, fr.coherence_regime,\n    now()\n  from base b\n  cross join fh\n  left join fr on fr.time_bucket = fh.time_bucket\n  left join best be on be.node_key = b.node_key\n  on conflict (time_bucket, node_key) do update set\n    n_pings = excluded.n_pings,\n    k = excluded.k,\n    w_share = excluded.w_share,\n    w = excluded.w,\n    tau = excluded.tau,\n    k_bar = excluded.k_bar,\n    role = excluded.role,\n    best_partner = excluded.best_partner,\n    best_coupling_score = excluded.best_coupling_score,\n    best_overlap_buckets = excluded.best_overlap_buckets,\n    best_corr_k = excluded.best_corr_k,\n    best_mae_k = excluded.best_mae_k,\n    best_w_pair_avg = excluded.best_w_pair_avg,\n    best_polarity = excluded.best_polarity,\n    ref_k = excluded.ref_k,\n    sigma_w = excluded.sigma_w,\n    dominance = excluded.dominance,\n    thin = excluded.thin,\n    coherence_regime = excluded.coherence_regime,\n    computed_at = now();\n\nend;\n$function$\n"
  },
  {
    "schema": "public",
    "function_name": "compute_node_deviation_recent",
    "ddl": "CREATE OR REPLACE FUNCTION public.compute_node_deviation_recent(p_lookback_buckets integer DEFAULT 24)\n RETURNS void\n LANGUAGE plpgsql\nAS $function$\ndeclare\n  bucket_ms bigint := 300000;\n  current_bucket bigint := floor(extract(epoch from now()) * 1000 / bucket_ms);\n  min_bucket bigint := current_bucket - p_lookback_buckets;\nbegin\n  insert into public.node_deviation (\n    time_bucket,\n    node_key,\n    node_stability,\n    node_confidence,\n    node_noise_class,\n    ref_stability,\n    ref_confidence,\n    ref_noise_class,\n    dispersion,\n    dev_stability,\n    dev_confidence,\n    dev_noise,\n    dev_total,\n    n_samples,\n    computed_at\n  )\n  with node_bucket as (\n    select\n      p.time_bucket,\n      p.node_key,\n      avg(p.stability_score::double precision) as node_stability,\n      avg(p.confidence::double precision) as node_confidence,\n      (\n        select p2.noise_class\n        from public.pings p2\n        where p2.time_bucket = p.time_bucket and p2.node_key = p.node_key\n        group by p2.noise_class\n        order by count(*) desc, p2.noise_class asc\n        limit 1\n      ) as node_noise_class,\n      count(*)::int as n_samples\n    from public.pings p\n    where p.time_bucket between min_bucket and current_bucket\n    group by p.time_bucket, p.node_key\n  )\n  select\n    nb.time_bucket,\n    nb.node_key,\n    nb.node_stability,\n    nb.node_confidence,\n    nb.node_noise_class,\n    rs.ref_stability,\n    rs.ref_confidence,\n    rs.ref_noise_class,\n    rs.dispersion,\n    abs(nb.node_stability - rs.ref_stability) as dev_stability,\n    abs(nb.node_confidence - rs.ref_confidence) as dev_confidence,\n    case when nb.node_noise_class = rs.ref_noise_class then 0 else 1 end as dev_noise,\n    (\n      abs(nb.node_stability - rs.ref_stability)\n      + abs(nb.node_confidence - rs.ref_confidence)\n      + (case when nb.node_noise_class = rs.ref_noise_class then 0 else 1 end) * 0.25\n    ) as dev_total,\n    nb.n_samples,\n    now()\n  from node_bucket nb\n  join public.reference_state rs\n    on rs.time_bucket = nb.time_bucket\n\n  on conflict (time_bucket, node_key) do update\n    set node_stability = excluded.node_stability,\n        node_confidence = excluded.node_confidence,\n        node_noise_class = excluded.node_noise_class,\n        ref_stability = excluded.ref_stability,\n        ref_confidence = excluded.ref_confidence,\n        ref_noise_class = excluded.ref_noise_class,\n        dispersion = excluded.dispersion,\n        dev_stability = excluded.dev_stability,\n        dev_confidence = excluded.dev_confidence,\n        dev_noise = excluded.dev_noise,\n        dev_total = excluded.dev_total,\n        n_samples = excluded.n_samples,\n        computed_at = now();\nend;\n$function$\n"
  },
  {
    "schema": "public",
    "function_name": "compute_node_roles_for_bucket_v1",
    "ddl": "CREATE OR REPLACE FUNCTION public.compute_node_roles_for_bucket_v1(p_bucket bigint, p_dom_share double precision DEFAULT 0.35, p_mid_share double precision DEFAULT 0.15, p_dev_sigma_mult double precision DEFAULT 0.75, p_min_pings integer DEFAULT 5)\n RETURNS void\n LANGUAGE sql\nAS $function$\nwith fh as (\n  select time_bucket, ref_k_raw as ref_k, sigma_w, thin\n  from public.field_health_v2\n  where time_bucket = p_bucket\n),\nbase as (\n  select\n    fc.time_bucket,\n    fc.node_key,\n    fc.k_median as k,\n    fc.w_share,\n    coalesce(ts.tau, 0.0) as tau,\n    na.n_pings,\n    fh.ref_k,\n    fh.sigma_w,\n    fh.thin,\n    abs(fc.k_median - fh.ref_k) as dev_k\n  from public.field_contrib_v1 fc\n  join public.node_agg na\n    on na.time_bucket = fc.time_bucket and na.node_key = fc.node_key\n  left join public.trust_state ts\n    on ts.node_key = fc.node_key\n  join fh on fh.time_bucket = fc.time_bucket\n  where fc.time_bucket = p_bucket\n),\nlabeled as (\n  select\n    *,\n    case\n      when thin then 'THIN_FIELD'\n      when n_pings < p_min_pings or w_share < 0.05 then 'ISOLATE'\n      when w_share >= p_dom_share and dev_k <= (p_dev_sigma_mult * greatest(sigma_w, 0.0001)) then 'CONDUCTOR'\n      when w_share >= p_dom_share and dev_k >  (p_dev_sigma_mult * greatest(sigma_w, 0.0001)) then 'DOMINATOR'\n      when w_share >= p_mid_share and dev_k <= (p_dev_sigma_mult * greatest(sigma_w, 0.0001)) then 'HARMONIZER'\n      when w_share >= p_mid_share and dev_k >  (p_dev_sigma_mult * greatest(sigma_w, 0.0001)) then 'DRIFTER'\n      else 'ISOLATE'\n    end as role\n  from base\n)\ninsert into public.node_roles_v1 (\n  time_bucket, node_key, role, w_share, k, ref_k, dev_k, tau, n_pings, computed_at\n)\nselect\n  time_bucket, node_key, role, w_share, k, ref_k, dev_k, tau, n_pings, now()\nfrom labeled\non conflict (time_bucket, node_key) do update set\n  role = excluded.role,\n  w_share = excluded.w_share,\n  k = excluded.k,\n  ref_k = excluded.ref_k,\n  dev_k = excluded.dev_k,\n  tau = excluded.tau,\n  n_pings = excluded.n_pings,\n  computed_at = now();\n$function$\n"
  },
  {
    "schema": "public",
    "function_name": "compute_reference_state_weighted_for_bucket",
    "ddl": "CREATE OR REPLACE FUNCTION public.compute_reference_state_weighted_for_bucket(b bigint)\n RETURNS void\n LANGUAGE plpgsql\nAS $function$\ndeclare\n  -- A1 thin-gated inertia parameter (already validated)\n  alpha_inertia double precision := 0.70;\n\n  -- A4 sampling reliability target (pings per full bucket)\n  n_target double precision := 100.0;\n\n  -- thin flag for this bucket\n  is_thin boolean := false;\n\n  -- raw computed values for bucket b\n  raw_ref_k double precision;\n  raw_dispersion double precision;\n  raw_n_samples integer;\n\n  -- previous bucket values\n  prev_ref_k double precision;\n  prev_dispersion double precision;\n\n  -- final output values (possibly blended)\n  out_ref_k double precision;\n  out_dispersion double precision;\nbegin\n  -- Thin flag from field telemetry (view)\n  select fh.thin\n    into is_thin\n  from public.field_health_v2 fh\n  where fh.time_bucket = b;\n\n  is_thin := coalesce(is_thin, false);\n\n  -- Compute raw weighted reference + dispersion for bucket b\n  with a as (\n    select na.time_bucket, na.node_key, na.k_median, na.n_pings\n    from public.node_agg na\n    where na.time_bucket = b\n  ),\n  t as (\n    select\n      a.*,\n      coalesce(ts.tau, 0.0) as tau,\n\n      -- Base trust weight (canon)\n      greatest(0.30, least(1.00, 0.20 + 0.80 * coalesce(ts.tau, 0.0))) as w_base,\n\n      -- A4: sampling reliability factor (gentle, bounded)\n      sqrt(least(1.0, (a.n_pings::double precision) / n_target)) as r\n\n    from a\n    left join public.trust_state ts on ts.node_key = a.node_key\n  ),\n  tw as (\n    select\n      t.*,\n      (t.w_base * t.r) as w\n    from t\n  ),\n  ref as (\n    select\n      time_bucket,\n      sum(w * k_median) / nullif(sum(w), 0) as ref_k,\n      sum(n_pings)::int as n_samples\n    from tw\n    group by time_bucket\n  ),\n  disp as (\n    select\n      r.time_bucket,\n      r.ref_k,\n      r.n_samples,\n      coalesce(sum(tw.w * abs(tw.k_median - r.ref_k)) / nullif(sum(tw.w), 0), 0) as dispersion\n    from ref r\n    join tw on tw.time_bucket = r.time_bucket\n    group by r.time_bucket, r.ref_k, r.n_samples\n  )\n  select\n    d.ref_k,\n    d.dispersion,\n    d.n_samples\n  into\n    raw_ref_k,\n    raw_dispersion,\n    raw_n_samples\n  from disp d;\n\n  if raw_ref_k is null then\n    raise notice 'No node_agg rows for bucket %; skipping reference write.', b;\n    return;\n  end if;\n\n  -- Previous bucket reference (for A1 thin inertia)\n  select\n    rs.ref_stability,\n    rs.dispersion\n  into\n    prev_ref_k,\n    prev_dispersion\n  from public.reference_state rs\n  where rs.time_bucket = b - 1;\n\n  -- A1: apply inertia ONLY when thin and previous exists\n  if is_thin and prev_ref_k is not null then\n    out_ref_k := alpha_inertia * raw_ref_k + (1 - alpha_inertia) * prev_ref_k;\n    out_dispersion := alpha_inertia * raw_dispersion\n                      + (1 - alpha_inertia) * coalesce(prev_dispersion, raw_dispersion);\n  else\n    out_ref_k := raw_ref_k;\n    out_dispersion := raw_dispersion;\n  end if;\n\n  -- Write reference_state for bucket b\n  insert into public.reference_state (\n    time_bucket, ref_stability, ref_confidence, ref_noise_class, dispersion, n_samples, computed_at\n  )\n  values (\n    b,\n    out_ref_k,\n    out_ref_k,\n    'weighted',\n    out_dispersion,\n    raw_n_samples,\n    now()\n  )\n  on conflict (time_bucket) do update set\n    ref_stability = excluded.ref_stability,\n    ref_confidence = excluded.ref_confidence,\n    ref_noise_class = excluded.ref_noise_class,\n    dispersion = excluded.dispersion,\n    n_samples = excluded.n_samples,\n    computed_at = excluded.computed_at;\n\nend;\n$function$\n"
  },
  {
    "schema": "public",
    "function_name": "log_governance_gate_if_changed_v1",
    "ddl": "CREATE OR REPLACE FUNCTION public.log_governance_gate_if_changed_v1()\n RETURNS void\n LANGUAGE plpgsql\n SECURITY DEFINER\n SET search_path TO 'public'\nAS $function$\ndeclare\n  g record;\n  last record;\nbegin\n  -- current gate (one row)\n  select\n    now,\n    gate_open,\n    recommended_mode,\n    gate_reason,\n    nodes_active_now,\n    vitality_score_0_1,\n    field_dominance\n  into g\n  from public.field_governance_gate_1h_v1\n  limit 1;\n\n  if g.now is null then\n    return;\n  end if;\n\n  -- last logged event (one row)\n  select\n    gate_open,\n    recommended_mode,\n    gate_reason,\n    nodes_active_now,\n    vitality_score_0_1,\n    field_dominance\n  into last\n  from public.field_governance_gate_log_v1\n  order by id desc\n  limit 1;\n\n  -- insert only if changed (or empty table)\n  if last.gate_open is distinct from g.gate_open\n     or last.recommended_mode is distinct from g.recommended_mode\n     or last.gate_reason is distinct from g.gate_reason\n     or last.nodes_active_now is distinct from g.nodes_active_now\n     or last.vitality_score_0_1 is distinct from g.vitality_score_0_1\n     or last.field_dominance is distinct from g.field_dominance\n  then\n    insert into public.field_governance_gate_log_v1 (\n      logged_at,\n      gate_open,\n      recommended_mode,\n      gate_reason,\n      nodes_active_now,\n      vitality_score_0_1,\n      field_dominance\n    ) values (\n      g.now,\n      g.gate_open,\n      g.recommended_mode,\n      g.gate_reason,\n      g.nodes_active_now::int,  -- log table is integer\n      g.vitality_score_0_1,\n      g.field_dominance::numeric\n    );\n  end if;\n\n  return;\nend;\n$function$\n"
  },
  {
    "schema": "public",
    "function_name": "refresh_field_stats_v1",
    "ddl": "CREATE OR REPLACE FUNCTION public.refresh_field_stats_v1()\n RETURNS void\n LANGUAGE plpgsql\nAS $function$\ndeclare\n  t0 timestamptz;\n  ms integer;\n  fb bigint;\nbegin\n  if not pg_try_advisory_lock(91001) then\n    return;\n  end if;\n\n  begin\n    t0 := clock_timestamp();\n\n    refresh materialized view public.field_cadence_1h_v1_mat;\n    refresh materialized view public.field_coherence_1h_v1_mat;\n    refresh materialized view public.field_vitality_1h_v1_mat;\n    refresh materialized view public.field_governance_gate_1h_v1_mat;\n    refresh materialized view public.field_pilot_readiness_latest_v1_mat;\n    refresh materialized view public.field_ingest_health_v1_mat;\n    refresh materialized view public.field_expansion_hints_1h_v1_mat;\n    refresh materialized view public.field_summary_1h_v1_mat;\n\n    ms := (extract(epoch from (clock_timestamp() - t0)) * 1000)::int;\n\n    -- “field_bucket” is the computed bucket; coherence/pilot readiness both carry it.\n    select max(field_bucket) into fb\n    from public.field_coherence_1h_v1;\n\n    insert into public.field_refresh_telemetry_v1(field_bucket, refresh_ms, note)\n    values (fb, ms, 'refresh_field_stats_v1');\n\n  exception when others then\n    perform pg_advisory_unlock(91001);\n    raise;\n  end;\n\n  perform pg_advisory_unlock(91001);\nend;\n$function$\n"
  },
  {
    "schema": "public",
    "function_name": "tick_field_for_bucket_v1",
    "ddl": "CREATE OR REPLACE FUNCTION public.tick_field_for_bucket_v1(b bigint)\n RETURNS void\n LANGUAGE plpgsql\nAS $function$\ndeclare\n  t0 timestamptz;\n  t1 timestamptz;\nbegin\n  t0 := clock_timestamp();\n  perform public.aggregate_pings_for_bucket(b);\n  t1 := clock_timestamp();\n  raise notice 'aggregate_pings_for_bucket: % ms', extract(epoch from (t1 - t0)) * 1000;\n\n  t0 := clock_timestamp();\n  perform public.compute_reference_state_weighted_for_bucket(b);\n  t1 := clock_timestamp();\n  raise notice 'compute_reference_state_weighted_for_bucket: % ms', extract(epoch from (t1 - t0)) * 1000;\n\n  t0 := clock_timestamp();\n  perform public.compute_node_deviation_recent(24);\n  t1 := clock_timestamp();\n  raise notice 'compute_node_deviation_recent(24): % ms', extract(epoch from (t1 - t0)) * 1000;\n\n  t0 := clock_timestamp();\n  perform public.update_trust_state_recent(24);\n  t1 := clock_timestamp();\n  raise notice 'update_trust_state_recent(24): % ms', extract(epoch from (t1 - t0)) * 1000;\n\n  t0 := clock_timestamp();\n  perform public.compute_field_anomalies_v1(b, 48, 3.0, 5);\n  t1 := clock_timestamp();\n  raise notice 'compute_field_anomalies_v1: % ms', extract(epoch from (t1 - t0)) * 1000;\n\n  t0 := clock_timestamp();\n  begin\n    perform public.compute_node_roles_for_bucket_v1(b);\n  exception when undefined_function or undefined_table then\n    null;\n  end;\n  t1 := clock_timestamp();\n  raise notice 'compute_node_roles_for_bucket_v1 (or skipped): % ms', extract(epoch from (t1 - t0)) * 1000;\n\n  t0 := clock_timestamp();\n  begin\n    perform public.compute_field_coupling_for_bucket_v1(b);\n  exception when undefined_function or undefined_table then\n    null;\n  end;\n  t1 := clock_timestamp();\n  raise notice 'compute_field_coupling_for_bucket_v1 (or skipped): % ms', extract(epoch from (t1 - t0)) * 1000;\n\n  t0 := clock_timestamp();\n  begin\n    perform public.compute_field_memory_for_bucket_v1(b);\n  exception when undefined_function or undefined_table then\n    null;\n  end;\n  t1 := clock_timestamp();\n  raise notice 'compute_field_memory_for_bucket_v1 (or skipped): % ms', extract(epoch from (t1 - t0)) * 1000;\nend;\n$function$\n"
  },
  {
    "schema": "public",
    "function_name": "tick_field_latest_v1",
    "ddl": "CREATE OR REPLACE FUNCTION public.tick_field_latest_v1()\n RETURNS void\n LANGUAGE plpgsql\nAS $function$\ndeclare\n  bucket_ms bigint := 300000;\n  b_now bigint := floor(extract(epoch from now()) * 1000 / bucket_ms);\n  b bigint := b_now - 1;\nbegin\n  perform public.tick_field_for_bucket_v1(b);\n\n  -- snapshot overlays after tick\n  perform public.refresh_field_stats_v1();\n\n  -- NEW: log governance changes if any\n  perform public.log_governance_gate_if_changed_v1();\nend;\n$function$\n"
  },
  {
    "schema": "public",
    "function_name": "update_trust_state_recent",
    "ddl": "CREATE OR REPLACE FUNCTION public.update_trust_state_recent(p_lookback_buckets integer DEFAULT 24)\n RETURNS void\n LANGUAGE plpgsql\nAS $function$\ndeclare\n  bucket_ms bigint := 300000;\n  current_bucket bigint := floor(extract(epoch from now()) * 1000 / bucket_ms);\n  min_bucket bigint := current_bucket - p_lookback_buckets;\nbegin\n  with windowed as (\n    select\n      nd.node_key,\n      avg(nd.dev_total) as avg_dev,\n      avg(nd.dispersion) as avg_disp,\n      sum(nd.n_samples) as total_samples,\n      max(nd.time_bucket) as last_bucket\n    from public.node_deviation nd\n    where nd.time_bucket between min_bucket and current_bucket\n    group by nd.node_key\n  ),\n  scored as (\n    select\n      node_key,\n      last_bucket,\n      total_samples,\n\n      -- Alignment in (0,1]: smaller dev => closer to 1\n      exp(-4.0 * avg_dev) as alignment_raw,\n\n      -- Dispersion gate in (0,1]: higher dispersion => smaller updates\n      1.0 / (1.0 + 3.0 * avg_disp) as dispersion_gate\n    from windowed\n  ),\n  targets as (\n    select\n      node_key,\n      last_bucket,\n      total_samples,\n      greatest(0.0, least(1.0, alignment_raw * dispersion_gate)) as target_tau,\n      -- k_bar: interpret as \"effective coupling strength\" (0..1) for now\n      greatest(0.0, least(1.0, alignment_raw)) as target_kbar\n    from scored\n  )\n  insert into public.trust_state (node_key, tau, k_bar, last_bucket, updated_at)\n  select\n    t.node_key,\n\n    -- slow trust update: tau moves 15% toward target each run\n    (0.85 * coalesce(ts.tau, 0.5)) + (0.15 * t.target_tau) as new_tau,\n\n    -- k_bar update (even slower): moves 10% toward target alignment\n    (0.90 * coalesce(ts.k_bar, 0.5)) + (0.10 * t.target_kbar) as new_kbar,\n\n    t.last_bucket,\n    now()\n  from targets t\n  left join public.trust_state ts\n    on ts.node_key = t.node_key\n  where t.total_samples >= 10\n\n  on conflict (node_key) do update\n    set tau = excluded.tau,\n        k_bar = excluded.k_bar,\n        last_bucket = excluded.last_bucket,\n        updated_at = now();\nend;\n$function$\n"
  }
]


[
  {
    "schemaname": "public",
    "viewname": "field_cadence_1h_v1",
    "definition": " SELECT ok,\n    now,\n    bucket_ms,\n    window_buckets,\n    start_bucket,\n    end_bucket,\n    buckets_with_any_ping,\n    coverage_pct,\n    buckets_empty,\n    pings_total,\n    avg_pings_per_bucket,\n    stddev_pings_per_bucket,\n    cadence_cv,\n    longest_silence_buckets,\n    longest_silence_pct,\n    trailing_silence_buckets,\n    trailing_silence_pct,\n    active_nodes,\n    top_contributors\n   FROM field_cadence_1h_v1_mat;"
  },
  {
    "schemaname": "public",
    "viewname": "field_coherence_1h_v1",
    "definition": " SELECT ok,\n    now,\n    current_bucket,\n    field_bucket,\n    field_n_nodes,\n    nodes_active_now,\n    nodes_recent,\n    nodes_stale,\n    field_dominance,\n    ref_k_weighted,\n    ref_n_samples,\n    dispersion,\n    dominance_01,\n    dominance_ok_01,\n    disp_cap,\n    dispersion_ok_01,\n    refk_01,\n    coherence_score_0_1,\n    coherence_regime\n   FROM field_coherence_1h_v1_mat;"
  },
  {
    "schemaname": "public",
    "viewname": "field_expansion_hints_1h_v1",
    "definition": " SELECT now,\n    ok,\n    vitality_score_0_1,\n    vitality_regime,\n    cadence_score_0_1,\n    cadence_regime,\n    coherence_score_0_1,\n    coherence_regime,\n    nodes_active_now,\n    field_n_nodes,\n    field_dominance,\n    dispersion,\n    min_active_nodes_for_coherent,\n    nodes_needed,\n    coherence_gate_open,\n    eta_buckets_to_exit_dominated,\n    action_hint\n   FROM field_expansion_hints_1h_v1_mat;"
  },
  {
    "schemaname": "public",
    "viewname": "field_governance_gate_1h_v1",
    "definition": " SELECT ok,\n    now,\n    nodes_active_now,\n    vitality_score_0_1,\n    vitality_regime,\n    field_dominance,\n    min_nodes_active,\n    open_vitality_ok,\n    close_vitality_ok,\n    open_max_dominance,\n    close_max_dominance,\n    vitality_healthy,\n    gate_open_strict,\n    gate_open_lenient,\n    gate_open,\n    gate_reason,\n    recommended_mode\n   FROM field_governance_gate_1h_v1_mat;"
  },
  {
    "schemaname": "public",
    "viewname": "field_governance_gate_last_event_v1",
    "definition": " SELECT id,\n    logged_at,\n    gate_open,\n    recommended_mode,\n    gate_reason,\n    nodes_active_now,\n    vitality_score_0_1,\n    field_dominance,\n    (EXTRACT(epoch FROM (now() - logged_at)))::bigint AS age_seconds\n   FROM field_governance_gate_log_v1\n  ORDER BY id DESC\n LIMIT 1;"
  },
  {
    "schemaname": "public",
    "viewname": "field_ingest_health_v1",
    "definition": " SELECT current_bucket,\n    field_bucket,\n    field_n_nodes,\n    field_dominance,\n    ref_k_weighted,\n    ref_n_samples,\n    nodes_seen_24h,\n    nodes_active_now,\n    nodes_recent,\n    nodes_stale,\n    nodes\n   FROM field_ingest_health_v1_mat;"
  },
  {
    "schemaname": "public",
    "viewname": "field_pilot_readiness_latest_v1",
    "definition": " SELECT field_bucket,\n    nodes_active_now,\n    nodes_recent,\n    nodes_stale,\n    field_n_nodes,\n    dominance,\n    ref_k_weighted,\n    ref_n_samples,\n    field_regime,\n    readiness_state,\n    readiness_reason\n   FROM field_pilot_readiness_latest_v1_mat;"
  },
  {
    "schemaname": "public",
    "viewname": "field_summary_1h_v1",
    "definition": " SELECT ok,\n    now,\n    vitality_score_0_1,\n    vitality_regime,\n    cadence_score_0_1,\n    cadence_regime,\n    coherence_score_0_1,\n    coherence_regime,\n    coverage_pct,\n    cadence_active_nodes,\n    coherence_active_now,\n    field_dominance,\n    summary_line,\n    next_hint\n   FROM field_summary_1h_v1_mat;"
  },
  {
    "schemaname": "public",
    "viewname": "field_vitality_1h_v1",
    "definition": " SELECT ok,\n    now,\n    window_buckets,\n    coverage_pct,\n    cadence_cv,\n    trailing_silence_buckets,\n    cadence_active_nodes,\n    cadence_score_0_1,\n    cadence_regime,\n    field_n_nodes,\n    coherence_active_now,\n    field_dominance,\n    dispersion,\n    ref_k_weighted,\n    coherence_score_0_1,\n    coherence_regime,\n    vitality_score_0_1,\n    vitality_regime\n   FROM field_vitality_1h_v1_mat;"
  },
  {
    "schemaname": "public",
    "viewname": "field_weather_v1",
    "definition": " SELECT time_bucket,\n    coherence_regime,\n    n_nodes,\n    w_eff,\n    dominance,\n    sigma_w,\n    ref_k_raw,\n        CASE\n            WHEN (coherence_regime = 'QUIET'::text) THEN '🌙 Still'::text\n            WHEN ((coherence_regime = 'COHERENT'::text) AND (sigma_w < (0.01)::double precision)) THEN '☀️ Clear'::text\n            WHEN (coherence_regime = 'COHERENT'::text) THEN '🌤️ Calm'::text\n            WHEN (coherence_regime = 'FRAGMENTED'::text) THEN '🌦️ Choppy'::text\n            WHEN (coherence_regime = 'DOMINATED'::text) THEN '🌪️ Windy'::text\n            WHEN (coherence_regime = 'TRANSITIONAL'::text) THEN '🌫️ Shifting'::text\n            ELSE '❓ Unknown'::text\n        END AS field_weather,\n        CASE\n            WHEN (coherence_regime = 'QUIET'::text) THEN 'low'::text\n            WHEN ((coherence_regime = 'COHERENT'::text) AND (sigma_w < (0.01)::double precision)) THEN 'very_stable'::text\n            WHEN (coherence_regime = 'COHERENT'::text) THEN 'stable'::text\n            WHEN (coherence_regime = 'FRAGMENTED'::text) THEN 'unstable'::text\n            WHEN (coherence_regime = 'DOMINATED'::text) THEN 'unstable'::text\n            WHEN (coherence_regime = 'TRANSITIONAL'::text) THEN 'variable'::text\n            ELSE 'unknown'::text\n        END AS weather_stability\n   FROM field_regime_v1 r;"
  },
  {
    "schemaname": "public",
    "viewname": "trust_state_v1",
    "definition": " SELECT node_key,\n    tau,\n    k_bar,\n    last_bucket,\n    updated_at,\n    trust,\n    GREATEST((0.0)::double precision, LEAST((1.0)::double precision, ((0.20)::double precision + ((0.80)::double precision * COALESCE(tau, (0.0)::double precision))))) AS trust_eff\n   FROM trust_state;"
  }
]


[
  {
    "schemaname": "public",
    "matviewname": "field_cadence_1h_v1_mat",
    "definition": " SELECT ok,\n    now,\n    bucket_ms,\n    window_buckets,\n    start_bucket,\n    end_bucket,\n    buckets_with_any_ping,\n    coverage_pct,\n    buckets_empty,\n    pings_total,\n    avg_pings_per_bucket,\n    stddev_pings_per_bucket,\n    cadence_cv,\n    longest_silence_buckets,\n    longest_silence_pct,\n    trailing_silence_buckets,\n    trailing_silence_pct,\n    active_nodes,\n    top_contributors\n   FROM field_cadence_1h_v1_live;"
  },
  {
    "schemaname": "public",
    "matviewname": "field_coherence_1h_v1_mat",
    "definition": " SELECT ok,\n    now,\n    current_bucket,\n    field_bucket,\n    field_n_nodes,\n    nodes_active_now,\n    nodes_recent,\n    nodes_stale,\n    field_dominance,\n    ref_k_weighted,\n    ref_n_samples,\n    dispersion,\n    dominance_01,\n    dominance_ok_01,\n    disp_cap,\n    dispersion_ok_01,\n    refk_01,\n    coherence_score_0_1,\n    coherence_regime\n   FROM field_coherence_1h_v1_live;"
  },
  {
    "schemaname": "public",
    "matviewname": "field_expansion_hints_1h_v1_mat",
    "definition": " SELECT now,\n    ok,\n    vitality_score_0_1,\n    vitality_regime,\n    cadence_score_0_1,\n    cadence_regime,\n    coherence_score_0_1,\n    coherence_regime,\n    nodes_active_now,\n    field_n_nodes,\n    field_dominance,\n    dispersion,\n    min_active_nodes_for_coherent,\n    nodes_needed,\n    coherence_gate_open,\n    eta_buckets_to_exit_dominated,\n    action_hint\n   FROM field_expansion_hints_1h_v1_raw;"
  },
  {
    "schemaname": "public",
    "matviewname": "field_governance_gate_1h_v1_mat",
    "definition": " SELECT ok,\n    now,\n    nodes_active_now,\n    vitality_score_0_1,\n    vitality_regime,\n    field_dominance,\n    min_nodes_active,\n    open_vitality_ok,\n    close_vitality_ok,\n    open_max_dominance,\n    close_max_dominance,\n    vitality_healthy,\n    gate_open_strict,\n    gate_open_lenient,\n    gate_open,\n    gate_reason,\n    recommended_mode\n   FROM field_governance_gate_1h_v1_raw;"
  },
  {
    "schemaname": "public",
    "matviewname": "field_ingest_health_v1_mat",
    "definition": " SELECT current_bucket,\n    field_bucket,\n    field_n_nodes,\n    field_dominance,\n    ref_k_weighted,\n    ref_n_samples,\n    nodes_seen_24h,\n    nodes_active_now,\n    nodes_recent,\n    nodes_stale,\n    nodes\n   FROM field_ingest_health_v1_raw;"
  },
  {
    "schemaname": "public",
    "matviewname": "field_pilot_readiness_latest_v1_mat",
    "definition": " SELECT field_bucket,\n    nodes_active_now,\n    nodes_recent,\n    nodes_stale,\n    field_n_nodes,\n    dominance,\n    ref_k_weighted,\n    ref_n_samples,\n    field_regime,\n    readiness_state,\n    readiness_reason\n   FROM field_pilot_readiness_latest_v1_raw;"
  },
  {
    "schemaname": "public",
    "matviewname": "field_summary_1h_v1_mat",
    "definition": " SELECT ok,\n    now,\n    vitality_score_0_1,\n    vitality_regime,\n    cadence_score_0_1,\n    cadence_regime,\n    coherence_score_0_1,\n    coherence_regime,\n    coverage_pct,\n    cadence_active_nodes,\n    coherence_active_now,\n    field_dominance,\n    summary_line,\n    next_hint\n   FROM field_summary_1h_v1_raw;"
  },
  {
    "schemaname": "public",
    "matviewname": "field_trust_state_health_1h_v1_mat",
    "definition": " SELECT mech_version,\n    trust_rows_total,\n    active_nodes_1h,\n    trust_rows_active_1h,\n    trust_state_updated_at_max,\n    tau_p50_active,\n    tau_p95_active,\n    tau_max_active,\n    tau_out_of_bounds_active,\n    kbar_out_of_bounds_active\n   FROM field_trust_state_health_1h_v1_raw;"
  },
  {
    "schemaname": "public",
    "matviewname": "field_vitality_1h_v1_mat",
    "definition": " SELECT ok,\n    now,\n    window_buckets,\n    coverage_pct,\n    cadence_cv,\n    trailing_silence_buckets,\n    cadence_active_nodes,\n    cadence_score_0_1,\n    cadence_regime,\n    field_n_nodes,\n    coherence_active_now,\n    field_dominance,\n    dispersion,\n    ref_k_weighted,\n    coherence_score_0_1,\n    coherence_regime,\n    vitality_score_0_1,\n    vitality_regime\n   FROM field_vitality_1h_v1_raw;"
  }
]


[
  {
    "table_name": "field_governance_gate_log_v1",
    "column_name": "id",
    "data_type": "bigint"
  },
  {
    "table_name": "field_governance_gate_log_v1",
    "column_name": "logged_at",
    "data_type": "timestamp with time zone"
  },
  {
    "table_name": "field_governance_gate_log_v1",
    "column_name": "gate_open",
    "data_type": "boolean"
  },
  {
    "table_name": "field_governance_gate_log_v1",
    "column_name": "recommended_mode",
    "data_type": "text"
  },
  {
    "table_name": "field_governance_gate_log_v1",
    "column_name": "gate_reason",
    "data_type": "text"
  },
  {
    "table_name": "field_governance_gate_log_v1",
    "column_name": "nodes_active_now",
    "data_type": "integer"
  },
  {
    "table_name": "field_governance_gate_log_v1",
    "column_name": "vitality_score_0_1",
    "data_type": "numeric"
  },
  {
    "table_name": "field_governance_gate_log_v1",
    "column_name": "field_dominance",
    "data_type": "numeric"
  },
  {
    "table_name": "field_refresh_telemetry_v1",
    "column_name": "id",
    "data_type": "bigint"
  },
  {
    "table_name": "field_refresh_telemetry_v1",
    "column_name": "refreshed_at",
    "data_type": "timestamp with time zone"
  },
  {
    "table_name": "field_refresh_telemetry_v1",
    "column_name": "field_bucket",
    "data_type": "bigint"
  },
  {
    "table_name": "field_refresh_telemetry_v1",
    "column_name": "refresh_ms",
    "data_type": "integer"
  },
  {
    "table_name": "field_refresh_telemetry_v1",
    "column_name": "note",
    "data_type": "text"
  },
  {
    "table_name": "node_agg",
    "column_name": "id",
    "data_type": "bigint"
  },
  {
    "table_name": "node_agg",
    "column_name": "node_key",
    "data_type": "text"
  },
  {
    "table_name": "node_agg",
    "column_name": "time_bucket",
    "data_type": "bigint"
  },
  {
    "table_name": "node_agg",
    "column_name": "k_median",
    "data_type": "double precision"
  },
  {
    "table_name": "node_agg",
    "column_name": "n_pings",
    "data_type": "integer"
  },
  {
    "table_name": "node_agg",
    "column_name": "computed_at",
    "data_type": "timestamp with time zone"
  },
  {
    "table_name": "node_deviation",
    "column_name": "time_bucket",
    "data_type": "bigint"
  },
  {
    "table_name": "node_deviation",
    "column_name": "node_key",
    "data_type": "text"
  },
  {
    "table_name": "node_deviation",
    "column_name": "node_stability",
    "data_type": "double precision"
  },
  {
    "table_name": "node_deviation",
    "column_name": "node_confidence",
    "data_type": "double precision"
  },
  {
    "table_name": "node_deviation",
    "column_name": "node_noise_class",
    "data_type": "text"
  },
  {
    "table_name": "node_deviation",
    "column_name": "ref_stability",
    "data_type": "double precision"
  },
  {
    "table_name": "node_deviation",
    "column_name": "ref_confidence",
    "data_type": "double precision"
  },
  {
    "table_name": "node_deviation",
    "column_name": "ref_noise_class",
    "data_type": "text"
  },
  {
    "table_name": "node_deviation",
    "column_name": "dispersion",
    "data_type": "double precision"
  },
  {
    "table_name": "node_deviation",
    "column_name": "dev_stability",
    "data_type": "double precision"
  },
  {
    "table_name": "node_deviation",
    "column_name": "dev_confidence",
    "data_type": "double precision"
  },
  {
    "table_name": "node_deviation",
    "column_name": "dev_noise",
    "data_type": "integer"
  },
  {
    "table_name": "node_deviation",
    "column_name": "dev_total",
    "data_type": "double precision"
  },
  {
    "table_name": "node_deviation",
    "column_name": "n_samples",
    "data_type": "integer"
  },
  {
    "table_name": "node_deviation",
    "column_name": "computed_at",
    "data_type": "timestamp with time zone"
  },
  {
    "table_name": "pings",
    "column_name": "id",
    "data_type": "bigint"
  },
  {
    "table_name": "pings",
    "column_name": "node_key",
    "data_type": "text"
  },
  {
    "table_name": "pings",
    "column_name": "time_bucket",
    "data_type": "bigint"
  },
  {
    "table_name": "pings",
    "column_name": "stability_score",
    "data_type": "double precision"
  },
  {
    "table_name": "pings",
    "column_name": "confidence",
    "data_type": "double precision"
  },
  {
    "table_name": "pings",
    "column_name": "noise_class",
    "data_type": "text"
  },
  {
    "table_name": "pings",
    "column_name": "client_version",
    "data_type": "text"
  },
  {
    "table_name": "pings",
    "column_name": "received_at",
    "data_type": "timestamp with time zone"
  },
  {
    "table_name": "reference_state",
    "column_name": "time_bucket",
    "data_type": "bigint"
  },
  {
    "table_name": "reference_state",
    "column_name": "ref_stability",
    "data_type": "double precision"
  },
  {
    "table_name": "reference_state",
    "column_name": "ref_confidence",
    "data_type": "double precision"
  },
  {
    "table_name": "reference_state",
    "column_name": "ref_noise_class",
    "data_type": "text"
  },
  {
    "table_name": "reference_state",
    "column_name": "dispersion",
    "data_type": "double precision"
  },
  {
    "table_name": "reference_state",
    "column_name": "n_samples",
    "data_type": "integer"
  },
  {
    "table_name": "reference_state",
    "column_name": "computed_at",
    "data_type": "timestamp with time zone"
  },
  {
    "table_name": "trust_state",
    "column_name": "node_key",
    "data_type": "text"
  },
  {
    "table_name": "trust_state",
    "column_name": "tau",
    "data_type": "double precision"
  },
  {
    "table_name": "trust_state",
    "column_name": "k_bar",
    "data_type": "double precision"
  },
  {
    "table_name": "trust_state",
    "column_name": "last_bucket",
    "data_type": "bigint"
  },
  {
    "table_name": "trust_state",
    "column_name": "updated_at",
    "data_type": "timestamp with time zone"
  },
  {
    "table_name": "trust_state",
    "column_name": "trust",
    "data_type": "double precision"
  }
]