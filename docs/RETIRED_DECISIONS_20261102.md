# Open decisions retired 2026-11-02

User asked to cut pending OPEN_DECISIONs from 203 to 100. 103 were resolved in `performance_audit` (signal_type='OPEN_DECISION', status RESOLVED, `resolution_text` states the reason). None were disproven; to revive one, re-flag it with `node scripts/flag_decision.mjs --add` (the original text is still in the history rows: `--list-all`).

## Auto-generated alerts (stale)
- perf_verdict_d0b265c439_20261019
- perf_verdict_c18d766973_20261020
- perf_regression_rss_mb_20261021
- job_slower_daily_recalibrate_ml_globex_split_mjs_20261029

## Moot after the 2026-11-02 ML cleanup
- ml_verdict_not_wired_to_real_order_placement_20260929
- ml_veto_gate_log_only_revisit_20261004
- ml_risk_tool_agreement_selection_20260921
- ml_walkforward_window_narrowing_decision_20260922
- tick_trend_efficiency_fade_outcome_recheck_pending_20260923
- ml_market_event_substrate_20260924
- ml_direction_signed_features_untested_20260924
- ml_standalone_detector_scoped_not_started_20260927
- ml_probability_sizing_scope_20260927
- ml_meta_labeling_train_set_frozen_for_a_week_20260929
- ml_promotion_gate_review_20261005
- audit_sites_gain_active_path_gate_coverage_gap_20260929
- trade_forward_path_table_and_policy_evaluator_20260924

## Parked / low priority, no action
- table_preentry_inflection_detection_pending_orderflow_data
- rolling_window_backtest_generalization_idea
- touch_quality_idea5_fade_friendliness_deferred
- wire_undefended_level_filter_into_compression_breakout
- compression_breakout_signal_wire_or_park
- price_bars_nqh26_contract_thin_and_early_20260928
- vwap_reclaim_short_build_structural_stop
- rth_stop_target_asymmetry_needs_new_technique
- ib_range_daytype_signal_needs_touch_level_rederivation
- zero_mfe_early_stop_tighten_idea
- twolot_scaleout_generalize_to_other_setups
- circuit_breaker_mute_tag_ha_page_requirement
- wr_lag_exposure_bound_alternative_20260907
- ai_setup_review_needs_validation_check_at_n20
- volume_building_inherited_level_remaining_angles_bc
- session_trend_char_as_live_filter_idea_20260915
- py_3m_level_calibration_still_thin_20260913
- nq_two_remaining_unexplained_large_moves_20260908
- example_20261021_rth_open_drop_defended_highs_not_caught
- es_confirming_fade_lead_needs_forward_test_20261026

## Recorded no (RTH null, Globex arm not worth building)
- amt_option3_globex_arm_untested_20261028
- vbp_trend_filter_globex_untested_20261027

## Stale or superseded (PROMOTE_ALL_MODE, LIVE_ROSTER, exit audit, regime/forecast nulls, Globex flush NOT SHOWN)
- wider_target_calib_needs_deepseek_review
- flush_setups_lack_breakeven_trail_protection
- wire_approach_pace_as_size_factor
- same_day_forming_volbuild_quartile_promotion_trigger
- liquidity_zones_idea_d_step5_build_needed
- flush_vwap_slope_exit_scoped_pending_test
- adverse_move_absorption_speed_runner_signal
- dtclass_live_read_wiring_and_regime_scope
- cross_direction_fast_flip_seasonality_thin_recheck
- trending_stop_cascade_no_suppression_since_20260805
- promote_wr_floor_vs_ev_only_suppress_asymmetry
- promote_recovery_wr_gate_unreachable_no_target_20260915
- early_commitment_angle_untested_pending
- globex_same_direction_stacking_no_sizedown
- momentum_against_fade_sizemultiplier_wiring_pending
- step_trail_per_cell_live_wiring_pending
- regime_filter_candidate_angles_queue_20260906
- globex_flush_fires_once_locks_out_rest_of_night_20260909
- globex_flush_oneshot_rearm_design_question_20260913
- magnitude_filter_flush_capture_untested_20260910
- globex_flush_live_window_replay_not_done_20261026
- globex_volume_piling_live_wiring_untested_20260910
- unified_context_arbiter_direction_and_runner_20260916
- vwap_slope_directional_bias_phase0_pending_20260916
- rotation_detector_patternscanner_unification_20260916
- direction_gate_shadow_crosses_trading_day_boundary_20260920
- overnight_rotation_setup_level_application_20260921
- setup_improvement_candidates_20260925
- all_levels_live_revisit_20260925
- collapsed_view_meaning_under_all_levels_live_20260926
- opening_drive_gate_generalized_later_session_signal_20260925
- rangeslope_volroll_broader_roster_generalization_20260929
- exit_tightening_test_scoped_20261005
- macro_regime_B_v2_needs_redesign_no_fresh_window
- big_order_mid_regime_stuffed_lead_confirm_20261020
- ib_negative_siblings_shadow_recheck_20261021
- orderflow_rejection_entry_selection_untested_20260916
- rotation_gate_bracket_breakout_long_backwards_20261012
- globex_44type_rotation_filter_2month_review_20261012
- promote_all_mode_stat_gate_coldstart_watch_20261011
- rotation_gate_standalone_detectors_unwired_20261013
- stop_width_top_volbuild_prereg_20261005
- promote_all_mode_review_post_rotation_changes_20261012
- roster_65pt_rotation_direction_gate_20261008
- marks_build_framework_state_20261029
- tail_skew_aware_setup_evaluation_needed
- globex_crossaccount_routing_untested_20261013

## Already decided, shipped or covered elsewhere
- per_setup_type_loss_streak_pause_calibration_needed: Row text already says RESOLVED (deferred) 2026-09-02: user chose wait-and-re-test; every candidate type failed computeRigor.
- prop_challenge_1yr_no_single_position_constraint_20260925: Row text already says RESOLVED 2026-09-25 (corrected twice); the flagship-script rewrite was optional.
- single_firing_directional_conflict_gate_not_built: Row UPDATE says all 4 real insert sites are wired; nothing left to build.
- daytype_alpha_realdata_breakeven_fix_pending_review: Fix shipped live and passed two DeepSeek review rounds; the optional hard-gate question is parked (cluster-aware design judged sufficient).
- poller_late_backfill_display_gap_20260914: Display fix (path a) shipped and verified; path (b) is tracked by poller_late_backfill_vs_entry_lookback_window_20261013.
- rigor_tercile_stability_flaw_20260916: Captured as CLAUDE.md hard rule hr-038 (prefer dayBlockedBootstrapCI when a finding matters).
- unfilled_sibling_shown_as_open_position_20261005: De facto kept ACTIVE plus the entry_filled flag; display fixed and rule recorded as CLAUDE.md cv-042. No PENDING_FILL status.
- post_close_rows_pollute_live_population_20261021: Recorded as CLAUDE.md cv-051 (exclude 16:00-18:00 ET rows 2026-07-09..09-16); accepted rather than adding a basis column.
- family_roster_narrowing_and_indicator_sprint_scoped_20261021: Roster change shipped as the LIVE_ROSTER gate (2026-10-25); the indicator sprint is covered by later pre-registered studies.
- dtc_auto_rearm_safe_keep_decision_20261101: User decided 2026-11-01 to keep DTC_AUTO_REARM_SAFE; recorded in docs/G0_GAP_AUDIT_20261101.md.
- amt_tell_user_authorisations_20261028: Record of user statements 2026-10-28; Stage 2 is live and its review rule is in amt_tell_stage2_leave_running_review_at_floor_20261101.
- amt_tell_live_build_scoped_20261028: Stage 2 was decided: running unchanged, see amt_tell_stage2_leave_running_review_at_floor_20261101.
- amt_next_steps_breakout_then_forward_tracker_20261028: Superseded 2026-10-28 handoff; later state is in the tell/marks/agentic-scope decisions still open.
- selected_over_starvation_recheck_at_n20: Rechecked 2026-11-02: still 15 non-null selected_over rows (same as 2026-09-24), so the N>=20 floor is not being approached; feature is starved.
- contract_calendar_failsoft_join_20260915: Cutover is done: schema.sql price_bars_primary now joins price_bars_contract_calendar and has a price_bars_primary_orig_backup view.
- dual_account_position_snapshot_blind_spot_20261013: Moot while everything runs under the single logon account DTC-Live-Simulator (user decision 2026-10-19, see per_order_account_routing_unproven_20261019). Re-flag if a second account returns.
- claude_md_needs_recondensation_20260901: Done: CLAUDE.md is now a capped index (40 KB / 300 lines, test_invariants [14]) with the archive in docs/CLAUDE_MD_ARCHIVE/.

# Second pass: 100 remaining folded into 18 umbrellas (user: cut to 20)

Not decided or dropped. Each member was resolved with a 'Folded into umbrella X' note; the umbrella `OPEN_DECISION` row lists every member with its first 260 characters, and the member's full text stays in its own row (`node scripts/flag_decision.mjs --list-all`). To work one member, re-flag it on its own with `--add`.

## hi_depth_archive_and_orderbook_poc
Order-book depth archive: back it up (user action, 230GB) then the pre-registered absorption proof of concept.
- preserve_sierra_chart_depth_archive_irreplaceable
- run_depth_absorption_poc_stage1

## hi_nq_bar_data_repairs_and_derived_tables
NQ bar gaps/contamination and the derived tables built on them (levels, setups, tags, MAE/MFE); re-derive after any bar repair (hr-054).
- nq_window_downstream_rebuild_decision
- nq_bars_missing_sep22_27_2025
- nq_bar_gaps_2024_2025_unflagged
- va_overlap_streak_degraded_data_gap_vulnerability_20260914
- late_bars_rederive_derived_tables_20261027
- confluence_validated_pairs_84_to_541_20261027
- mae_points_corruption_independent_of_entry_price_20260915

## hi_broker_pnl_and_close_integrity
Real-order integrity: broker P&L attribution, double closes, manual Sierra actions, reconciliation, fill realism.
- manual_sierra_action_no_broker_pnl_visibility_20261013
- unknown_broker_pnl_silent_close_policy_20261018
- stop_and_flatten_both_fill_double_close_multislot_20261019
- broker_stop_fill_not_reflected_in_app_row_20261019
- rotation_flip_close_first_live_verification_20261019
- reconciliation_refused_fill_log_noise_20261021
- sierra_chart_reconciliation_cadence_and_static_stop_20260929
- oco_bracket_sim1_structurally_broken_20261007
- sim1_near_instant_stop_fills_realism_question_20261013
- dtc_fill_cost_audit_not_yet_feasible_20261007

## med_live_means_fired_entry_path
Every live row must reach the broker: late/missed entry windows, forming-bar detectors, shadow leaks, stacking rule.
- live_means_fired_every_live_row_must_reach_broker_20261019
- major_pivot_live_rows_always_miss_3min_entry_window_20261019
- poller_late_backfill_vs_entry_lookback_window_20261013
- stall_minor_detectors_forming_5min_bar_20261019
- momentum_chase_hardwired_shadow_no_promotion_path_20261019
- shadow_no_reason_rows_leak_to_live_20261019
- same_setup_type_stacking_rule_undecided_20261013

## med_risk_gates_dll_margin_accounts
Risk gates and account setup: daily loss limit blind spots, margin config, per-order account routing.
- dll_gate_blind_to_open_exposure_20261013
- dll_gate_worst_case_ignores_stop_exit_slippage_20261019
- single_trade_stop_can_exceed_daily_loss_limit_20261026
- mnq_margin_config_may_be_using_nq_values_20261007
- per_order_account_routing_unproven_20261019

## hi_detection_poll_and_bar_view_speed
Detection poll timeouts and price_bars view speed (A1 index, A2 cast-free reads), judged by perf_report.
- price_bars_view_speed_and_startup_lookups_20261019
- detection_poll_chronic_timeouts_rth_20261019

## hi_poc_join_and_flip_exit
POC rotation join: is its edge real on the live construction, flip-close value, tell overlap, migration prereg.
- poc_join_edge_unproven_live_construction_20261020
- poc_flip_close_marginal_value_review_20261019
- poc_join_blown_through_tell_forward_tag_20261028
- poc_migration_multiweek_floor_prereg_20261027

## hi_roster_scoreboard_and_live_gates
LIVE_ROSTER scoreboard and live-gate reviews (opening drive gate, rotation gate, sim-fill drag, missing OPTIMAL_STOP rows).
- next_steps_scoreboard_and_bar_studies_scoped_20261025
- roster_survivors_no_out_of_window_edge_20261026
- rotation_gate_forward_first_look_20261020
- opening_drive_gate_6week_revisit_20260925
- setup_family_sim_fill_drag_review_20261021
- active_setup_types_without_optimal_stop_row_20261021

## med_setup_calibration_and_promotion
Setup calibration and shadow-to-live promotion questions (trail-exit resolutions, wider target, MomFade, FSR targets, cluster tagging).
- setup_status_excludes_trail_exit_resolution
- wider_target_live_recheck_cleared_promotion_consideration
- momfade_globex_live_wiring_scoped_20260929
- fsr_target_miscalibration_deadlock_20260915
- case_engine_family_cluster_tagging_gap_20260908
- stop_sweep_retire_after_merged_rows_20261021
- bias_state_real_era_recheck_20261019

## med_scheduled_forward_looks
Pre-registered single forward looks and passive trackers; each is ONE look on its date, no earlier peeks (optional stopping).
- stuffed_at_defended_pivot_forward_look_20261215
- onh_hold_zone_forward_look_20261215
- four_hour_volume_cut_forward_look_20261215
- four_hour_stored_level_forward_look_20261215
- sequential_run_forward_look_20270401
- multiscale_run_forward_look_20270401
- vbp_acceptance_forward_look_20270401
- amt_s2_s3_forward_look_due

## med_user_chart_calls_waiting
Waiting on the user to log/rate chart calls, then ONE analysis each.
- my_call_log_first_look_20261130
- side_calls_ratings_pending_20261101

## med_amt_tell_live_stage2
AMT tell live detector: Stage 2 runs unchanged to the evidence floor; sidecar, roll-week, Globex, export and flip items.
- amt_tell_stage2_leave_running_review_at_floor_20261101
- amt_tell_sidecar_evening_start_no_tick_file_20261029
- amt_tell_roll_week_contract_selection_20261028
- amt_tell_globex_arm_untested_20261028
- amt_tell_sierra_500vol_bars_export_needed_20261028
- amt_tell_flip_disagree_forward_test_20261101
- ddy_delta_flip_needs_fresh_export_to_replicate_20261101
- amt_tell_trade_test_or_holdout_look_needs_user_20261028

## med_amt_explore_leads_need_user
AMT explore leads that each need a user answer before a pre-registration.
- amt_sweep_absorb_proximity_variant_needs_user_20261028
- amt_node_ladder_continuous_version_needs_user_20261028
- amt_ignition_market_entry_lead_needs_prereg_20261028

## med_absorption_exhaustion_marks_line
Absorption/exhaustion marks line: user review, grind-hold idea, stage 2 run, context gate, interaction study.
- absorption_grind_hold_idea_20261028
- absorption_exhaustion_marks_user_review_20261028
- marks_stage2_signature_run_20261029
- marks_context_gate_and_build_plan_20261029
- absorption_next_steps_after_shelf_20261029
- absorption_exhaustion_interaction_study_20261029
- bubble_large_order_definition_needed_20261020

## med_user_idea_studies_and_levels
User-idea studies and level definitions: volume/delta by price, Sierra 3M level mismatch, value traversal, auction state, runners, rotation events.
- volume_delta_by_price_scope_user_review_20261026
- three_month_poc_vah_differ_from_sierra_20261026
- stored_period_levels_swap_to_tick_volume_20261026
- faithful_redo_of_narrowed_user_idea_studies_20261026
- value_traversal_setup_vs_guidance_untested_parts_20261019
- auction_state_balance_vs_expansion_stageA_20261018
- managed_runner_after_t1_touch_flow_test_20261020
- rotation_events_mining_digest_and_live_recorder_20261019

## med_agentic_direction_and_research_infra
Agentic system scope, direction program inputs, look-ledger policy, scheduled-job failure surfacing.
- agentic_system_and_hard_todos_scope_review_20261101
- direction_program_inputs_received_20261101
- look_ledger_enforcement_runner_gate_20261101
- look_ledger_family_wise_policy_20261102
- scheduled_job_failures_not_surfaced_20261027

## med_ml_forecast_and_user_actions
ML chain sunset, ML feature roadmap, quantile model review, regime cron (user action), dead forecast panel, AI review API credit.
- ml_metalabeler_chain_sunset_20261102
- ml_feature_candidates_after_forward_r4_r5_20261020
- ml_feature_and_overnight_context_ideas_watchlist_20261025
- quantile_model_one_month_review_criteria_20260924
- regime_outlook_cron_not_added_20261102
- sessionforecastpanel_intel_section_dead_code_20260928
- anthropic_api_credit_exhausted_ai_review_failing_20261019

## med_stale_stats_and_code_size
Stale stats feeding the UI and acd.js file-size reduction.
- setup_daytype_winrates_stale_never_scheduled_20260927
- acdjs_file_size_reduction_scoped_20260916

