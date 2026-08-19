--
-- PostgreSQL database dump
--


-- Dumped from database version 16.14 (Ubuntu 16.14-0ubuntu0.24.04.1)
-- Dumped by pg_dump version 16.14 (Ubuntu 16.14-0ubuntu0.24.04.1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: update_updated_at_column(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_updated_at_column() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: account_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.account_settings (
    id integer NOT NULL,
    account_id character varying(50) NOT NULL,
    daily_loss_limit numeric DEFAULT 400 NOT NULL,
    max_contracts integer DEFAULT 1 NOT NULL,
    dll_removed_count integer DEFAULT 0,
    last_dll_removal timestamp without time zone,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now(),
    account_stage character varying(20) DEFAULT 'EVALUATION'::character varying
);


--
-- Name: account_settings_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.account_settings_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: account_settings_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.account_settings_id_seq OWNED BY public.account_settings.id;


--
-- Name: acd_backtest_results; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.acd_backtest_results (
    id integer NOT NULL,
    run_date timestamp without time zone DEFAULT now(),
    or_minutes integer,
    a_multiplier numeric,
    sustain_minutes integer,
    total_signals integer,
    win_rate numeric,
    avg_win_r numeric,
    avg_loss_r numeric,
    payoff_ratio numeric,
    ev_per_signal numeric,
    profit_factor numeric,
    win_rate_nl_above_9 numeric,
    win_rate_nl_below_9 numeric,
    win_rate_nl_ranging numeric,
    notes text,
    nl_aligned boolean DEFAULT false,
    or_range_max integer,
    c_confirmed_only boolean DEFAULT false,
    filter_label character varying(50),
    period character varying(20) DEFAULT 'all-time'::character varying
);


--
-- Name: acd_backtest_results_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.acd_backtest_results_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: acd_backtest_results_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.acd_backtest_results_id_seq OWNED BY public.acd_backtest_results.id;


--
-- Name: acd_daily_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.acd_daily_log (
    id integer NOT NULL,
    trade_date date NOT NULL,
    or_high numeric,
    or_low numeric,
    a_multiplier numeric DEFAULT 0.33,
    a_up_level numeric,
    a_down_level numeric,
    a_up_fired boolean DEFAULT false,
    a_up_time time without time zone,
    a_down_fired boolean DEFAULT false,
    a_down_time time without time zone,
    c_up_confirmed boolean DEFAULT false,
    c_down_confirmed boolean DEFAULT false,
    daily_score integer DEFAULT 0,
    session_close numeric,
    notes text,
    created_at timestamp without time zone DEFAULT now(),
    close_position character varying(10),
    day_type character varying(30),
    profile_shape character varying(20)
);


--
-- Name: acd_daily_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.acd_daily_log_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: acd_daily_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.acd_daily_log_id_seq OWNED BY public.acd_daily_log.id;


--
-- Name: acd_monthly_pivot; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.acd_monthly_pivot (
    id integer NOT NULL,
    month_year character varying(7) NOT NULL,
    prior_month_high numeric,
    prior_month_low numeric,
    prior_month_close numeric,
    pivot_level numeric,
    pivot_r1 numeric,
    pivot_s1 numeric,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: acd_monthly_pivot_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.acd_monthly_pivot_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: acd_monthly_pivot_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.acd_monthly_pivot_id_seq OWNED BY public.acd_monthly_pivot.id;


--
-- Name: acd_setup_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.acd_setup_events (
    id integer NOT NULL,
    trade_date date NOT NULL,
    setup_type character varying(50) NOT NULL,
    fired_time time without time zone NOT NULL,
    fired_price numeric,
    minutes_from_or integer,
    or_high numeric,
    or_low numeric,
    a_up_level numeric,
    a_down_level numeric,
    session_high numeric,
    session_low numeric,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: acd_setup_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.acd_setup_events_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: acd_setup_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.acd_setup_events_id_seq OWNED BY public.acd_setup_events.id;


--
-- Name: acd_setup_events_or_rename_backup_20260812; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.acd_setup_events_or_rename_backup_20260812 (
    id integer,
    trade_date date,
    setup_type character varying(50),
    fired_time time without time zone,
    fired_price numeric,
    minutes_from_or integer,
    or_high numeric,
    or_low numeric,
    a_up_level numeric,
    a_down_level numeric,
    session_high numeric,
    session_low numeric,
    created_at timestamp without time zone
);


--
-- Name: acd_weekly_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.acd_weekly_log (
    id integer NOT NULL,
    week_start date NOT NULL,
    or_day date,
    or_high numeric,
    or_low numeric,
    a_multiplier numeric DEFAULT 0.33,
    a_up_level numeric,
    a_down_level numeric,
    a_up_fired boolean DEFAULT false,
    a_up_day date,
    a_down_fired boolean DEFAULT false,
    a_down_day date,
    c_up_confirmed boolean DEFAULT false,
    c_down_confirmed boolean DEFAULT false,
    daily_score integer DEFAULT 0,
    week_close numeric,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: acd_weekly_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.acd_weekly_log_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: acd_weekly_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.acd_weekly_log_id_seq OWNED BY public.acd_weekly_log.id;


--
-- Name: active_setups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.active_setups (
    id integer NOT NULL,
    trade_date date DEFAULT CURRENT_DATE NOT NULL,
    setup_type character varying(60) NOT NULL,
    fired_at timestamp without time zone NOT NULL,
    expires_at timestamp without time zone,
    resolved_at timestamp without time zone,
    status character varying(10) DEFAULT 'ACTIVE'::character varying NOT NULL,
    resolution character varying(20),
    entry_zone_low numeric,
    entry_zone_high numeric,
    stop_level numeric,
    t1_level numeric,
    t1_label character varying(100),
    structural_level_touched numeric,
    structural_level_type character varying(60),
    price_at_detection numeric,
    price_at_resolution numeric,
    historical_win_rate numeric,
    historical_sessions integer,
    historical_avg_pnl numeric,
    historical_t1_hit_rate numeric,
    historical_source character varying(20),
    nl30_at_detection integer,
    structural_state_at_detection character varying(60),
    confluence_score_at_detection integer,
    actual_outcome character varying(20),
    actual_pnl numeric,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now(),
    invalidation_timing character varying(20),
    resolution_method character varying(20),
    overnight_bias character varying(20),
    mae_points numeric,
    mfe_points numeric,
    bars_to_resolution integer,
    resolution_bar_time timestamp without time zone,
    replay_resolution character varying(20),
    size_multiplier numeric(5,3),
    suppression_reason text,
    touch_quality character varying(20),
    touch_quality_vol_z numeric,
    origin_status character varying(12),
    is_rth boolean GENERATED ALWAYS AS ((((EXTRACT(hour FROM fired_at) > (9)::numeric) OR ((EXTRACT(hour FROM fired_at) = (9)::numeric) AND (EXTRACT(minute FROM fired_at) >= (30)::numeric))) AND (EXTRACT(hour FROM fired_at) < (16)::numeric))) STORED,
    runner_trail_width numeric,
    breakeven_armed_at timestamp without time zone,
    runner_peak_price numeric,
    runner_trail_price numeric,
    confluence_levels_at_detection text[],
    exhaustion_signal_at_detection boolean,
    bar6_checkpoint character varying(20),
    bar6_exit_recommended boolean,
    extend_target_level numeric,
    extend_decision character varying(20),
    delta_confirmation_state character varying(20),
    cluster_attributed_setups text[],
    hivol_lopace_at_detection boolean,
    regime_pos_10d numeric(8,4),
    regime_label_10d character varying(4),
    regime_pos_20d numeric(8,4),
    regime_label_20d character varying(4),
    regime_pos_30d numeric(8,4),
    regime_label_30d character varying(4),
    regime_pos_45d numeric(8,4),
    regime_label_45d character varying(4),
    regime_pos_60d numeric(8,4),
    regime_label_60d character varying(4),
    regime_pos_90d numeric(8,4),
    regime_label_90d character varying(4),
    regime_pos_180d numeric(8,4),
    regime_label_180d character varying(4),
    va_width_pctile_60d numeric,
    va_overlap_streak integer,
    ib_range_pctile_60d numeric,
    fired_status character varying(10),
    selected_over text[],
    day_type_at_fire character varying(20),
    vol_bucket_at_fire character varying(12),
    session character varying(8),
    minutes_from_open integer,
    bet_class character varying(24),
    wider_target_mult numeric,
    ib_window_stale_basis boolean
);


--
-- Name: active_setups_backfill_backup_20260714; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.active_setups_backfill_backup_20260714 (
    id integer,
    trade_date date,
    setup_type character varying(60),
    fired_at timestamp without time zone,
    expires_at timestamp without time zone,
    resolved_at timestamp without time zone,
    status character varying(10),
    resolution character varying(20),
    entry_zone_low numeric,
    entry_zone_high numeric,
    stop_level numeric,
    t1_level numeric,
    t1_label character varying(100),
    structural_level_touched numeric,
    structural_level_type character varying(60),
    price_at_detection numeric,
    price_at_resolution numeric,
    historical_win_rate numeric,
    historical_sessions integer,
    historical_avg_pnl numeric,
    historical_t1_hit_rate numeric,
    historical_source character varying(20),
    nl30_at_detection integer,
    structural_state_at_detection character varying(60),
    confluence_score_at_detection integer,
    actual_outcome character varying(20),
    actual_pnl numeric,
    created_at timestamp without time zone,
    updated_at timestamp without time zone,
    invalidation_timing character varying(20),
    resolution_method character varying(20),
    overnight_bias character varying(20),
    mae_points numeric,
    mfe_points numeric,
    bars_to_resolution integer,
    resolution_bar_time timestamp without time zone,
    replay_resolution character varying(20),
    size_multiplier numeric(5,3),
    suppression_reason text
);


--
-- Name: active_setups_cam_window_backup_20260714; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.active_setups_cam_window_backup_20260714 (
    id integer,
    trade_date date,
    setup_type character varying(60),
    fired_at timestamp without time zone,
    expires_at timestamp without time zone,
    resolved_at timestamp without time zone,
    status character varying(10),
    resolution character varying(20),
    entry_zone_low numeric,
    entry_zone_high numeric,
    stop_level numeric,
    t1_level numeric,
    t1_label character varying(100),
    structural_level_touched numeric,
    structural_level_type character varying(60),
    price_at_detection numeric,
    price_at_resolution numeric,
    historical_win_rate numeric,
    historical_sessions integer,
    historical_avg_pnl numeric,
    historical_t1_hit_rate numeric,
    historical_source character varying(20),
    nl30_at_detection integer,
    structural_state_at_detection character varying(60),
    confluence_score_at_detection integer,
    actual_outcome character varying(20),
    actual_pnl numeric,
    created_at timestamp without time zone,
    updated_at timestamp without time zone,
    invalidation_timing character varying(20),
    resolution_method character varying(20),
    overnight_bias character varying(20),
    mae_points numeric,
    mfe_points numeric,
    bars_to_resolution integer,
    resolution_bar_time timestamp without time zone,
    replay_resolution character varying(20),
    size_multiplier numeric(5,3),
    suppression_reason text
);


--
-- Name: active_setups_cascade_breaker_repair_backup_20260816; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.active_setups_cascade_breaker_repair_backup_20260816 (
    id integer,
    trade_date date,
    setup_type character varying(60),
    fired_at timestamp without time zone,
    expires_at timestamp without time zone,
    resolved_at timestamp without time zone,
    status character varying(10),
    resolution character varying(20),
    entry_zone_low numeric,
    entry_zone_high numeric,
    stop_level numeric,
    t1_level numeric,
    t1_label character varying(100),
    structural_level_touched numeric,
    structural_level_type character varying(60),
    price_at_detection numeric,
    price_at_resolution numeric,
    historical_win_rate numeric,
    historical_sessions integer,
    historical_avg_pnl numeric,
    historical_t1_hit_rate numeric,
    historical_source character varying(20),
    nl30_at_detection integer,
    structural_state_at_detection character varying(60),
    confluence_score_at_detection integer,
    actual_outcome character varying(20),
    actual_pnl numeric,
    created_at timestamp without time zone,
    updated_at timestamp without time zone,
    invalidation_timing character varying(20),
    resolution_method character varying(20),
    overnight_bias character varying(20),
    mae_points numeric,
    mfe_points numeric,
    bars_to_resolution integer,
    resolution_bar_time timestamp without time zone,
    replay_resolution character varying(20),
    size_multiplier numeric(5,3),
    suppression_reason text,
    touch_quality character varying(20),
    touch_quality_vol_z numeric,
    origin_status character varying(12),
    is_rth boolean,
    runner_trail_width numeric,
    breakeven_armed_at timestamp without time zone,
    runner_peak_price numeric,
    runner_trail_price numeric,
    confluence_levels_at_detection text[],
    exhaustion_signal_at_detection boolean,
    bar6_checkpoint character varying(20),
    bar6_exit_recommended boolean,
    extend_target_level numeric,
    extend_decision character varying(20),
    delta_confirmation_state character varying(20),
    cluster_attributed_setups text[],
    hivol_lopace_at_detection boolean,
    regime_pos_10d numeric(8,4),
    regime_label_10d character varying(4),
    regime_pos_20d numeric(8,4),
    regime_label_20d character varying(4),
    regime_pos_30d numeric(8,4),
    regime_label_30d character varying(4),
    regime_pos_45d numeric(8,4),
    regime_label_45d character varying(4),
    regime_pos_60d numeric(8,4),
    regime_label_60d character varying(4),
    regime_pos_90d numeric(8,4),
    regime_label_90d character varying(4),
    regime_pos_180d numeric(8,4),
    regime_label_180d character varying(4),
    va_width_pctile_60d numeric,
    va_overlap_streak integer,
    ib_range_pctile_60d numeric,
    fired_status character varying(10),
    selected_over text[],
    day_type_at_fire character varying(20),
    vol_bucket_at_fire character varying(12),
    session character varying(8),
    minutes_from_open integer,
    bet_class character varying(24)
);


--
-- Name: active_setups_commission_repair_backup_20260811; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.active_setups_commission_repair_backup_20260811 (
    id integer,
    trade_date date,
    setup_type character varying(60),
    fired_at timestamp without time zone,
    expires_at timestamp without time zone,
    resolved_at timestamp without time zone,
    status character varying(10),
    resolution character varying(20),
    entry_zone_low numeric,
    entry_zone_high numeric,
    stop_level numeric,
    t1_level numeric,
    t1_label character varying(100),
    structural_level_touched numeric,
    structural_level_type character varying(60),
    price_at_detection numeric,
    price_at_resolution numeric,
    historical_win_rate numeric,
    historical_sessions integer,
    historical_avg_pnl numeric,
    historical_t1_hit_rate numeric,
    historical_source character varying(20),
    nl30_at_detection integer,
    structural_state_at_detection character varying(60),
    confluence_score_at_detection integer,
    actual_outcome character varying(20),
    actual_pnl numeric,
    created_at timestamp without time zone,
    updated_at timestamp without time zone,
    invalidation_timing character varying(20),
    resolution_method character varying(20),
    overnight_bias character varying(20),
    mae_points numeric,
    mfe_points numeric,
    bars_to_resolution integer,
    resolution_bar_time timestamp without time zone,
    replay_resolution character varying(20),
    size_multiplier numeric(5,3),
    suppression_reason text,
    touch_quality character varying(20),
    touch_quality_vol_z numeric,
    origin_status character varying(12),
    is_rth boolean,
    runner_trail_width numeric,
    breakeven_armed_at timestamp without time zone,
    runner_peak_price numeric,
    runner_trail_price numeric,
    confluence_levels_at_detection text[],
    exhaustion_signal_at_detection boolean,
    bar6_checkpoint character varying(20),
    bar6_exit_recommended boolean,
    extend_target_level numeric,
    extend_decision character varying(20),
    delta_confirmation_state character varying(20),
    cluster_attributed_setups text[],
    hivol_lopace_at_detection boolean,
    regime_pos_10d numeric(8,4),
    regime_label_10d character varying(4),
    regime_pos_20d numeric(8,4),
    regime_label_20d character varying(4),
    regime_pos_30d numeric(8,4),
    regime_label_30d character varying(4),
    regime_pos_45d numeric(8,4),
    regime_label_45d character varying(4),
    regime_pos_60d numeric(8,4),
    regime_label_60d character varying(4),
    regime_pos_90d numeric(8,4),
    regime_label_90d character varying(4),
    regime_pos_180d numeric(8,4),
    regime_label_180d character varying(4),
    va_width_pctile_60d numeric,
    va_overlap_streak integer,
    ib_range_pctile_60d numeric,
    fired_status character varying(10),
    selected_over text[],
    day_type_at_fire character varying(20),
    vol_bucket_at_fire character varying(12),
    session character varying(8),
    minutes_from_open integer,
    bet_class character varying(24)
);


--
-- Name: active_setups_dead_end_repair_backup_20260727; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.active_setups_dead_end_repair_backup_20260727 (
    id integer,
    trade_date date,
    setup_type character varying(60),
    fired_at timestamp without time zone,
    expires_at timestamp without time zone,
    resolved_at timestamp without time zone,
    status character varying(10),
    resolution character varying(20),
    entry_zone_low numeric,
    entry_zone_high numeric,
    stop_level numeric,
    t1_level numeric,
    t1_label character varying(100),
    structural_level_touched numeric,
    structural_level_type character varying(60),
    price_at_detection numeric,
    price_at_resolution numeric,
    historical_win_rate numeric,
    historical_sessions integer,
    historical_avg_pnl numeric,
    historical_t1_hit_rate numeric,
    historical_source character varying(20),
    nl30_at_detection integer,
    structural_state_at_detection character varying(60),
    confluence_score_at_detection integer,
    actual_outcome character varying(20),
    actual_pnl numeric,
    created_at timestamp without time zone,
    updated_at timestamp without time zone,
    invalidation_timing character varying(20),
    resolution_method character varying(20),
    overnight_bias character varying(20),
    mae_points numeric,
    mfe_points numeric,
    bars_to_resolution integer,
    resolution_bar_time timestamp without time zone,
    replay_resolution character varying(20),
    size_multiplier numeric(5,3),
    suppression_reason text,
    touch_quality character varying(20),
    touch_quality_vol_z numeric,
    origin_status character varying(12),
    is_rth boolean,
    runner_trail_width numeric,
    breakeven_armed_at timestamp without time zone,
    runner_peak_price numeric,
    runner_trail_price numeric,
    confluence_levels_at_detection text[],
    exhaustion_signal_at_detection boolean,
    bar6_checkpoint character varying(20),
    bar6_exit_recommended boolean
);


--
-- Name: active_setups_duplicate_touch_backup_20260717; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.active_setups_duplicate_touch_backup_20260717 (
    id integer,
    trade_date date,
    setup_type character varying(60),
    fired_at timestamp without time zone,
    expires_at timestamp without time zone,
    resolved_at timestamp without time zone,
    status character varying(10),
    resolution character varying(20),
    entry_zone_low numeric,
    entry_zone_high numeric,
    stop_level numeric,
    t1_level numeric,
    t1_label character varying(100),
    structural_level_touched numeric,
    structural_level_type character varying(60),
    price_at_detection numeric,
    price_at_resolution numeric,
    historical_win_rate numeric,
    historical_sessions integer,
    historical_avg_pnl numeric,
    historical_t1_hit_rate numeric,
    historical_source character varying(20),
    nl30_at_detection integer,
    structural_state_at_detection character varying(60),
    confluence_score_at_detection integer,
    actual_outcome character varying(20),
    actual_pnl numeric,
    created_at timestamp without time zone,
    updated_at timestamp without time zone,
    invalidation_timing character varying(20),
    resolution_method character varying(20),
    overnight_bias character varying(20),
    mae_points numeric,
    mfe_points numeric,
    bars_to_resolution integer,
    resolution_bar_time timestamp without time zone,
    replay_resolution character varying(20),
    size_multiplier numeric(5,3),
    suppression_reason text,
    touch_quality character varying(20),
    touch_quality_vol_z numeric,
    origin_status character varying(12)
);


--
-- Name: active_setups_globex_betclass_backup_20260811; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.active_setups_globex_betclass_backup_20260811 (
    id integer,
    setup_type character varying(60),
    bet_class character varying(24)
);


--
-- Name: active_setups_globex_vwap_fade_backfill_backup_20260728; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.active_setups_globex_vwap_fade_backfill_backup_20260728 (
    id integer,
    trade_date date,
    setup_type character varying(60),
    fired_at timestamp without time zone,
    expires_at timestamp without time zone,
    resolved_at timestamp without time zone,
    status character varying(10),
    resolution character varying(20),
    entry_zone_low numeric,
    entry_zone_high numeric,
    stop_level numeric,
    t1_level numeric,
    t1_label character varying(100),
    structural_level_touched numeric,
    structural_level_type character varying(60),
    price_at_detection numeric,
    price_at_resolution numeric,
    historical_win_rate numeric,
    historical_sessions integer,
    historical_avg_pnl numeric,
    historical_t1_hit_rate numeric,
    historical_source character varying(20),
    nl30_at_detection integer,
    structural_state_at_detection character varying(60),
    confluence_score_at_detection integer,
    actual_outcome character varying(20),
    actual_pnl numeric,
    created_at timestamp without time zone,
    updated_at timestamp without time zone,
    invalidation_timing character varying(20),
    resolution_method character varying(20),
    overnight_bias character varying(20),
    mae_points numeric,
    mfe_points numeric,
    bars_to_resolution integer,
    resolution_bar_time timestamp without time zone,
    replay_resolution character varying(20),
    size_multiplier numeric(5,3),
    suppression_reason text,
    touch_quality character varying(20),
    touch_quality_vol_z numeric,
    origin_status character varying(12),
    is_rth boolean,
    runner_trail_width numeric,
    breakeven_armed_at timestamp without time zone,
    runner_peak_price numeric,
    runner_trail_price numeric,
    confluence_levels_at_detection text[],
    exhaustion_signal_at_detection boolean,
    bar6_checkpoint character varying(20),
    bar6_exit_recommended boolean,
    extend_target_level numeric,
    extend_decision character varying(20),
    delta_confirmation_state character varying(20)
);


--
-- Name: active_setups_globex_vwap_magnet_backfill_backup_20260728; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.active_setups_globex_vwap_magnet_backfill_backup_20260728 (
    id integer,
    trade_date date,
    setup_type character varying(60),
    fired_at timestamp without time zone,
    expires_at timestamp without time zone,
    resolved_at timestamp without time zone,
    status character varying(10),
    resolution character varying(20),
    entry_zone_low numeric,
    entry_zone_high numeric,
    stop_level numeric,
    t1_level numeric,
    t1_label character varying(100),
    structural_level_touched numeric,
    structural_level_type character varying(60),
    price_at_detection numeric,
    price_at_resolution numeric,
    historical_win_rate numeric,
    historical_sessions integer,
    historical_avg_pnl numeric,
    historical_t1_hit_rate numeric,
    historical_source character varying(20),
    nl30_at_detection integer,
    structural_state_at_detection character varying(60),
    confluence_score_at_detection integer,
    actual_outcome character varying(20),
    actual_pnl numeric,
    created_at timestamp without time zone,
    updated_at timestamp without time zone,
    invalidation_timing character varying(20),
    resolution_method character varying(20),
    overnight_bias character varying(20),
    mae_points numeric,
    mfe_points numeric,
    bars_to_resolution integer,
    resolution_bar_time timestamp without time zone,
    replay_resolution character varying(20),
    size_multiplier numeric(5,3),
    suppression_reason text,
    touch_quality character varying(20),
    touch_quality_vol_z numeric,
    origin_status character varying(12),
    is_rth boolean,
    runner_trail_width numeric,
    breakeven_armed_at timestamp without time zone,
    runner_peak_price numeric,
    runner_trail_price numeric,
    confluence_levels_at_detection text[],
    exhaustion_signal_at_detection boolean,
    bar6_checkpoint character varying(20),
    bar6_exit_recommended boolean,
    extend_target_level numeric,
    extend_decision character varying(20),
    delta_confirmation_state character varying(20)
);


--
-- Name: active_setups_ib_window_backfill_backup_20260819; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.active_setups_ib_window_backfill_backup_20260819 (
    id integer,
    trade_date date,
    setup_type character varying(60),
    fired_at timestamp without time zone,
    expires_at timestamp without time zone,
    resolved_at timestamp without time zone,
    status character varying(10),
    resolution character varying(20),
    entry_zone_low numeric,
    entry_zone_high numeric,
    stop_level numeric,
    t1_level numeric,
    t1_label character varying(100),
    structural_level_touched numeric,
    structural_level_type character varying(60),
    price_at_detection numeric,
    price_at_resolution numeric,
    historical_win_rate numeric,
    historical_sessions integer,
    historical_avg_pnl numeric,
    historical_t1_hit_rate numeric,
    historical_source character varying(20),
    nl30_at_detection integer,
    structural_state_at_detection character varying(60),
    confluence_score_at_detection integer,
    actual_outcome character varying(20),
    actual_pnl numeric,
    created_at timestamp without time zone,
    updated_at timestamp without time zone,
    invalidation_timing character varying(20),
    resolution_method character varying(20),
    overnight_bias character varying(20),
    mae_points numeric,
    mfe_points numeric,
    bars_to_resolution integer,
    resolution_bar_time timestamp without time zone,
    replay_resolution character varying(20),
    size_multiplier numeric(5,3),
    suppression_reason text,
    touch_quality character varying(20),
    touch_quality_vol_z numeric,
    origin_status character varying(12),
    is_rth boolean,
    runner_trail_width numeric,
    breakeven_armed_at timestamp without time zone,
    runner_peak_price numeric,
    runner_trail_price numeric,
    confluence_levels_at_detection text[],
    exhaustion_signal_at_detection boolean,
    bar6_checkpoint character varying(20),
    bar6_exit_recommended boolean,
    extend_target_level numeric,
    extend_decision character varying(20),
    delta_confirmation_state character varying(20),
    cluster_attributed_setups text[],
    hivol_lopace_at_detection boolean,
    regime_pos_10d numeric(8,4),
    regime_label_10d character varying(4),
    regime_pos_20d numeric(8,4),
    regime_label_20d character varying(4),
    regime_pos_30d numeric(8,4),
    regime_label_30d character varying(4),
    regime_pos_45d numeric(8,4),
    regime_label_45d character varying(4),
    regime_pos_60d numeric(8,4),
    regime_label_60d character varying(4),
    regime_pos_90d numeric(8,4),
    regime_label_90d character varying(4),
    regime_pos_180d numeric(8,4),
    regime_label_180d character varying(4),
    va_width_pctile_60d numeric,
    va_overlap_streak integer,
    ib_range_pctile_60d numeric,
    fired_status character varying(10),
    selected_over text[],
    day_type_at_fire character varying(20),
    vol_bucket_at_fire character varying(12),
    session character varying(8),
    minutes_from_open integer,
    bet_class character varying(24),
    wider_target_mult numeric,
    ib_window_stale_basis boolean
);


--
-- Name: active_setups_ib_window_backup_20260714; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.active_setups_ib_window_backup_20260714 (
    id integer,
    trade_date date,
    setup_type character varying(60),
    fired_at timestamp without time zone,
    expires_at timestamp without time zone,
    resolved_at timestamp without time zone,
    status character varying(10),
    resolution character varying(20),
    entry_zone_low numeric,
    entry_zone_high numeric,
    stop_level numeric,
    t1_level numeric,
    t1_label character varying(100),
    structural_level_touched numeric,
    structural_level_type character varying(60),
    price_at_detection numeric,
    price_at_resolution numeric,
    historical_win_rate numeric,
    historical_sessions integer,
    historical_avg_pnl numeric,
    historical_t1_hit_rate numeric,
    historical_source character varying(20),
    nl30_at_detection integer,
    structural_state_at_detection character varying(60),
    confluence_score_at_detection integer,
    actual_outcome character varying(20),
    actual_pnl numeric,
    created_at timestamp without time zone,
    updated_at timestamp without time zone,
    invalidation_timing character varying(20),
    resolution_method character varying(20),
    overnight_bias character varying(20),
    mae_points numeric,
    mfe_points numeric,
    bars_to_resolution integer,
    resolution_bar_time timestamp without time zone,
    replay_resolution character varying(20),
    size_multiplier numeric(5,3),
    suppression_reason text
);


--
-- Name: active_setups_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.active_setups_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: active_setups_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.active_setups_id_seq OWNED BY public.active_setups.id;


--
-- Name: active_setups_invalidated_pnl_backup_20260720; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.active_setups_invalidated_pnl_backup_20260720 (
    id integer,
    trade_date date,
    setup_type character varying(60),
    fired_at timestamp without time zone,
    expires_at timestamp without time zone,
    resolved_at timestamp without time zone,
    status character varying(10),
    resolution character varying(20),
    entry_zone_low numeric,
    entry_zone_high numeric,
    stop_level numeric,
    t1_level numeric,
    t1_label character varying(100),
    structural_level_touched numeric,
    structural_level_type character varying(60),
    price_at_detection numeric,
    price_at_resolution numeric,
    historical_win_rate numeric,
    historical_sessions integer,
    historical_avg_pnl numeric,
    historical_t1_hit_rate numeric,
    historical_source character varying(20),
    nl30_at_detection integer,
    structural_state_at_detection character varying(60),
    confluence_score_at_detection integer,
    actual_outcome character varying(20),
    actual_pnl numeric,
    created_at timestamp without time zone,
    updated_at timestamp without time zone,
    invalidation_timing character varying(20),
    resolution_method character varying(20),
    overnight_bias character varying(20),
    mae_points numeric,
    mfe_points numeric,
    bars_to_resolution integer,
    resolution_bar_time timestamp without time zone,
    replay_resolution character varying(20),
    size_multiplier numeric(5,3),
    suppression_reason text,
    touch_quality character varying(20),
    touch_quality_vol_z numeric,
    origin_status character varying(12),
    is_rth boolean,
    runner_trail_width numeric,
    breakeven_armed_at timestamp without time zone,
    runner_peak_price numeric,
    runner_trail_price numeric
);


--
-- Name: active_setups_islongsetup_gapvariant_backfill_backup_20260817; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.active_setups_islongsetup_gapvariant_backfill_backup_20260817 (
    id integer,
    trade_date date,
    setup_type character varying(60),
    fired_at timestamp without time zone,
    expires_at timestamp without time zone,
    resolved_at timestamp without time zone,
    status character varying(10),
    resolution character varying(20),
    entry_zone_low numeric,
    entry_zone_high numeric,
    stop_level numeric,
    t1_level numeric,
    t1_label character varying(100),
    structural_level_touched numeric,
    structural_level_type character varying(60),
    price_at_detection numeric,
    price_at_resolution numeric,
    historical_win_rate numeric,
    historical_sessions integer,
    historical_avg_pnl numeric,
    historical_t1_hit_rate numeric,
    historical_source character varying(20),
    nl30_at_detection integer,
    structural_state_at_detection character varying(60),
    confluence_score_at_detection integer,
    actual_outcome character varying(20),
    actual_pnl numeric,
    created_at timestamp without time zone,
    updated_at timestamp without time zone,
    invalidation_timing character varying(20),
    resolution_method character varying(20),
    overnight_bias character varying(20),
    mae_points numeric,
    mfe_points numeric,
    bars_to_resolution integer,
    resolution_bar_time timestamp without time zone,
    replay_resolution character varying(20),
    size_multiplier numeric(5,3),
    suppression_reason text,
    touch_quality character varying(20),
    touch_quality_vol_z numeric,
    origin_status character varying(12),
    is_rth boolean,
    runner_trail_width numeric,
    breakeven_armed_at timestamp without time zone,
    runner_peak_price numeric,
    runner_trail_price numeric,
    confluence_levels_at_detection text[],
    exhaustion_signal_at_detection boolean,
    bar6_checkpoint character varying(20),
    bar6_exit_recommended boolean,
    extend_target_level numeric,
    extend_decision character varying(20),
    delta_confirmation_state character varying(20),
    cluster_attributed_setups text[],
    hivol_lopace_at_detection boolean,
    regime_pos_10d numeric(8,4),
    regime_label_10d character varying(4),
    regime_pos_20d numeric(8,4),
    regime_label_20d character varying(4),
    regime_pos_30d numeric(8,4),
    regime_label_30d character varying(4),
    regime_pos_45d numeric(8,4),
    regime_label_45d character varying(4),
    regime_pos_60d numeric(8,4),
    regime_label_60d character varying(4),
    regime_pos_90d numeric(8,4),
    regime_label_90d character varying(4),
    regime_pos_180d numeric(8,4),
    regime_label_180d character varying(4),
    va_width_pctile_60d numeric,
    va_overlap_streak integer,
    ib_range_pctile_60d numeric,
    fired_status character varying(10),
    selected_over text[],
    day_type_at_fire character varying(20),
    vol_bucket_at_fire character varying(12),
    session character varying(8),
    minutes_from_open integer,
    bet_class character varying(24),
    wider_target_mult numeric
);


--
-- Name: active_setups_maemfe_backup_20260717; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.active_setups_maemfe_backup_20260717 (
    id integer,
    mae_points numeric,
    mfe_points numeric,
    bars_to_resolution integer,
    resolution_bar_time timestamp without time zone,
    replay_resolution character varying(20)
);


--
-- Name: active_setups_monthlyvwap_yearlypoc_backup_20260719; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.active_setups_monthlyvwap_yearlypoc_backup_20260719 (
    id integer,
    trade_date date,
    setup_type character varying(60),
    fired_at timestamp without time zone,
    expires_at timestamp without time zone,
    resolved_at timestamp without time zone,
    status character varying(10),
    resolution character varying(20),
    entry_zone_low numeric,
    entry_zone_high numeric,
    stop_level numeric,
    t1_level numeric,
    t1_label character varying(100),
    structural_level_touched numeric,
    structural_level_type character varying(60),
    price_at_detection numeric,
    price_at_resolution numeric,
    historical_win_rate numeric,
    historical_sessions integer,
    historical_avg_pnl numeric,
    historical_t1_hit_rate numeric,
    historical_source character varying(20),
    nl30_at_detection integer,
    structural_state_at_detection character varying(60),
    confluence_score_at_detection integer,
    actual_outcome character varying(20),
    actual_pnl numeric,
    created_at timestamp without time zone,
    updated_at timestamp without time zone,
    invalidation_timing character varying(20),
    resolution_method character varying(20),
    overnight_bias character varying(20),
    mae_points numeric,
    mfe_points numeric,
    bars_to_resolution integer,
    resolution_bar_time timestamp without time zone,
    replay_resolution character varying(20),
    size_multiplier numeric(5,3),
    suppression_reason text,
    touch_quality character varying(20),
    touch_quality_vol_z numeric,
    origin_status character varying(12),
    is_rth boolean
);


--
-- Name: active_setups_null_pnl_recovery_backup_20260720; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.active_setups_null_pnl_recovery_backup_20260720 (
    id integer,
    trade_date date,
    setup_type character varying(60),
    fired_at timestamp without time zone,
    expires_at timestamp without time zone,
    resolved_at timestamp without time zone,
    status character varying(10),
    resolution character varying(20),
    entry_zone_low numeric,
    entry_zone_high numeric,
    stop_level numeric,
    t1_level numeric,
    t1_label character varying(100),
    structural_level_touched numeric,
    structural_level_type character varying(60),
    price_at_detection numeric,
    price_at_resolution numeric,
    historical_win_rate numeric,
    historical_sessions integer,
    historical_avg_pnl numeric,
    historical_t1_hit_rate numeric,
    historical_source character varying(20),
    nl30_at_detection integer,
    structural_state_at_detection character varying(60),
    confluence_score_at_detection integer,
    actual_outcome character varying(20),
    actual_pnl numeric,
    created_at timestamp without time zone,
    updated_at timestamp without time zone,
    invalidation_timing character varying(20),
    resolution_method character varying(20),
    overnight_bias character varying(20),
    mae_points numeric,
    mfe_points numeric,
    bars_to_resolution integer,
    resolution_bar_time timestamp without time zone,
    replay_resolution character varying(20),
    size_multiplier numeric(5,3),
    suppression_reason text,
    touch_quality character varying(20),
    touch_quality_vol_z numeric,
    origin_status character varying(12),
    is_rth boolean,
    runner_trail_width numeric,
    breakeven_armed_at timestamp without time zone,
    runner_peak_price numeric,
    runner_trail_price numeric
);


--
-- Name: active_setups_null_pnl_recovery_backup_20260720_batch2; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.active_setups_null_pnl_recovery_backup_20260720_batch2 (
    id integer,
    trade_date date,
    setup_type character varying(60),
    fired_at timestamp without time zone,
    expires_at timestamp without time zone,
    resolved_at timestamp without time zone,
    status character varying(10),
    resolution character varying(20),
    entry_zone_low numeric,
    entry_zone_high numeric,
    stop_level numeric,
    t1_level numeric,
    t1_label character varying(100),
    structural_level_touched numeric,
    structural_level_type character varying(60),
    price_at_detection numeric,
    price_at_resolution numeric,
    historical_win_rate numeric,
    historical_sessions integer,
    historical_avg_pnl numeric,
    historical_t1_hit_rate numeric,
    historical_source character varying(20),
    nl30_at_detection integer,
    structural_state_at_detection character varying(60),
    confluence_score_at_detection integer,
    actual_outcome character varying(20),
    actual_pnl numeric,
    created_at timestamp without time zone,
    updated_at timestamp without time zone,
    invalidation_timing character varying(20),
    resolution_method character varying(20),
    overnight_bias character varying(20),
    mae_points numeric,
    mfe_points numeric,
    bars_to_resolution integer,
    resolution_bar_time timestamp without time zone,
    replay_resolution character varying(20),
    size_multiplier numeric(5,3),
    suppression_reason text,
    touch_quality character varying(20),
    touch_quality_vol_z numeric,
    origin_status character varying(12),
    is_rth boolean,
    runner_trail_width numeric,
    breakeven_armed_at timestamp without time zone,
    runner_peak_price numeric,
    runner_trail_price numeric
);


--
-- Name: active_setups_or_rename_backup_20260812; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.active_setups_or_rename_backup_20260812 (
    id integer,
    trade_date date,
    setup_type character varying(60),
    fired_at timestamp without time zone,
    expires_at timestamp without time zone,
    resolved_at timestamp without time zone,
    status character varying(10),
    resolution character varying(20),
    entry_zone_low numeric,
    entry_zone_high numeric,
    stop_level numeric,
    t1_level numeric,
    t1_label character varying(100),
    structural_level_touched numeric,
    structural_level_type character varying(60),
    price_at_detection numeric,
    price_at_resolution numeric,
    historical_win_rate numeric,
    historical_sessions integer,
    historical_avg_pnl numeric,
    historical_t1_hit_rate numeric,
    historical_source character varying(20),
    nl30_at_detection integer,
    structural_state_at_detection character varying(60),
    confluence_score_at_detection integer,
    actual_outcome character varying(20),
    actual_pnl numeric,
    created_at timestamp without time zone,
    updated_at timestamp without time zone,
    invalidation_timing character varying(20),
    resolution_method character varying(20),
    overnight_bias character varying(20),
    mae_points numeric,
    mfe_points numeric,
    bars_to_resolution integer,
    resolution_bar_time timestamp without time zone,
    replay_resolution character varying(20),
    size_multiplier numeric(5,3),
    suppression_reason text,
    touch_quality character varying(20),
    touch_quality_vol_z numeric,
    origin_status character varying(12),
    is_rth boolean,
    runner_trail_width numeric,
    breakeven_armed_at timestamp without time zone,
    runner_peak_price numeric,
    runner_trail_price numeric,
    confluence_levels_at_detection text[],
    exhaustion_signal_at_detection boolean,
    bar6_checkpoint character varying(20),
    bar6_exit_recommended boolean,
    extend_target_level numeric,
    extend_decision character varying(20),
    delta_confirmation_state character varying(20),
    cluster_attributed_setups text[],
    hivol_lopace_at_detection boolean,
    regime_pos_10d numeric(8,4),
    regime_label_10d character varying(4),
    regime_pos_20d numeric(8,4),
    regime_label_20d character varying(4),
    regime_pos_30d numeric(8,4),
    regime_label_30d character varying(4),
    regime_pos_45d numeric(8,4),
    regime_label_45d character varying(4),
    regime_pos_60d numeric(8,4),
    regime_label_60d character varying(4),
    regime_pos_90d numeric(8,4),
    regime_label_90d character varying(4),
    regime_pos_180d numeric(8,4),
    regime_label_180d character varying(4),
    va_width_pctile_60d numeric,
    va_overlap_streak integer,
    ib_range_pctile_60d numeric,
    fired_status character varying(10),
    selected_over text[],
    day_type_at_fire character varying(20),
    vol_bucket_at_fire character varying(12),
    session character varying(8),
    minutes_from_open integer,
    bet_class character varying(24)
);


--
-- Name: active_setups_or_rename_race_duplicate_backup_20260812; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.active_setups_or_rename_race_duplicate_backup_20260812 (
    id integer,
    trade_date date,
    setup_type character varying(60),
    fired_at timestamp without time zone,
    expires_at timestamp without time zone,
    resolved_at timestamp without time zone,
    status character varying(10),
    resolution character varying(20),
    entry_zone_low numeric,
    entry_zone_high numeric,
    stop_level numeric,
    t1_level numeric,
    t1_label character varying(100),
    structural_level_touched numeric,
    structural_level_type character varying(60),
    price_at_detection numeric,
    price_at_resolution numeric,
    historical_win_rate numeric,
    historical_sessions integer,
    historical_avg_pnl numeric,
    historical_t1_hit_rate numeric,
    historical_source character varying(20),
    nl30_at_detection integer,
    structural_state_at_detection character varying(60),
    confluence_score_at_detection integer,
    actual_outcome character varying(20),
    actual_pnl numeric,
    created_at timestamp without time zone,
    updated_at timestamp without time zone,
    invalidation_timing character varying(20),
    resolution_method character varying(20),
    overnight_bias character varying(20),
    mae_points numeric,
    mfe_points numeric,
    bars_to_resolution integer,
    resolution_bar_time timestamp without time zone,
    replay_resolution character varying(20),
    size_multiplier numeric(5,3),
    suppression_reason text,
    touch_quality character varying(20),
    touch_quality_vol_z numeric,
    origin_status character varying(12),
    is_rth boolean,
    runner_trail_width numeric,
    breakeven_armed_at timestamp without time zone,
    runner_peak_price numeric,
    runner_trail_price numeric,
    confluence_levels_at_detection text[],
    exhaustion_signal_at_detection boolean,
    bar6_checkpoint character varying(20),
    bar6_exit_recommended boolean,
    extend_target_level numeric,
    extend_decision character varying(20),
    delta_confirmation_state character varying(20),
    cluster_attributed_setups text[],
    hivol_lopace_at_detection boolean,
    regime_pos_10d numeric(8,4),
    regime_label_10d character varying(4),
    regime_pos_20d numeric(8,4),
    regime_label_20d character varying(4),
    regime_pos_30d numeric(8,4),
    regime_label_30d character varying(4),
    regime_pos_45d numeric(8,4),
    regime_label_45d character varying(4),
    regime_pos_60d numeric(8,4),
    regime_label_60d character varying(4),
    regime_pos_90d numeric(8,4),
    regime_label_90d character varying(4),
    regime_pos_180d numeric(8,4),
    regime_label_180d character varying(4),
    va_width_pctile_60d numeric,
    va_overlap_streak integer,
    ib_range_pctile_60d numeric,
    fired_status character varying(10),
    selected_over text[],
    day_type_at_fire character varying(20),
    vol_bucket_at_fire character varying(12),
    session character varying(8),
    minutes_from_open integer,
    bet_class character varying(24)
);


--
-- Name: active_setups_pnl_rescale_backup_20260714; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.active_setups_pnl_rescale_backup_20260714 (
    id integer,
    setup_type character varying(60),
    resolution character varying(20),
    actual_pnl numeric
);


--
-- Name: active_setups_remaining_window_backup_20260714; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.active_setups_remaining_window_backup_20260714 (
    id integer,
    trade_date date,
    setup_type character varying(60),
    fired_at timestamp without time zone,
    expires_at timestamp without time zone,
    resolved_at timestamp without time zone,
    status character varying(10),
    resolution character varying(20),
    entry_zone_low numeric,
    entry_zone_high numeric,
    stop_level numeric,
    t1_level numeric,
    t1_label character varying(100),
    structural_level_touched numeric,
    structural_level_type character varying(60),
    price_at_detection numeric,
    price_at_resolution numeric,
    historical_win_rate numeric,
    historical_sessions integer,
    historical_avg_pnl numeric,
    historical_t1_hit_rate numeric,
    historical_source character varying(20),
    nl30_at_detection integer,
    structural_state_at_detection character varying(60),
    confluence_score_at_detection integer,
    actual_outcome character varying(20),
    actual_pnl numeric,
    created_at timestamp without time zone,
    updated_at timestamp without time zone,
    invalidation_timing character varying(20),
    resolution_method character varying(20),
    overnight_bias character varying(20),
    mae_points numeric,
    mfe_points numeric,
    bars_to_resolution integer,
    resolution_bar_time timestamp without time zone,
    replay_resolution character varying(20),
    size_multiplier numeric(5,3),
    suppression_reason text
);


--
-- Name: active_setups_resolution_bar_time_backup_20260727; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.active_setups_resolution_bar_time_backup_20260727 (
    id integer DEFAULT nextval('public.active_setups_id_seq'::regclass) NOT NULL,
    trade_date date DEFAULT CURRENT_DATE NOT NULL,
    setup_type character varying(60) NOT NULL,
    fired_at timestamp without time zone NOT NULL,
    expires_at timestamp without time zone,
    resolved_at timestamp without time zone,
    status character varying(10) DEFAULT 'ACTIVE'::character varying NOT NULL,
    resolution character varying(20),
    entry_zone_low numeric,
    entry_zone_high numeric,
    stop_level numeric,
    t1_level numeric,
    t1_label character varying(100),
    structural_level_touched numeric,
    structural_level_type character varying(60),
    price_at_detection numeric,
    price_at_resolution numeric,
    historical_win_rate numeric,
    historical_sessions integer,
    historical_avg_pnl numeric,
    historical_t1_hit_rate numeric,
    historical_source character varying(20),
    nl30_at_detection integer,
    structural_state_at_detection character varying(60),
    confluence_score_at_detection integer,
    actual_outcome character varying(20),
    actual_pnl numeric,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now(),
    invalidation_timing character varying(20),
    resolution_method character varying(20),
    overnight_bias character varying(20),
    mae_points numeric,
    mfe_points numeric,
    bars_to_resolution integer,
    resolution_bar_time timestamp without time zone,
    replay_resolution character varying(20),
    size_multiplier numeric(5,3),
    suppression_reason text,
    touch_quality character varying(20),
    touch_quality_vol_z numeric,
    origin_status character varying(12),
    is_rth boolean,
    runner_trail_width numeric,
    breakeven_armed_at timestamp without time zone,
    runner_peak_price numeric,
    runner_trail_price numeric,
    confluence_levels_at_detection text[],
    exhaustion_signal_at_detection boolean,
    bar6_checkpoint character varying(20),
    bar6_exit_recommended boolean
);


--
-- Name: active_setups_resolved_at_tz_bug_backup_20260727; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.active_setups_resolved_at_tz_bug_backup_20260727 (
    id integer,
    trade_date date,
    setup_type character varying(60),
    fired_at timestamp without time zone,
    expires_at timestamp without time zone,
    resolved_at timestamp without time zone,
    status character varying(10),
    resolution character varying(20),
    entry_zone_low numeric,
    entry_zone_high numeric,
    stop_level numeric,
    t1_level numeric,
    t1_label character varying(100),
    structural_level_touched numeric,
    structural_level_type character varying(60),
    price_at_detection numeric,
    price_at_resolution numeric,
    historical_win_rate numeric,
    historical_sessions integer,
    historical_avg_pnl numeric,
    historical_t1_hit_rate numeric,
    historical_source character varying(20),
    nl30_at_detection integer,
    structural_state_at_detection character varying(60),
    confluence_score_at_detection integer,
    actual_outcome character varying(20),
    actual_pnl numeric,
    created_at timestamp without time zone,
    updated_at timestamp without time zone,
    invalidation_timing character varying(20),
    resolution_method character varying(20),
    overnight_bias character varying(20),
    mae_points numeric,
    mfe_points numeric,
    bars_to_resolution integer,
    resolution_bar_time timestamp without time zone,
    replay_resolution character varying(20),
    size_multiplier numeric(5,3),
    suppression_reason text,
    touch_quality character varying(20),
    touch_quality_vol_z numeric,
    origin_status character varying(12),
    is_rth boolean,
    runner_trail_width numeric,
    breakeven_armed_at timestamp without time zone,
    runner_peak_price numeric,
    runner_trail_price numeric,
    confluence_levels_at_detection text[],
    exhaustion_signal_at_detection boolean,
    bar6_checkpoint character varying(20),
    bar6_exit_recommended boolean
);


--
-- Name: active_setups_rth_vwap_fade_backfill_backup_20260728; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.active_setups_rth_vwap_fade_backfill_backup_20260728 (
    id integer,
    trade_date date,
    setup_type character varying(60),
    fired_at timestamp without time zone,
    expires_at timestamp without time zone,
    resolved_at timestamp without time zone,
    status character varying(10),
    resolution character varying(20),
    entry_zone_low numeric,
    entry_zone_high numeric,
    stop_level numeric,
    t1_level numeric,
    t1_label character varying(100),
    structural_level_touched numeric,
    structural_level_type character varying(60),
    price_at_detection numeric,
    price_at_resolution numeric,
    historical_win_rate numeric,
    historical_sessions integer,
    historical_avg_pnl numeric,
    historical_t1_hit_rate numeric,
    historical_source character varying(20),
    nl30_at_detection integer,
    structural_state_at_detection character varying(60),
    confluence_score_at_detection integer,
    actual_outcome character varying(20),
    actual_pnl numeric,
    created_at timestamp without time zone,
    updated_at timestamp without time zone,
    invalidation_timing character varying(20),
    resolution_method character varying(20),
    overnight_bias character varying(20),
    mae_points numeric,
    mfe_points numeric,
    bars_to_resolution integer,
    resolution_bar_time timestamp without time zone,
    replay_resolution character varying(20),
    size_multiplier numeric(5,3),
    suppression_reason text,
    touch_quality character varying(20),
    touch_quality_vol_z numeric,
    origin_status character varying(12),
    is_rth boolean,
    runner_trail_width numeric,
    breakeven_armed_at timestamp without time zone,
    runner_peak_price numeric,
    runner_trail_price numeric,
    confluence_levels_at_detection text[],
    exhaustion_signal_at_detection boolean,
    bar6_checkpoint character varying(20),
    bar6_exit_recommended boolean,
    extend_target_level numeric,
    extend_decision character varying(20),
    delta_confirmation_state character varying(20)
);


--
-- Name: active_setups_rth_vwap_fade_todshift_backup_20260811; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.active_setups_rth_vwap_fade_todshift_backup_20260811 (
    id integer,
    trade_date date,
    setup_type character varying(60),
    fired_at timestamp without time zone,
    expires_at timestamp without time zone,
    resolved_at timestamp without time zone,
    status character varying(10),
    resolution character varying(20),
    entry_zone_low numeric,
    entry_zone_high numeric,
    stop_level numeric,
    t1_level numeric,
    t1_label character varying(100),
    structural_level_touched numeric,
    structural_level_type character varying(60),
    price_at_detection numeric,
    price_at_resolution numeric,
    historical_win_rate numeric,
    historical_sessions integer,
    historical_avg_pnl numeric,
    historical_t1_hit_rate numeric,
    historical_source character varying(20),
    nl30_at_detection integer,
    structural_state_at_detection character varying(60),
    confluence_score_at_detection integer,
    actual_outcome character varying(20),
    actual_pnl numeric,
    created_at timestamp without time zone,
    updated_at timestamp without time zone,
    invalidation_timing character varying(20),
    resolution_method character varying(20),
    overnight_bias character varying(20),
    mae_points numeric,
    mfe_points numeric,
    bars_to_resolution integer,
    resolution_bar_time timestamp without time zone,
    replay_resolution character varying(20),
    size_multiplier numeric(5,3),
    suppression_reason text,
    touch_quality character varying(20),
    touch_quality_vol_z numeric,
    origin_status character varying(12),
    is_rth boolean,
    runner_trail_width numeric,
    breakeven_armed_at timestamp without time zone,
    runner_peak_price numeric,
    runner_trail_price numeric,
    confluence_levels_at_detection text[],
    exhaustion_signal_at_detection boolean,
    bar6_checkpoint character varying(20),
    bar6_exit_recommended boolean,
    extend_target_level numeric,
    extend_decision character varying(20),
    delta_confirmation_state character varying(20),
    cluster_attributed_setups text[],
    hivol_lopace_at_detection boolean,
    regime_pos_10d numeric(8,4),
    regime_label_10d character varying(4),
    regime_pos_20d numeric(8,4),
    regime_label_20d character varying(4),
    regime_pos_30d numeric(8,4),
    regime_label_30d character varying(4),
    regime_pos_45d numeric(8,4),
    regime_label_45d character varying(4),
    regime_pos_60d numeric(8,4),
    regime_label_60d character varying(4),
    regime_pos_90d numeric(8,4),
    regime_label_90d character varying(4),
    regime_pos_180d numeric(8,4),
    regime_label_180d character varying(4),
    va_width_pctile_60d numeric,
    va_overlap_streak integer,
    ib_range_pctile_60d numeric,
    fired_status character varying(10),
    selected_over text[],
    day_type_at_fire character varying(20),
    vol_bucket_at_fire character varying(12),
    session character varying(8),
    minutes_from_open integer,
    bet_class character varying(24)
);


--
-- Name: active_setups_top8_window_backup_20260714; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.active_setups_top8_window_backup_20260714 (
    id integer,
    trade_date date,
    setup_type character varying(60),
    fired_at timestamp without time zone,
    expires_at timestamp without time zone,
    resolved_at timestamp without time zone,
    status character varying(10),
    resolution character varying(20),
    entry_zone_low numeric,
    entry_zone_high numeric,
    stop_level numeric,
    t1_level numeric,
    t1_label character varying(100),
    structural_level_touched numeric,
    structural_level_type character varying(60),
    price_at_detection numeric,
    price_at_resolution numeric,
    historical_win_rate numeric,
    historical_sessions integer,
    historical_avg_pnl numeric,
    historical_t1_hit_rate numeric,
    historical_source character varying(20),
    nl30_at_detection integer,
    structural_state_at_detection character varying(60),
    confluence_score_at_detection integer,
    actual_outcome character varying(20),
    actual_pnl numeric,
    created_at timestamp without time zone,
    updated_at timestamp without time zone,
    invalidation_timing character varying(20),
    resolution_method character varying(20),
    overnight_bias character varying(20),
    mae_points numeric,
    mfe_points numeric,
    bars_to_resolution integer,
    resolution_bar_time timestamp without time zone,
    replay_resolution character varying(20),
    size_multiplier numeric(5,3),
    suppression_reason text
);


--
-- Name: active_setups_unified_levels_backup_20260718; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.active_setups_unified_levels_backup_20260718 (
    id integer,
    trade_date date,
    setup_type character varying(60),
    fired_at timestamp without time zone,
    expires_at timestamp without time zone,
    resolved_at timestamp without time zone,
    status character varying(10),
    resolution character varying(20),
    entry_zone_low numeric,
    entry_zone_high numeric,
    stop_level numeric,
    t1_level numeric,
    t1_label character varying(100),
    structural_level_touched numeric,
    structural_level_type character varying(60),
    price_at_detection numeric,
    price_at_resolution numeric,
    historical_win_rate numeric,
    historical_sessions integer,
    historical_avg_pnl numeric,
    historical_t1_hit_rate numeric,
    historical_source character varying(20),
    nl30_at_detection integer,
    structural_state_at_detection character varying(60),
    confluence_score_at_detection integer,
    actual_outcome character varying(20),
    actual_pnl numeric,
    created_at timestamp without time zone,
    updated_at timestamp without time zone,
    invalidation_timing character varying(20),
    resolution_method character varying(20),
    overnight_bias character varying(20),
    mae_points numeric,
    mfe_points numeric,
    bars_to_resolution integer,
    resolution_bar_time timestamp without time zone,
    replay_resolution character varying(20),
    size_multiplier numeric(5,3),
    suppression_reason text,
    touch_quality character varying(20),
    touch_quality_vol_z numeric,
    origin_status character varying(12),
    is_rth boolean,
    runner_trail_width numeric,
    breakeven_armed_at timestamp without time zone,
    runner_peak_price numeric,
    runner_trail_price numeric,
    confluence_levels_at_detection text[],
    exhaustion_signal_at_detection boolean,
    bar6_checkpoint character varying(20),
    bar6_exit_recommended boolean
);


--
-- Name: active_setups_vwap_magnet_backfill_backup_20260728; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.active_setups_vwap_magnet_backfill_backup_20260728 (
    id integer,
    trade_date date,
    setup_type character varying(60),
    fired_at timestamp without time zone,
    expires_at timestamp without time zone,
    resolved_at timestamp without time zone,
    status character varying(10),
    resolution character varying(20),
    entry_zone_low numeric,
    entry_zone_high numeric,
    stop_level numeric,
    t1_level numeric,
    t1_label character varying(100),
    structural_level_touched numeric,
    structural_level_type character varying(60),
    price_at_detection numeric,
    price_at_resolution numeric,
    historical_win_rate numeric,
    historical_sessions integer,
    historical_avg_pnl numeric,
    historical_t1_hit_rate numeric,
    historical_source character varying(20),
    nl30_at_detection integer,
    structural_state_at_detection character varying(60),
    confluence_score_at_detection integer,
    actual_outcome character varying(20),
    actual_pnl numeric,
    created_at timestamp without time zone,
    updated_at timestamp without time zone,
    invalidation_timing character varying(20),
    resolution_method character varying(20),
    overnight_bias character varying(20),
    mae_points numeric,
    mfe_points numeric,
    bars_to_resolution integer,
    resolution_bar_time timestamp without time zone,
    replay_resolution character varying(20),
    size_multiplier numeric(5,3),
    suppression_reason text,
    touch_quality character varying(20),
    touch_quality_vol_z numeric,
    origin_status character varying(12),
    is_rth boolean,
    runner_trail_width numeric,
    breakeven_armed_at timestamp without time zone,
    runner_peak_price numeric,
    runner_trail_price numeric,
    confluence_levels_at_detection text[],
    exhaustion_signal_at_detection boolean,
    bar6_checkpoint character varying(20),
    bar6_exit_recommended boolean,
    extend_target_level numeric,
    extend_decision character varying(20),
    delta_confirmation_state character varying(20)
);


--
-- Name: active_setups_weeklyvwap_window_backup_20260714; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.active_setups_weeklyvwap_window_backup_20260714 (
    id integer,
    trade_date date,
    setup_type character varying(60),
    fired_at timestamp without time zone,
    expires_at timestamp without time zone,
    resolved_at timestamp without time zone,
    status character varying(10),
    resolution character varying(20),
    entry_zone_low numeric,
    entry_zone_high numeric,
    stop_level numeric,
    t1_level numeric,
    t1_label character varying(100),
    structural_level_touched numeric,
    structural_level_type character varying(60),
    price_at_detection numeric,
    price_at_resolution numeric,
    historical_win_rate numeric,
    historical_sessions integer,
    historical_avg_pnl numeric,
    historical_t1_hit_rate numeric,
    historical_source character varying(20),
    nl30_at_detection integer,
    structural_state_at_detection character varying(60),
    confluence_score_at_detection integer,
    actual_outcome character varying(20),
    actual_pnl numeric,
    created_at timestamp without time zone,
    updated_at timestamp without time zone,
    invalidation_timing character varying(20),
    resolution_method character varying(20),
    overnight_bias character varying(20),
    mae_points numeric,
    mfe_points numeric,
    bars_to_resolution integer,
    resolution_bar_time timestamp without time zone,
    replay_resolution character varying(20),
    size_multiplier numeric(5,3),
    suppression_reason text
);


--
-- Name: active_setups_widertarget_4thsite_backfill_backup_20260818; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.active_setups_widertarget_4thsite_backfill_backup_20260818 (
    id integer,
    trade_date date,
    setup_type character varying(60),
    fired_at timestamp without time zone,
    expires_at timestamp without time zone,
    resolved_at timestamp without time zone,
    status character varying(10),
    resolution character varying(20),
    entry_zone_low numeric,
    entry_zone_high numeric,
    stop_level numeric,
    t1_level numeric,
    t1_label character varying(100),
    structural_level_touched numeric,
    structural_level_type character varying(60),
    price_at_detection numeric,
    price_at_resolution numeric,
    historical_win_rate numeric,
    historical_sessions integer,
    historical_avg_pnl numeric,
    historical_t1_hit_rate numeric,
    historical_source character varying(20),
    nl30_at_detection integer,
    structural_state_at_detection character varying(60),
    confluence_score_at_detection integer,
    actual_outcome character varying(20),
    actual_pnl numeric,
    created_at timestamp without time zone,
    updated_at timestamp without time zone,
    invalidation_timing character varying(20),
    resolution_method character varying(20),
    overnight_bias character varying(20),
    mae_points numeric,
    mfe_points numeric,
    bars_to_resolution integer,
    resolution_bar_time timestamp without time zone,
    replay_resolution character varying(20),
    size_multiplier numeric(5,3),
    suppression_reason text,
    touch_quality character varying(20),
    touch_quality_vol_z numeric,
    origin_status character varying(12),
    is_rth boolean,
    runner_trail_width numeric,
    breakeven_armed_at timestamp without time zone,
    runner_peak_price numeric,
    runner_trail_price numeric,
    confluence_levels_at_detection text[],
    exhaustion_signal_at_detection boolean,
    bar6_checkpoint character varying(20),
    bar6_exit_recommended boolean,
    extend_target_level numeric,
    extend_decision character varying(20),
    delta_confirmation_state character varying(20),
    cluster_attributed_setups text[],
    hivol_lopace_at_detection boolean,
    regime_pos_10d numeric(8,4),
    regime_label_10d character varying(4),
    regime_pos_20d numeric(8,4),
    regime_label_20d character varying(4),
    regime_pos_30d numeric(8,4),
    regime_label_30d character varying(4),
    regime_pos_45d numeric(8,4),
    regime_label_45d character varying(4),
    regime_pos_60d numeric(8,4),
    regime_label_60d character varying(4),
    regime_pos_90d numeric(8,4),
    regime_label_90d character varying(4),
    regime_pos_180d numeric(8,4),
    regime_label_180d character varying(4),
    va_width_pctile_60d numeric,
    va_overlap_streak integer,
    ib_range_pctile_60d numeric,
    fired_status character varying(10),
    selected_over text[],
    day_type_at_fire character varying(20),
    vol_bucket_at_fire character varying(12),
    session character varying(8),
    minutes_from_open integer,
    bet_class character varying(24),
    wider_target_mult numeric
);


--
-- Name: ai_cost_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_cost_log (
    id integer NOT NULL,
    logged_at timestamp with time zone DEFAULT now() NOT NULL,
    call_type character varying(40) NOT NULL,
    model character varying(60),
    input_tokens integer,
    output_tokens integer,
    cost_usd numeric(8,5) NOT NULL,
    session_date date,
    reference_id integer
);


--
-- Name: ai_cost_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.ai_cost_log_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: ai_cost_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.ai_cost_log_id_seq OWNED BY public.ai_cost_log.id;


--
-- Name: auction_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auction_history (
    id integer NOT NULL,
    date date NOT NULL,
    prior_day text,
    prior_profile text,
    nl_trend text,
    nl30 integer,
    inv text,
    val_pos text,
    or_cond text,
    bias_dir text,
    conflict boolean,
    outcome text,
    actual_dir text,
    acd_score integer,
    pts_vs_open integer,
    or_high numeric,
    or_low numeric,
    a_up_level numeric,
    a_down_level numeric,
    a_up_fired boolean,
    a_down_fired boolean,
    prior_vah numeric,
    prior_val numeric,
    prior_poc numeric,
    session_high numeric,
    session_low numeric,
    session_close numeric,
    session_open numeric,
    pivot_bias text,
    bars jsonb,
    computed_at timestamp without time zone DEFAULT now()
);


--
-- Name: auction_history_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.auction_history_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: auction_history_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.auction_history_id_seq OWNED BY public.auction_history.id;


--
-- Name: auction_reads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auction_reads (
    id integer NOT NULL,
    trade_date date NOT NULL,
    overnight_inventory character varying(20),
    open_vs_prior_value character varying(20),
    prior_day_profile character varying(30),
    or_condition character varying(20),
    opening_call_type character varying(30),
    a_signal_override character varying(30),
    p3_value_migrating boolean,
    p3_vwap_holding boolean,
    p3_delta_confirming boolean,
    p3_auction_accepted boolean,
    p3_rotations_increasing boolean,
    updated_at timestamp without time zone DEFAULT now(),
    p1_updated_at timestamp with time zone,
    p2_updated_at timestamp with time zone,
    p3_updated_at timestamp with time zone,
    ts_overnight_inventory timestamp with time zone,
    ts_open_vs_prior_value timestamp with time zone,
    ts_prior_day_profile timestamp with time zone,
    ts_or_condition timestamp with time zone,
    ts_opening_call_type timestamp with time zone,
    ts_a_signal_override timestamp with time zone,
    ts_p3_value_migrating timestamp with time zone,
    ts_p3_vwap_holding timestamp with time zone,
    ts_p3_delta_confirming timestamp with time zone,
    ts_p3_auction_accepted timestamp with time zone,
    ts_p3_rotations_increasing timestamp with time zone
);


--
-- Name: auction_reads_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.auction_reads_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: auction_reads_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.auction_reads_id_seq OWNED BY public.auction_reads.id;


--
-- Name: combo_stats; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.combo_stats (
    combo_id text NOT NULL,
    label text NOT NULL,
    category text,
    tier integer,
    levels text[],
    n integer,
    win_count integer,
    avg_pnl numeric(10,2),
    win_rate numeric(5,2),
    prox_pts numeric(6,2),
    session_range_start date,
    session_range_end date,
    last_analyzed timestamp with time zone DEFAULT now()
);


--
-- Name: condition_memory; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.condition_memory (
    id integer NOT NULL,
    structural_state character varying(30) NOT NULL,
    nl30_bucket character varying(15) NOT NULL,
    opening_call character varying(30) NOT NULL,
    a_signal_quality character varying(20) NOT NULL,
    confluence_bucket character varying(15) NOT NULL,
    counter_trend boolean DEFAULT false NOT NULL,
    occurrences integer DEFAULT 0,
    wins integer DEFAULT 0,
    losses integer DEFAULT 0,
    breakeven integer DEFAULT 0,
    t1_hits integer DEFAULT 0,
    stops integer DEFAULT 0,
    total_pnl numeric DEFAULT 0,
    win_rate numeric,
    t1_hit_rate numeric,
    avg_pnl numeric,
    expectancy numeric,
    occurrences_last30 integer DEFAULT 0,
    wins_last30 integer DEFAULT 0,
    win_rate_last30 numeric,
    avg_pnl_last30 numeric,
    win_rate_trend character varying(12),
    sufficient_data boolean DEFAULT false,
    first_seen date,
    last_seen date,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: condition_memory_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.condition_memory_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: condition_memory_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.condition_memory_id_seq OWNED BY public.condition_memory.id;


--
-- Name: condition_memory_session_pnl_fix_backup_20260719; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.condition_memory_session_pnl_fix_backup_20260719 (
    id integer,
    structural_state character varying(30),
    nl30_bucket character varying(15),
    opening_call character varying(30),
    a_signal_quality character varying(20),
    confluence_bucket character varying(15),
    counter_trend boolean,
    occurrences integer,
    wins integer,
    losses integer,
    breakeven integer,
    t1_hits integer,
    stops integer,
    total_pnl numeric,
    win_rate numeric,
    t1_hit_rate numeric,
    avg_pnl numeric,
    expectancy numeric,
    occurrences_last30 integer,
    wins_last30 integer,
    win_rate_last30 numeric,
    avg_pnl_last30 numeric,
    win_rate_trend character varying(12),
    sufficient_data boolean,
    first_seen date,
    last_seen date,
    created_at timestamp without time zone,
    updated_at timestamp without time zone
);


--
-- Name: custom_field_definitions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.custom_field_definitions (
    id integer NOT NULL,
    field_name character varying(100) NOT NULL,
    field_type character varying(50) NOT NULL,
    field_category character varying(50) NOT NULL,
    options jsonb,
    is_required boolean DEFAULT false,
    display_order integer,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT custom_field_definitions_field_category_check CHECK (((field_category)::text = ANY ((ARRAY['trade'::character varying, 'daily_log'::character varying])::text[]))),
    CONSTRAINT custom_field_definitions_field_type_check CHECK (((field_type)::text = ANY ((ARRAY['text'::character varying, 'number'::character varying, 'select'::character varying, 'date'::character varying, 'textarea'::character varying, 'checkbox'::character varying])::text[])))
);


--
-- Name: custom_field_definitions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.custom_field_definitions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: custom_field_definitions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.custom_field_definitions_id_seq OWNED BY public.custom_field_definitions.id;


--
-- Name: daily_ai_reviews; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.daily_ai_reviews (
    id integer NOT NULL,
    review_date date NOT NULL,
    generated_at timestamp with time zone DEFAULT now() NOT NULL,
    setups_reviewed jsonb,
    ai_response text NOT NULL,
    flags jsonb,
    stop_target_analysis jsonb,
    data_requests jsonb,
    augmented_response text,
    input_tokens integer,
    output_tokens integer,
    cost_usd numeric(8,5),
    model character varying(60),
    total_cost_usd numeric(8,5)
);


--
-- Name: daily_ai_reviews_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.daily_ai_reviews_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: daily_ai_reviews_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.daily_ai_reviews_id_seq OWNED BY public.daily_ai_reviews.id;


--
-- Name: daily_charts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.daily_charts (
    log_date date NOT NULL,
    image_path text NOT NULL,
    chart_type text DEFAULT 'daily'::text,
    analysis text,
    analyzed_at timestamp with time zone,
    api_calls integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT now(),
    chart_start text,
    chart_end text,
    chart_price_low numeric,
    chart_price_high numeric
);


--
-- Name: daily_coaching; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.daily_coaching (
    id integer NOT NULL,
    session_date date NOT NULL,
    trades_count integer,
    session_pnl numeric,
    largest_missed_profit numeric,
    raw_context jsonb,
    coaching_text text,
    coaching_read boolean DEFAULT false,
    created_at timestamp without time zone DEFAULT now(),
    peak_pnl numeric,
    give_back numeric
);


--
-- Name: daily_coaching_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.daily_coaching_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: daily_coaching_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.daily_coaching_id_seq OWNED BY public.daily_coaching.id;


--
-- Name: daily_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.daily_logs (
    id integer NOT NULL,
    log_date date NOT NULL,
    sleep_quality character varying(20),
    mood character varying(50),
    market_condition character varying(50),
    pre_market_notes text,
    post_market_notes text,
    lessons_learned text,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: daily_logs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.daily_logs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: daily_logs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.daily_logs_id_seq OWNED BY public.daily_logs.id;


--
-- Name: trades; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.trades (
    id integer NOT NULL,
    log_date date NOT NULL,
    entry_time timestamp without time zone NOT NULL,
    exit_time timestamp without time zone,
    symbol character varying(20) NOT NULL,
    direction character varying(10) NOT NULL,
    quantity integer NOT NULL,
    entry_price numeric(10,2) NOT NULL,
    exit_price numeric(10,2),
    stop_loss numeric(10,2),
    target numeric(10,2),
    pnl numeric(10,2),
    fees numeric(10,2) DEFAULT 0,
    setup_type character varying(100),
    trade_notes text,
    mistakes text,
    emotional_state character varying(50),
    risk_reward_ratio numeric(5,2),
    tags text[],
    custom_fields jsonb,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    acd_signal character varying(20),
    acd_number_line_at_entry integer,
    acd_monthly_bias character varying(20),
    wyckoff_setup character varying(30),
    spring_volume_type character varying(10),
    support_resistance_level numeric,
    follow_through boolean,
    level_proximity jsonb,
    is_rth boolean GENERATED ALWAYS AS ((((EXTRACT(hour FROM ((entry_time AT TIME ZONE 'UTC'::text) AT TIME ZONE 'America/New_York'::text)) > (9)::numeric) OR ((EXTRACT(hour FROM ((entry_time AT TIME ZONE 'UTC'::text) AT TIME ZONE 'America/New_York'::text)) = (9)::numeric) AND (EXTRACT(minute FROM ((entry_time AT TIME ZONE 'UTC'::text) AT TIME ZONE 'America/New_York'::text)) >= (30)::numeric))) AND (EXTRACT(hour FROM ((entry_time AT TIME ZONE 'UTC'::text) AT TIME ZONE 'America/New_York'::text)) < (16)::numeric))) STORED,
    CONSTRAINT trades_direction_check CHECK (((direction)::text = ANY ((ARRAY['LONG'::character varying, 'SHORT'::character varying])::text[])))
);


--
-- Name: daily_performance; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.daily_performance AS
 SELECT log_date,
    count(*) AS total_trades,
    sum(
        CASE
            WHEN (pnl > (0)::numeric) THEN 1
            ELSE 0
        END) AS winning_trades,
    sum(
        CASE
            WHEN (pnl < (0)::numeric) THEN 1
            ELSE 0
        END) AS losing_trades,
    round(sum(pnl), 2) AS daily_pnl,
    round(avg(pnl), 2) AS avg_pnl_per_trade,
    round(max(pnl), 2) AS best_trade,
    round(min(pnl), 2) AS worst_trade,
    round((((sum(
        CASE
            WHEN (pnl > (0)::numeric) THEN 1
            ELSE 0
        END))::numeric / (count(*))::numeric) * (100)::numeric), 2) AS win_rate
   FROM public.trades t
  WHERE (exit_time IS NOT NULL)
  GROUP BY log_date
  ORDER BY log_date DESC;


--
-- Name: daily_performance_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.daily_performance_log (
    id integer NOT NULL,
    trade_date date NOT NULL,
    structural_state character varying(30),
    nl30_at_open integer,
    nl10_at_open integer,
    opening_call character varying(30),
    a_signal_direction character varying(20),
    a_signal_quality character varying(20),
    confluence_score_pre integer,
    confluence_score_peak integer,
    counter_trend boolean DEFAULT false,
    total_trades integer DEFAULT 0,
    winners integer DEFAULT 0,
    losers integer DEFAULT 0,
    breakeven integer DEFAULT 0,
    session_pnl numeric DEFAULT 0,
    win_rate numeric,
    t1_hit boolean,
    stopped_out boolean,
    max_favorable numeric,
    max_adverse numeric,
    phase_change_alerts_count integer DEFAULT 0,
    phase_change_reversed integer DEFAULT 0,
    close_position character varying(10),
    value_migrated character varying(15),
    sufficient_session_data boolean DEFAULT false,
    notes text,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: daily_performance_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.daily_performance_log_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: daily_performance_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.daily_performance_log_id_seq OWNED BY public.daily_performance_log.id;


--
-- Name: daily_performance_log_session_pnl_fix_backup_20260719; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.daily_performance_log_session_pnl_fix_backup_20260719 (
    id integer,
    trade_date date,
    structural_state character varying(30),
    nl30_at_open integer,
    nl10_at_open integer,
    opening_call character varying(30),
    a_signal_direction character varying(20),
    a_signal_quality character varying(20),
    confluence_score_pre integer,
    confluence_score_peak integer,
    counter_trend boolean,
    total_trades integer,
    winners integer,
    losers integer,
    breakeven integer,
    session_pnl numeric,
    win_rate numeric,
    t1_hit boolean,
    stopped_out boolean,
    max_favorable numeric,
    max_adverse numeric,
    phase_change_alerts_count integer,
    phase_change_reversed integer,
    close_position character varying(10),
    value_migrated character varying(15),
    sufficient_session_data boolean,
    notes text,
    created_at timestamp without time zone,
    updated_at timestamp without time zone
);


--
-- Name: daytype_accuracy_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.daytype_accuracy_log (
    id integer NOT NULL,
    trade_date date NOT NULL,
    intraday_call text,
    eod_truth text,
    matched boolean,
    session_range numeric,
    close_pct numeric,
    trend_strength numeric,
    or_width numeric,
    nl30 numeric,
    logged_at timestamp with time zone DEFAULT now()
);


--
-- Name: daytype_accuracy_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.daytype_accuracy_log_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: daytype_accuracy_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.daytype_accuracy_log_id_seq OWNED BY public.daytype_accuracy_log.id;


--
-- Name: developing_value_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.developing_value_log (
    id integer NOT NULL,
    trade_date date NOT NULL,
    poc numeric(10,2),
    vah numeric(10,2),
    val numeric(10,2),
    session_high numeric(10,2),
    session_low numeric(10,2),
    session_close numeric(10,2),
    poc_delta_vs_prior numeric(10,2),
    va_overlap_pct_vs_prior numeric(6,4),
    migration_dir_vs_prior text,
    hold_or_reject_vs_prior text,
    computed_at timestamp without time zone DEFAULT now()
);


--
-- Name: developing_value_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.developing_value_log_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: developing_value_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.developing_value_log_id_seq OWNED BY public.developing_value_log.id;


--
-- Name: dll_daily_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dll_daily_events (
    account_id text NOT NULL,
    log_date date NOT NULL,
    daily_pnl numeric NOT NULL,
    daily_loss_limit numeric NOT NULL,
    event_type text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT dll_daily_events_event_type_check CHECK ((event_type = ANY (ARRAY['WARNING'::text, 'BREACH'::text])))
);


--
-- Name: dynamic_edges_mining; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dynamic_edges_mining (
    id integer NOT NULL,
    setup_type text NOT NULL,
    dimension text NOT NULL,
    segment text NOT NULL,
    tested_n integer NOT NULL,
    wins integer NOT NULL,
    win_rate numeric(5,2) NOT NULL,
    baseline_n integer NOT NULL,
    baseline_win_rate numeric(5,2) NOT NULL,
    deviation numeric(5,2) NOT NULL,
    z_score numeric(5,2) NOT NULL,
    p_value numeric(5,4) NOT NULL,
    status text NOT NULL,
    updated_at timestamp with time zone DEFAULT now(),
    run_date date NOT NULL
);


--
-- Name: dynamic_edges_mining_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.dynamic_edges_mining_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: dynamic_edges_mining_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.dynamic_edges_mining_id_seq OWNED BY public.dynamic_edges_mining.id;


--
-- Name: engine_reads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.engine_reads (
    id integer NOT NULL,
    trade_date date NOT NULL,
    read_type character varying(30) NOT NULL,
    signal_value character varying(30) NOT NULL,
    session_bias_context character varying(10),
    nl30 integer,
    or_cond character varying(20),
    predicted_direction character varying(10),
    outcome character varying(20),
    pts_vs_open integer,
    outcome_detail text,
    evaluated_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: engine_reads_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.engine_reads_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: engine_reads_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.engine_reads_id_seq OWNED BY public.engine_reads.id;


--
-- Name: gated_candidates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gated_candidates (
    id bigint NOT NULL,
    evaluated_at timestamp without time zone DEFAULT now() NOT NULL,
    trade_date date NOT NULL,
    setup_type character varying(60) NOT NULL,
    gate_name character varying(60) NOT NULL,
    gate_reason text,
    would_have_entry numeric,
    would_have_stop numeric,
    would_have_target numeric,
    bet_class character varying(24)
);


--
-- Name: gated_candidates_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.gated_candidates_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: gated_candidates_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.gated_candidates_id_seq OWNED BY public.gated_candidates.id;


--
-- Name: import_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.import_log (
    id integer NOT NULL,
    import_time timestamp without time zone DEFAULT now() NOT NULL,
    file_used character varying(255),
    imported integer DEFAULT 0,
    skipped integer DEFAULT 0,
    errors integer DEFAULT 0,
    trigger character varying(20),
    notes text
);


--
-- Name: import_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.import_log_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: import_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.import_log_id_seq OWNED BY public.import_log.id;


--
-- Name: learning_digest_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.learning_digest_events (
    id integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    event_type character varying(30) NOT NULL,
    signal_name character varying(100) NOT NULL,
    old_value text,
    new_value text,
    description text NOT NULL,
    magnitude numeric,
    shown boolean DEFAULT false NOT NULL
);


--
-- Name: learning_digest_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.learning_digest_events_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: learning_digest_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.learning_digest_events_id_seq OWNED BY public.learning_digest_events.id;


--
-- Name: level_prices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.level_prices (
    trade_date date NOT NULL,
    level_name text NOT NULL,
    price numeric(12,4),
    category text,
    computed_at timestamp with time zone DEFAULT now()
);


--
-- Name: level_prices_3m_va_lookahead_backup_20260719; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.level_prices_3m_va_lookahead_backup_20260719 (
    trade_date date,
    level_name text,
    price numeric(12,4),
    category text,
    computed_at timestamp with time zone
);


--
-- Name: level_prices_ib_backup_20260714; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.level_prices_ib_backup_20260714 (
    trade_date date,
    level_name text,
    price numeric(12,4),
    category text,
    computed_at timestamp with time zone
);


--
-- Name: level_prices_or_rename_backup_20260812; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.level_prices_or_rename_backup_20260812 (
    trade_date date,
    level_name text,
    price numeric(12,4),
    category text,
    computed_at timestamp with time zone
);


--
-- Name: level_prices_va_bucketing_backup_20260717; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.level_prices_va_bucketing_backup_20260717 (
    trade_date date,
    level_name text,
    price numeric(12,4),
    category text,
    computed_at timestamp with time zone
);


--
-- Name: level_prices_weekly_open_backup_20260720; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.level_prices_weekly_open_backup_20260720 (
    trade_date date,
    level_name text,
    price numeric(12,4),
    category text,
    computed_at timestamp with time zone
);


--
-- Name: level_prices_weeklyvwap_backup_20260714; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.level_prices_weeklyvwap_backup_20260714 (
    trade_date date,
    level_name text,
    price numeric(12,4),
    category text,
    computed_at timestamp with time zone
);


--
-- Name: level_regime_performance; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.level_regime_performance (
    id integer NOT NULL,
    level_name character varying(30),
    vol_regime character varying(15),
    dir_regime character varying(15),
    range_regime character varying(15),
    sample_size integer,
    win_rate numeric,
    ev_per_trade numeric,
    avg_mfe numeric,
    avg_mae numeric,
    vs_overall character varying(15),
    last_computed date DEFAULT CURRENT_DATE
);


--
-- Name: level_regime_performance_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.level_regime_performance_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: level_regime_performance_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.level_regime_performance_id_seq OWNED BY public.level_regime_performance.id;


--
-- Name: live_reads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.live_reads (
    id integer NOT NULL,
    trade_date date NOT NULL,
    logged_at timestamp with time zone DEFAULT now() NOT NULL,
    direction text NOT NULL,
    entry_price numeric(10,2) NOT NULL,
    note text,
    exit_price numeric(10,2),
    actual_pnl numeric(10,2),
    nearest_level_name text,
    nearest_level_value numeric(10,2),
    nearest_level_dist integer,
    bar_body_pct integer,
    bar_dir text,
    et_min integer,
    day_type text,
    cum_delta_at_entry integer,
    attributed_setups text[],
    outcome text,
    pnl_pts numeric(8,2),
    CONSTRAINT live_reads_direction_check CHECK ((direction = ANY (ARRAY['LONG'::text, 'SHORT'::text]))),
    CONSTRAINT live_reads_outcome_check CHECK ((outcome = ANY (ARRAY['WIN'::text, 'LOSS'::text, 'SCRATCH'::text, 'OPEN'::text])))
);


--
-- Name: live_reads_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.live_reads_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: live_reads_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.live_reads_id_seq OWNED BY public.live_reads.id;


--
-- Name: macro_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.macro_events (
    id integer NOT NULL,
    event_date date NOT NULL,
    event_type character varying(50) NOT NULL,
    event_time time without time zone,
    impact_level character varying(20) DEFAULT 'HIGH'::character varying,
    notes text,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: macro_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.macro_events_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: macro_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.macro_events_id_seq OWNED BY public.macro_events.id;


--
-- Name: monte_carlo_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.monte_carlo_runs (
    id integer NOT NULL,
    run_date timestamp with time zone DEFAULT now(),
    name text,
    config jsonb NOT NULL,
    results jsonb NOT NULL,
    summary jsonb NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: monte_carlo_runs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.monte_carlo_runs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: monte_carlo_runs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.monte_carlo_runs_id_seq OWNED BY public.monte_carlo_runs.id;


--
-- Name: morning_briefs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.morning_briefs (
    id integer NOT NULL,
    brief_date date NOT NULL,
    brief_text text,
    structural_data jsonb,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: morning_briefs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.morning_briefs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: morning_briefs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.morning_briefs_id_seq OWNED BY public.morning_briefs.id;


--
-- Name: optimal_stop_circuit_breaker_backup_20260804; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.optimal_stop_circuit_breaker_backup_20260804 (
    id integer,
    run_date date,
    window_days integer,
    signal_type character varying(30),
    signal_name character varying(60),
    sample_size integer,
    win_rate numeric,
    ev_per_trade numeric,
    total_pnl numeric,
    avg_mfe numeric,
    p50_mfe numeric,
    p75_mfe numeric,
    avg_mae numeric,
    p50_mae numeric,
    p75_mae numeric,
    p90_mae numeric,
    avg_duration_min numeric,
    current_stop numeric,
    current_target numeric,
    optimal_stop numeric,
    optimal_target numeric,
    optimal_ev numeric,
    stop_blowthrough_pct numeric,
    t1_overshoot_avg numeric,
    mfe_range_pct numeric,
    mae_range_pct numeric,
    recommendation character varying(20),
    notes text,
    created_at timestamp without time zone
);


--
-- Name: optimal_stop_noise_floor_revert_backup_20260805; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.optimal_stop_noise_floor_revert_backup_20260805 (
    id integer,
    run_date date,
    window_days integer,
    signal_type character varying(30),
    signal_name character varying(60),
    sample_size integer,
    win_rate numeric,
    ev_per_trade numeric,
    total_pnl numeric,
    avg_mfe numeric,
    p50_mfe numeric,
    p75_mfe numeric,
    avg_mae numeric,
    p50_mae numeric,
    p75_mae numeric,
    p90_mae numeric,
    avg_duration_min numeric,
    current_stop numeric,
    current_target numeric,
    optimal_stop numeric,
    optimal_target numeric,
    optimal_ev numeric,
    stop_blowthrough_pct numeric,
    t1_overshoot_avg numeric,
    mfe_range_pct numeric,
    mae_range_pct numeric,
    recommendation character varying(20),
    notes text,
    created_at timestamp without time zone
);


--
-- Name: optimal_stop_noise_floor_revert_backup_20260809; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.optimal_stop_noise_floor_revert_backup_20260809 (
    id integer,
    run_date date,
    window_days integer,
    signal_type character varying(30),
    signal_name character varying(60),
    sample_size integer,
    win_rate numeric,
    ev_per_trade numeric,
    total_pnl numeric,
    avg_mfe numeric,
    p50_mfe numeric,
    p75_mfe numeric,
    avg_mae numeric,
    p50_mae numeric,
    p75_mae numeric,
    p90_mae numeric,
    avg_duration_min numeric,
    current_stop numeric,
    current_target numeric,
    optimal_stop numeric,
    optimal_target numeric,
    optimal_ev numeric,
    stop_blowthrough_pct numeric,
    t1_overshoot_avg numeric,
    mfe_range_pct numeric,
    mae_range_pct numeric,
    recommendation character varying(20),
    notes text,
    created_at timestamp without time zone
);


--
-- Name: optimal_stop_rebaseline_after_backup_20260809; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.optimal_stop_rebaseline_after_backup_20260809 (
    id integer,
    run_date date,
    window_days integer,
    signal_type character varying(30),
    signal_name character varying(60),
    sample_size integer,
    win_rate numeric,
    ev_per_trade numeric,
    total_pnl numeric,
    avg_mfe numeric,
    p50_mfe numeric,
    p75_mfe numeric,
    avg_mae numeric,
    p50_mae numeric,
    p75_mae numeric,
    p90_mae numeric,
    avg_duration_min numeric,
    current_stop numeric,
    current_target numeric,
    optimal_stop numeric,
    optimal_target numeric,
    optimal_ev numeric,
    stop_blowthrough_pct numeric,
    t1_overshoot_avg numeric,
    mfe_range_pct numeric,
    mae_range_pct numeric,
    recommendation character varying(20),
    notes text,
    created_at timestamp without time zone
);


--
-- Name: optimal_stop_rebaseline_backup_20260809; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.optimal_stop_rebaseline_backup_20260809 (
    id integer,
    run_date date,
    window_days integer,
    signal_type character varying(30),
    signal_name character varying(60),
    sample_size integer,
    win_rate numeric,
    ev_per_trade numeric,
    total_pnl numeric,
    avg_mfe numeric,
    p50_mfe numeric,
    p75_mfe numeric,
    avg_mae numeric,
    p50_mae numeric,
    p75_mae numeric,
    p90_mae numeric,
    avg_duration_min numeric,
    current_stop numeric,
    current_target numeric,
    optimal_stop numeric,
    optimal_target numeric,
    optimal_ev numeric,
    stop_blowthrough_pct numeric,
    t1_overshoot_avg numeric,
    mfe_range_pct numeric,
    mae_range_pct numeric,
    recommendation character varying(20),
    notes text,
    created_at timestamp without time zone
);


--
-- Name: pattern_discoveries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pattern_discoveries (
    id integer NOT NULL,
    pattern_key character varying(100) NOT NULL,
    dimension character varying(50) NOT NULL,
    win_rate double precision NOT NULL,
    sample_size integer NOT NULL,
    net_pnl_dollars double precision,
    first_seen date NOT NULL,
    last_updated date NOT NULL,
    status character varying(20) DEFAULT 'ACTIVE'::character varying,
    notified boolean DEFAULT false,
    context jsonb DEFAULT '{}'::jsonb,
    window_type character varying(20) DEFAULT 'ROLLING_90D'::character varying,
    win_rate_at_first_seen double precision,
    sample_size_at_first_seen integer,
    net_pnl_at_first_seen double precision,
    degraded_on date
);


--
-- Name: pattern_discoveries_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.pattern_discoveries_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: pattern_discoveries_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.pattern_discoveries_id_seq OWNED BY public.pattern_discoveries.id;


--
-- Name: pattern_stats; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pattern_stats (
    id integer NOT NULL,
    calculated_date date NOT NULL,
    lookback_days integer NOT NULL,
    structural_state character varying(30) NOT NULL,
    total_sessions integer DEFAULT 0,
    avg_win_rate numeric,
    avg_pnl_per_session numeric,
    t1_hit_rate numeric,
    stop_rate numeric,
    total_pnl numeric,
    best_confluence_threshold integer,
    win_rate_above_threshold numeric,
    win_rate_below_threshold numeric,
    phase_change_reversal_rate numeric,
    phase_change_avg_magnitude numeric,
    phase_change_events integer DEFAULT 0,
    win_rate_prior_window numeric,
    win_rate_trend character varying(12),
    degrading_alert boolean DEFAULT false,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: pattern_stats_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.pattern_stats_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: pattern_stats_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.pattern_stats_id_seq OWNED BY public.pattern_stats.id;


--
-- Name: pattern_stats_session_pnl_fix_backup_20260719; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pattern_stats_session_pnl_fix_backup_20260719 (
    id integer,
    calculated_date date,
    lookback_days integer,
    structural_state character varying(30),
    total_sessions integer,
    avg_win_rate numeric,
    avg_pnl_per_session numeric,
    t1_hit_rate numeric,
    stop_rate numeric,
    total_pnl numeric,
    best_confluence_threshold integer,
    win_rate_above_threshold numeric,
    win_rate_below_threshold numeric,
    phase_change_reversal_rate numeric,
    phase_change_avg_magnitude numeric,
    phase_change_events integer,
    win_rate_prior_window numeric,
    win_rate_trend character varying(12),
    degrading_alert boolean,
    created_at timestamp without time zone
);


--
-- Name: performance_audit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.performance_audit (
    id integer NOT NULL,
    run_date date DEFAULT CURRENT_DATE NOT NULL,
    window_days integer NOT NULL,
    signal_type character varying(30) NOT NULL,
    signal_name character varying(60) NOT NULL,
    sample_size integer,
    win_rate numeric,
    ev_per_trade numeric,
    total_pnl numeric,
    avg_mfe numeric,
    p50_mfe numeric,
    p75_mfe numeric,
    avg_mae numeric,
    p50_mae numeric,
    p75_mae numeric,
    p90_mae numeric,
    avg_duration_min numeric,
    current_stop numeric,
    current_target numeric,
    optimal_stop numeric,
    optimal_target numeric,
    optimal_ev numeric,
    stop_blowthrough_pct numeric,
    t1_overshoot_avg numeric,
    mfe_range_pct numeric,
    mae_range_pct numeric,
    recommendation character varying(20),
    notes text,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: performance_audit_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.performance_audit_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: performance_audit_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.performance_audit_id_seq OWNED BY public.performance_audit.id;


--
-- Name: performance_audit_optimal_stop_commission_fix_backup_20260719; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.performance_audit_optimal_stop_commission_fix_backup_20260719 (
    id integer,
    run_date date,
    window_days integer,
    signal_type character varying(20),
    signal_name character varying(60),
    sample_size integer,
    win_rate numeric,
    ev_per_trade numeric,
    total_pnl numeric,
    avg_mfe numeric,
    p50_mfe numeric,
    p75_mfe numeric,
    avg_mae numeric,
    p50_mae numeric,
    p75_mae numeric,
    p90_mae numeric,
    avg_duration_min numeric,
    current_stop numeric,
    current_target numeric,
    optimal_stop numeric,
    optimal_target numeric,
    optimal_ev numeric,
    stop_blowthrough_pct numeric,
    t1_overshoot_avg numeric,
    mfe_range_pct numeric,
    mae_range_pct numeric,
    recommendation character varying(20),
    notes text,
    created_at timestamp without time zone
);


--
-- Name: performance_audit_or_rename_backup_20260812; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.performance_audit_or_rename_backup_20260812 (
    id integer,
    run_date date,
    window_days integer,
    signal_type character varying(30),
    signal_name character varying(60),
    sample_size integer,
    win_rate numeric,
    ev_per_trade numeric,
    total_pnl numeric,
    avg_mfe numeric,
    p50_mfe numeric,
    p75_mfe numeric,
    avg_mae numeric,
    p50_mae numeric,
    p75_mae numeric,
    p90_mae numeric,
    avg_duration_min numeric,
    current_stop numeric,
    current_target numeric,
    optimal_stop numeric,
    optimal_target numeric,
    optimal_ev numeric,
    stop_blowthrough_pct numeric,
    t1_overshoot_avg numeric,
    mfe_range_pct numeric,
    mae_range_pct numeric,
    recommendation character varying(20),
    notes text,
    created_at timestamp without time zone
);


--
-- Name: phase_change_alerts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.phase_change_alerts (
    id integer NOT NULL,
    trade_date date DEFAULT CURRENT_DATE NOT NULL,
    alert_time timestamp without time zone DEFAULT now() NOT NULL,
    price_at_alert numeric,
    structural_level numeric,
    level_type character varying(30),
    distance_to_level numeric,
    near_structural_level boolean DEFAULT false,
    volume_declining boolean DEFAULT false,
    delta_diverging boolean DEFAULT false,
    range_compressing boolean DEFAULT false,
    profile_stopped boolean DEFAULT false,
    conditions_met integer DEFAULT 0,
    volume_source character varying(15) DEFAULT 'AUTO'::character varying,
    delta_source character varying(15) DEFAULT 'AUTO'::character varying,
    range_source character varying(15) DEFAULT 'AUTO'::character varying,
    profile_source character varying(15) DEFAULT 'AUTO'::character varying,
    volume_declining_override boolean,
    delta_diverging_override boolean,
    range_compressing_override boolean,
    profile_stopped_override boolean,
    prior_phase_direction character varying(20),
    bars_in_current_move integer,
    alert_acknowledged boolean DEFAULT false,
    acknowledged_at timestamp without time zone,
    outcome_15min numeric,
    outcome_30min numeric,
    outcome_60min numeric,
    did_reverse boolean,
    reversal_magnitude numeric,
    notes text,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: phase_change_alerts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.phase_change_alerts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: phase_change_alerts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.phase_change_alerts_id_seq OWNED BY public.phase_change_alerts.id;


--
-- Name: phase_change_backtest_results; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.phase_change_backtest_results (
    id integer NOT NULL,
    run_date timestamp without time zone DEFAULT now(),
    proximity_points integer DEFAULT 20,
    min_conditions integer DEFAULT 3,
    volume_lookback_bars integer DEFAULT 3,
    delta_lookback_bars integer DEFAULT 5,
    range_lookback_bars integer DEFAULT 3,
    profile_lookback_bars integer DEFAULT 10,
    forward_window_minutes integer DEFAULT 30,
    reversal_threshold_points integer DEFAULT 15,
    sessions_analyzed integer,
    total_bars_scanned integer,
    date_range_start date,
    date_range_end date,
    total_events integer,
    events_3_conditions integer,
    events_4_conditions integer,
    events_5_conditions integer,
    reversal_rate_3 numeric,
    reversal_rate_4 numeric,
    reversal_rate_5 numeric,
    avg_reversal_magnitude_3 numeric,
    avg_reversal_magnitude_4 numeric,
    avg_reversal_magnitude_5 numeric,
    best_level character varying(30),
    best_level_reversal_rate numeric,
    best_level_avg_magnitude numeric,
    best_level_event_count integer,
    results_by_level jsonb,
    results_by_combo jsonb,
    run_duration_seconds integer
);


--
-- Name: phase_change_backtest_results_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.phase_change_backtest_results_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: phase_change_backtest_results_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.phase_change_backtest_results_id_seq OWNED BY public.phase_change_backtest_results.id;


--
-- Name: playbook_conversations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.playbook_conversations (
    id integer NOT NULL,
    session_date date NOT NULL,
    triggered_at timestamp with time zone DEFAULT now() NOT NULL,
    intent character varying(10) NOT NULL,
    market_snapshot jsonb NOT NULL,
    user_prompt text NOT NULL,
    ai_response text NOT NULL,
    input_tokens integer,
    output_tokens integer,
    cost_usd numeric(8,5),
    model character varying(60),
    CONSTRAINT playbook_conversations_intent_check CHECK (((intent)::text = ANY ((ARRAY['LONG'::character varying, 'SHORT'::character varying, 'UNSURE'::character varying])::text[])))
);


--
-- Name: playbook_conversations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.playbook_conversations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: playbook_conversations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.playbook_conversations_id_seq OWNED BY public.playbook_conversations.id;


--
-- Name: post_loss_cooldowns; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.post_loss_cooldowns (
    id integer NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    end_time timestamp with time zone NOT NULL,
    dismissed_at timestamp with time zone
);


--
-- Name: post_loss_cooldowns_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.post_loss_cooldowns_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: post_loss_cooldowns_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.post_loss_cooldowns_id_seq OWNED BY public.post_loss_cooldowns.id;


--
-- Name: premarket_walkthroughs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.premarket_walkthroughs (
    id integer NOT NULL,
    trade_date date NOT NULL,
    regime text,
    overnight_read text,
    open_notes text,
    signals_notes text,
    layer1_lean text,
    layer2_lean text,
    layer3_lean text,
    layer4_lean text,
    committed_plan text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: premarket_walkthroughs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.premarket_walkthroughs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: premarket_walkthroughs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.premarket_walkthroughs_id_seq OWNED BY public.premarket_walkthroughs.id;


--
-- Name: price_bar_ingests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.price_bar_ingests (
    id integer NOT NULL,
    filename text NOT NULL,
    contract text NOT NULL,
    symbol text NOT NULL,
    bars_inserted integer DEFAULT 0 NOT NULL,
    date_from date,
    date_to date,
    ingested_at timestamp without time zone DEFAULT now() NOT NULL,
    file_size bigint
);


--
-- Name: price_bar_ingests_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.price_bar_ingests_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: price_bar_ingests_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.price_bar_ingests_id_seq OWNED BY public.price_bar_ingests.id;


--
-- Name: price_bars; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.price_bars (
    id bigint NOT NULL,
    symbol text NOT NULL,
    contract text NOT NULL,
    ts timestamp without time zone NOT NULL,
    open numeric(12,4) NOT NULL,
    high numeric(12,4) NOT NULL,
    low numeric(12,4) NOT NULL,
    close numeric(12,4) NOT NULL,
    volume integer DEFAULT 0 NOT NULL,
    num_trades integer DEFAULT 0 NOT NULL,
    bid_volume integer DEFAULT 0 NOT NULL,
    ask_volume integer DEFAULT 0 NOT NULL
)
PARTITION BY RANGE (ts);


--
-- Name: price_bars_new_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.price_bars_new_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: price_bars_new_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.price_bars_new_id_seq OWNED BY public.price_bars.id;


--
-- Name: price_bars_2022_12; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.price_bars_2022_12 (
    id bigint DEFAULT nextval('public.price_bars_new_id_seq'::regclass) NOT NULL,
    symbol text NOT NULL,
    contract text NOT NULL,
    ts timestamp without time zone NOT NULL,
    open numeric(12,4) NOT NULL,
    high numeric(12,4) NOT NULL,
    low numeric(12,4) NOT NULL,
    close numeric(12,4) NOT NULL,
    volume integer DEFAULT 0 NOT NULL,
    num_trades integer DEFAULT 0 NOT NULL,
    bid_volume integer DEFAULT 0 NOT NULL,
    ask_volume integer DEFAULT 0 NOT NULL
);


--
-- Name: price_bars_2023_01; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.price_bars_2023_01 (
    id bigint DEFAULT nextval('public.price_bars_new_id_seq'::regclass) NOT NULL,
    symbol text NOT NULL,
    contract text NOT NULL,
    ts timestamp without time zone NOT NULL,
    open numeric(12,4) NOT NULL,
    high numeric(12,4) NOT NULL,
    low numeric(12,4) NOT NULL,
    close numeric(12,4) NOT NULL,
    volume integer DEFAULT 0 NOT NULL,
    num_trades integer DEFAULT 0 NOT NULL,
    bid_volume integer DEFAULT 0 NOT NULL,
    ask_volume integer DEFAULT 0 NOT NULL
);


--
-- Name: price_bars_2023_02; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.price_bars_2023_02 (
    id bigint DEFAULT nextval('public.price_bars_new_id_seq'::regclass) NOT NULL,
    symbol text NOT NULL,
    contract text NOT NULL,
    ts timestamp without time zone NOT NULL,
    open numeric(12,4) NOT NULL,
    high numeric(12,4) NOT NULL,
    low numeric(12,4) NOT NULL,
    close numeric(12,4) NOT NULL,
    volume integer DEFAULT 0 NOT NULL,
    num_trades integer DEFAULT 0 NOT NULL,
    bid_volume integer DEFAULT 0 NOT NULL,
    ask_volume integer DEFAULT 0 NOT NULL
);


--
-- Name: price_bars_2023_03; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.price_bars_2023_03 (
    id bigint DEFAULT nextval('public.price_bars_new_id_seq'::regclass) NOT NULL,
    symbol text NOT NULL,
    contract text NOT NULL,
    ts timestamp without time zone NOT NULL,
    open numeric(12,4) NOT NULL,
    high numeric(12,4) NOT NULL,
    low numeric(12,4) NOT NULL,
    close numeric(12,4) NOT NULL,
    volume integer DEFAULT 0 NOT NULL,
    num_trades integer DEFAULT 0 NOT NULL,
    bid_volume integer DEFAULT 0 NOT NULL,
    ask_volume integer DEFAULT 0 NOT NULL
);


--
-- Name: price_bars_2023_04; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.price_bars_2023_04 (
    id bigint DEFAULT nextval('public.price_bars_new_id_seq'::regclass) NOT NULL,
    symbol text NOT NULL,
    contract text NOT NULL,
    ts timestamp without time zone NOT NULL,
    open numeric(12,4) NOT NULL,
    high numeric(12,4) NOT NULL,
    low numeric(12,4) NOT NULL,
    close numeric(12,4) NOT NULL,
    volume integer DEFAULT 0 NOT NULL,
    num_trades integer DEFAULT 0 NOT NULL,
    bid_volume integer DEFAULT 0 NOT NULL,
    ask_volume integer DEFAULT 0 NOT NULL
);


--
-- Name: price_bars_2023_05; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.price_bars_2023_05 (
    id bigint DEFAULT nextval('public.price_bars_new_id_seq'::regclass) NOT NULL,
    symbol text NOT NULL,
    contract text NOT NULL,
    ts timestamp without time zone NOT NULL,
    open numeric(12,4) NOT NULL,
    high numeric(12,4) NOT NULL,
    low numeric(12,4) NOT NULL,
    close numeric(12,4) NOT NULL,
    volume integer DEFAULT 0 NOT NULL,
    num_trades integer DEFAULT 0 NOT NULL,
    bid_volume integer DEFAULT 0 NOT NULL,
    ask_volume integer DEFAULT 0 NOT NULL
);


--
-- Name: price_bars_2023_06; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.price_bars_2023_06 (
    id bigint DEFAULT nextval('public.price_bars_new_id_seq'::regclass) NOT NULL,
    symbol text NOT NULL,
    contract text NOT NULL,
    ts timestamp without time zone NOT NULL,
    open numeric(12,4) NOT NULL,
    high numeric(12,4) NOT NULL,
    low numeric(12,4) NOT NULL,
    close numeric(12,4) NOT NULL,
    volume integer DEFAULT 0 NOT NULL,
    num_trades integer DEFAULT 0 NOT NULL,
    bid_volume integer DEFAULT 0 NOT NULL,
    ask_volume integer DEFAULT 0 NOT NULL
);


--
-- Name: price_bars_2023_07; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.price_bars_2023_07 (
    id bigint DEFAULT nextval('public.price_bars_new_id_seq'::regclass) NOT NULL,
    symbol text NOT NULL,
    contract text NOT NULL,
    ts timestamp without time zone NOT NULL,
    open numeric(12,4) NOT NULL,
    high numeric(12,4) NOT NULL,
    low numeric(12,4) NOT NULL,
    close numeric(12,4) NOT NULL,
    volume integer DEFAULT 0 NOT NULL,
    num_trades integer DEFAULT 0 NOT NULL,
    bid_volume integer DEFAULT 0 NOT NULL,
    ask_volume integer DEFAULT 0 NOT NULL
);


--
-- Name: price_bars_2023_08; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.price_bars_2023_08 (
    id bigint DEFAULT nextval('public.price_bars_new_id_seq'::regclass) NOT NULL,
    symbol text NOT NULL,
    contract text NOT NULL,
    ts timestamp without time zone NOT NULL,
    open numeric(12,4) NOT NULL,
    high numeric(12,4) NOT NULL,
    low numeric(12,4) NOT NULL,
    close numeric(12,4) NOT NULL,
    volume integer DEFAULT 0 NOT NULL,
    num_trades integer DEFAULT 0 NOT NULL,
    bid_volume integer DEFAULT 0 NOT NULL,
    ask_volume integer DEFAULT 0 NOT NULL
);


--
-- Name: price_bars_2023_09; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.price_bars_2023_09 (
    id bigint DEFAULT nextval('public.price_bars_new_id_seq'::regclass) NOT NULL,
    symbol text NOT NULL,
    contract text NOT NULL,
    ts timestamp without time zone NOT NULL,
    open numeric(12,4) NOT NULL,
    high numeric(12,4) NOT NULL,
    low numeric(12,4) NOT NULL,
    close numeric(12,4) NOT NULL,
    volume integer DEFAULT 0 NOT NULL,
    num_trades integer DEFAULT 0 NOT NULL,
    bid_volume integer DEFAULT 0 NOT NULL,
    ask_volume integer DEFAULT 0 NOT NULL
);


--
-- Name: price_bars_2023_10; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.price_bars_2023_10 (
    id bigint DEFAULT nextval('public.price_bars_new_id_seq'::regclass) NOT NULL,
    symbol text NOT NULL,
    contract text NOT NULL,
    ts timestamp without time zone NOT NULL,
    open numeric(12,4) NOT NULL,
    high numeric(12,4) NOT NULL,
    low numeric(12,4) NOT NULL,
    close numeric(12,4) NOT NULL,
    volume integer DEFAULT 0 NOT NULL,
    num_trades integer DEFAULT 0 NOT NULL,
    bid_volume integer DEFAULT 0 NOT NULL,
    ask_volume integer DEFAULT 0 NOT NULL
);


--
-- Name: price_bars_2023_11; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.price_bars_2023_11 (
    id bigint DEFAULT nextval('public.price_bars_new_id_seq'::regclass) NOT NULL,
    symbol text NOT NULL,
    contract text NOT NULL,
    ts timestamp without time zone NOT NULL,
    open numeric(12,4) NOT NULL,
    high numeric(12,4) NOT NULL,
    low numeric(12,4) NOT NULL,
    close numeric(12,4) NOT NULL,
    volume integer DEFAULT 0 NOT NULL,
    num_trades integer DEFAULT 0 NOT NULL,
    bid_volume integer DEFAULT 0 NOT NULL,
    ask_volume integer DEFAULT 0 NOT NULL
);


--
-- Name: price_bars_2023_12; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.price_bars_2023_12 (
    id bigint DEFAULT nextval('public.price_bars_new_id_seq'::regclass) NOT NULL,
    symbol text NOT NULL,
    contract text NOT NULL,
    ts timestamp without time zone NOT NULL,
    open numeric(12,4) NOT NULL,
    high numeric(12,4) NOT NULL,
    low numeric(12,4) NOT NULL,
    close numeric(12,4) NOT NULL,
    volume integer DEFAULT 0 NOT NULL,
    num_trades integer DEFAULT 0 NOT NULL,
    bid_volume integer DEFAULT 0 NOT NULL,
    ask_volume integer DEFAULT 0 NOT NULL
);


--
-- Name: price_bars_2024_01; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.price_bars_2024_01 (
    id bigint DEFAULT nextval('public.price_bars_new_id_seq'::regclass) NOT NULL,
    symbol text NOT NULL,
    contract text NOT NULL,
    ts timestamp without time zone NOT NULL,
    open numeric(12,4) NOT NULL,
    high numeric(12,4) NOT NULL,
    low numeric(12,4) NOT NULL,
    close numeric(12,4) NOT NULL,
    volume integer DEFAULT 0 NOT NULL,
    num_trades integer DEFAULT 0 NOT NULL,
    bid_volume integer DEFAULT 0 NOT NULL,
    ask_volume integer DEFAULT 0 NOT NULL
);


--
-- Name: price_bars_2024_02; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.price_bars_2024_02 (
    id bigint DEFAULT nextval('public.price_bars_new_id_seq'::regclass) NOT NULL,
    symbol text NOT NULL,
    contract text NOT NULL,
    ts timestamp without time zone NOT NULL,
    open numeric(12,4) NOT NULL,
    high numeric(12,4) NOT NULL,
    low numeric(12,4) NOT NULL,
    close numeric(12,4) NOT NULL,
    volume integer DEFAULT 0 NOT NULL,
    num_trades integer DEFAULT 0 NOT NULL,
    bid_volume integer DEFAULT 0 NOT NULL,
    ask_volume integer DEFAULT 0 NOT NULL
);


--
-- Name: price_bars_2024_03; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.price_bars_2024_03 (
    id bigint DEFAULT nextval('public.price_bars_new_id_seq'::regclass) NOT NULL,
    symbol text NOT NULL,
    contract text NOT NULL,
    ts timestamp without time zone NOT NULL,
    open numeric(12,4) NOT NULL,
    high numeric(12,4) NOT NULL,
    low numeric(12,4) NOT NULL,
    close numeric(12,4) NOT NULL,
    volume integer DEFAULT 0 NOT NULL,
    num_trades integer DEFAULT 0 NOT NULL,
    bid_volume integer DEFAULT 0 NOT NULL,
    ask_volume integer DEFAULT 0 NOT NULL
);


--
-- Name: price_bars_2024_04; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.price_bars_2024_04 (
    id bigint DEFAULT nextval('public.price_bars_new_id_seq'::regclass) NOT NULL,
    symbol text NOT NULL,
    contract text NOT NULL,
    ts timestamp without time zone NOT NULL,
    open numeric(12,4) NOT NULL,
    high numeric(12,4) NOT NULL,
    low numeric(12,4) NOT NULL,
    close numeric(12,4) NOT NULL,
    volume integer DEFAULT 0 NOT NULL,
    num_trades integer DEFAULT 0 NOT NULL,
    bid_volume integer DEFAULT 0 NOT NULL,
    ask_volume integer DEFAULT 0 NOT NULL
);


--
-- Name: price_bars_2024_05; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.price_bars_2024_05 (
    id bigint DEFAULT nextval('public.price_bars_new_id_seq'::regclass) NOT NULL,
    symbol text NOT NULL,
    contract text NOT NULL,
    ts timestamp without time zone NOT NULL,
    open numeric(12,4) NOT NULL,
    high numeric(12,4) NOT NULL,
    low numeric(12,4) NOT NULL,
    close numeric(12,4) NOT NULL,
    volume integer DEFAULT 0 NOT NULL,
    num_trades integer DEFAULT 0 NOT NULL,
    bid_volume integer DEFAULT 0 NOT NULL,
    ask_volume integer DEFAULT 0 NOT NULL
);


--
-- Name: price_bars_2024_06; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.price_bars_2024_06 (
    id bigint DEFAULT nextval('public.price_bars_new_id_seq'::regclass) NOT NULL,
    symbol text NOT NULL,
    contract text NOT NULL,
    ts timestamp without time zone NOT NULL,
    open numeric(12,4) NOT NULL,
    high numeric(12,4) NOT NULL,
    low numeric(12,4) NOT NULL,
    close numeric(12,4) NOT NULL,
    volume integer DEFAULT 0 NOT NULL,
    num_trades integer DEFAULT 0 NOT NULL,
    bid_volume integer DEFAULT 0 NOT NULL,
    ask_volume integer DEFAULT 0 NOT NULL
);


--
-- Name: price_bars_2024_07; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.price_bars_2024_07 (
    id bigint DEFAULT nextval('public.price_bars_new_id_seq'::regclass) NOT NULL,
    symbol text NOT NULL,
    contract text NOT NULL,
    ts timestamp without time zone NOT NULL,
    open numeric(12,4) NOT NULL,
    high numeric(12,4) NOT NULL,
    low numeric(12,4) NOT NULL,
    close numeric(12,4) NOT NULL,
    volume integer DEFAULT 0 NOT NULL,
    num_trades integer DEFAULT 0 NOT NULL,
    bid_volume integer DEFAULT 0 NOT NULL,
    ask_volume integer DEFAULT 0 NOT NULL
);


--
-- Name: price_bars_2024_08; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.price_bars_2024_08 (
    id bigint DEFAULT nextval('public.price_bars_new_id_seq'::regclass) NOT NULL,
    symbol text NOT NULL,
    contract text NOT NULL,
    ts timestamp without time zone NOT NULL,
    open numeric(12,4) NOT NULL,
    high numeric(12,4) NOT NULL,
    low numeric(12,4) NOT NULL,
    close numeric(12,4) NOT NULL,
    volume integer DEFAULT 0 NOT NULL,
    num_trades integer DEFAULT 0 NOT NULL,
    bid_volume integer DEFAULT 0 NOT NULL,
    ask_volume integer DEFAULT 0 NOT NULL
);


--
-- Name: price_bars_2024_09; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.price_bars_2024_09 (
    id bigint DEFAULT nextval('public.price_bars_new_id_seq'::regclass) NOT NULL,
    symbol text NOT NULL,
    contract text NOT NULL,
    ts timestamp without time zone NOT NULL,
    open numeric(12,4) NOT NULL,
    high numeric(12,4) NOT NULL,
    low numeric(12,4) NOT NULL,
    close numeric(12,4) NOT NULL,
    volume integer DEFAULT 0 NOT NULL,
    num_trades integer DEFAULT 0 NOT NULL,
    bid_volume integer DEFAULT 0 NOT NULL,
    ask_volume integer DEFAULT 0 NOT NULL
);


--
-- Name: price_bars_2024_10; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.price_bars_2024_10 (
    id bigint DEFAULT nextval('public.price_bars_new_id_seq'::regclass) NOT NULL,
    symbol text NOT NULL,
    contract text NOT NULL,
    ts timestamp without time zone NOT NULL,
    open numeric(12,4) NOT NULL,
    high numeric(12,4) NOT NULL,
    low numeric(12,4) NOT NULL,
    close numeric(12,4) NOT NULL,
    volume integer DEFAULT 0 NOT NULL,
    num_trades integer DEFAULT 0 NOT NULL,
    bid_volume integer DEFAULT 0 NOT NULL,
    ask_volume integer DEFAULT 0 NOT NULL
);


--
-- Name: price_bars_2024_11; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.price_bars_2024_11 (
    id bigint DEFAULT nextval('public.price_bars_new_id_seq'::regclass) NOT NULL,
    symbol text NOT NULL,
    contract text NOT NULL,
    ts timestamp without time zone NOT NULL,
    open numeric(12,4) NOT NULL,
    high numeric(12,4) NOT NULL,
    low numeric(12,4) NOT NULL,
    close numeric(12,4) NOT NULL,
    volume integer DEFAULT 0 NOT NULL,
    num_trades integer DEFAULT 0 NOT NULL,
    bid_volume integer DEFAULT 0 NOT NULL,
    ask_volume integer DEFAULT 0 NOT NULL
);


--
-- Name: price_bars_2024_12; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.price_bars_2024_12 (
    id bigint DEFAULT nextval('public.price_bars_new_id_seq'::regclass) NOT NULL,
    symbol text NOT NULL,
    contract text NOT NULL,
    ts timestamp without time zone NOT NULL,
    open numeric(12,4) NOT NULL,
    high numeric(12,4) NOT NULL,
    low numeric(12,4) NOT NULL,
    close numeric(12,4) NOT NULL,
    volume integer DEFAULT 0 NOT NULL,
    num_trades integer DEFAULT 0 NOT NULL,
    bid_volume integer DEFAULT 0 NOT NULL,
    ask_volume integer DEFAULT 0 NOT NULL
);


--
-- Name: price_bars_2025_01; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.price_bars_2025_01 (
    id bigint DEFAULT nextval('public.price_bars_new_id_seq'::regclass) NOT NULL,
    symbol text NOT NULL,
    contract text NOT NULL,
    ts timestamp without time zone NOT NULL,
    open numeric(12,4) NOT NULL,
    high numeric(12,4) NOT NULL,
    low numeric(12,4) NOT NULL,
    close numeric(12,4) NOT NULL,
    volume integer DEFAULT 0 NOT NULL,
    num_trades integer DEFAULT 0 NOT NULL,
    bid_volume integer DEFAULT 0 NOT NULL,
    ask_volume integer DEFAULT 0 NOT NULL
);


--
-- Name: price_bars_2025_02; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.price_bars_2025_02 (
    id bigint DEFAULT nextval('public.price_bars_new_id_seq'::regclass) NOT NULL,
    symbol text NOT NULL,
    contract text NOT NULL,
    ts timestamp without time zone NOT NULL,
    open numeric(12,4) NOT NULL,
    high numeric(12,4) NOT NULL,
    low numeric(12,4) NOT NULL,
    close numeric(12,4) NOT NULL,
    volume integer DEFAULT 0 NOT NULL,
    num_trades integer DEFAULT 0 NOT NULL,
    bid_volume integer DEFAULT 0 NOT NULL,
    ask_volume integer DEFAULT 0 NOT NULL
);


--
-- Name: price_bars_2025_03; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.price_bars_2025_03 (
    id bigint DEFAULT nextval('public.price_bars_new_id_seq'::regclass) NOT NULL,
    symbol text NOT NULL,
    contract text NOT NULL,
    ts timestamp without time zone NOT NULL,
    open numeric(12,4) NOT NULL,
    high numeric(12,4) NOT NULL,
    low numeric(12,4) NOT NULL,
    close numeric(12,4) NOT NULL,
    volume integer DEFAULT 0 NOT NULL,
    num_trades integer DEFAULT 0 NOT NULL,
    bid_volume integer DEFAULT 0 NOT NULL,
    ask_volume integer DEFAULT 0 NOT NULL
);


--
-- Name: price_bars_2025_04; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.price_bars_2025_04 (
    id bigint DEFAULT nextval('public.price_bars_new_id_seq'::regclass) NOT NULL,
    symbol text NOT NULL,
    contract text NOT NULL,
    ts timestamp without time zone NOT NULL,
    open numeric(12,4) NOT NULL,
    high numeric(12,4) NOT NULL,
    low numeric(12,4) NOT NULL,
    close numeric(12,4) NOT NULL,
    volume integer DEFAULT 0 NOT NULL,
    num_trades integer DEFAULT 0 NOT NULL,
    bid_volume integer DEFAULT 0 NOT NULL,
    ask_volume integer DEFAULT 0 NOT NULL
);


--
-- Name: price_bars_2025_05; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.price_bars_2025_05 (
    id bigint DEFAULT nextval('public.price_bars_new_id_seq'::regclass) NOT NULL,
    symbol text NOT NULL,
    contract text NOT NULL,
    ts timestamp without time zone NOT NULL,
    open numeric(12,4) NOT NULL,
    high numeric(12,4) NOT NULL,
    low numeric(12,4) NOT NULL,
    close numeric(12,4) NOT NULL,
    volume integer DEFAULT 0 NOT NULL,
    num_trades integer DEFAULT 0 NOT NULL,
    bid_volume integer DEFAULT 0 NOT NULL,
    ask_volume integer DEFAULT 0 NOT NULL
);


--
-- Name: price_bars_2025_06; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.price_bars_2025_06 (
    id bigint DEFAULT nextval('public.price_bars_new_id_seq'::regclass) NOT NULL,
    symbol text NOT NULL,
    contract text NOT NULL,
    ts timestamp without time zone NOT NULL,
    open numeric(12,4) NOT NULL,
    high numeric(12,4) NOT NULL,
    low numeric(12,4) NOT NULL,
    close numeric(12,4) NOT NULL,
    volume integer DEFAULT 0 NOT NULL,
    num_trades integer DEFAULT 0 NOT NULL,
    bid_volume integer DEFAULT 0 NOT NULL,
    ask_volume integer DEFAULT 0 NOT NULL
);


--
-- Name: price_bars_2025_07; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.price_bars_2025_07 (
    id bigint DEFAULT nextval('public.price_bars_new_id_seq'::regclass) NOT NULL,
    symbol text NOT NULL,
    contract text NOT NULL,
    ts timestamp without time zone NOT NULL,
    open numeric(12,4) NOT NULL,
    high numeric(12,4) NOT NULL,
    low numeric(12,4) NOT NULL,
    close numeric(12,4) NOT NULL,
    volume integer DEFAULT 0 NOT NULL,
    num_trades integer DEFAULT 0 NOT NULL,
    bid_volume integer DEFAULT 0 NOT NULL,
    ask_volume integer DEFAULT 0 NOT NULL
);


--
-- Name: price_bars_2025_08; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.price_bars_2025_08 (
    id bigint DEFAULT nextval('public.price_bars_new_id_seq'::regclass) NOT NULL,
    symbol text NOT NULL,
    contract text NOT NULL,
    ts timestamp without time zone NOT NULL,
    open numeric(12,4) NOT NULL,
    high numeric(12,4) NOT NULL,
    low numeric(12,4) NOT NULL,
    close numeric(12,4) NOT NULL,
    volume integer DEFAULT 0 NOT NULL,
    num_trades integer DEFAULT 0 NOT NULL,
    bid_volume integer DEFAULT 0 NOT NULL,
    ask_volume integer DEFAULT 0 NOT NULL
);


--
-- Name: price_bars_2025_09; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.price_bars_2025_09 (
    id bigint DEFAULT nextval('public.price_bars_new_id_seq'::regclass) NOT NULL,
    symbol text NOT NULL,
    contract text NOT NULL,
    ts timestamp without time zone NOT NULL,
    open numeric(12,4) NOT NULL,
    high numeric(12,4) NOT NULL,
    low numeric(12,4) NOT NULL,
    close numeric(12,4) NOT NULL,
    volume integer DEFAULT 0 NOT NULL,
    num_trades integer DEFAULT 0 NOT NULL,
    bid_volume integer DEFAULT 0 NOT NULL,
    ask_volume integer DEFAULT 0 NOT NULL
);


--
-- Name: price_bars_2025_10; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.price_bars_2025_10 (
    id bigint DEFAULT nextval('public.price_bars_new_id_seq'::regclass) NOT NULL,
    symbol text NOT NULL,
    contract text NOT NULL,
    ts timestamp without time zone NOT NULL,
    open numeric(12,4) NOT NULL,
    high numeric(12,4) NOT NULL,
    low numeric(12,4) NOT NULL,
    close numeric(12,4) NOT NULL,
    volume integer DEFAULT 0 NOT NULL,
    num_trades integer DEFAULT 0 NOT NULL,
    bid_volume integer DEFAULT 0 NOT NULL,
    ask_volume integer DEFAULT 0 NOT NULL
);


--
-- Name: price_bars_2025_11; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.price_bars_2025_11 (
    id bigint DEFAULT nextval('public.price_bars_new_id_seq'::regclass) NOT NULL,
    symbol text NOT NULL,
    contract text NOT NULL,
    ts timestamp without time zone NOT NULL,
    open numeric(12,4) NOT NULL,
    high numeric(12,4) NOT NULL,
    low numeric(12,4) NOT NULL,
    close numeric(12,4) NOT NULL,
    volume integer DEFAULT 0 NOT NULL,
    num_trades integer DEFAULT 0 NOT NULL,
    bid_volume integer DEFAULT 0 NOT NULL,
    ask_volume integer DEFAULT 0 NOT NULL
);


--
-- Name: price_bars_2025_12; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.price_bars_2025_12 (
    id bigint DEFAULT nextval('public.price_bars_new_id_seq'::regclass) NOT NULL,
    symbol text NOT NULL,
    contract text NOT NULL,
    ts timestamp without time zone NOT NULL,
    open numeric(12,4) NOT NULL,
    high numeric(12,4) NOT NULL,
    low numeric(12,4) NOT NULL,
    close numeric(12,4) NOT NULL,
    volume integer DEFAULT 0 NOT NULL,
    num_trades integer DEFAULT 0 NOT NULL,
    bid_volume integer DEFAULT 0 NOT NULL,
    ask_volume integer DEFAULT 0 NOT NULL
);


--
-- Name: price_bars_2026_01; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.price_bars_2026_01 (
    id bigint DEFAULT nextval('public.price_bars_new_id_seq'::regclass) NOT NULL,
    symbol text NOT NULL,
    contract text NOT NULL,
    ts timestamp without time zone NOT NULL,
    open numeric(12,4) NOT NULL,
    high numeric(12,4) NOT NULL,
    low numeric(12,4) NOT NULL,
    close numeric(12,4) NOT NULL,
    volume integer DEFAULT 0 NOT NULL,
    num_trades integer DEFAULT 0 NOT NULL,
    bid_volume integer DEFAULT 0 NOT NULL,
    ask_volume integer DEFAULT 0 NOT NULL
);


--
-- Name: price_bars_2026_02; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.price_bars_2026_02 (
    id bigint DEFAULT nextval('public.price_bars_new_id_seq'::regclass) NOT NULL,
    symbol text NOT NULL,
    contract text NOT NULL,
    ts timestamp without time zone NOT NULL,
    open numeric(12,4) NOT NULL,
    high numeric(12,4) NOT NULL,
    low numeric(12,4) NOT NULL,
    close numeric(12,4) NOT NULL,
    volume integer DEFAULT 0 NOT NULL,
    num_trades integer DEFAULT 0 NOT NULL,
    bid_volume integer DEFAULT 0 NOT NULL,
    ask_volume integer DEFAULT 0 NOT NULL
);


--
-- Name: price_bars_2026_03; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.price_bars_2026_03 (
    id bigint DEFAULT nextval('public.price_bars_new_id_seq'::regclass) NOT NULL,
    symbol text NOT NULL,
    contract text NOT NULL,
    ts timestamp without time zone NOT NULL,
    open numeric(12,4) NOT NULL,
    high numeric(12,4) NOT NULL,
    low numeric(12,4) NOT NULL,
    close numeric(12,4) NOT NULL,
    volume integer DEFAULT 0 NOT NULL,
    num_trades integer DEFAULT 0 NOT NULL,
    bid_volume integer DEFAULT 0 NOT NULL,
    ask_volume integer DEFAULT 0 NOT NULL
);


--
-- Name: price_bars_2026_04; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.price_bars_2026_04 (
    id bigint DEFAULT nextval('public.price_bars_new_id_seq'::regclass) NOT NULL,
    symbol text NOT NULL,
    contract text NOT NULL,
    ts timestamp without time zone NOT NULL,
    open numeric(12,4) NOT NULL,
    high numeric(12,4) NOT NULL,
    low numeric(12,4) NOT NULL,
    close numeric(12,4) NOT NULL,
    volume integer DEFAULT 0 NOT NULL,
    num_trades integer DEFAULT 0 NOT NULL,
    bid_volume integer DEFAULT 0 NOT NULL,
    ask_volume integer DEFAULT 0 NOT NULL
);


--
-- Name: price_bars_2026_05; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.price_bars_2026_05 (
    id bigint DEFAULT nextval('public.price_bars_new_id_seq'::regclass) NOT NULL,
    symbol text NOT NULL,
    contract text NOT NULL,
    ts timestamp without time zone NOT NULL,
    open numeric(12,4) NOT NULL,
    high numeric(12,4) NOT NULL,
    low numeric(12,4) NOT NULL,
    close numeric(12,4) NOT NULL,
    volume integer DEFAULT 0 NOT NULL,
    num_trades integer DEFAULT 0 NOT NULL,
    bid_volume integer DEFAULT 0 NOT NULL,
    ask_volume integer DEFAULT 0 NOT NULL
);


--
-- Name: price_bars_2026_06; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.price_bars_2026_06 (
    id bigint DEFAULT nextval('public.price_bars_new_id_seq'::regclass) NOT NULL,
    symbol text NOT NULL,
    contract text NOT NULL,
    ts timestamp without time zone NOT NULL,
    open numeric(12,4) NOT NULL,
    high numeric(12,4) NOT NULL,
    low numeric(12,4) NOT NULL,
    close numeric(12,4) NOT NULL,
    volume integer DEFAULT 0 NOT NULL,
    num_trades integer DEFAULT 0 NOT NULL,
    bid_volume integer DEFAULT 0 NOT NULL,
    ask_volume integer DEFAULT 0 NOT NULL
);


--
-- Name: price_bars_2026_07; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.price_bars_2026_07 (
    id bigint DEFAULT nextval('public.price_bars_new_id_seq'::regclass) NOT NULL,
    symbol text NOT NULL,
    contract text NOT NULL,
    ts timestamp without time zone NOT NULL,
    open numeric(12,4) NOT NULL,
    high numeric(12,4) NOT NULL,
    low numeric(12,4) NOT NULL,
    close numeric(12,4) NOT NULL,
    volume integer DEFAULT 0 NOT NULL,
    num_trades integer DEFAULT 0 NOT NULL,
    bid_volume integer DEFAULT 0 NOT NULL,
    ask_volume integer DEFAULT 0 NOT NULL
);


--
-- Name: price_bars_2026_08; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.price_bars_2026_08 (
    id bigint DEFAULT nextval('public.price_bars_new_id_seq'::regclass) NOT NULL,
    symbol text NOT NULL,
    contract text NOT NULL,
    ts timestamp without time zone NOT NULL,
    open numeric(12,4) NOT NULL,
    high numeric(12,4) NOT NULL,
    low numeric(12,4) NOT NULL,
    close numeric(12,4) NOT NULL,
    volume integer DEFAULT 0 NOT NULL,
    num_trades integer DEFAULT 0 NOT NULL,
    bid_volume integer DEFAULT 0 NOT NULL,
    ask_volume integer DEFAULT 0 NOT NULL
);


--
-- Name: price_bars_2026_09; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.price_bars_2026_09 (
    id bigint DEFAULT nextval('public.price_bars_new_id_seq'::regclass) NOT NULL,
    symbol text NOT NULL,
    contract text NOT NULL,
    ts timestamp without time zone NOT NULL,
    open numeric(12,4) NOT NULL,
    high numeric(12,4) NOT NULL,
    low numeric(12,4) NOT NULL,
    close numeric(12,4) NOT NULL,
    volume integer DEFAULT 0 NOT NULL,
    num_trades integer DEFAULT 0 NOT NULL,
    bid_volume integer DEFAULT 0 NOT NULL,
    ask_volume integer DEFAULT 0 NOT NULL
);


--
-- Name: price_bars_2026_10; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.price_bars_2026_10 (
    id bigint DEFAULT nextval('public.price_bars_new_id_seq'::regclass) NOT NULL,
    symbol text NOT NULL,
    contract text NOT NULL,
    ts timestamp without time zone NOT NULL,
    open numeric(12,4) NOT NULL,
    high numeric(12,4) NOT NULL,
    low numeric(12,4) NOT NULL,
    close numeric(12,4) NOT NULL,
    volume integer DEFAULT 0 NOT NULL,
    num_trades integer DEFAULT 0 NOT NULL,
    bid_volume integer DEFAULT 0 NOT NULL,
    ask_volume integer DEFAULT 0 NOT NULL
);


--
-- Name: price_bars_2026_11; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.price_bars_2026_11 (
    id bigint DEFAULT nextval('public.price_bars_new_id_seq'::regclass) NOT NULL,
    symbol text NOT NULL,
    contract text NOT NULL,
    ts timestamp without time zone NOT NULL,
    open numeric(12,4) NOT NULL,
    high numeric(12,4) NOT NULL,
    low numeric(12,4) NOT NULL,
    close numeric(12,4) NOT NULL,
    volume integer DEFAULT 0 NOT NULL,
    num_trades integer DEFAULT 0 NOT NULL,
    bid_volume integer DEFAULT 0 NOT NULL,
    ask_volume integer DEFAULT 0 NOT NULL
);


--
-- Name: price_bars_2026_12; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.price_bars_2026_12 (
    id bigint DEFAULT nextval('public.price_bars_new_id_seq'::regclass) NOT NULL,
    symbol text NOT NULL,
    contract text NOT NULL,
    ts timestamp without time zone NOT NULL,
    open numeric(12,4) NOT NULL,
    high numeric(12,4) NOT NULL,
    low numeric(12,4) NOT NULL,
    close numeric(12,4) NOT NULL,
    volume integer DEFAULT 0 NOT NULL,
    num_trades integer DEFAULT 0 NOT NULL,
    bid_volume integer DEFAULT 0 NOT NULL,
    ask_volume integer DEFAULT 0 NOT NULL
);


--
-- Name: price_bars_2027_01; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.price_bars_2027_01 (
    id bigint DEFAULT nextval('public.price_bars_new_id_seq'::regclass) NOT NULL,
    symbol text NOT NULL,
    contract text NOT NULL,
    ts timestamp without time zone NOT NULL,
    open numeric(12,4) NOT NULL,
    high numeric(12,4) NOT NULL,
    low numeric(12,4) NOT NULL,
    close numeric(12,4) NOT NULL,
    volume integer DEFAULT 0 NOT NULL,
    num_trades integer DEFAULT 0 NOT NULL,
    bid_volume integer DEFAULT 0 NOT NULL,
    ask_volume integer DEFAULT 0 NOT NULL
);


--
-- Name: price_bars_2027_02; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.price_bars_2027_02 (
    id bigint DEFAULT nextval('public.price_bars_new_id_seq'::regclass) NOT NULL,
    symbol text NOT NULL,
    contract text NOT NULL,
    ts timestamp without time zone NOT NULL,
    open numeric(12,4) NOT NULL,
    high numeric(12,4) NOT NULL,
    low numeric(12,4) NOT NULL,
    close numeric(12,4) NOT NULL,
    volume integer DEFAULT 0 NOT NULL,
    num_trades integer DEFAULT 0 NOT NULL,
    bid_volume integer DEFAULT 0 NOT NULL,
    ask_volume integer DEFAULT 0 NOT NULL
);


--
-- Name: price_bars_2027_03; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.price_bars_2027_03 (
    id bigint DEFAULT nextval('public.price_bars_new_id_seq'::regclass) NOT NULL,
    symbol text NOT NULL,
    contract text NOT NULL,
    ts timestamp without time zone NOT NULL,
    open numeric(12,4) NOT NULL,
    high numeric(12,4) NOT NULL,
    low numeric(12,4) NOT NULL,
    close numeric(12,4) NOT NULL,
    volume integer DEFAULT 0 NOT NULL,
    num_trades integer DEFAULT 0 NOT NULL,
    bid_volume integer DEFAULT 0 NOT NULL,
    ask_volume integer DEFAULT 0 NOT NULL
);


--
-- Name: price_bars_2027_04; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.price_bars_2027_04 (
    id bigint DEFAULT nextval('public.price_bars_new_id_seq'::regclass) NOT NULL,
    symbol text NOT NULL,
    contract text NOT NULL,
    ts timestamp without time zone NOT NULL,
    open numeric(12,4) NOT NULL,
    high numeric(12,4) NOT NULL,
    low numeric(12,4) NOT NULL,
    close numeric(12,4) NOT NULL,
    volume integer DEFAULT 0 NOT NULL,
    num_trades integer DEFAULT 0 NOT NULL,
    bid_volume integer DEFAULT 0 NOT NULL,
    ask_volume integer DEFAULT 0 NOT NULL
);


--
-- Name: price_bars_2027_05; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.price_bars_2027_05 (
    id bigint DEFAULT nextval('public.price_bars_new_id_seq'::regclass) NOT NULL,
    symbol text NOT NULL,
    contract text NOT NULL,
    ts timestamp without time zone NOT NULL,
    open numeric(12,4) NOT NULL,
    high numeric(12,4) NOT NULL,
    low numeric(12,4) NOT NULL,
    close numeric(12,4) NOT NULL,
    volume integer DEFAULT 0 NOT NULL,
    num_trades integer DEFAULT 0 NOT NULL,
    bid_volume integer DEFAULT 0 NOT NULL,
    ask_volume integer DEFAULT 0 NOT NULL
);


--
-- Name: price_bars_2027_06; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.price_bars_2027_06 (
    id bigint DEFAULT nextval('public.price_bars_new_id_seq'::regclass) NOT NULL,
    symbol text NOT NULL,
    contract text NOT NULL,
    ts timestamp without time zone NOT NULL,
    open numeric(12,4) NOT NULL,
    high numeric(12,4) NOT NULL,
    low numeric(12,4) NOT NULL,
    close numeric(12,4) NOT NULL,
    volume integer DEFAULT 0 NOT NULL,
    num_trades integer DEFAULT 0 NOT NULL,
    bid_volume integer DEFAULT 0 NOT NULL,
    ask_volume integer DEFAULT 0 NOT NULL
);


--
-- Name: price_bars_2027_07; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.price_bars_2027_07 (
    id bigint DEFAULT nextval('public.price_bars_new_id_seq'::regclass) NOT NULL,
    symbol text NOT NULL,
    contract text NOT NULL,
    ts timestamp without time zone NOT NULL,
    open numeric(12,4) NOT NULL,
    high numeric(12,4) NOT NULL,
    low numeric(12,4) NOT NULL,
    close numeric(12,4) NOT NULL,
    volume integer DEFAULT 0 NOT NULL,
    num_trades integer DEFAULT 0 NOT NULL,
    bid_volume integer DEFAULT 0 NOT NULL,
    ask_volume integer DEFAULT 0 NOT NULL
);


--
-- Name: price_bars_2027_08; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.price_bars_2027_08 (
    id bigint DEFAULT nextval('public.price_bars_new_id_seq'::regclass) NOT NULL,
    symbol text NOT NULL,
    contract text NOT NULL,
    ts timestamp without time zone NOT NULL,
    open numeric(12,4) NOT NULL,
    high numeric(12,4) NOT NULL,
    low numeric(12,4) NOT NULL,
    close numeric(12,4) NOT NULL,
    volume integer DEFAULT 0 NOT NULL,
    num_trades integer DEFAULT 0 NOT NULL,
    bid_volume integer DEFAULT 0 NOT NULL,
    ask_volume integer DEFAULT 0 NOT NULL
);


--
-- Name: price_bars_2027_09; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.price_bars_2027_09 (
    id bigint DEFAULT nextval('public.price_bars_new_id_seq'::regclass) NOT NULL,
    symbol text NOT NULL,
    contract text NOT NULL,
    ts timestamp without time zone NOT NULL,
    open numeric(12,4) NOT NULL,
    high numeric(12,4) NOT NULL,
    low numeric(12,4) NOT NULL,
    close numeric(12,4) NOT NULL,
    volume integer DEFAULT 0 NOT NULL,
    num_trades integer DEFAULT 0 NOT NULL,
    bid_volume integer DEFAULT 0 NOT NULL,
    ask_volume integer DEFAULT 0 NOT NULL
);


--
-- Name: price_bars_2027_10; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.price_bars_2027_10 (
    id bigint DEFAULT nextval('public.price_bars_new_id_seq'::regclass) NOT NULL,
    symbol text NOT NULL,
    contract text NOT NULL,
    ts timestamp without time zone NOT NULL,
    open numeric(12,4) NOT NULL,
    high numeric(12,4) NOT NULL,
    low numeric(12,4) NOT NULL,
    close numeric(12,4) NOT NULL,
    volume integer DEFAULT 0 NOT NULL,
    num_trades integer DEFAULT 0 NOT NULL,
    bid_volume integer DEFAULT 0 NOT NULL,
    ask_volume integer DEFAULT 0 NOT NULL
);


--
-- Name: price_bars_2027_11; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.price_bars_2027_11 (
    id bigint DEFAULT nextval('public.price_bars_new_id_seq'::regclass) NOT NULL,
    symbol text NOT NULL,
    contract text NOT NULL,
    ts timestamp without time zone NOT NULL,
    open numeric(12,4) NOT NULL,
    high numeric(12,4) NOT NULL,
    low numeric(12,4) NOT NULL,
    close numeric(12,4) NOT NULL,
    volume integer DEFAULT 0 NOT NULL,
    num_trades integer DEFAULT 0 NOT NULL,
    bid_volume integer DEFAULT 0 NOT NULL,
    ask_volume integer DEFAULT 0 NOT NULL
);


--
-- Name: price_bars_2027_12; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.price_bars_2027_12 (
    id bigint DEFAULT nextval('public.price_bars_new_id_seq'::regclass) NOT NULL,
    symbol text NOT NULL,
    contract text NOT NULL,
    ts timestamp without time zone NOT NULL,
    open numeric(12,4) NOT NULL,
    high numeric(12,4) NOT NULL,
    low numeric(12,4) NOT NULL,
    close numeric(12,4) NOT NULL,
    volume integer DEFAULT 0 NOT NULL,
    num_trades integer DEFAULT 0 NOT NULL,
    bid_volume integer DEFAULT 0 NOT NULL,
    ask_volume integer DEFAULT 0 NOT NULL
);


--
-- Name: price_bars_contract_calendar; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.price_bars_contract_calendar (
    symbol text NOT NULL,
    trade_date date NOT NULL,
    contract text NOT NULL,
    bar_count integer DEFAULT 0 NOT NULL
);


--
-- Name: price_bars_dedup_hist; Type: MATERIALIZED VIEW; Schema: public; Owner: -
--

CREATE MATERIALIZED VIEW public.price_bars_dedup_hist AS
 SELECT (array_agg(pb.id ORDER BY pb.ts))[1] AS id,
    pb.symbol,
    pb.contract,
    date_trunc('minute'::text, pb.ts) AS ts,
    ((array_agg(pb.open ORDER BY pb.ts))[1])::numeric(12,4) AS open,
    (max(pb.high))::numeric(12,4) AS high,
    (min(pb.low))::numeric(12,4) AS low,
    ((array_agg(pb.close ORDER BY pb.ts DESC))[1])::numeric(12,4) AS close,
    (sum(pb.volume))::integer AS volume,
    (sum(pb.num_trades))::integer AS num_trades,
    (sum(pb.bid_volume))::integer AS bid_volume,
    (sum(pb.ask_volume))::integer AS ask_volume
   FROM (public.price_bars pb
     JOIN public.price_bars_contract_calendar cc ON (((cc.symbol = pb.symbol) AND (cc.trade_date = (pb.ts)::date) AND (cc.contract = pb.contract))))
  WHERE ((pb.ts)::date < CURRENT_DATE)
  GROUP BY pb.symbol, pb.contract, (date_trunc('minute'::text, pb.ts))
  WITH NO DATA;


--
-- Name: price_bars_primary; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.price_bars_primary AS
 SELECT price_bars_dedup_hist.id,
    price_bars_dedup_hist.symbol,
    price_bars_dedup_hist.contract,
    price_bars_dedup_hist.ts,
    price_bars_dedup_hist.open,
    price_bars_dedup_hist.high,
    price_bars_dedup_hist.low,
    price_bars_dedup_hist.close,
    price_bars_dedup_hist.volume,
    price_bars_dedup_hist.num_trades,
    price_bars_dedup_hist.bid_volume,
    price_bars_dedup_hist.ask_volume
   FROM public.price_bars_dedup_hist
UNION ALL
 SELECT (array_agg(pb.id ORDER BY pb.ts))[1] AS id,
    pb.symbol,
    pb.contract,
    date_trunc('minute'::text, pb.ts) AS ts,
    ((array_agg(pb.open ORDER BY pb.ts))[1])::numeric(12,4) AS open,
    (max(pb.high))::numeric(12,4) AS high,
    (min(pb.low))::numeric(12,4) AS low,
    ((array_agg(pb.close ORDER BY pb.ts DESC))[1])::numeric(12,4) AS close,
    (sum(pb.volume))::integer AS volume,
    (sum(pb.num_trades))::integer AS num_trades,
    (sum(pb.bid_volume))::integer AS bid_volume,
    (sum(pb.ask_volume))::integer AS ask_volume
   FROM (public.price_bars pb
     JOIN public.price_bars_contract_calendar cc ON (((cc.symbol = pb.symbol) AND (cc.trade_date = (pb.ts)::date) AND (cc.contract = pb.contract))))
  WHERE (pb.ts > ( SELECT COALESCE(max(price_bars_dedup_hist.ts), '1970-01-01 00:00:00'::timestamp without time zone) AS "coalesce"
           FROM public.price_bars_dedup_hist))
  GROUP BY pb.symbol, pb.contract, (date_trunc('minute'::text, pb.ts));


--
-- Name: price_bars_primary_orig_backup; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.price_bars_primary_orig_backup AS
 SELECT (array_agg(pb.id ORDER BY pb.ts))[1] AS id,
    pb.symbol,
    pb.contract,
    date_trunc('minute'::text, pb.ts) AS ts,
    ((array_agg(pb.open ORDER BY pb.ts))[1])::numeric(12,4) AS open,
    (max(pb.high))::numeric(12,4) AS high,
    (min(pb.low))::numeric(12,4) AS low,
    ((array_agg(pb.close ORDER BY pb.ts DESC))[1])::numeric(12,4) AS close,
    (sum(pb.volume))::integer AS volume,
    (sum(pb.num_trades))::integer AS num_trades,
    (sum(pb.bid_volume))::integer AS bid_volume,
    (sum(pb.ask_volume))::integer AS ask_volume
   FROM (public.price_bars pb
     JOIN public.price_bars_contract_calendar cc ON (((cc.symbol = pb.symbol) AND (cc.trade_date = (pb.ts)::date) AND (cc.contract = pb.contract))))
  GROUP BY pb.symbol, pb.contract, (date_trunc('minute'::text, pb.ts));


--
-- Name: process_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.process_log (
    id integer NOT NULL,
    process_name character varying(50) NOT NULL,
    scheduled_time character varying(50),
    started_at timestamp without time zone,
    completed_at timestamp without time zone,
    status character varying(20),
    records_affected integer DEFAULT 0,
    error_message text,
    metadata jsonb,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: process_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.process_log_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: process_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.process_log_id_seq OWNED BY public.process_log.id;


--
-- Name: profit_lock_config; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.profit_lock_config (
    id integer DEFAULT 1 NOT NULL,
    lock_threshold numeric DEFAULT 400,
    giveback_pct numeric DEFAULT 0.40,
    floor_after_arm numeric DEFAULT 120,
    upanddone_threshold numeric DEFAULT 400,
    enabled boolean DEFAULT true,
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: profit_lock_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.profit_lock_events (
    id integer NOT NULL,
    event_date date NOT NULL,
    event_type text NOT NULL,
    event_at timestamp with time zone DEFAULT now(),
    peak_pnl numeric,
    current_pnl numeric,
    threshold numeric,
    user_choice text,
    kept_trading boolean,
    final_pnl numeric,
    notes text
);


--
-- Name: profit_lock_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.profit_lock_events_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: profit_lock_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.profit_lock_events_id_seq OWNED BY public.profit_lock_events.id;


--
-- Name: risk_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.risk_settings (
    id integer NOT NULL,
    account_size numeric DEFAULT 50000,
    risk_pct_per_trade numeric DEFAULT 2.0,
    instrument character varying DEFAULT 'MNQ'::character varying,
    lookback_days integer DEFAULT 60,
    daily_loss_limit_pct numeric DEFAULT 2.0,
    updated_at timestamp without time zone DEFAULT now(),
    acd_or_minutes integer DEFAULT 5,
    acd_a_multiplier numeric DEFAULT 0.25,
    acd_sustain_minutes integer DEFAULT 5,
    acd_best_params_period character varying(20) DEFAULT 'last-30d'::character varying,
    acd_best_params_ev numeric
);


--
-- Name: risk_settings_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.risk_settings_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: risk_settings_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.risk_settings_id_seq OWNED BY public.risk_settings.id;


--
-- Name: rule_overrides_backup_20260716; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.rule_overrides_backup_20260716 (
    id integer,
    override_date date,
    override_time timestamp without time zone,
    rule_violated character varying(50),
    confluence_score integer,
    session_outcome numeric,
    created_at timestamp without time zone
);


--
-- Name: session_analysis; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.session_analysis (
    id integer NOT NULL,
    trade_date date NOT NULL,
    session_type character varying(30),
    open_type character varying(30),
    close_type character varying(30),
    open_price double precision,
    close_price double precision,
    session_high double precision,
    session_low double precision,
    range_pt double precision,
    atr_ratio double precision,
    gap_pt double precision,
    gap_filled boolean,
    close_vs_open double precision,
    close_pct_of_range integer,
    vwap double precision,
    close_vs_vwap double precision,
    poc double precision,
    close_vs_poc double precision,
    rotations_65pt integer,
    avg_rotation_size double precision,
    max_rotation_size double precision,
    rotation_trend character varying(20),
    compressions integer DEFAULT 0,
    volume_climaxes integer DEFAULT 0,
    failed_breakouts integer DEFAULT 0,
    stop_sweeps integer DEFAULT 0,
    vwap_crosses integer DEFAULT 0,
    patterns jsonb DEFAULT '[]'::jsonb,
    metrics jsonb DEFAULT '{}'::jsonb,
    summary text,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: session_analysis_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.session_analysis_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: session_analysis_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.session_analysis_id_seq OWNED BY public.session_analysis.id;


--
-- Name: session_patterns; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.session_patterns (
    id integer NOT NULL,
    trade_date date NOT NULL,
    pattern_type character varying(50) NOT NULL,
    et_minute integer,
    duration_min integer,
    direction character varying(10),
    magnitude double precision,
    context jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: session_patterns_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.session_patterns_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: session_patterns_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.session_patterns_id_seq OWNED BY public.session_patterns.id;


--
-- Name: settings_todos; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.settings_todos (
    id integer NOT NULL,
    category character varying(100) NOT NULL,
    priority integer NOT NULL,
    title character varying(255) NOT NULL,
    impact character varying(255),
    description text,
    completed boolean DEFAULT false,
    is_custom boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: settings_todos_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.settings_todos_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: settings_todos_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.settings_todos_id_seq OWNED BY public.settings_todos.id;


--
-- Name: setup_correlation_cache; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.setup_correlation_cache (
    id integer NOT NULL,
    bias_dir character varying(10) NOT NULL,
    setup_key character varying(30) NOT NULL,
    tested integer,
    profitable integer,
    avg_pts integer,
    max_pts integer,
    hit_rate numeric,
    computed_at timestamp without time zone DEFAULT now(),
    prior_hit_rate numeric,
    prior_avg_pts integer,
    changed boolean DEFAULT false
);


--
-- Name: setup_correlation_cache_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.setup_correlation_cache_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: setup_correlation_cache_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.setup_correlation_cache_id_seq OWNED BY public.setup_correlation_cache.id;


--
-- Name: setup_daytype_winrates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.setup_daytype_winrates (
    setup_type text NOT NULL,
    day_type text NOT NULL,
    n integer NOT NULL,
    decided_n integer NOT NULL,
    target_hit integer NOT NULL,
    stop_hit integer NOT NULL,
    expired integer NOT NULL,
    win_rate numeric,
    limited_sample boolean DEFAULT true NOT NULL,
    computed_date date NOT NULL
);


--
-- Name: setup_move_stats; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.setup_move_stats (
    id integer NOT NULL,
    calculated_date date DEFAULT CURRENT_DATE NOT NULL,
    setup_type character varying(30) NOT NULL,
    avg_move_30d numeric,
    sessions_30d integer,
    avg_move_90d numeric,
    sessions_90d integer,
    avg_move_alltime numeric,
    sessions_alltime integer,
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: setup_move_stats_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.setup_move_stats_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: setup_move_stats_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.setup_move_stats_id_seq OWNED BY public.setup_move_stats.id;


--
-- Name: setup_move_stats_session_pnl_fix_backup_20260719; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.setup_move_stats_session_pnl_fix_backup_20260719 (
    id integer,
    calculated_date date,
    setup_type character varying(30),
    avg_move_30d numeric,
    sessions_30d integer,
    avg_move_90d numeric,
    sessions_90d integer,
    avg_move_alltime numeric,
    sessions_alltime integer,
    updated_at timestamp without time zone
);


--
-- Name: setup_outcome_backtest; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.setup_outcome_backtest (
    id integer NOT NULL,
    setup_id integer,
    trade_date date NOT NULL,
    setup_type character varying(40) NOT NULL,
    fired_at timestamp without time zone NOT NULL,
    entry_price numeric,
    stop_price numeric,
    t1_price numeric,
    level_at_entry character varying(40),
    nl30_at_entry integer,
    structural_state character varying(30),
    confluence_score integer,
    day_type character varying(20),
    hit_t1 boolean,
    hit_stop boolean,
    hit_t1_first boolean,
    mfe_points numeric,
    mae_points numeric,
    bars_to_resolution integer,
    computed_pnl_1contract numeric,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: setup_outcome_backtest_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.setup_outcome_backtest_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: setup_outcome_backtest_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.setup_outcome_backtest_id_seq OWNED BY public.setup_outcome_backtest.id;


--
-- Name: setup_status_manual_override_backup_20260809; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.setup_status_manual_override_backup_20260809 (
    id integer,
    run_date date,
    window_days integer,
    signal_type character varying(30),
    signal_name character varying(60),
    sample_size integer,
    win_rate numeric,
    ev_per_trade numeric,
    total_pnl numeric,
    avg_mfe numeric,
    p50_mfe numeric,
    p75_mfe numeric,
    avg_mae numeric,
    p50_mae numeric,
    p75_mae numeric,
    p90_mae numeric,
    avg_duration_min numeric,
    current_stop numeric,
    current_target numeric,
    optimal_stop numeric,
    optimal_target numeric,
    optimal_ev numeric,
    stop_blowthrough_pct numeric,
    t1_overshoot_avg numeric,
    mfe_range_pct numeric,
    mae_range_pct numeric,
    recommendation character varying(20),
    notes text,
    created_at timestamp without time zone
);


--
-- Name: setup_types; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.setup_types (
    id integer NOT NULL,
    name character varying(100) NOT NULL,
    description text,
    is_active boolean DEFAULT true,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: setup_types_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.setup_types_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: setup_types_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.setup_types_id_seq OWNED BY public.setup_types.id;


--
-- Name: trade_annotations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.trade_annotations (
    id integer NOT NULL,
    trade_date date NOT NULL,
    trade_ids integer[] NOT NULL,
    annotation_text text,
    setup_type character varying(120),
    context_marker character varying(20) DEFAULT 'planned'::character varying NOT NULL,
    image_path text,
    correction_text text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: trade_annotations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.trade_annotations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: trade_annotations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.trade_annotations_id_seq OWNED BY public.trade_annotations.id;


--
-- Name: trade_feedback; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.trade_feedback (
    id integer NOT NULL,
    trade_date date DEFAULT CURRENT_DATE NOT NULL,
    setup_id integer,
    setup_type text NOT NULL,
    action text NOT NULL,
    direction text,
    entry_price numeric,
    exit_price numeric,
    pnl numeric,
    contracts integer DEFAULT 1,
    tags text[] DEFAULT '{}'::text[],
    note text,
    created_at timestamp with time zone DEFAULT now(),
    closed_at timestamp with time zone,
    CONSTRAINT trade_feedback_action_check CHECK ((action = ANY (ARRAY['TAKEN'::text, 'PASSED'::text]))),
    CONSTRAINT trade_feedback_direction_check CHECK ((direction = ANY (ARRAY['LONG'::text, 'SHORT'::text])))
);


--
-- Name: trade_feedback_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.trade_feedback_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: trade_feedback_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.trade_feedback_id_seq OWNED BY public.trade_feedback.id;


--
-- Name: trade_screenshots_backup_20260716; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.trade_screenshots_backup_20260716 (
    id integer,
    trade_id integer,
    filename character varying(255),
    file_path text,
    upload_time timestamp without time zone,
    caption text
);


--
-- Name: trade_timeline_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.trade_timeline_events (
    id integer NOT NULL,
    trade_date date DEFAULT CURRENT_DATE NOT NULL,
    event_time timestamp without time zone NOT NULL,
    event_type character varying(20) NOT NULL,
    setup_type character varying(60),
    setup_id integer,
    direction character varying(5),
    entry_zone numeric,
    stop_level numeric,
    t1_level numeric,
    t1_label character varying(100),
    structural_level character varying(60),
    resolution character varying(20),
    price_at_resolution numeric,
    historical_win_rate numeric,
    historical_sessions integer,
    window_duration_minutes integer,
    signal_type character varying(20),
    signal_price numeric,
    signal_quality character varying(10),
    alert_type character varying(60),
    conditions_met integer,
    notes text,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: trade_timeline_events_cascade_breaker_repair_backup_20260816; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.trade_timeline_events_cascade_breaker_repair_backup_20260816 (
    id integer,
    trade_date date,
    event_time timestamp without time zone,
    event_type character varying(20),
    setup_type character varying(60),
    setup_id integer,
    direction character varying(5),
    entry_zone numeric,
    stop_level numeric,
    t1_level numeric,
    t1_label character varying(100),
    structural_level character varying(60),
    resolution character varying(20),
    price_at_resolution numeric,
    historical_win_rate numeric,
    historical_sessions integer,
    window_duration_minutes integer,
    signal_type character varying(20),
    signal_price numeric,
    signal_quality character varying(10),
    alert_type character varying(60),
    conditions_met integer,
    notes text,
    created_at timestamp without time zone,
    updated_at timestamp without time zone
);


--
-- Name: trade_timeline_events_duplicate_backup_20260717; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.trade_timeline_events_duplicate_backup_20260717 (
    id integer,
    trade_date date,
    event_time timestamp without time zone,
    event_type character varying(20),
    setup_type character varying(60),
    setup_id integer,
    direction character varying(5),
    entry_zone numeric,
    stop_level numeric,
    t1_level numeric,
    t1_label character varying(100),
    structural_level character varying(60),
    resolution character varying(20),
    price_at_resolution numeric,
    historical_win_rate numeric,
    historical_sessions integer,
    window_duration_minutes integer,
    signal_type character varying(20),
    signal_price numeric,
    signal_quality character varying(10),
    alert_type character varying(60),
    conditions_met integer,
    notes text,
    created_at timestamp without time zone,
    updated_at timestamp without time zone
);


--
-- Name: trade_timeline_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.trade_timeline_events_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: trade_timeline_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.trade_timeline_events_id_seq OWNED BY public.trade_timeline_events.id;


--
-- Name: trade_timeline_events_or_rename_backup_20260812; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.trade_timeline_events_or_rename_backup_20260812 (
    id integer,
    trade_date date,
    event_time timestamp without time zone,
    event_type character varying(20),
    setup_type character varying(60),
    setup_id integer,
    direction character varying(5),
    entry_zone numeric,
    stop_level numeric,
    t1_level numeric,
    t1_label character varying(100),
    structural_level character varying(60),
    resolution character varying(20),
    price_at_resolution numeric,
    historical_win_rate numeric,
    historical_sessions integer,
    window_duration_minutes integer,
    signal_type character varying(20),
    signal_price numeric,
    signal_quality character varying(10),
    alert_type character varying(60),
    conditions_met integer,
    notes text,
    created_at timestamp without time zone,
    updated_at timestamp without time zone
);


--
-- Name: trade_timeline_events_or_rename_race_duplicate_backup_20260812; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.trade_timeline_events_or_rename_race_duplicate_backup_20260812 (
    id integer,
    trade_date date,
    event_time timestamp without time zone,
    event_type character varying(20),
    setup_type character varying(60),
    setup_id integer,
    direction character varying(5),
    entry_zone numeric,
    stop_level numeric,
    t1_level numeric,
    t1_label character varying(100),
    structural_level character varying(60),
    resolution character varying(20),
    price_at_resolution numeric,
    historical_win_rate numeric,
    historical_sessions integer,
    window_duration_minutes integer,
    signal_type character varying(20),
    signal_price numeric,
    signal_quality character varying(10),
    alert_type character varying(60),
    conditions_met integer,
    notes text,
    created_at timestamp without time zone,
    updated_at timestamp without time zone
);


--
-- Name: trades_backup_20260716; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.trades_backup_20260716 (
    id integer,
    log_date date,
    entry_time timestamp without time zone,
    exit_time timestamp without time zone,
    symbol character varying(20),
    direction character varying(10),
    quantity integer,
    entry_price numeric(10,2),
    exit_price numeric(10,2),
    stop_loss numeric(10,2),
    target numeric(10,2),
    pnl numeric(10,2),
    fees numeric(10,2),
    setup_type character varying(100),
    trade_notes text,
    mistakes text,
    emotional_state character varying(50),
    risk_reward_ratio numeric(5,2),
    tags text[],
    custom_fields jsonb,
    created_at timestamp without time zone,
    updated_at timestamp without time zone,
    acd_signal character varying(20),
    acd_number_line_at_entry integer,
    acd_monthly_bias character varying(20),
    wyckoff_setup character varying(30),
    spring_volume_type character varying(10),
    support_resistance_level numeric,
    follow_through boolean,
    level_proximity jsonb
);


--
-- Name: trades_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.trades_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: trades_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.trades_id_seq OWNED BY public.trades.id;


--
-- Name: trades_level_proximity_backup_20260717; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.trades_level_proximity_backup_20260717 (
    id integer,
    level_proximity jsonb
);


--
-- Name: trades_level_proximity_backup_20260717_pre_atr_scale; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.trades_level_proximity_backup_20260717_pre_atr_scale (
    id integer,
    level_proximity jsonb
);


--
-- Name: trading_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.trading_sessions (
    id integer NOT NULL,
    session_date date DEFAULT CURRENT_DATE,
    opening_account_value numeric,
    daily_loss_limit_pct numeric DEFAULT 2.0,
    session_closed boolean DEFAULT false,
    closed_reason character varying,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: trading_sessions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.trading_sessions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: trading_sessions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.trading_sessions_id_seq OWNED BY public.trading_sessions.id;


--
-- Name: value_area_regime_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.value_area_regime_snapshots (
    id integer NOT NULL,
    snapshot_date date NOT NULL,
    lookback_days integer NOT NULL,
    vah numeric(10,2),
    val numeric(10,2),
    poc numeric(10,2),
    total_vol numeric(14,2),
    computed_at timestamp without time zone DEFAULT now()
);


--
-- Name: value_area_regime_snapshots_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.value_area_regime_snapshots_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: value_area_regime_snapshots_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.value_area_regime_snapshots_id_seq OWNED BY public.value_area_regime_snapshots.id;


--
-- Name: vol_backtest_cache; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vol_backtest_cache (
    id integer NOT NULL,
    run_at timestamp without time zone DEFAULT now(),
    session_count integer NOT NULL,
    results jsonb NOT NULL
);


--
-- Name: vol_backtest_cache_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.vol_backtest_cache_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: vol_backtest_cache_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.vol_backtest_cache_id_seq OWNED BY public.vol_backtest_cache.id;


--
-- Name: weekly_assessments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.weekly_assessments (
    id integer NOT NULL,
    week_start date NOT NULL,
    week_end date NOT NULL,
    total_trades integer,
    winning_days integer,
    losing_days integer,
    total_pnl numeric,
    best_day_pnl numeric,
    worst_day_pnl numeric,
    avg_daily_pnl numeric,
    setups_fired integer,
    setups_taken integer,
    setups_hit_t1 integer,
    coaching_themes text,
    assessment_text text,
    process_grade character varying(2),
    days_with_morning_prep integer,
    days_with_trades integer,
    created_at timestamp without time zone DEFAULT now(),
    report_text text
);


--
-- Name: weekly_assessments_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.weekly_assessments_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: weekly_assessments_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.weekly_assessments_id_seq OWNED BY public.weekly_assessments.id;


--
-- Name: weekly_ib_structure; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.weekly_ib_structure (
    id integer NOT NULL,
    week_start date NOT NULL,
    monday_high numeric,
    monday_low numeric,
    normal_week_upper numeric,
    normal_week_lower numeric,
    normal_var_upper numeric,
    normal_var_lower numeric,
    week_high numeric,
    week_low numeric,
    week_close numeric,
    week_type character varying(30),
    direction character varying(5),
    acd_number_line_monday integer,
    monthly_pivot_bias character varying(15),
    notes text,
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: weekly_ib_structure_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.weekly_ib_structure_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: weekly_ib_structure_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.weekly_ib_structure_id_seq OWNED BY public.weekly_ib_structure.id;


--
-- Name: price_bars_2022_12; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars ATTACH PARTITION public.price_bars_2022_12 FOR VALUES FROM ('2022-12-01 00:00:00') TO ('2023-01-01 00:00:00');


--
-- Name: price_bars_2023_01; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars ATTACH PARTITION public.price_bars_2023_01 FOR VALUES FROM ('2023-01-01 00:00:00') TO ('2023-02-01 00:00:00');


--
-- Name: price_bars_2023_02; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars ATTACH PARTITION public.price_bars_2023_02 FOR VALUES FROM ('2023-02-01 00:00:00') TO ('2023-03-01 00:00:00');


--
-- Name: price_bars_2023_03; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars ATTACH PARTITION public.price_bars_2023_03 FOR VALUES FROM ('2023-03-01 00:00:00') TO ('2023-04-01 00:00:00');


--
-- Name: price_bars_2023_04; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars ATTACH PARTITION public.price_bars_2023_04 FOR VALUES FROM ('2023-04-01 00:00:00') TO ('2023-05-01 00:00:00');


--
-- Name: price_bars_2023_05; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars ATTACH PARTITION public.price_bars_2023_05 FOR VALUES FROM ('2023-05-01 00:00:00') TO ('2023-06-01 00:00:00');


--
-- Name: price_bars_2023_06; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars ATTACH PARTITION public.price_bars_2023_06 FOR VALUES FROM ('2023-06-01 00:00:00') TO ('2023-07-01 00:00:00');


--
-- Name: price_bars_2023_07; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars ATTACH PARTITION public.price_bars_2023_07 FOR VALUES FROM ('2023-07-01 00:00:00') TO ('2023-08-01 00:00:00');


--
-- Name: price_bars_2023_08; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars ATTACH PARTITION public.price_bars_2023_08 FOR VALUES FROM ('2023-08-01 00:00:00') TO ('2023-09-01 00:00:00');


--
-- Name: price_bars_2023_09; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars ATTACH PARTITION public.price_bars_2023_09 FOR VALUES FROM ('2023-09-01 00:00:00') TO ('2023-10-01 00:00:00');


--
-- Name: price_bars_2023_10; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars ATTACH PARTITION public.price_bars_2023_10 FOR VALUES FROM ('2023-10-01 00:00:00') TO ('2023-11-01 00:00:00');


--
-- Name: price_bars_2023_11; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars ATTACH PARTITION public.price_bars_2023_11 FOR VALUES FROM ('2023-11-01 00:00:00') TO ('2023-12-01 00:00:00');


--
-- Name: price_bars_2023_12; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars ATTACH PARTITION public.price_bars_2023_12 FOR VALUES FROM ('2023-12-01 00:00:00') TO ('2024-01-01 00:00:00');


--
-- Name: price_bars_2024_01; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars ATTACH PARTITION public.price_bars_2024_01 FOR VALUES FROM ('2024-01-01 00:00:00') TO ('2024-02-01 00:00:00');


--
-- Name: price_bars_2024_02; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars ATTACH PARTITION public.price_bars_2024_02 FOR VALUES FROM ('2024-02-01 00:00:00') TO ('2024-03-01 00:00:00');


--
-- Name: price_bars_2024_03; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars ATTACH PARTITION public.price_bars_2024_03 FOR VALUES FROM ('2024-03-01 00:00:00') TO ('2024-04-01 00:00:00');


--
-- Name: price_bars_2024_04; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars ATTACH PARTITION public.price_bars_2024_04 FOR VALUES FROM ('2024-04-01 00:00:00') TO ('2024-05-01 00:00:00');


--
-- Name: price_bars_2024_05; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars ATTACH PARTITION public.price_bars_2024_05 FOR VALUES FROM ('2024-05-01 00:00:00') TO ('2024-06-01 00:00:00');


--
-- Name: price_bars_2024_06; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars ATTACH PARTITION public.price_bars_2024_06 FOR VALUES FROM ('2024-06-01 00:00:00') TO ('2024-07-01 00:00:00');


--
-- Name: price_bars_2024_07; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars ATTACH PARTITION public.price_bars_2024_07 FOR VALUES FROM ('2024-07-01 00:00:00') TO ('2024-08-01 00:00:00');


--
-- Name: price_bars_2024_08; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars ATTACH PARTITION public.price_bars_2024_08 FOR VALUES FROM ('2024-08-01 00:00:00') TO ('2024-09-01 00:00:00');


--
-- Name: price_bars_2024_09; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars ATTACH PARTITION public.price_bars_2024_09 FOR VALUES FROM ('2024-09-01 00:00:00') TO ('2024-10-01 00:00:00');


--
-- Name: price_bars_2024_10; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars ATTACH PARTITION public.price_bars_2024_10 FOR VALUES FROM ('2024-10-01 00:00:00') TO ('2024-11-01 00:00:00');


--
-- Name: price_bars_2024_11; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars ATTACH PARTITION public.price_bars_2024_11 FOR VALUES FROM ('2024-11-01 00:00:00') TO ('2024-12-01 00:00:00');


--
-- Name: price_bars_2024_12; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars ATTACH PARTITION public.price_bars_2024_12 FOR VALUES FROM ('2024-12-01 00:00:00') TO ('2025-01-01 00:00:00');


--
-- Name: price_bars_2025_01; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars ATTACH PARTITION public.price_bars_2025_01 FOR VALUES FROM ('2025-01-01 00:00:00') TO ('2025-02-01 00:00:00');


--
-- Name: price_bars_2025_02; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars ATTACH PARTITION public.price_bars_2025_02 FOR VALUES FROM ('2025-02-01 00:00:00') TO ('2025-03-01 00:00:00');


--
-- Name: price_bars_2025_03; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars ATTACH PARTITION public.price_bars_2025_03 FOR VALUES FROM ('2025-03-01 00:00:00') TO ('2025-04-01 00:00:00');


--
-- Name: price_bars_2025_04; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars ATTACH PARTITION public.price_bars_2025_04 FOR VALUES FROM ('2025-04-01 00:00:00') TO ('2025-05-01 00:00:00');


--
-- Name: price_bars_2025_05; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars ATTACH PARTITION public.price_bars_2025_05 FOR VALUES FROM ('2025-05-01 00:00:00') TO ('2025-06-01 00:00:00');


--
-- Name: price_bars_2025_06; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars ATTACH PARTITION public.price_bars_2025_06 FOR VALUES FROM ('2025-06-01 00:00:00') TO ('2025-07-01 00:00:00');


--
-- Name: price_bars_2025_07; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars ATTACH PARTITION public.price_bars_2025_07 FOR VALUES FROM ('2025-07-01 00:00:00') TO ('2025-08-01 00:00:00');


--
-- Name: price_bars_2025_08; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars ATTACH PARTITION public.price_bars_2025_08 FOR VALUES FROM ('2025-08-01 00:00:00') TO ('2025-09-01 00:00:00');


--
-- Name: price_bars_2025_09; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars ATTACH PARTITION public.price_bars_2025_09 FOR VALUES FROM ('2025-09-01 00:00:00') TO ('2025-10-01 00:00:00');


--
-- Name: price_bars_2025_10; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars ATTACH PARTITION public.price_bars_2025_10 FOR VALUES FROM ('2025-10-01 00:00:00') TO ('2025-11-01 00:00:00');


--
-- Name: price_bars_2025_11; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars ATTACH PARTITION public.price_bars_2025_11 FOR VALUES FROM ('2025-11-01 00:00:00') TO ('2025-12-01 00:00:00');


--
-- Name: price_bars_2025_12; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars ATTACH PARTITION public.price_bars_2025_12 FOR VALUES FROM ('2025-12-01 00:00:00') TO ('2026-01-01 00:00:00');


--
-- Name: price_bars_2026_01; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars ATTACH PARTITION public.price_bars_2026_01 FOR VALUES FROM ('2026-01-01 00:00:00') TO ('2026-02-01 00:00:00');


--
-- Name: price_bars_2026_02; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars ATTACH PARTITION public.price_bars_2026_02 FOR VALUES FROM ('2026-02-01 00:00:00') TO ('2026-03-01 00:00:00');


--
-- Name: price_bars_2026_03; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars ATTACH PARTITION public.price_bars_2026_03 FOR VALUES FROM ('2026-03-01 00:00:00') TO ('2026-04-01 00:00:00');


--
-- Name: price_bars_2026_04; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars ATTACH PARTITION public.price_bars_2026_04 FOR VALUES FROM ('2026-04-01 00:00:00') TO ('2026-05-01 00:00:00');


--
-- Name: price_bars_2026_05; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars ATTACH PARTITION public.price_bars_2026_05 FOR VALUES FROM ('2026-05-01 00:00:00') TO ('2026-06-01 00:00:00');


--
-- Name: price_bars_2026_06; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars ATTACH PARTITION public.price_bars_2026_06 FOR VALUES FROM ('2026-06-01 00:00:00') TO ('2026-07-01 00:00:00');


--
-- Name: price_bars_2026_07; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars ATTACH PARTITION public.price_bars_2026_07 FOR VALUES FROM ('2026-07-01 00:00:00') TO ('2026-08-01 00:00:00');


--
-- Name: price_bars_2026_08; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars ATTACH PARTITION public.price_bars_2026_08 FOR VALUES FROM ('2026-08-01 00:00:00') TO ('2026-09-01 00:00:00');


--
-- Name: price_bars_2026_09; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars ATTACH PARTITION public.price_bars_2026_09 FOR VALUES FROM ('2026-09-01 00:00:00') TO ('2026-10-01 00:00:00');


--
-- Name: price_bars_2026_10; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars ATTACH PARTITION public.price_bars_2026_10 FOR VALUES FROM ('2026-10-01 00:00:00') TO ('2026-11-01 00:00:00');


--
-- Name: price_bars_2026_11; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars ATTACH PARTITION public.price_bars_2026_11 FOR VALUES FROM ('2026-11-01 00:00:00') TO ('2026-12-01 00:00:00');


--
-- Name: price_bars_2026_12; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars ATTACH PARTITION public.price_bars_2026_12 FOR VALUES FROM ('2026-12-01 00:00:00') TO ('2027-01-01 00:00:00');


--
-- Name: price_bars_2027_01; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars ATTACH PARTITION public.price_bars_2027_01 FOR VALUES FROM ('2027-01-01 00:00:00') TO ('2027-02-01 00:00:00');


--
-- Name: price_bars_2027_02; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars ATTACH PARTITION public.price_bars_2027_02 FOR VALUES FROM ('2027-02-01 00:00:00') TO ('2027-03-01 00:00:00');


--
-- Name: price_bars_2027_03; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars ATTACH PARTITION public.price_bars_2027_03 FOR VALUES FROM ('2027-03-01 00:00:00') TO ('2027-04-01 00:00:00');


--
-- Name: price_bars_2027_04; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars ATTACH PARTITION public.price_bars_2027_04 FOR VALUES FROM ('2027-04-01 00:00:00') TO ('2027-05-01 00:00:00');


--
-- Name: price_bars_2027_05; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars ATTACH PARTITION public.price_bars_2027_05 FOR VALUES FROM ('2027-05-01 00:00:00') TO ('2027-06-01 00:00:00');


--
-- Name: price_bars_2027_06; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars ATTACH PARTITION public.price_bars_2027_06 FOR VALUES FROM ('2027-06-01 00:00:00') TO ('2027-07-01 00:00:00');


--
-- Name: price_bars_2027_07; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars ATTACH PARTITION public.price_bars_2027_07 FOR VALUES FROM ('2027-07-01 00:00:00') TO ('2027-08-01 00:00:00');


--
-- Name: price_bars_2027_08; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars ATTACH PARTITION public.price_bars_2027_08 FOR VALUES FROM ('2027-08-01 00:00:00') TO ('2027-09-01 00:00:00');


--
-- Name: price_bars_2027_09; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars ATTACH PARTITION public.price_bars_2027_09 FOR VALUES FROM ('2027-09-01 00:00:00') TO ('2027-10-01 00:00:00');


--
-- Name: price_bars_2027_10; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars ATTACH PARTITION public.price_bars_2027_10 FOR VALUES FROM ('2027-10-01 00:00:00') TO ('2027-11-01 00:00:00');


--
-- Name: price_bars_2027_11; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars ATTACH PARTITION public.price_bars_2027_11 FOR VALUES FROM ('2027-11-01 00:00:00') TO ('2027-12-01 00:00:00');


--
-- Name: price_bars_2027_12; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars ATTACH PARTITION public.price_bars_2027_12 FOR VALUES FROM ('2027-12-01 00:00:00') TO ('2028-01-01 00:00:00');


--
-- Name: account_settings id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_settings ALTER COLUMN id SET DEFAULT nextval('public.account_settings_id_seq'::regclass);


--
-- Name: acd_backtest_results id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.acd_backtest_results ALTER COLUMN id SET DEFAULT nextval('public.acd_backtest_results_id_seq'::regclass);


--
-- Name: acd_daily_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.acd_daily_log ALTER COLUMN id SET DEFAULT nextval('public.acd_daily_log_id_seq'::regclass);


--
-- Name: acd_monthly_pivot id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.acd_monthly_pivot ALTER COLUMN id SET DEFAULT nextval('public.acd_monthly_pivot_id_seq'::regclass);


--
-- Name: acd_setup_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.acd_setup_events ALTER COLUMN id SET DEFAULT nextval('public.acd_setup_events_id_seq'::regclass);


--
-- Name: acd_weekly_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.acd_weekly_log ALTER COLUMN id SET DEFAULT nextval('public.acd_weekly_log_id_seq'::regclass);


--
-- Name: active_setups id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.active_setups ALTER COLUMN id SET DEFAULT nextval('public.active_setups_id_seq'::regclass);


--
-- Name: ai_cost_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_cost_log ALTER COLUMN id SET DEFAULT nextval('public.ai_cost_log_id_seq'::regclass);


--
-- Name: auction_history id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auction_history ALTER COLUMN id SET DEFAULT nextval('public.auction_history_id_seq'::regclass);


--
-- Name: auction_reads id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auction_reads ALTER COLUMN id SET DEFAULT nextval('public.auction_reads_id_seq'::regclass);


--
-- Name: condition_memory id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.condition_memory ALTER COLUMN id SET DEFAULT nextval('public.condition_memory_id_seq'::regclass);


--
-- Name: custom_field_definitions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.custom_field_definitions ALTER COLUMN id SET DEFAULT nextval('public.custom_field_definitions_id_seq'::regclass);


--
-- Name: daily_ai_reviews id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_ai_reviews ALTER COLUMN id SET DEFAULT nextval('public.daily_ai_reviews_id_seq'::regclass);


--
-- Name: daily_coaching id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_coaching ALTER COLUMN id SET DEFAULT nextval('public.daily_coaching_id_seq'::regclass);


--
-- Name: daily_logs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_logs ALTER COLUMN id SET DEFAULT nextval('public.daily_logs_id_seq'::regclass);


--
-- Name: daily_performance_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_performance_log ALTER COLUMN id SET DEFAULT nextval('public.daily_performance_log_id_seq'::regclass);


--
-- Name: daytype_accuracy_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daytype_accuracy_log ALTER COLUMN id SET DEFAULT nextval('public.daytype_accuracy_log_id_seq'::regclass);


--
-- Name: developing_value_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.developing_value_log ALTER COLUMN id SET DEFAULT nextval('public.developing_value_log_id_seq'::regclass);


--
-- Name: dynamic_edges_mining id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dynamic_edges_mining ALTER COLUMN id SET DEFAULT nextval('public.dynamic_edges_mining_id_seq'::regclass);


--
-- Name: engine_reads id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.engine_reads ALTER COLUMN id SET DEFAULT nextval('public.engine_reads_id_seq'::regclass);


--
-- Name: gated_candidates id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gated_candidates ALTER COLUMN id SET DEFAULT nextval('public.gated_candidates_id_seq'::regclass);


--
-- Name: import_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_log ALTER COLUMN id SET DEFAULT nextval('public.import_log_id_seq'::regclass);


--
-- Name: learning_digest_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.learning_digest_events ALTER COLUMN id SET DEFAULT nextval('public.learning_digest_events_id_seq'::regclass);


--
-- Name: level_regime_performance id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.level_regime_performance ALTER COLUMN id SET DEFAULT nextval('public.level_regime_performance_id_seq'::regclass);


--
-- Name: live_reads id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.live_reads ALTER COLUMN id SET DEFAULT nextval('public.live_reads_id_seq'::regclass);


--
-- Name: macro_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.macro_events ALTER COLUMN id SET DEFAULT nextval('public.macro_events_id_seq'::regclass);


--
-- Name: monte_carlo_runs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.monte_carlo_runs ALTER COLUMN id SET DEFAULT nextval('public.monte_carlo_runs_id_seq'::regclass);


--
-- Name: morning_briefs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.morning_briefs ALTER COLUMN id SET DEFAULT nextval('public.morning_briefs_id_seq'::regclass);


--
-- Name: pattern_discoveries id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pattern_discoveries ALTER COLUMN id SET DEFAULT nextval('public.pattern_discoveries_id_seq'::regclass);


--
-- Name: pattern_stats id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pattern_stats ALTER COLUMN id SET DEFAULT nextval('public.pattern_stats_id_seq'::regclass);


--
-- Name: performance_audit id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.performance_audit ALTER COLUMN id SET DEFAULT nextval('public.performance_audit_id_seq'::regclass);


--
-- Name: phase_change_alerts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.phase_change_alerts ALTER COLUMN id SET DEFAULT nextval('public.phase_change_alerts_id_seq'::regclass);


--
-- Name: phase_change_backtest_results id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.phase_change_backtest_results ALTER COLUMN id SET DEFAULT nextval('public.phase_change_backtest_results_id_seq'::regclass);


--
-- Name: playbook_conversations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.playbook_conversations ALTER COLUMN id SET DEFAULT nextval('public.playbook_conversations_id_seq'::regclass);


--
-- Name: post_loss_cooldowns id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.post_loss_cooldowns ALTER COLUMN id SET DEFAULT nextval('public.post_loss_cooldowns_id_seq'::regclass);


--
-- Name: premarket_walkthroughs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.premarket_walkthroughs ALTER COLUMN id SET DEFAULT nextval('public.premarket_walkthroughs_id_seq'::regclass);


--
-- Name: price_bar_ingests id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bar_ingests ALTER COLUMN id SET DEFAULT nextval('public.price_bar_ingests_id_seq'::regclass);


--
-- Name: price_bars id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars ALTER COLUMN id SET DEFAULT nextval('public.price_bars_new_id_seq'::regclass);


--
-- Name: process_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.process_log ALTER COLUMN id SET DEFAULT nextval('public.process_log_id_seq'::regclass);


--
-- Name: profit_lock_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profit_lock_events ALTER COLUMN id SET DEFAULT nextval('public.profit_lock_events_id_seq'::regclass);


--
-- Name: risk_settings id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.risk_settings ALTER COLUMN id SET DEFAULT nextval('public.risk_settings_id_seq'::regclass);


--
-- Name: session_analysis id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session_analysis ALTER COLUMN id SET DEFAULT nextval('public.session_analysis_id_seq'::regclass);


--
-- Name: session_patterns id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session_patterns ALTER COLUMN id SET DEFAULT nextval('public.session_patterns_id_seq'::regclass);


--
-- Name: settings_todos id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.settings_todos ALTER COLUMN id SET DEFAULT nextval('public.settings_todos_id_seq'::regclass);


--
-- Name: setup_correlation_cache id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.setup_correlation_cache ALTER COLUMN id SET DEFAULT nextval('public.setup_correlation_cache_id_seq'::regclass);


--
-- Name: setup_move_stats id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.setup_move_stats ALTER COLUMN id SET DEFAULT nextval('public.setup_move_stats_id_seq'::regclass);


--
-- Name: setup_outcome_backtest id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.setup_outcome_backtest ALTER COLUMN id SET DEFAULT nextval('public.setup_outcome_backtest_id_seq'::regclass);


--
-- Name: setup_types id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.setup_types ALTER COLUMN id SET DEFAULT nextval('public.setup_types_id_seq'::regclass);


--
-- Name: trade_annotations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trade_annotations ALTER COLUMN id SET DEFAULT nextval('public.trade_annotations_id_seq'::regclass);


--
-- Name: trade_feedback id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trade_feedback ALTER COLUMN id SET DEFAULT nextval('public.trade_feedback_id_seq'::regclass);


--
-- Name: trade_timeline_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trade_timeline_events ALTER COLUMN id SET DEFAULT nextval('public.trade_timeline_events_id_seq'::regclass);


--
-- Name: trades id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trades ALTER COLUMN id SET DEFAULT nextval('public.trades_id_seq'::regclass);


--
-- Name: trading_sessions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trading_sessions ALTER COLUMN id SET DEFAULT nextval('public.trading_sessions_id_seq'::regclass);


--
-- Name: value_area_regime_snapshots id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.value_area_regime_snapshots ALTER COLUMN id SET DEFAULT nextval('public.value_area_regime_snapshots_id_seq'::regclass);


--
-- Name: vol_backtest_cache id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vol_backtest_cache ALTER COLUMN id SET DEFAULT nextval('public.vol_backtest_cache_id_seq'::regclass);


--
-- Name: weekly_assessments id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.weekly_assessments ALTER COLUMN id SET DEFAULT nextval('public.weekly_assessments_id_seq'::regclass);


--
-- Name: weekly_ib_structure id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.weekly_ib_structure ALTER COLUMN id SET DEFAULT nextval('public.weekly_ib_structure_id_seq'::regclass);


--
-- Name: account_settings account_settings_account_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_settings
    ADD CONSTRAINT account_settings_account_id_key UNIQUE (account_id);


--
-- Name: account_settings account_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_settings
    ADD CONSTRAINT account_settings_pkey PRIMARY KEY (id);


--
-- Name: acd_backtest_results acd_backtest_results_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.acd_backtest_results
    ADD CONSTRAINT acd_backtest_results_pkey PRIMARY KEY (id);


--
-- Name: acd_daily_log acd_daily_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.acd_daily_log
    ADD CONSTRAINT acd_daily_log_pkey PRIMARY KEY (id);


--
-- Name: acd_daily_log acd_daily_log_trade_date_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.acd_daily_log
    ADD CONSTRAINT acd_daily_log_trade_date_key UNIQUE (trade_date);


--
-- Name: acd_monthly_pivot acd_monthly_pivot_month_year_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.acd_monthly_pivot
    ADD CONSTRAINT acd_monthly_pivot_month_year_key UNIQUE (month_year);


--
-- Name: acd_monthly_pivot acd_monthly_pivot_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.acd_monthly_pivot
    ADD CONSTRAINT acd_monthly_pivot_pkey PRIMARY KEY (id);


--
-- Name: acd_setup_events acd_setup_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.acd_setup_events
    ADD CONSTRAINT acd_setup_events_pkey PRIMARY KEY (id);


--
-- Name: acd_setup_events acd_setup_events_trade_date_setup_type_fired_time_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.acd_setup_events
    ADD CONSTRAINT acd_setup_events_trade_date_setup_type_fired_time_key UNIQUE (trade_date, setup_type, fired_time);


--
-- Name: acd_weekly_log acd_weekly_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.acd_weekly_log
    ADD CONSTRAINT acd_weekly_log_pkey PRIMARY KEY (id);


--
-- Name: acd_weekly_log acd_weekly_log_week_start_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.acd_weekly_log
    ADD CONSTRAINT acd_weekly_log_week_start_key UNIQUE (week_start);


--
-- Name: active_setups active_setups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.active_setups
    ADD CONSTRAINT active_setups_pkey PRIMARY KEY (id);


--
-- Name: active_setups_resolution_bar_time_backup_20260727 active_setups_resolution_bar_time_backup_20260727_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.active_setups_resolution_bar_time_backup_20260727
    ADD CONSTRAINT active_setups_resolution_bar_time_backup_20260727_pkey PRIMARY KEY (id);


--
-- Name: ai_cost_log ai_cost_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_cost_log
    ADD CONSTRAINT ai_cost_log_pkey PRIMARY KEY (id);


--
-- Name: auction_history auction_history_date_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auction_history
    ADD CONSTRAINT auction_history_date_key UNIQUE (date);


--
-- Name: auction_history auction_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auction_history
    ADD CONSTRAINT auction_history_pkey PRIMARY KEY (id);


--
-- Name: auction_reads auction_reads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auction_reads
    ADD CONSTRAINT auction_reads_pkey PRIMARY KEY (id);


--
-- Name: auction_reads auction_reads_trade_date_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auction_reads
    ADD CONSTRAINT auction_reads_trade_date_key UNIQUE (trade_date);


--
-- Name: combo_stats combo_stats_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.combo_stats
    ADD CONSTRAINT combo_stats_pkey PRIMARY KEY (combo_id);


--
-- Name: condition_memory condition_memory_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.condition_memory
    ADD CONSTRAINT condition_memory_pkey PRIMARY KEY (id);


--
-- Name: condition_memory condition_memory_structural_state_nl30_bucket_opening_call__key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.condition_memory
    ADD CONSTRAINT condition_memory_structural_state_nl30_bucket_opening_call__key UNIQUE (structural_state, nl30_bucket, opening_call, a_signal_quality, confluence_bucket, counter_trend);


--
-- Name: custom_field_definitions custom_field_definitions_field_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.custom_field_definitions
    ADD CONSTRAINT custom_field_definitions_field_name_key UNIQUE (field_name);


--
-- Name: custom_field_definitions custom_field_definitions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.custom_field_definitions
    ADD CONSTRAINT custom_field_definitions_pkey PRIMARY KEY (id);


--
-- Name: daily_ai_reviews daily_ai_reviews_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_ai_reviews
    ADD CONSTRAINT daily_ai_reviews_pkey PRIMARY KEY (id);


--
-- Name: daily_ai_reviews daily_ai_reviews_review_date_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_ai_reviews
    ADD CONSTRAINT daily_ai_reviews_review_date_key UNIQUE (review_date);


--
-- Name: daily_charts daily_charts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_charts
    ADD CONSTRAINT daily_charts_pkey PRIMARY KEY (log_date);


--
-- Name: daily_coaching daily_coaching_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_coaching
    ADD CONSTRAINT daily_coaching_pkey PRIMARY KEY (id);


--
-- Name: daily_coaching daily_coaching_session_date_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_coaching
    ADD CONSTRAINT daily_coaching_session_date_key UNIQUE (session_date);


--
-- Name: daily_logs daily_logs_log_date_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_logs
    ADD CONSTRAINT daily_logs_log_date_key UNIQUE (log_date);


--
-- Name: daily_logs daily_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_logs
    ADD CONSTRAINT daily_logs_pkey PRIMARY KEY (id);


--
-- Name: daily_performance_log daily_performance_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_performance_log
    ADD CONSTRAINT daily_performance_log_pkey PRIMARY KEY (id);


--
-- Name: daily_performance_log daily_performance_log_trade_date_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_performance_log
    ADD CONSTRAINT daily_performance_log_trade_date_key UNIQUE (trade_date);


--
-- Name: daytype_accuracy_log daytype_accuracy_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daytype_accuracy_log
    ADD CONSTRAINT daytype_accuracy_log_pkey PRIMARY KEY (id);


--
-- Name: daytype_accuracy_log daytype_accuracy_log_trade_date_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daytype_accuracy_log
    ADD CONSTRAINT daytype_accuracy_log_trade_date_key UNIQUE (trade_date);


--
-- Name: developing_value_log developing_value_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.developing_value_log
    ADD CONSTRAINT developing_value_log_pkey PRIMARY KEY (id);


--
-- Name: developing_value_log developing_value_log_trade_date_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.developing_value_log
    ADD CONSTRAINT developing_value_log_trade_date_key UNIQUE (trade_date);


--
-- Name: dll_daily_events dll_daily_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dll_daily_events
    ADD CONSTRAINT dll_daily_events_pkey PRIMARY KEY (account_id, log_date);


--
-- Name: dynamic_edges_mining dynamic_edges_mining_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dynamic_edges_mining
    ADD CONSTRAINT dynamic_edges_mining_pkey PRIMARY KEY (id);


--
-- Name: engine_reads engine_reads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.engine_reads
    ADD CONSTRAINT engine_reads_pkey PRIMARY KEY (id);


--
-- Name: engine_reads engine_reads_trade_date_read_type_signal_value_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.engine_reads
    ADD CONSTRAINT engine_reads_trade_date_read_type_signal_value_key UNIQUE (trade_date, read_type, signal_value);


--
-- Name: gated_candidates gated_candidates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gated_candidates
    ADD CONSTRAINT gated_candidates_pkey PRIMARY KEY (id);


--
-- Name: import_log import_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_log
    ADD CONSTRAINT import_log_pkey PRIMARY KEY (id);


--
-- Name: learning_digest_events learning_digest_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.learning_digest_events
    ADD CONSTRAINT learning_digest_events_pkey PRIMARY KEY (id);


--
-- Name: level_prices level_prices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.level_prices
    ADD CONSTRAINT level_prices_pkey PRIMARY KEY (trade_date, level_name);


--
-- Name: level_regime_performance level_regime_performance_level_name_vol_regime_dir_regime_r_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.level_regime_performance
    ADD CONSTRAINT level_regime_performance_level_name_vol_regime_dir_regime_r_key UNIQUE (level_name, vol_regime, dir_regime, range_regime);


--
-- Name: level_regime_performance level_regime_performance_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.level_regime_performance
    ADD CONSTRAINT level_regime_performance_pkey PRIMARY KEY (id);


--
-- Name: live_reads live_reads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.live_reads
    ADD CONSTRAINT live_reads_pkey PRIMARY KEY (id);


--
-- Name: macro_events macro_events_event_date_event_type_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.macro_events
    ADD CONSTRAINT macro_events_event_date_event_type_key UNIQUE (event_date, event_type);


--
-- Name: macro_events macro_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.macro_events
    ADD CONSTRAINT macro_events_pkey PRIMARY KEY (id);


--
-- Name: monte_carlo_runs monte_carlo_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.monte_carlo_runs
    ADD CONSTRAINT monte_carlo_runs_pkey PRIMARY KEY (id);


--
-- Name: morning_briefs morning_briefs_brief_date_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.morning_briefs
    ADD CONSTRAINT morning_briefs_brief_date_key UNIQUE (brief_date);


--
-- Name: morning_briefs morning_briefs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.morning_briefs
    ADD CONSTRAINT morning_briefs_pkey PRIMARY KEY (id);


--
-- Name: pattern_discoveries pattern_discoveries_pattern_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pattern_discoveries
    ADD CONSTRAINT pattern_discoveries_pattern_key_key UNIQUE (pattern_key);


--
-- Name: pattern_discoveries pattern_discoveries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pattern_discoveries
    ADD CONSTRAINT pattern_discoveries_pkey PRIMARY KEY (id);


--
-- Name: pattern_stats pattern_stats_calculated_date_lookback_days_structural_stat_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pattern_stats
    ADD CONSTRAINT pattern_stats_calculated_date_lookback_days_structural_stat_key UNIQUE (calculated_date, lookback_days, structural_state);


--
-- Name: pattern_stats pattern_stats_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pattern_stats
    ADD CONSTRAINT pattern_stats_pkey PRIMARY KEY (id);


--
-- Name: performance_audit performance_audit_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.performance_audit
    ADD CONSTRAINT performance_audit_pkey PRIMARY KEY (id);


--
-- Name: performance_audit performance_audit_run_date_window_days_signal_type_signal_n_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.performance_audit
    ADD CONSTRAINT performance_audit_run_date_window_days_signal_type_signal_n_key UNIQUE (run_date, window_days, signal_type, signal_name);


--
-- Name: phase_change_alerts phase_change_alerts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.phase_change_alerts
    ADD CONSTRAINT phase_change_alerts_pkey PRIMARY KEY (id);


--
-- Name: phase_change_backtest_results phase_change_backtest_results_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.phase_change_backtest_results
    ADD CONSTRAINT phase_change_backtest_results_pkey PRIMARY KEY (id);


--
-- Name: playbook_conversations playbook_conversations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.playbook_conversations
    ADD CONSTRAINT playbook_conversations_pkey PRIMARY KEY (id);


--
-- Name: post_loss_cooldowns post_loss_cooldowns_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.post_loss_cooldowns
    ADD CONSTRAINT post_loss_cooldowns_pkey PRIMARY KEY (id);


--
-- Name: premarket_walkthroughs premarket_walkthroughs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.premarket_walkthroughs
    ADD CONSTRAINT premarket_walkthroughs_pkey PRIMARY KEY (id);


--
-- Name: premarket_walkthroughs premarket_walkthroughs_trade_date_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.premarket_walkthroughs
    ADD CONSTRAINT premarket_walkthroughs_trade_date_key UNIQUE (trade_date);


--
-- Name: price_bar_ingests price_bar_ingests_filename_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bar_ingests
    ADD CONSTRAINT price_bar_ingests_filename_key UNIQUE (filename);


--
-- Name: price_bar_ingests price_bar_ingests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bar_ingests
    ADD CONSTRAINT price_bar_ingests_pkey PRIMARY KEY (id);


--
-- Name: price_bars price_bars_new_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars
    ADD CONSTRAINT price_bars_new_pkey PRIMARY KEY (contract, ts);


--
-- Name: price_bars_2022_12 price_bars_2022_12_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars_2022_12
    ADD CONSTRAINT price_bars_2022_12_pkey PRIMARY KEY (contract, ts);


--
-- Name: price_bars_2023_01 price_bars_2023_01_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars_2023_01
    ADD CONSTRAINT price_bars_2023_01_pkey PRIMARY KEY (contract, ts);


--
-- Name: price_bars_2023_02 price_bars_2023_02_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars_2023_02
    ADD CONSTRAINT price_bars_2023_02_pkey PRIMARY KEY (contract, ts);


--
-- Name: price_bars_2023_03 price_bars_2023_03_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars_2023_03
    ADD CONSTRAINT price_bars_2023_03_pkey PRIMARY KEY (contract, ts);


--
-- Name: price_bars_2023_04 price_bars_2023_04_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars_2023_04
    ADD CONSTRAINT price_bars_2023_04_pkey PRIMARY KEY (contract, ts);


--
-- Name: price_bars_2023_05 price_bars_2023_05_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars_2023_05
    ADD CONSTRAINT price_bars_2023_05_pkey PRIMARY KEY (contract, ts);


--
-- Name: price_bars_2023_06 price_bars_2023_06_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars_2023_06
    ADD CONSTRAINT price_bars_2023_06_pkey PRIMARY KEY (contract, ts);


--
-- Name: price_bars_2023_07 price_bars_2023_07_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars_2023_07
    ADD CONSTRAINT price_bars_2023_07_pkey PRIMARY KEY (contract, ts);


--
-- Name: price_bars_2023_08 price_bars_2023_08_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars_2023_08
    ADD CONSTRAINT price_bars_2023_08_pkey PRIMARY KEY (contract, ts);


--
-- Name: price_bars_2023_09 price_bars_2023_09_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars_2023_09
    ADD CONSTRAINT price_bars_2023_09_pkey PRIMARY KEY (contract, ts);


--
-- Name: price_bars_2023_10 price_bars_2023_10_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars_2023_10
    ADD CONSTRAINT price_bars_2023_10_pkey PRIMARY KEY (contract, ts);


--
-- Name: price_bars_2023_11 price_bars_2023_11_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars_2023_11
    ADD CONSTRAINT price_bars_2023_11_pkey PRIMARY KEY (contract, ts);


--
-- Name: price_bars_2023_12 price_bars_2023_12_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars_2023_12
    ADD CONSTRAINT price_bars_2023_12_pkey PRIMARY KEY (contract, ts);


--
-- Name: price_bars_2024_01 price_bars_2024_01_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars_2024_01
    ADD CONSTRAINT price_bars_2024_01_pkey PRIMARY KEY (contract, ts);


--
-- Name: price_bars_2024_02 price_bars_2024_02_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars_2024_02
    ADD CONSTRAINT price_bars_2024_02_pkey PRIMARY KEY (contract, ts);


--
-- Name: price_bars_2024_03 price_bars_2024_03_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars_2024_03
    ADD CONSTRAINT price_bars_2024_03_pkey PRIMARY KEY (contract, ts);


--
-- Name: price_bars_2024_04 price_bars_2024_04_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars_2024_04
    ADD CONSTRAINT price_bars_2024_04_pkey PRIMARY KEY (contract, ts);


--
-- Name: price_bars_2024_05 price_bars_2024_05_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars_2024_05
    ADD CONSTRAINT price_bars_2024_05_pkey PRIMARY KEY (contract, ts);


--
-- Name: price_bars_2024_06 price_bars_2024_06_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars_2024_06
    ADD CONSTRAINT price_bars_2024_06_pkey PRIMARY KEY (contract, ts);


--
-- Name: price_bars_2024_07 price_bars_2024_07_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars_2024_07
    ADD CONSTRAINT price_bars_2024_07_pkey PRIMARY KEY (contract, ts);


--
-- Name: price_bars_2024_08 price_bars_2024_08_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars_2024_08
    ADD CONSTRAINT price_bars_2024_08_pkey PRIMARY KEY (contract, ts);


--
-- Name: price_bars_2024_09 price_bars_2024_09_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars_2024_09
    ADD CONSTRAINT price_bars_2024_09_pkey PRIMARY KEY (contract, ts);


--
-- Name: price_bars_2024_10 price_bars_2024_10_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars_2024_10
    ADD CONSTRAINT price_bars_2024_10_pkey PRIMARY KEY (contract, ts);


--
-- Name: price_bars_2024_11 price_bars_2024_11_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars_2024_11
    ADD CONSTRAINT price_bars_2024_11_pkey PRIMARY KEY (contract, ts);


--
-- Name: price_bars_2024_12 price_bars_2024_12_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars_2024_12
    ADD CONSTRAINT price_bars_2024_12_pkey PRIMARY KEY (contract, ts);


--
-- Name: price_bars_2025_01 price_bars_2025_01_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars_2025_01
    ADD CONSTRAINT price_bars_2025_01_pkey PRIMARY KEY (contract, ts);


--
-- Name: price_bars_2025_02 price_bars_2025_02_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars_2025_02
    ADD CONSTRAINT price_bars_2025_02_pkey PRIMARY KEY (contract, ts);


--
-- Name: price_bars_2025_03 price_bars_2025_03_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars_2025_03
    ADD CONSTRAINT price_bars_2025_03_pkey PRIMARY KEY (contract, ts);


--
-- Name: price_bars_2025_04 price_bars_2025_04_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars_2025_04
    ADD CONSTRAINT price_bars_2025_04_pkey PRIMARY KEY (contract, ts);


--
-- Name: price_bars_2025_05 price_bars_2025_05_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars_2025_05
    ADD CONSTRAINT price_bars_2025_05_pkey PRIMARY KEY (contract, ts);


--
-- Name: price_bars_2025_06 price_bars_2025_06_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars_2025_06
    ADD CONSTRAINT price_bars_2025_06_pkey PRIMARY KEY (contract, ts);


--
-- Name: price_bars_2025_07 price_bars_2025_07_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars_2025_07
    ADD CONSTRAINT price_bars_2025_07_pkey PRIMARY KEY (contract, ts);


--
-- Name: price_bars_2025_08 price_bars_2025_08_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars_2025_08
    ADD CONSTRAINT price_bars_2025_08_pkey PRIMARY KEY (contract, ts);


--
-- Name: price_bars_2025_09 price_bars_2025_09_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars_2025_09
    ADD CONSTRAINT price_bars_2025_09_pkey PRIMARY KEY (contract, ts);


--
-- Name: price_bars_2025_10 price_bars_2025_10_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars_2025_10
    ADD CONSTRAINT price_bars_2025_10_pkey PRIMARY KEY (contract, ts);


--
-- Name: price_bars_2025_11 price_bars_2025_11_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars_2025_11
    ADD CONSTRAINT price_bars_2025_11_pkey PRIMARY KEY (contract, ts);


--
-- Name: price_bars_2025_12 price_bars_2025_12_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars_2025_12
    ADD CONSTRAINT price_bars_2025_12_pkey PRIMARY KEY (contract, ts);


--
-- Name: price_bars_2026_01 price_bars_2026_01_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars_2026_01
    ADD CONSTRAINT price_bars_2026_01_pkey PRIMARY KEY (contract, ts);


--
-- Name: price_bars_2026_02 price_bars_2026_02_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars_2026_02
    ADD CONSTRAINT price_bars_2026_02_pkey PRIMARY KEY (contract, ts);


--
-- Name: price_bars_2026_03 price_bars_2026_03_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars_2026_03
    ADD CONSTRAINT price_bars_2026_03_pkey PRIMARY KEY (contract, ts);


--
-- Name: price_bars_2026_04 price_bars_2026_04_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars_2026_04
    ADD CONSTRAINT price_bars_2026_04_pkey PRIMARY KEY (contract, ts);


--
-- Name: price_bars_2026_05 price_bars_2026_05_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars_2026_05
    ADD CONSTRAINT price_bars_2026_05_pkey PRIMARY KEY (contract, ts);


--
-- Name: price_bars_2026_06 price_bars_2026_06_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars_2026_06
    ADD CONSTRAINT price_bars_2026_06_pkey PRIMARY KEY (contract, ts);


--
-- Name: price_bars_2026_07 price_bars_2026_07_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars_2026_07
    ADD CONSTRAINT price_bars_2026_07_pkey PRIMARY KEY (contract, ts);


--
-- Name: price_bars_2026_08 price_bars_2026_08_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars_2026_08
    ADD CONSTRAINT price_bars_2026_08_pkey PRIMARY KEY (contract, ts);


--
-- Name: price_bars_2026_09 price_bars_2026_09_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars_2026_09
    ADD CONSTRAINT price_bars_2026_09_pkey PRIMARY KEY (contract, ts);


--
-- Name: price_bars_2026_10 price_bars_2026_10_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars_2026_10
    ADD CONSTRAINT price_bars_2026_10_pkey PRIMARY KEY (contract, ts);


--
-- Name: price_bars_2026_11 price_bars_2026_11_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars_2026_11
    ADD CONSTRAINT price_bars_2026_11_pkey PRIMARY KEY (contract, ts);


--
-- Name: price_bars_2026_12 price_bars_2026_12_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars_2026_12
    ADD CONSTRAINT price_bars_2026_12_pkey PRIMARY KEY (contract, ts);


--
-- Name: price_bars_2027_01 price_bars_2027_01_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars_2027_01
    ADD CONSTRAINT price_bars_2027_01_pkey PRIMARY KEY (contract, ts);


--
-- Name: price_bars_2027_02 price_bars_2027_02_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars_2027_02
    ADD CONSTRAINT price_bars_2027_02_pkey PRIMARY KEY (contract, ts);


--
-- Name: price_bars_2027_03 price_bars_2027_03_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars_2027_03
    ADD CONSTRAINT price_bars_2027_03_pkey PRIMARY KEY (contract, ts);


--
-- Name: price_bars_2027_04 price_bars_2027_04_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars_2027_04
    ADD CONSTRAINT price_bars_2027_04_pkey PRIMARY KEY (contract, ts);


--
-- Name: price_bars_2027_05 price_bars_2027_05_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars_2027_05
    ADD CONSTRAINT price_bars_2027_05_pkey PRIMARY KEY (contract, ts);


--
-- Name: price_bars_2027_06 price_bars_2027_06_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars_2027_06
    ADD CONSTRAINT price_bars_2027_06_pkey PRIMARY KEY (contract, ts);


--
-- Name: price_bars_2027_07 price_bars_2027_07_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars_2027_07
    ADD CONSTRAINT price_bars_2027_07_pkey PRIMARY KEY (contract, ts);


--
-- Name: price_bars_2027_08 price_bars_2027_08_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars_2027_08
    ADD CONSTRAINT price_bars_2027_08_pkey PRIMARY KEY (contract, ts);


--
-- Name: price_bars_2027_09 price_bars_2027_09_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars_2027_09
    ADD CONSTRAINT price_bars_2027_09_pkey PRIMARY KEY (contract, ts);


--
-- Name: price_bars_2027_10 price_bars_2027_10_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars_2027_10
    ADD CONSTRAINT price_bars_2027_10_pkey PRIMARY KEY (contract, ts);


--
-- Name: price_bars_2027_11 price_bars_2027_11_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars_2027_11
    ADD CONSTRAINT price_bars_2027_11_pkey PRIMARY KEY (contract, ts);


--
-- Name: price_bars_2027_12 price_bars_2027_12_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars_2027_12
    ADD CONSTRAINT price_bars_2027_12_pkey PRIMARY KEY (contract, ts);


--
-- Name: price_bars_contract_calendar price_bars_contract_calendar_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_bars_contract_calendar
    ADD CONSTRAINT price_bars_contract_calendar_pkey PRIMARY KEY (symbol, trade_date);


--
-- Name: process_log process_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.process_log
    ADD CONSTRAINT process_log_pkey PRIMARY KEY (id);


--
-- Name: profit_lock_config profit_lock_config_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profit_lock_config
    ADD CONSTRAINT profit_lock_config_pkey PRIMARY KEY (id);


--
-- Name: profit_lock_events profit_lock_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profit_lock_events
    ADD CONSTRAINT profit_lock_events_pkey PRIMARY KEY (id);


--
-- Name: risk_settings risk_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.risk_settings
    ADD CONSTRAINT risk_settings_pkey PRIMARY KEY (id);


--
-- Name: session_analysis session_analysis_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session_analysis
    ADD CONSTRAINT session_analysis_pkey PRIMARY KEY (id);


--
-- Name: session_analysis session_analysis_trade_date_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session_analysis
    ADD CONSTRAINT session_analysis_trade_date_key UNIQUE (trade_date);


--
-- Name: session_patterns session_patterns_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session_patterns
    ADD CONSTRAINT session_patterns_pkey PRIMARY KEY (id);


--
-- Name: settings_todos settings_todos_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.settings_todos
    ADD CONSTRAINT settings_todos_pkey PRIMARY KEY (id);


--
-- Name: setup_correlation_cache setup_correlation_cache_bias_dir_setup_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.setup_correlation_cache
    ADD CONSTRAINT setup_correlation_cache_bias_dir_setup_key_key UNIQUE (bias_dir, setup_key);


--
-- Name: setup_correlation_cache setup_correlation_cache_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.setup_correlation_cache
    ADD CONSTRAINT setup_correlation_cache_pkey PRIMARY KEY (id);


--
-- Name: setup_daytype_winrates setup_daytype_winrates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.setup_daytype_winrates
    ADD CONSTRAINT setup_daytype_winrates_pkey PRIMARY KEY (setup_type, day_type, computed_date);


--
-- Name: setup_move_stats setup_move_stats_calculated_date_setup_type_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.setup_move_stats
    ADD CONSTRAINT setup_move_stats_calculated_date_setup_type_key UNIQUE (calculated_date, setup_type);


--
-- Name: setup_move_stats setup_move_stats_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.setup_move_stats
    ADD CONSTRAINT setup_move_stats_pkey PRIMARY KEY (id);


--
-- Name: setup_outcome_backtest setup_outcome_backtest_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.setup_outcome_backtest
    ADD CONSTRAINT setup_outcome_backtest_pkey PRIMARY KEY (id);


--
-- Name: setup_outcome_backtest setup_outcome_backtest_setup_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.setup_outcome_backtest
    ADD CONSTRAINT setup_outcome_backtest_setup_id_key UNIQUE (setup_id);


--
-- Name: setup_types setup_types_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.setup_types
    ADD CONSTRAINT setup_types_name_key UNIQUE (name);


--
-- Name: setup_types setup_types_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.setup_types
    ADD CONSTRAINT setup_types_pkey PRIMARY KEY (id);


--
-- Name: trade_annotations trade_annotations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trade_annotations
    ADD CONSTRAINT trade_annotations_pkey PRIMARY KEY (id);


--
-- Name: trade_feedback trade_feedback_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trade_feedback
    ADD CONSTRAINT trade_feedback_pkey PRIMARY KEY (id);


--
-- Name: trade_feedback trade_feedback_trade_date_setup_type_setup_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trade_feedback
    ADD CONSTRAINT trade_feedback_trade_date_setup_type_setup_id_key UNIQUE (trade_date, setup_type, setup_id);


--
-- Name: trade_timeline_events trade_timeline_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trade_timeline_events
    ADD CONSTRAINT trade_timeline_events_pkey PRIMARY KEY (id);


--
-- Name: trade_timeline_events trade_timeline_events_setup_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trade_timeline_events
    ADD CONSTRAINT trade_timeline_events_setup_id_key UNIQUE (setup_id);


--
-- Name: trades trades_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trades
    ADD CONSTRAINT trades_pkey PRIMARY KEY (id);


--
-- Name: trading_sessions trading_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trading_sessions
    ADD CONSTRAINT trading_sessions_pkey PRIMARY KEY (id);


--
-- Name: dynamic_edges_mining uniq_edge_run; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dynamic_edges_mining
    ADD CONSTRAINT uniq_edge_run UNIQUE (setup_type, dimension, segment, run_date);


--
-- Name: value_area_regime_snapshots value_area_regime_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.value_area_regime_snapshots
    ADD CONSTRAINT value_area_regime_snapshots_pkey PRIMARY KEY (id);


--
-- Name: value_area_regime_snapshots value_area_regime_snapshots_snapshot_date_lookback_days_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.value_area_regime_snapshots
    ADD CONSTRAINT value_area_regime_snapshots_snapshot_date_lookback_days_key UNIQUE (snapshot_date, lookback_days);


--
-- Name: vol_backtest_cache vol_backtest_cache_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vol_backtest_cache
    ADD CONSTRAINT vol_backtest_cache_pkey PRIMARY KEY (id);


--
-- Name: weekly_assessments weekly_assessments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.weekly_assessments
    ADD CONSTRAINT weekly_assessments_pkey PRIMARY KEY (id);


--
-- Name: weekly_assessments weekly_assessments_week_start_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.weekly_assessments
    ADD CONSTRAINT weekly_assessments_week_start_key UNIQUE (week_start);


--
-- Name: weekly_ib_structure weekly_ib_structure_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.weekly_ib_structure
    ADD CONSTRAINT weekly_ib_structure_pkey PRIMARY KEY (id);


--
-- Name: weekly_ib_structure weekly_ib_structure_week_start_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.weekly_ib_structure
    ADD CONSTRAINT weekly_ib_structure_week_start_key UNIQUE (week_start);


--
-- Name: active_setups_resolution_bar__trade_date_setup_type_coalesc_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX active_setups_resolution_bar__trade_date_setup_type_coalesc_idx ON public.active_setups_resolution_bar_time_backup_20260727 USING btree (trade_date, setup_type, COALESCE(status, ''::character varying)) WHERE ((status)::text = ANY ((ARRAY['ACTIVE'::character varying, 'SHADOW'::character varying])::text[]));


--
-- Name: active_setups_resolution_bar__trade_date_setup_type_fired_a_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX active_setups_resolution_bar__trade_date_setup_type_fired_a_idx ON public.active_setups_resolution_bar_time_backup_20260727 USING btree (trade_date, setup_type, fired_at);


--
-- Name: active_setups_resolution_bar_time_backup_20260727_fired_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX active_setups_resolution_bar_time_backup_20260727_fired_at_idx ON public.active_setups_resolution_bar_time_backup_20260727 USING btree (fired_at);


--
-- Name: active_setups_resolution_bar_time_backup_20260727_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX active_setups_resolution_bar_time_backup_20260727_status_idx ON public.active_setups_resolution_bar_time_backup_20260727 USING btree (status);


--
-- Name: active_setups_resolution_bar_time_backup_2026072_trade_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX active_setups_resolution_bar_time_backup_2026072_trade_date_idx ON public.active_setups_resolution_bar_time_backup_20260727 USING btree (trade_date);


--
-- Name: active_setups_resolution_bar_time_backup_202607_trade_date_idx1; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX active_setups_resolution_bar_time_backup_202607_trade_date_idx1 ON public.active_setups_resolution_bar_time_backup_20260727 USING btree (trade_date) WHERE ((mae_points IS NULL) AND (entry_zone_low IS NOT NULL) AND (stop_level IS NOT NULL) AND (t1_level IS NOT NULL));


--
-- Name: engine_reads_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX engine_reads_date_idx ON public.engine_reads USING btree (trade_date);


--
-- Name: engine_reads_outcome_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX engine_reads_outcome_idx ON public.engine_reads USING btree (read_type, signal_value, outcome);


--
-- Name: engine_reads_type_signal_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX engine_reads_type_signal_idx ON public.engine_reads USING btree (read_type, signal_value);


--
-- Name: idx_acd_setup_events_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_acd_setup_events_date ON public.acd_setup_events USING btree (trade_date);


--
-- Name: idx_acd_setup_events_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_acd_setup_events_type ON public.acd_setup_events USING btree (setup_type);


--
-- Name: idx_as_fired_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_as_fired_at ON public.active_setups USING btree (fired_at);


--
-- Name: idx_as_mae_null; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_as_mae_null ON public.active_setups USING btree (trade_date) WHERE ((mae_points IS NULL) AND (entry_zone_low IS NOT NULL) AND (stop_level IS NOT NULL) AND (t1_level IS NOT NULL));


--
-- Name: idx_as_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_as_status ON public.active_setups USING btree (status);


--
-- Name: idx_as_trade_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_as_trade_date ON public.active_setups USING btree (trade_date);


--
-- Name: idx_as_unique_setup; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_as_unique_setup ON public.active_setups USING btree (trade_date, setup_type, COALESCE(status, ''::character varying)) WHERE ((status)::text = ANY ((ARRAY['ACTIVE'::character varying, 'SHADOW'::character varying])::text[]));


--
-- Name: idx_as_unique_touch_instant; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_as_unique_touch_instant ON public.active_setups USING btree (trade_date, setup_type, fired_at);


--
-- Name: idx_cm_last_seen; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cm_last_seen ON public.condition_memory USING btree (last_seen);


--
-- Name: idx_cm_structural_state; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cm_structural_state ON public.condition_memory USING btree (structural_state);


--
-- Name: idx_cm_sufficient_data; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cm_sufficient_data ON public.condition_memory USING btree (sufficient_data);


--
-- Name: idx_daily_logs_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_daily_logs_date ON public.daily_logs USING btree (log_date);


--
-- Name: idx_dc_session_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dc_session_date ON public.daily_coaching USING btree (session_date);


--
-- Name: idx_dpl_nl30; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dpl_nl30 ON public.daily_performance_log USING btree (nl30_at_open);


--
-- Name: idx_dpl_structural_state; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dpl_structural_state ON public.daily_performance_log USING btree (structural_state);


--
-- Name: idx_dpl_trade_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dpl_trade_date ON public.daily_performance_log USING btree (trade_date);


--
-- Name: idx_gated_candidates_trade_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gated_candidates_trade_date ON public.gated_candidates USING btree (trade_date);


--
-- Name: idx_gated_candidates_type_gate; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gated_candidates_type_gate ON public.gated_candidates USING btree (setup_type, gate_name);


--
-- Name: idx_learning_digest_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_learning_digest_created ON public.learning_digest_events USING btree (created_at DESC);


--
-- Name: idx_learning_digest_shown; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_learning_digest_shown ON public.learning_digest_events USING btree (shown) WHERE (NOT shown);


--
-- Name: idx_live_reads_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_live_reads_date ON public.live_reads USING btree (trade_date);


--
-- Name: idx_pattern_disc_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pattern_disc_status ON public.pattern_discoveries USING btree (status);


--
-- Name: idx_pattern_disc_window_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pattern_disc_window_type ON public.pattern_discoveries USING btree (window_type);


--
-- Name: idx_pbdh_symbol_contract_ts; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_pbdh_symbol_contract_ts ON public.price_bars_dedup_hist USING btree (symbol, contract, ts);


--
-- Name: idx_pbdh_symbol_ts; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pbdh_symbol_ts ON public.price_bars_dedup_hist USING btree (symbol, ts);


--
-- Name: idx_pc_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pc_date ON public.playbook_conversations USING btree (session_date);


--
-- Name: idx_pca_alert_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pca_alert_time ON public.phase_change_alerts USING btree (alert_time);


--
-- Name: idx_pca_trade_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pca_trade_date ON public.phase_change_alerts USING btree (trade_date);


--
-- Name: idx_pl_process_name; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pl_process_name ON public.process_log USING btree (process_name);


--
-- Name: idx_pl_started_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pl_started_at ON public.process_log USING btree (started_at DESC);


--
-- Name: idx_ple_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ple_date ON public.profit_lock_events USING btree (event_date);


--
-- Name: idx_price_bars_new_contract; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_price_bars_new_contract ON ONLY public.price_bars USING btree (contract);


--
-- Name: idx_price_bars_new_symbol_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_price_bars_new_symbol_date ON ONLY public.price_bars USING btree (symbol, ((ts)::date));


--
-- Name: idx_price_bars_new_symbol_ts; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_price_bars_new_symbol_ts ON ONLY public.price_bars USING btree (symbol, ts);


--
-- Name: idx_price_bars_new_ts; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_price_bars_new_ts ON ONLY public.price_bars USING btree (ts);


--
-- Name: idx_ps_calculated_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ps_calculated_date ON public.pattern_stats USING btree (calculated_date);


--
-- Name: idx_ps_degrading; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ps_degrading ON public.pattern_stats USING btree (degrading_alert);


--
-- Name: idx_session_analysis_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_session_analysis_date ON public.session_analysis USING btree (trade_date);


--
-- Name: idx_session_patterns_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_session_patterns_date ON public.session_patterns USING btree (trade_date);


--
-- Name: idx_session_patterns_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_session_patterns_type ON public.session_patterns USING btree (pattern_type);


--
-- Name: idx_sob_level; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sob_level ON public.setup_outcome_backtest USING btree (level_at_entry);


--
-- Name: idx_sob_setup_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sob_setup_type ON public.setup_outcome_backtest USING btree (setup_type);


--
-- Name: idx_sob_structural_state; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sob_structural_state ON public.setup_outcome_backtest USING btree (structural_state);


--
-- Name: idx_sob_trade_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sob_trade_date ON public.setup_outcome_backtest USING btree (trade_date);


--
-- Name: idx_trade_feedback_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_trade_feedback_date ON public.trade_feedback USING btree (trade_date);


--
-- Name: idx_trade_feedback_tags; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_trade_feedback_tags ON public.trade_feedback USING gin (tags);


--
-- Name: idx_trade_feedback_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_trade_feedback_type ON public.trade_feedback USING btree (setup_type);


--
-- Name: idx_trades_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_trades_account ON public.trades USING btree (((custom_fields ->> 'account'::text)));


--
-- Name: idx_trades_entry_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_trades_entry_time ON public.trades USING btree (entry_time);


--
-- Name: idx_trades_exit_time_notnull; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_trades_exit_time_notnull ON public.trades USING btree (entry_time DESC) WHERE (exit_time IS NOT NULL);


--
-- Name: idx_trades_log_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_trades_log_date ON public.trades USING btree (log_date);


--
-- Name: idx_trades_setup_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_trades_setup_type ON public.trades USING btree (setup_type);


--
-- Name: idx_trades_symbol; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_trades_symbol ON public.trades USING btree (symbol);


--
-- Name: idx_tte_event_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tte_event_time ON public.trade_timeline_events USING btree (event_time);


--
-- Name: idx_tte_trade_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tte_trade_date ON public.trade_timeline_events USING btree (trade_date);


--
-- Name: idx_vars_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vars_date ON public.value_area_regime_snapshots USING btree (snapshot_date);


--
-- Name: idx_wa_week_start; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wa_week_start ON public.weekly_assessments USING btree (week_start);


--
-- Name: level_prices_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX level_prices_date_idx ON public.level_prices USING btree (trade_date DESC);


--
-- Name: level_prices_name_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX level_prices_name_idx ON public.level_prices USING btree (level_name);


--
-- Name: price_bars_2022_12_contract_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2022_12_contract_idx ON public.price_bars_2022_12 USING btree (contract);


--
-- Name: price_bars_2022_12_symbol_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2022_12_symbol_ts_idx ON public.price_bars_2022_12 USING btree (symbol, ts);


--
-- Name: price_bars_2022_12_symbol_ts_idx1; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2022_12_symbol_ts_idx1 ON public.price_bars_2022_12 USING btree (symbol, ((ts)::date));


--
-- Name: price_bars_2022_12_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2022_12_ts_idx ON public.price_bars_2022_12 USING btree (ts);


--
-- Name: price_bars_2023_01_contract_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2023_01_contract_idx ON public.price_bars_2023_01 USING btree (contract);


--
-- Name: price_bars_2023_01_symbol_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2023_01_symbol_ts_idx ON public.price_bars_2023_01 USING btree (symbol, ts);


--
-- Name: price_bars_2023_01_symbol_ts_idx1; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2023_01_symbol_ts_idx1 ON public.price_bars_2023_01 USING btree (symbol, ((ts)::date));


--
-- Name: price_bars_2023_01_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2023_01_ts_idx ON public.price_bars_2023_01 USING btree (ts);


--
-- Name: price_bars_2023_02_contract_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2023_02_contract_idx ON public.price_bars_2023_02 USING btree (contract);


--
-- Name: price_bars_2023_02_symbol_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2023_02_symbol_ts_idx ON public.price_bars_2023_02 USING btree (symbol, ts);


--
-- Name: price_bars_2023_02_symbol_ts_idx1; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2023_02_symbol_ts_idx1 ON public.price_bars_2023_02 USING btree (symbol, ((ts)::date));


--
-- Name: price_bars_2023_02_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2023_02_ts_idx ON public.price_bars_2023_02 USING btree (ts);


--
-- Name: price_bars_2023_03_contract_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2023_03_contract_idx ON public.price_bars_2023_03 USING btree (contract);


--
-- Name: price_bars_2023_03_symbol_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2023_03_symbol_ts_idx ON public.price_bars_2023_03 USING btree (symbol, ts);


--
-- Name: price_bars_2023_03_symbol_ts_idx1; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2023_03_symbol_ts_idx1 ON public.price_bars_2023_03 USING btree (symbol, ((ts)::date));


--
-- Name: price_bars_2023_03_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2023_03_ts_idx ON public.price_bars_2023_03 USING btree (ts);


--
-- Name: price_bars_2023_04_contract_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2023_04_contract_idx ON public.price_bars_2023_04 USING btree (contract);


--
-- Name: price_bars_2023_04_symbol_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2023_04_symbol_ts_idx ON public.price_bars_2023_04 USING btree (symbol, ts);


--
-- Name: price_bars_2023_04_symbol_ts_idx1; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2023_04_symbol_ts_idx1 ON public.price_bars_2023_04 USING btree (symbol, ((ts)::date));


--
-- Name: price_bars_2023_04_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2023_04_ts_idx ON public.price_bars_2023_04 USING btree (ts);


--
-- Name: price_bars_2023_05_contract_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2023_05_contract_idx ON public.price_bars_2023_05 USING btree (contract);


--
-- Name: price_bars_2023_05_symbol_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2023_05_symbol_ts_idx ON public.price_bars_2023_05 USING btree (symbol, ts);


--
-- Name: price_bars_2023_05_symbol_ts_idx1; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2023_05_symbol_ts_idx1 ON public.price_bars_2023_05 USING btree (symbol, ((ts)::date));


--
-- Name: price_bars_2023_05_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2023_05_ts_idx ON public.price_bars_2023_05 USING btree (ts);


--
-- Name: price_bars_2023_06_contract_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2023_06_contract_idx ON public.price_bars_2023_06 USING btree (contract);


--
-- Name: price_bars_2023_06_symbol_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2023_06_symbol_ts_idx ON public.price_bars_2023_06 USING btree (symbol, ts);


--
-- Name: price_bars_2023_06_symbol_ts_idx1; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2023_06_symbol_ts_idx1 ON public.price_bars_2023_06 USING btree (symbol, ((ts)::date));


--
-- Name: price_bars_2023_06_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2023_06_ts_idx ON public.price_bars_2023_06 USING btree (ts);


--
-- Name: price_bars_2023_07_contract_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2023_07_contract_idx ON public.price_bars_2023_07 USING btree (contract);


--
-- Name: price_bars_2023_07_symbol_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2023_07_symbol_ts_idx ON public.price_bars_2023_07 USING btree (symbol, ts);


--
-- Name: price_bars_2023_07_symbol_ts_idx1; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2023_07_symbol_ts_idx1 ON public.price_bars_2023_07 USING btree (symbol, ((ts)::date));


--
-- Name: price_bars_2023_07_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2023_07_ts_idx ON public.price_bars_2023_07 USING btree (ts);


--
-- Name: price_bars_2023_08_contract_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2023_08_contract_idx ON public.price_bars_2023_08 USING btree (contract);


--
-- Name: price_bars_2023_08_symbol_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2023_08_symbol_ts_idx ON public.price_bars_2023_08 USING btree (symbol, ts);


--
-- Name: price_bars_2023_08_symbol_ts_idx1; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2023_08_symbol_ts_idx1 ON public.price_bars_2023_08 USING btree (symbol, ((ts)::date));


--
-- Name: price_bars_2023_08_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2023_08_ts_idx ON public.price_bars_2023_08 USING btree (ts);


--
-- Name: price_bars_2023_09_contract_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2023_09_contract_idx ON public.price_bars_2023_09 USING btree (contract);


--
-- Name: price_bars_2023_09_symbol_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2023_09_symbol_ts_idx ON public.price_bars_2023_09 USING btree (symbol, ts);


--
-- Name: price_bars_2023_09_symbol_ts_idx1; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2023_09_symbol_ts_idx1 ON public.price_bars_2023_09 USING btree (symbol, ((ts)::date));


--
-- Name: price_bars_2023_09_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2023_09_ts_idx ON public.price_bars_2023_09 USING btree (ts);


--
-- Name: price_bars_2023_10_contract_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2023_10_contract_idx ON public.price_bars_2023_10 USING btree (contract);


--
-- Name: price_bars_2023_10_symbol_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2023_10_symbol_ts_idx ON public.price_bars_2023_10 USING btree (symbol, ts);


--
-- Name: price_bars_2023_10_symbol_ts_idx1; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2023_10_symbol_ts_idx1 ON public.price_bars_2023_10 USING btree (symbol, ((ts)::date));


--
-- Name: price_bars_2023_10_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2023_10_ts_idx ON public.price_bars_2023_10 USING btree (ts);


--
-- Name: price_bars_2023_11_contract_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2023_11_contract_idx ON public.price_bars_2023_11 USING btree (contract);


--
-- Name: price_bars_2023_11_symbol_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2023_11_symbol_ts_idx ON public.price_bars_2023_11 USING btree (symbol, ts);


--
-- Name: price_bars_2023_11_symbol_ts_idx1; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2023_11_symbol_ts_idx1 ON public.price_bars_2023_11 USING btree (symbol, ((ts)::date));


--
-- Name: price_bars_2023_11_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2023_11_ts_idx ON public.price_bars_2023_11 USING btree (ts);


--
-- Name: price_bars_2023_12_contract_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2023_12_contract_idx ON public.price_bars_2023_12 USING btree (contract);


--
-- Name: price_bars_2023_12_symbol_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2023_12_symbol_ts_idx ON public.price_bars_2023_12 USING btree (symbol, ts);


--
-- Name: price_bars_2023_12_symbol_ts_idx1; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2023_12_symbol_ts_idx1 ON public.price_bars_2023_12 USING btree (symbol, ((ts)::date));


--
-- Name: price_bars_2023_12_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2023_12_ts_idx ON public.price_bars_2023_12 USING btree (ts);


--
-- Name: price_bars_2024_01_contract_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2024_01_contract_idx ON public.price_bars_2024_01 USING btree (contract);


--
-- Name: price_bars_2024_01_symbol_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2024_01_symbol_ts_idx ON public.price_bars_2024_01 USING btree (symbol, ts);


--
-- Name: price_bars_2024_01_symbol_ts_idx1; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2024_01_symbol_ts_idx1 ON public.price_bars_2024_01 USING btree (symbol, ((ts)::date));


--
-- Name: price_bars_2024_01_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2024_01_ts_idx ON public.price_bars_2024_01 USING btree (ts);


--
-- Name: price_bars_2024_02_contract_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2024_02_contract_idx ON public.price_bars_2024_02 USING btree (contract);


--
-- Name: price_bars_2024_02_symbol_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2024_02_symbol_ts_idx ON public.price_bars_2024_02 USING btree (symbol, ts);


--
-- Name: price_bars_2024_02_symbol_ts_idx1; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2024_02_symbol_ts_idx1 ON public.price_bars_2024_02 USING btree (symbol, ((ts)::date));


--
-- Name: price_bars_2024_02_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2024_02_ts_idx ON public.price_bars_2024_02 USING btree (ts);


--
-- Name: price_bars_2024_03_contract_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2024_03_contract_idx ON public.price_bars_2024_03 USING btree (contract);


--
-- Name: price_bars_2024_03_symbol_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2024_03_symbol_ts_idx ON public.price_bars_2024_03 USING btree (symbol, ts);


--
-- Name: price_bars_2024_03_symbol_ts_idx1; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2024_03_symbol_ts_idx1 ON public.price_bars_2024_03 USING btree (symbol, ((ts)::date));


--
-- Name: price_bars_2024_03_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2024_03_ts_idx ON public.price_bars_2024_03 USING btree (ts);


--
-- Name: price_bars_2024_04_contract_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2024_04_contract_idx ON public.price_bars_2024_04 USING btree (contract);


--
-- Name: price_bars_2024_04_symbol_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2024_04_symbol_ts_idx ON public.price_bars_2024_04 USING btree (symbol, ts);


--
-- Name: price_bars_2024_04_symbol_ts_idx1; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2024_04_symbol_ts_idx1 ON public.price_bars_2024_04 USING btree (symbol, ((ts)::date));


--
-- Name: price_bars_2024_04_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2024_04_ts_idx ON public.price_bars_2024_04 USING btree (ts);


--
-- Name: price_bars_2024_05_contract_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2024_05_contract_idx ON public.price_bars_2024_05 USING btree (contract);


--
-- Name: price_bars_2024_05_symbol_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2024_05_symbol_ts_idx ON public.price_bars_2024_05 USING btree (symbol, ts);


--
-- Name: price_bars_2024_05_symbol_ts_idx1; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2024_05_symbol_ts_idx1 ON public.price_bars_2024_05 USING btree (symbol, ((ts)::date));


--
-- Name: price_bars_2024_05_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2024_05_ts_idx ON public.price_bars_2024_05 USING btree (ts);


--
-- Name: price_bars_2024_06_contract_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2024_06_contract_idx ON public.price_bars_2024_06 USING btree (contract);


--
-- Name: price_bars_2024_06_symbol_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2024_06_symbol_ts_idx ON public.price_bars_2024_06 USING btree (symbol, ts);


--
-- Name: price_bars_2024_06_symbol_ts_idx1; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2024_06_symbol_ts_idx1 ON public.price_bars_2024_06 USING btree (symbol, ((ts)::date));


--
-- Name: price_bars_2024_06_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2024_06_ts_idx ON public.price_bars_2024_06 USING btree (ts);


--
-- Name: price_bars_2024_07_contract_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2024_07_contract_idx ON public.price_bars_2024_07 USING btree (contract);


--
-- Name: price_bars_2024_07_symbol_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2024_07_symbol_ts_idx ON public.price_bars_2024_07 USING btree (symbol, ts);


--
-- Name: price_bars_2024_07_symbol_ts_idx1; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2024_07_symbol_ts_idx1 ON public.price_bars_2024_07 USING btree (symbol, ((ts)::date));


--
-- Name: price_bars_2024_07_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2024_07_ts_idx ON public.price_bars_2024_07 USING btree (ts);


--
-- Name: price_bars_2024_08_contract_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2024_08_contract_idx ON public.price_bars_2024_08 USING btree (contract);


--
-- Name: price_bars_2024_08_symbol_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2024_08_symbol_ts_idx ON public.price_bars_2024_08 USING btree (symbol, ts);


--
-- Name: price_bars_2024_08_symbol_ts_idx1; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2024_08_symbol_ts_idx1 ON public.price_bars_2024_08 USING btree (symbol, ((ts)::date));


--
-- Name: price_bars_2024_08_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2024_08_ts_idx ON public.price_bars_2024_08 USING btree (ts);


--
-- Name: price_bars_2024_09_contract_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2024_09_contract_idx ON public.price_bars_2024_09 USING btree (contract);


--
-- Name: price_bars_2024_09_symbol_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2024_09_symbol_ts_idx ON public.price_bars_2024_09 USING btree (symbol, ts);


--
-- Name: price_bars_2024_09_symbol_ts_idx1; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2024_09_symbol_ts_idx1 ON public.price_bars_2024_09 USING btree (symbol, ((ts)::date));


--
-- Name: price_bars_2024_09_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2024_09_ts_idx ON public.price_bars_2024_09 USING btree (ts);


--
-- Name: price_bars_2024_10_contract_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2024_10_contract_idx ON public.price_bars_2024_10 USING btree (contract);


--
-- Name: price_bars_2024_10_symbol_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2024_10_symbol_ts_idx ON public.price_bars_2024_10 USING btree (symbol, ts);


--
-- Name: price_bars_2024_10_symbol_ts_idx1; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2024_10_symbol_ts_idx1 ON public.price_bars_2024_10 USING btree (symbol, ((ts)::date));


--
-- Name: price_bars_2024_10_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2024_10_ts_idx ON public.price_bars_2024_10 USING btree (ts);


--
-- Name: price_bars_2024_11_contract_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2024_11_contract_idx ON public.price_bars_2024_11 USING btree (contract);


--
-- Name: price_bars_2024_11_symbol_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2024_11_symbol_ts_idx ON public.price_bars_2024_11 USING btree (symbol, ts);


--
-- Name: price_bars_2024_11_symbol_ts_idx1; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2024_11_symbol_ts_idx1 ON public.price_bars_2024_11 USING btree (symbol, ((ts)::date));


--
-- Name: price_bars_2024_11_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2024_11_ts_idx ON public.price_bars_2024_11 USING btree (ts);


--
-- Name: price_bars_2024_12_contract_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2024_12_contract_idx ON public.price_bars_2024_12 USING btree (contract);


--
-- Name: price_bars_2024_12_symbol_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2024_12_symbol_ts_idx ON public.price_bars_2024_12 USING btree (symbol, ts);


--
-- Name: price_bars_2024_12_symbol_ts_idx1; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2024_12_symbol_ts_idx1 ON public.price_bars_2024_12 USING btree (symbol, ((ts)::date));


--
-- Name: price_bars_2024_12_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2024_12_ts_idx ON public.price_bars_2024_12 USING btree (ts);


--
-- Name: price_bars_2025_01_contract_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2025_01_contract_idx ON public.price_bars_2025_01 USING btree (contract);


--
-- Name: price_bars_2025_01_symbol_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2025_01_symbol_ts_idx ON public.price_bars_2025_01 USING btree (symbol, ts);


--
-- Name: price_bars_2025_01_symbol_ts_idx1; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2025_01_symbol_ts_idx1 ON public.price_bars_2025_01 USING btree (symbol, ((ts)::date));


--
-- Name: price_bars_2025_01_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2025_01_ts_idx ON public.price_bars_2025_01 USING btree (ts);


--
-- Name: price_bars_2025_02_contract_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2025_02_contract_idx ON public.price_bars_2025_02 USING btree (contract);


--
-- Name: price_bars_2025_02_symbol_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2025_02_symbol_ts_idx ON public.price_bars_2025_02 USING btree (symbol, ts);


--
-- Name: price_bars_2025_02_symbol_ts_idx1; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2025_02_symbol_ts_idx1 ON public.price_bars_2025_02 USING btree (symbol, ((ts)::date));


--
-- Name: price_bars_2025_02_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2025_02_ts_idx ON public.price_bars_2025_02 USING btree (ts);


--
-- Name: price_bars_2025_03_contract_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2025_03_contract_idx ON public.price_bars_2025_03 USING btree (contract);


--
-- Name: price_bars_2025_03_symbol_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2025_03_symbol_ts_idx ON public.price_bars_2025_03 USING btree (symbol, ts);


--
-- Name: price_bars_2025_03_symbol_ts_idx1; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2025_03_symbol_ts_idx1 ON public.price_bars_2025_03 USING btree (symbol, ((ts)::date));


--
-- Name: price_bars_2025_03_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2025_03_ts_idx ON public.price_bars_2025_03 USING btree (ts);


--
-- Name: price_bars_2025_04_contract_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2025_04_contract_idx ON public.price_bars_2025_04 USING btree (contract);


--
-- Name: price_bars_2025_04_symbol_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2025_04_symbol_ts_idx ON public.price_bars_2025_04 USING btree (symbol, ts);


--
-- Name: price_bars_2025_04_symbol_ts_idx1; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2025_04_symbol_ts_idx1 ON public.price_bars_2025_04 USING btree (symbol, ((ts)::date));


--
-- Name: price_bars_2025_04_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2025_04_ts_idx ON public.price_bars_2025_04 USING btree (ts);


--
-- Name: price_bars_2025_05_contract_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2025_05_contract_idx ON public.price_bars_2025_05 USING btree (contract);


--
-- Name: price_bars_2025_05_symbol_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2025_05_symbol_ts_idx ON public.price_bars_2025_05 USING btree (symbol, ts);


--
-- Name: price_bars_2025_05_symbol_ts_idx1; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2025_05_symbol_ts_idx1 ON public.price_bars_2025_05 USING btree (symbol, ((ts)::date));


--
-- Name: price_bars_2025_05_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2025_05_ts_idx ON public.price_bars_2025_05 USING btree (ts);


--
-- Name: price_bars_2025_06_contract_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2025_06_contract_idx ON public.price_bars_2025_06 USING btree (contract);


--
-- Name: price_bars_2025_06_symbol_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2025_06_symbol_ts_idx ON public.price_bars_2025_06 USING btree (symbol, ts);


--
-- Name: price_bars_2025_06_symbol_ts_idx1; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2025_06_symbol_ts_idx1 ON public.price_bars_2025_06 USING btree (symbol, ((ts)::date));


--
-- Name: price_bars_2025_06_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2025_06_ts_idx ON public.price_bars_2025_06 USING btree (ts);


--
-- Name: price_bars_2025_07_contract_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2025_07_contract_idx ON public.price_bars_2025_07 USING btree (contract);


--
-- Name: price_bars_2025_07_symbol_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2025_07_symbol_ts_idx ON public.price_bars_2025_07 USING btree (symbol, ts);


--
-- Name: price_bars_2025_07_symbol_ts_idx1; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2025_07_symbol_ts_idx1 ON public.price_bars_2025_07 USING btree (symbol, ((ts)::date));


--
-- Name: price_bars_2025_07_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2025_07_ts_idx ON public.price_bars_2025_07 USING btree (ts);


--
-- Name: price_bars_2025_08_contract_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2025_08_contract_idx ON public.price_bars_2025_08 USING btree (contract);


--
-- Name: price_bars_2025_08_symbol_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2025_08_symbol_ts_idx ON public.price_bars_2025_08 USING btree (symbol, ts);


--
-- Name: price_bars_2025_08_symbol_ts_idx1; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2025_08_symbol_ts_idx1 ON public.price_bars_2025_08 USING btree (symbol, ((ts)::date));


--
-- Name: price_bars_2025_08_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2025_08_ts_idx ON public.price_bars_2025_08 USING btree (ts);


--
-- Name: price_bars_2025_09_contract_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2025_09_contract_idx ON public.price_bars_2025_09 USING btree (contract);


--
-- Name: price_bars_2025_09_symbol_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2025_09_symbol_ts_idx ON public.price_bars_2025_09 USING btree (symbol, ts);


--
-- Name: price_bars_2025_09_symbol_ts_idx1; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2025_09_symbol_ts_idx1 ON public.price_bars_2025_09 USING btree (symbol, ((ts)::date));


--
-- Name: price_bars_2025_09_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2025_09_ts_idx ON public.price_bars_2025_09 USING btree (ts);


--
-- Name: price_bars_2025_10_contract_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2025_10_contract_idx ON public.price_bars_2025_10 USING btree (contract);


--
-- Name: price_bars_2025_10_symbol_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2025_10_symbol_ts_idx ON public.price_bars_2025_10 USING btree (symbol, ts);


--
-- Name: price_bars_2025_10_symbol_ts_idx1; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2025_10_symbol_ts_idx1 ON public.price_bars_2025_10 USING btree (symbol, ((ts)::date));


--
-- Name: price_bars_2025_10_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2025_10_ts_idx ON public.price_bars_2025_10 USING btree (ts);


--
-- Name: price_bars_2025_11_contract_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2025_11_contract_idx ON public.price_bars_2025_11 USING btree (contract);


--
-- Name: price_bars_2025_11_symbol_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2025_11_symbol_ts_idx ON public.price_bars_2025_11 USING btree (symbol, ts);


--
-- Name: price_bars_2025_11_symbol_ts_idx1; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2025_11_symbol_ts_idx1 ON public.price_bars_2025_11 USING btree (symbol, ((ts)::date));


--
-- Name: price_bars_2025_11_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2025_11_ts_idx ON public.price_bars_2025_11 USING btree (ts);


--
-- Name: price_bars_2025_12_contract_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2025_12_contract_idx ON public.price_bars_2025_12 USING btree (contract);


--
-- Name: price_bars_2025_12_symbol_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2025_12_symbol_ts_idx ON public.price_bars_2025_12 USING btree (symbol, ts);


--
-- Name: price_bars_2025_12_symbol_ts_idx1; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2025_12_symbol_ts_idx1 ON public.price_bars_2025_12 USING btree (symbol, ((ts)::date));


--
-- Name: price_bars_2025_12_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2025_12_ts_idx ON public.price_bars_2025_12 USING btree (ts);


--
-- Name: price_bars_2026_01_contract_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2026_01_contract_idx ON public.price_bars_2026_01 USING btree (contract);


--
-- Name: price_bars_2026_01_symbol_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2026_01_symbol_ts_idx ON public.price_bars_2026_01 USING btree (symbol, ts);


--
-- Name: price_bars_2026_01_symbol_ts_idx1; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2026_01_symbol_ts_idx1 ON public.price_bars_2026_01 USING btree (symbol, ((ts)::date));


--
-- Name: price_bars_2026_01_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2026_01_ts_idx ON public.price_bars_2026_01 USING btree (ts);


--
-- Name: price_bars_2026_02_contract_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2026_02_contract_idx ON public.price_bars_2026_02 USING btree (contract);


--
-- Name: price_bars_2026_02_symbol_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2026_02_symbol_ts_idx ON public.price_bars_2026_02 USING btree (symbol, ts);


--
-- Name: price_bars_2026_02_symbol_ts_idx1; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2026_02_symbol_ts_idx1 ON public.price_bars_2026_02 USING btree (symbol, ((ts)::date));


--
-- Name: price_bars_2026_02_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2026_02_ts_idx ON public.price_bars_2026_02 USING btree (ts);


--
-- Name: price_bars_2026_03_contract_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2026_03_contract_idx ON public.price_bars_2026_03 USING btree (contract);


--
-- Name: price_bars_2026_03_symbol_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2026_03_symbol_ts_idx ON public.price_bars_2026_03 USING btree (symbol, ts);


--
-- Name: price_bars_2026_03_symbol_ts_idx1; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2026_03_symbol_ts_idx1 ON public.price_bars_2026_03 USING btree (symbol, ((ts)::date));


--
-- Name: price_bars_2026_03_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2026_03_ts_idx ON public.price_bars_2026_03 USING btree (ts);


--
-- Name: price_bars_2026_04_contract_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2026_04_contract_idx ON public.price_bars_2026_04 USING btree (contract);


--
-- Name: price_bars_2026_04_symbol_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2026_04_symbol_ts_idx ON public.price_bars_2026_04 USING btree (symbol, ts);


--
-- Name: price_bars_2026_04_symbol_ts_idx1; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2026_04_symbol_ts_idx1 ON public.price_bars_2026_04 USING btree (symbol, ((ts)::date));


--
-- Name: price_bars_2026_04_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2026_04_ts_idx ON public.price_bars_2026_04 USING btree (ts);


--
-- Name: price_bars_2026_05_contract_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2026_05_contract_idx ON public.price_bars_2026_05 USING btree (contract);


--
-- Name: price_bars_2026_05_symbol_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2026_05_symbol_ts_idx ON public.price_bars_2026_05 USING btree (symbol, ts);


--
-- Name: price_bars_2026_05_symbol_ts_idx1; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2026_05_symbol_ts_idx1 ON public.price_bars_2026_05 USING btree (symbol, ((ts)::date));


--
-- Name: price_bars_2026_05_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2026_05_ts_idx ON public.price_bars_2026_05 USING btree (ts);


--
-- Name: price_bars_2026_06_contract_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2026_06_contract_idx ON public.price_bars_2026_06 USING btree (contract);


--
-- Name: price_bars_2026_06_symbol_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2026_06_symbol_ts_idx ON public.price_bars_2026_06 USING btree (symbol, ts);


--
-- Name: price_bars_2026_06_symbol_ts_idx1; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2026_06_symbol_ts_idx1 ON public.price_bars_2026_06 USING btree (symbol, ((ts)::date));


--
-- Name: price_bars_2026_06_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2026_06_ts_idx ON public.price_bars_2026_06 USING btree (ts);


--
-- Name: price_bars_2026_07_contract_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2026_07_contract_idx ON public.price_bars_2026_07 USING btree (contract);


--
-- Name: price_bars_2026_07_symbol_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2026_07_symbol_ts_idx ON public.price_bars_2026_07 USING btree (symbol, ts);


--
-- Name: price_bars_2026_07_symbol_ts_idx1; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2026_07_symbol_ts_idx1 ON public.price_bars_2026_07 USING btree (symbol, ((ts)::date));


--
-- Name: price_bars_2026_07_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2026_07_ts_idx ON public.price_bars_2026_07 USING btree (ts);


--
-- Name: price_bars_2026_08_contract_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2026_08_contract_idx ON public.price_bars_2026_08 USING btree (contract);


--
-- Name: price_bars_2026_08_symbol_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2026_08_symbol_ts_idx ON public.price_bars_2026_08 USING btree (symbol, ts);


--
-- Name: price_bars_2026_08_symbol_ts_idx1; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2026_08_symbol_ts_idx1 ON public.price_bars_2026_08 USING btree (symbol, ((ts)::date));


--
-- Name: price_bars_2026_08_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2026_08_ts_idx ON public.price_bars_2026_08 USING btree (ts);


--
-- Name: price_bars_2026_09_contract_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2026_09_contract_idx ON public.price_bars_2026_09 USING btree (contract);


--
-- Name: price_bars_2026_09_symbol_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2026_09_symbol_ts_idx ON public.price_bars_2026_09 USING btree (symbol, ts);


--
-- Name: price_bars_2026_09_symbol_ts_idx1; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2026_09_symbol_ts_idx1 ON public.price_bars_2026_09 USING btree (symbol, ((ts)::date));


--
-- Name: price_bars_2026_09_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2026_09_ts_idx ON public.price_bars_2026_09 USING btree (ts);


--
-- Name: price_bars_2026_10_contract_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2026_10_contract_idx ON public.price_bars_2026_10 USING btree (contract);


--
-- Name: price_bars_2026_10_symbol_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2026_10_symbol_ts_idx ON public.price_bars_2026_10 USING btree (symbol, ts);


--
-- Name: price_bars_2026_10_symbol_ts_idx1; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2026_10_symbol_ts_idx1 ON public.price_bars_2026_10 USING btree (symbol, ((ts)::date));


--
-- Name: price_bars_2026_10_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2026_10_ts_idx ON public.price_bars_2026_10 USING btree (ts);


--
-- Name: price_bars_2026_11_contract_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2026_11_contract_idx ON public.price_bars_2026_11 USING btree (contract);


--
-- Name: price_bars_2026_11_symbol_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2026_11_symbol_ts_idx ON public.price_bars_2026_11 USING btree (symbol, ts);


--
-- Name: price_bars_2026_11_symbol_ts_idx1; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2026_11_symbol_ts_idx1 ON public.price_bars_2026_11 USING btree (symbol, ((ts)::date));


--
-- Name: price_bars_2026_11_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2026_11_ts_idx ON public.price_bars_2026_11 USING btree (ts);


--
-- Name: price_bars_2026_12_contract_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2026_12_contract_idx ON public.price_bars_2026_12 USING btree (contract);


--
-- Name: price_bars_2026_12_symbol_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2026_12_symbol_ts_idx ON public.price_bars_2026_12 USING btree (symbol, ts);


--
-- Name: price_bars_2026_12_symbol_ts_idx1; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2026_12_symbol_ts_idx1 ON public.price_bars_2026_12 USING btree (symbol, ((ts)::date));


--
-- Name: price_bars_2026_12_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2026_12_ts_idx ON public.price_bars_2026_12 USING btree (ts);


--
-- Name: price_bars_2027_01_contract_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2027_01_contract_idx ON public.price_bars_2027_01 USING btree (contract);


--
-- Name: price_bars_2027_01_symbol_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2027_01_symbol_ts_idx ON public.price_bars_2027_01 USING btree (symbol, ts);


--
-- Name: price_bars_2027_01_symbol_ts_idx1; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2027_01_symbol_ts_idx1 ON public.price_bars_2027_01 USING btree (symbol, ((ts)::date));


--
-- Name: price_bars_2027_01_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2027_01_ts_idx ON public.price_bars_2027_01 USING btree (ts);


--
-- Name: price_bars_2027_02_contract_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2027_02_contract_idx ON public.price_bars_2027_02 USING btree (contract);


--
-- Name: price_bars_2027_02_symbol_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2027_02_symbol_ts_idx ON public.price_bars_2027_02 USING btree (symbol, ts);


--
-- Name: price_bars_2027_02_symbol_ts_idx1; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2027_02_symbol_ts_idx1 ON public.price_bars_2027_02 USING btree (symbol, ((ts)::date));


--
-- Name: price_bars_2027_02_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2027_02_ts_idx ON public.price_bars_2027_02 USING btree (ts);


--
-- Name: price_bars_2027_03_contract_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2027_03_contract_idx ON public.price_bars_2027_03 USING btree (contract);


--
-- Name: price_bars_2027_03_symbol_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2027_03_symbol_ts_idx ON public.price_bars_2027_03 USING btree (symbol, ts);


--
-- Name: price_bars_2027_03_symbol_ts_idx1; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2027_03_symbol_ts_idx1 ON public.price_bars_2027_03 USING btree (symbol, ((ts)::date));


--
-- Name: price_bars_2027_03_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2027_03_ts_idx ON public.price_bars_2027_03 USING btree (ts);


--
-- Name: price_bars_2027_04_contract_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2027_04_contract_idx ON public.price_bars_2027_04 USING btree (contract);


--
-- Name: price_bars_2027_04_symbol_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2027_04_symbol_ts_idx ON public.price_bars_2027_04 USING btree (symbol, ts);


--
-- Name: price_bars_2027_04_symbol_ts_idx1; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2027_04_symbol_ts_idx1 ON public.price_bars_2027_04 USING btree (symbol, ((ts)::date));


--
-- Name: price_bars_2027_04_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2027_04_ts_idx ON public.price_bars_2027_04 USING btree (ts);


--
-- Name: price_bars_2027_05_contract_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2027_05_contract_idx ON public.price_bars_2027_05 USING btree (contract);


--
-- Name: price_bars_2027_05_symbol_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2027_05_symbol_ts_idx ON public.price_bars_2027_05 USING btree (symbol, ts);


--
-- Name: price_bars_2027_05_symbol_ts_idx1; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2027_05_symbol_ts_idx1 ON public.price_bars_2027_05 USING btree (symbol, ((ts)::date));


--
-- Name: price_bars_2027_05_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2027_05_ts_idx ON public.price_bars_2027_05 USING btree (ts);


--
-- Name: price_bars_2027_06_contract_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2027_06_contract_idx ON public.price_bars_2027_06 USING btree (contract);


--
-- Name: price_bars_2027_06_symbol_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2027_06_symbol_ts_idx ON public.price_bars_2027_06 USING btree (symbol, ts);


--
-- Name: price_bars_2027_06_symbol_ts_idx1; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2027_06_symbol_ts_idx1 ON public.price_bars_2027_06 USING btree (symbol, ((ts)::date));


--
-- Name: price_bars_2027_06_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2027_06_ts_idx ON public.price_bars_2027_06 USING btree (ts);


--
-- Name: price_bars_2027_07_contract_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2027_07_contract_idx ON public.price_bars_2027_07 USING btree (contract);


--
-- Name: price_bars_2027_07_symbol_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2027_07_symbol_ts_idx ON public.price_bars_2027_07 USING btree (symbol, ts);


--
-- Name: price_bars_2027_07_symbol_ts_idx1; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2027_07_symbol_ts_idx1 ON public.price_bars_2027_07 USING btree (symbol, ((ts)::date));


--
-- Name: price_bars_2027_07_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2027_07_ts_idx ON public.price_bars_2027_07 USING btree (ts);


--
-- Name: price_bars_2027_08_contract_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2027_08_contract_idx ON public.price_bars_2027_08 USING btree (contract);


--
-- Name: price_bars_2027_08_symbol_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2027_08_symbol_ts_idx ON public.price_bars_2027_08 USING btree (symbol, ts);


--
-- Name: price_bars_2027_08_symbol_ts_idx1; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2027_08_symbol_ts_idx1 ON public.price_bars_2027_08 USING btree (symbol, ((ts)::date));


--
-- Name: price_bars_2027_08_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2027_08_ts_idx ON public.price_bars_2027_08 USING btree (ts);


--
-- Name: price_bars_2027_09_contract_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2027_09_contract_idx ON public.price_bars_2027_09 USING btree (contract);


--
-- Name: price_bars_2027_09_symbol_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2027_09_symbol_ts_idx ON public.price_bars_2027_09 USING btree (symbol, ts);


--
-- Name: price_bars_2027_09_symbol_ts_idx1; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2027_09_symbol_ts_idx1 ON public.price_bars_2027_09 USING btree (symbol, ((ts)::date));


--
-- Name: price_bars_2027_09_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2027_09_ts_idx ON public.price_bars_2027_09 USING btree (ts);


--
-- Name: price_bars_2027_10_contract_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2027_10_contract_idx ON public.price_bars_2027_10 USING btree (contract);


--
-- Name: price_bars_2027_10_symbol_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2027_10_symbol_ts_idx ON public.price_bars_2027_10 USING btree (symbol, ts);


--
-- Name: price_bars_2027_10_symbol_ts_idx1; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2027_10_symbol_ts_idx1 ON public.price_bars_2027_10 USING btree (symbol, ((ts)::date));


--
-- Name: price_bars_2027_10_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2027_10_ts_idx ON public.price_bars_2027_10 USING btree (ts);


--
-- Name: price_bars_2027_11_contract_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2027_11_contract_idx ON public.price_bars_2027_11 USING btree (contract);


--
-- Name: price_bars_2027_11_symbol_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2027_11_symbol_ts_idx ON public.price_bars_2027_11 USING btree (symbol, ts);


--
-- Name: price_bars_2027_11_symbol_ts_idx1; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2027_11_symbol_ts_idx1 ON public.price_bars_2027_11 USING btree (symbol, ((ts)::date));


--
-- Name: price_bars_2027_11_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2027_11_ts_idx ON public.price_bars_2027_11 USING btree (ts);


--
-- Name: price_bars_2027_12_contract_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2027_12_contract_idx ON public.price_bars_2027_12 USING btree (contract);


--
-- Name: price_bars_2027_12_symbol_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2027_12_symbol_ts_idx ON public.price_bars_2027_12 USING btree (symbol, ts);


--
-- Name: price_bars_2027_12_symbol_ts_idx1; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2027_12_symbol_ts_idx1 ON public.price_bars_2027_12 USING btree (symbol, ((ts)::date));


--
-- Name: price_bars_2027_12_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_bars_2027_12_ts_idx ON public.price_bars_2027_12 USING btree (ts);


--
-- Name: trade_annotations_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX trade_annotations_date_idx ON public.trade_annotations USING btree (trade_date);


--
-- Name: trade_annotations_trade_ids_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX trade_annotations_trade_ids_idx ON public.trade_annotations USING gin (trade_ids);


--
-- Name: trades_level_proximity_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX trades_level_proximity_idx ON public.trades USING gin (level_proximity) WHERE (level_proximity IS NOT NULL);


--
-- Name: price_bars_2022_12_contract_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_contract ATTACH PARTITION public.price_bars_2022_12_contract_idx;


--
-- Name: price_bars_2022_12_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.price_bars_new_pkey ATTACH PARTITION public.price_bars_2022_12_pkey;


--
-- Name: price_bars_2022_12_symbol_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_ts ATTACH PARTITION public.price_bars_2022_12_symbol_ts_idx;


--
-- Name: price_bars_2022_12_symbol_ts_idx1; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_date ATTACH PARTITION public.price_bars_2022_12_symbol_ts_idx1;


--
-- Name: price_bars_2022_12_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_ts ATTACH PARTITION public.price_bars_2022_12_ts_idx;


--
-- Name: price_bars_2023_01_contract_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_contract ATTACH PARTITION public.price_bars_2023_01_contract_idx;


--
-- Name: price_bars_2023_01_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.price_bars_new_pkey ATTACH PARTITION public.price_bars_2023_01_pkey;


--
-- Name: price_bars_2023_01_symbol_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_ts ATTACH PARTITION public.price_bars_2023_01_symbol_ts_idx;


--
-- Name: price_bars_2023_01_symbol_ts_idx1; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_date ATTACH PARTITION public.price_bars_2023_01_symbol_ts_idx1;


--
-- Name: price_bars_2023_01_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_ts ATTACH PARTITION public.price_bars_2023_01_ts_idx;


--
-- Name: price_bars_2023_02_contract_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_contract ATTACH PARTITION public.price_bars_2023_02_contract_idx;


--
-- Name: price_bars_2023_02_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.price_bars_new_pkey ATTACH PARTITION public.price_bars_2023_02_pkey;


--
-- Name: price_bars_2023_02_symbol_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_ts ATTACH PARTITION public.price_bars_2023_02_symbol_ts_idx;


--
-- Name: price_bars_2023_02_symbol_ts_idx1; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_date ATTACH PARTITION public.price_bars_2023_02_symbol_ts_idx1;


--
-- Name: price_bars_2023_02_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_ts ATTACH PARTITION public.price_bars_2023_02_ts_idx;


--
-- Name: price_bars_2023_03_contract_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_contract ATTACH PARTITION public.price_bars_2023_03_contract_idx;


--
-- Name: price_bars_2023_03_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.price_bars_new_pkey ATTACH PARTITION public.price_bars_2023_03_pkey;


--
-- Name: price_bars_2023_03_symbol_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_ts ATTACH PARTITION public.price_bars_2023_03_symbol_ts_idx;


--
-- Name: price_bars_2023_03_symbol_ts_idx1; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_date ATTACH PARTITION public.price_bars_2023_03_symbol_ts_idx1;


--
-- Name: price_bars_2023_03_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_ts ATTACH PARTITION public.price_bars_2023_03_ts_idx;


--
-- Name: price_bars_2023_04_contract_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_contract ATTACH PARTITION public.price_bars_2023_04_contract_idx;


--
-- Name: price_bars_2023_04_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.price_bars_new_pkey ATTACH PARTITION public.price_bars_2023_04_pkey;


--
-- Name: price_bars_2023_04_symbol_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_ts ATTACH PARTITION public.price_bars_2023_04_symbol_ts_idx;


--
-- Name: price_bars_2023_04_symbol_ts_idx1; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_date ATTACH PARTITION public.price_bars_2023_04_symbol_ts_idx1;


--
-- Name: price_bars_2023_04_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_ts ATTACH PARTITION public.price_bars_2023_04_ts_idx;


--
-- Name: price_bars_2023_05_contract_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_contract ATTACH PARTITION public.price_bars_2023_05_contract_idx;


--
-- Name: price_bars_2023_05_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.price_bars_new_pkey ATTACH PARTITION public.price_bars_2023_05_pkey;


--
-- Name: price_bars_2023_05_symbol_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_ts ATTACH PARTITION public.price_bars_2023_05_symbol_ts_idx;


--
-- Name: price_bars_2023_05_symbol_ts_idx1; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_date ATTACH PARTITION public.price_bars_2023_05_symbol_ts_idx1;


--
-- Name: price_bars_2023_05_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_ts ATTACH PARTITION public.price_bars_2023_05_ts_idx;


--
-- Name: price_bars_2023_06_contract_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_contract ATTACH PARTITION public.price_bars_2023_06_contract_idx;


--
-- Name: price_bars_2023_06_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.price_bars_new_pkey ATTACH PARTITION public.price_bars_2023_06_pkey;


--
-- Name: price_bars_2023_06_symbol_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_ts ATTACH PARTITION public.price_bars_2023_06_symbol_ts_idx;


--
-- Name: price_bars_2023_06_symbol_ts_idx1; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_date ATTACH PARTITION public.price_bars_2023_06_symbol_ts_idx1;


--
-- Name: price_bars_2023_06_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_ts ATTACH PARTITION public.price_bars_2023_06_ts_idx;


--
-- Name: price_bars_2023_07_contract_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_contract ATTACH PARTITION public.price_bars_2023_07_contract_idx;


--
-- Name: price_bars_2023_07_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.price_bars_new_pkey ATTACH PARTITION public.price_bars_2023_07_pkey;


--
-- Name: price_bars_2023_07_symbol_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_ts ATTACH PARTITION public.price_bars_2023_07_symbol_ts_idx;


--
-- Name: price_bars_2023_07_symbol_ts_idx1; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_date ATTACH PARTITION public.price_bars_2023_07_symbol_ts_idx1;


--
-- Name: price_bars_2023_07_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_ts ATTACH PARTITION public.price_bars_2023_07_ts_idx;


--
-- Name: price_bars_2023_08_contract_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_contract ATTACH PARTITION public.price_bars_2023_08_contract_idx;


--
-- Name: price_bars_2023_08_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.price_bars_new_pkey ATTACH PARTITION public.price_bars_2023_08_pkey;


--
-- Name: price_bars_2023_08_symbol_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_ts ATTACH PARTITION public.price_bars_2023_08_symbol_ts_idx;


--
-- Name: price_bars_2023_08_symbol_ts_idx1; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_date ATTACH PARTITION public.price_bars_2023_08_symbol_ts_idx1;


--
-- Name: price_bars_2023_08_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_ts ATTACH PARTITION public.price_bars_2023_08_ts_idx;


--
-- Name: price_bars_2023_09_contract_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_contract ATTACH PARTITION public.price_bars_2023_09_contract_idx;


--
-- Name: price_bars_2023_09_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.price_bars_new_pkey ATTACH PARTITION public.price_bars_2023_09_pkey;


--
-- Name: price_bars_2023_09_symbol_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_ts ATTACH PARTITION public.price_bars_2023_09_symbol_ts_idx;


--
-- Name: price_bars_2023_09_symbol_ts_idx1; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_date ATTACH PARTITION public.price_bars_2023_09_symbol_ts_idx1;


--
-- Name: price_bars_2023_09_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_ts ATTACH PARTITION public.price_bars_2023_09_ts_idx;


--
-- Name: price_bars_2023_10_contract_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_contract ATTACH PARTITION public.price_bars_2023_10_contract_idx;


--
-- Name: price_bars_2023_10_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.price_bars_new_pkey ATTACH PARTITION public.price_bars_2023_10_pkey;


--
-- Name: price_bars_2023_10_symbol_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_ts ATTACH PARTITION public.price_bars_2023_10_symbol_ts_idx;


--
-- Name: price_bars_2023_10_symbol_ts_idx1; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_date ATTACH PARTITION public.price_bars_2023_10_symbol_ts_idx1;


--
-- Name: price_bars_2023_10_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_ts ATTACH PARTITION public.price_bars_2023_10_ts_idx;


--
-- Name: price_bars_2023_11_contract_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_contract ATTACH PARTITION public.price_bars_2023_11_contract_idx;


--
-- Name: price_bars_2023_11_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.price_bars_new_pkey ATTACH PARTITION public.price_bars_2023_11_pkey;


--
-- Name: price_bars_2023_11_symbol_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_ts ATTACH PARTITION public.price_bars_2023_11_symbol_ts_idx;


--
-- Name: price_bars_2023_11_symbol_ts_idx1; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_date ATTACH PARTITION public.price_bars_2023_11_symbol_ts_idx1;


--
-- Name: price_bars_2023_11_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_ts ATTACH PARTITION public.price_bars_2023_11_ts_idx;


--
-- Name: price_bars_2023_12_contract_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_contract ATTACH PARTITION public.price_bars_2023_12_contract_idx;


--
-- Name: price_bars_2023_12_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.price_bars_new_pkey ATTACH PARTITION public.price_bars_2023_12_pkey;


--
-- Name: price_bars_2023_12_symbol_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_ts ATTACH PARTITION public.price_bars_2023_12_symbol_ts_idx;


--
-- Name: price_bars_2023_12_symbol_ts_idx1; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_date ATTACH PARTITION public.price_bars_2023_12_symbol_ts_idx1;


--
-- Name: price_bars_2023_12_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_ts ATTACH PARTITION public.price_bars_2023_12_ts_idx;


--
-- Name: price_bars_2024_01_contract_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_contract ATTACH PARTITION public.price_bars_2024_01_contract_idx;


--
-- Name: price_bars_2024_01_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.price_bars_new_pkey ATTACH PARTITION public.price_bars_2024_01_pkey;


--
-- Name: price_bars_2024_01_symbol_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_ts ATTACH PARTITION public.price_bars_2024_01_symbol_ts_idx;


--
-- Name: price_bars_2024_01_symbol_ts_idx1; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_date ATTACH PARTITION public.price_bars_2024_01_symbol_ts_idx1;


--
-- Name: price_bars_2024_01_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_ts ATTACH PARTITION public.price_bars_2024_01_ts_idx;


--
-- Name: price_bars_2024_02_contract_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_contract ATTACH PARTITION public.price_bars_2024_02_contract_idx;


--
-- Name: price_bars_2024_02_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.price_bars_new_pkey ATTACH PARTITION public.price_bars_2024_02_pkey;


--
-- Name: price_bars_2024_02_symbol_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_ts ATTACH PARTITION public.price_bars_2024_02_symbol_ts_idx;


--
-- Name: price_bars_2024_02_symbol_ts_idx1; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_date ATTACH PARTITION public.price_bars_2024_02_symbol_ts_idx1;


--
-- Name: price_bars_2024_02_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_ts ATTACH PARTITION public.price_bars_2024_02_ts_idx;


--
-- Name: price_bars_2024_03_contract_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_contract ATTACH PARTITION public.price_bars_2024_03_contract_idx;


--
-- Name: price_bars_2024_03_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.price_bars_new_pkey ATTACH PARTITION public.price_bars_2024_03_pkey;


--
-- Name: price_bars_2024_03_symbol_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_ts ATTACH PARTITION public.price_bars_2024_03_symbol_ts_idx;


--
-- Name: price_bars_2024_03_symbol_ts_idx1; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_date ATTACH PARTITION public.price_bars_2024_03_symbol_ts_idx1;


--
-- Name: price_bars_2024_03_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_ts ATTACH PARTITION public.price_bars_2024_03_ts_idx;


--
-- Name: price_bars_2024_04_contract_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_contract ATTACH PARTITION public.price_bars_2024_04_contract_idx;


--
-- Name: price_bars_2024_04_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.price_bars_new_pkey ATTACH PARTITION public.price_bars_2024_04_pkey;


--
-- Name: price_bars_2024_04_symbol_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_ts ATTACH PARTITION public.price_bars_2024_04_symbol_ts_idx;


--
-- Name: price_bars_2024_04_symbol_ts_idx1; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_date ATTACH PARTITION public.price_bars_2024_04_symbol_ts_idx1;


--
-- Name: price_bars_2024_04_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_ts ATTACH PARTITION public.price_bars_2024_04_ts_idx;


--
-- Name: price_bars_2024_05_contract_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_contract ATTACH PARTITION public.price_bars_2024_05_contract_idx;


--
-- Name: price_bars_2024_05_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.price_bars_new_pkey ATTACH PARTITION public.price_bars_2024_05_pkey;


--
-- Name: price_bars_2024_05_symbol_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_ts ATTACH PARTITION public.price_bars_2024_05_symbol_ts_idx;


--
-- Name: price_bars_2024_05_symbol_ts_idx1; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_date ATTACH PARTITION public.price_bars_2024_05_symbol_ts_idx1;


--
-- Name: price_bars_2024_05_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_ts ATTACH PARTITION public.price_bars_2024_05_ts_idx;


--
-- Name: price_bars_2024_06_contract_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_contract ATTACH PARTITION public.price_bars_2024_06_contract_idx;


--
-- Name: price_bars_2024_06_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.price_bars_new_pkey ATTACH PARTITION public.price_bars_2024_06_pkey;


--
-- Name: price_bars_2024_06_symbol_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_ts ATTACH PARTITION public.price_bars_2024_06_symbol_ts_idx;


--
-- Name: price_bars_2024_06_symbol_ts_idx1; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_date ATTACH PARTITION public.price_bars_2024_06_symbol_ts_idx1;


--
-- Name: price_bars_2024_06_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_ts ATTACH PARTITION public.price_bars_2024_06_ts_idx;


--
-- Name: price_bars_2024_07_contract_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_contract ATTACH PARTITION public.price_bars_2024_07_contract_idx;


--
-- Name: price_bars_2024_07_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.price_bars_new_pkey ATTACH PARTITION public.price_bars_2024_07_pkey;


--
-- Name: price_bars_2024_07_symbol_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_ts ATTACH PARTITION public.price_bars_2024_07_symbol_ts_idx;


--
-- Name: price_bars_2024_07_symbol_ts_idx1; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_date ATTACH PARTITION public.price_bars_2024_07_symbol_ts_idx1;


--
-- Name: price_bars_2024_07_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_ts ATTACH PARTITION public.price_bars_2024_07_ts_idx;


--
-- Name: price_bars_2024_08_contract_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_contract ATTACH PARTITION public.price_bars_2024_08_contract_idx;


--
-- Name: price_bars_2024_08_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.price_bars_new_pkey ATTACH PARTITION public.price_bars_2024_08_pkey;


--
-- Name: price_bars_2024_08_symbol_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_ts ATTACH PARTITION public.price_bars_2024_08_symbol_ts_idx;


--
-- Name: price_bars_2024_08_symbol_ts_idx1; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_date ATTACH PARTITION public.price_bars_2024_08_symbol_ts_idx1;


--
-- Name: price_bars_2024_08_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_ts ATTACH PARTITION public.price_bars_2024_08_ts_idx;


--
-- Name: price_bars_2024_09_contract_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_contract ATTACH PARTITION public.price_bars_2024_09_contract_idx;


--
-- Name: price_bars_2024_09_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.price_bars_new_pkey ATTACH PARTITION public.price_bars_2024_09_pkey;


--
-- Name: price_bars_2024_09_symbol_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_ts ATTACH PARTITION public.price_bars_2024_09_symbol_ts_idx;


--
-- Name: price_bars_2024_09_symbol_ts_idx1; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_date ATTACH PARTITION public.price_bars_2024_09_symbol_ts_idx1;


--
-- Name: price_bars_2024_09_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_ts ATTACH PARTITION public.price_bars_2024_09_ts_idx;


--
-- Name: price_bars_2024_10_contract_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_contract ATTACH PARTITION public.price_bars_2024_10_contract_idx;


--
-- Name: price_bars_2024_10_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.price_bars_new_pkey ATTACH PARTITION public.price_bars_2024_10_pkey;


--
-- Name: price_bars_2024_10_symbol_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_ts ATTACH PARTITION public.price_bars_2024_10_symbol_ts_idx;


--
-- Name: price_bars_2024_10_symbol_ts_idx1; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_date ATTACH PARTITION public.price_bars_2024_10_symbol_ts_idx1;


--
-- Name: price_bars_2024_10_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_ts ATTACH PARTITION public.price_bars_2024_10_ts_idx;


--
-- Name: price_bars_2024_11_contract_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_contract ATTACH PARTITION public.price_bars_2024_11_contract_idx;


--
-- Name: price_bars_2024_11_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.price_bars_new_pkey ATTACH PARTITION public.price_bars_2024_11_pkey;


--
-- Name: price_bars_2024_11_symbol_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_ts ATTACH PARTITION public.price_bars_2024_11_symbol_ts_idx;


--
-- Name: price_bars_2024_11_symbol_ts_idx1; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_date ATTACH PARTITION public.price_bars_2024_11_symbol_ts_idx1;


--
-- Name: price_bars_2024_11_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_ts ATTACH PARTITION public.price_bars_2024_11_ts_idx;


--
-- Name: price_bars_2024_12_contract_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_contract ATTACH PARTITION public.price_bars_2024_12_contract_idx;


--
-- Name: price_bars_2024_12_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.price_bars_new_pkey ATTACH PARTITION public.price_bars_2024_12_pkey;


--
-- Name: price_bars_2024_12_symbol_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_ts ATTACH PARTITION public.price_bars_2024_12_symbol_ts_idx;


--
-- Name: price_bars_2024_12_symbol_ts_idx1; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_date ATTACH PARTITION public.price_bars_2024_12_symbol_ts_idx1;


--
-- Name: price_bars_2024_12_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_ts ATTACH PARTITION public.price_bars_2024_12_ts_idx;


--
-- Name: price_bars_2025_01_contract_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_contract ATTACH PARTITION public.price_bars_2025_01_contract_idx;


--
-- Name: price_bars_2025_01_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.price_bars_new_pkey ATTACH PARTITION public.price_bars_2025_01_pkey;


--
-- Name: price_bars_2025_01_symbol_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_ts ATTACH PARTITION public.price_bars_2025_01_symbol_ts_idx;


--
-- Name: price_bars_2025_01_symbol_ts_idx1; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_date ATTACH PARTITION public.price_bars_2025_01_symbol_ts_idx1;


--
-- Name: price_bars_2025_01_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_ts ATTACH PARTITION public.price_bars_2025_01_ts_idx;


--
-- Name: price_bars_2025_02_contract_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_contract ATTACH PARTITION public.price_bars_2025_02_contract_idx;


--
-- Name: price_bars_2025_02_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.price_bars_new_pkey ATTACH PARTITION public.price_bars_2025_02_pkey;


--
-- Name: price_bars_2025_02_symbol_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_ts ATTACH PARTITION public.price_bars_2025_02_symbol_ts_idx;


--
-- Name: price_bars_2025_02_symbol_ts_idx1; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_date ATTACH PARTITION public.price_bars_2025_02_symbol_ts_idx1;


--
-- Name: price_bars_2025_02_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_ts ATTACH PARTITION public.price_bars_2025_02_ts_idx;


--
-- Name: price_bars_2025_03_contract_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_contract ATTACH PARTITION public.price_bars_2025_03_contract_idx;


--
-- Name: price_bars_2025_03_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.price_bars_new_pkey ATTACH PARTITION public.price_bars_2025_03_pkey;


--
-- Name: price_bars_2025_03_symbol_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_ts ATTACH PARTITION public.price_bars_2025_03_symbol_ts_idx;


--
-- Name: price_bars_2025_03_symbol_ts_idx1; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_date ATTACH PARTITION public.price_bars_2025_03_symbol_ts_idx1;


--
-- Name: price_bars_2025_03_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_ts ATTACH PARTITION public.price_bars_2025_03_ts_idx;


--
-- Name: price_bars_2025_04_contract_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_contract ATTACH PARTITION public.price_bars_2025_04_contract_idx;


--
-- Name: price_bars_2025_04_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.price_bars_new_pkey ATTACH PARTITION public.price_bars_2025_04_pkey;


--
-- Name: price_bars_2025_04_symbol_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_ts ATTACH PARTITION public.price_bars_2025_04_symbol_ts_idx;


--
-- Name: price_bars_2025_04_symbol_ts_idx1; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_date ATTACH PARTITION public.price_bars_2025_04_symbol_ts_idx1;


--
-- Name: price_bars_2025_04_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_ts ATTACH PARTITION public.price_bars_2025_04_ts_idx;


--
-- Name: price_bars_2025_05_contract_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_contract ATTACH PARTITION public.price_bars_2025_05_contract_idx;


--
-- Name: price_bars_2025_05_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.price_bars_new_pkey ATTACH PARTITION public.price_bars_2025_05_pkey;


--
-- Name: price_bars_2025_05_symbol_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_ts ATTACH PARTITION public.price_bars_2025_05_symbol_ts_idx;


--
-- Name: price_bars_2025_05_symbol_ts_idx1; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_date ATTACH PARTITION public.price_bars_2025_05_symbol_ts_idx1;


--
-- Name: price_bars_2025_05_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_ts ATTACH PARTITION public.price_bars_2025_05_ts_idx;


--
-- Name: price_bars_2025_06_contract_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_contract ATTACH PARTITION public.price_bars_2025_06_contract_idx;


--
-- Name: price_bars_2025_06_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.price_bars_new_pkey ATTACH PARTITION public.price_bars_2025_06_pkey;


--
-- Name: price_bars_2025_06_symbol_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_ts ATTACH PARTITION public.price_bars_2025_06_symbol_ts_idx;


--
-- Name: price_bars_2025_06_symbol_ts_idx1; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_date ATTACH PARTITION public.price_bars_2025_06_symbol_ts_idx1;


--
-- Name: price_bars_2025_06_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_ts ATTACH PARTITION public.price_bars_2025_06_ts_idx;


--
-- Name: price_bars_2025_07_contract_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_contract ATTACH PARTITION public.price_bars_2025_07_contract_idx;


--
-- Name: price_bars_2025_07_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.price_bars_new_pkey ATTACH PARTITION public.price_bars_2025_07_pkey;


--
-- Name: price_bars_2025_07_symbol_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_ts ATTACH PARTITION public.price_bars_2025_07_symbol_ts_idx;


--
-- Name: price_bars_2025_07_symbol_ts_idx1; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_date ATTACH PARTITION public.price_bars_2025_07_symbol_ts_idx1;


--
-- Name: price_bars_2025_07_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_ts ATTACH PARTITION public.price_bars_2025_07_ts_idx;


--
-- Name: price_bars_2025_08_contract_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_contract ATTACH PARTITION public.price_bars_2025_08_contract_idx;


--
-- Name: price_bars_2025_08_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.price_bars_new_pkey ATTACH PARTITION public.price_bars_2025_08_pkey;


--
-- Name: price_bars_2025_08_symbol_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_ts ATTACH PARTITION public.price_bars_2025_08_symbol_ts_idx;


--
-- Name: price_bars_2025_08_symbol_ts_idx1; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_date ATTACH PARTITION public.price_bars_2025_08_symbol_ts_idx1;


--
-- Name: price_bars_2025_08_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_ts ATTACH PARTITION public.price_bars_2025_08_ts_idx;


--
-- Name: price_bars_2025_09_contract_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_contract ATTACH PARTITION public.price_bars_2025_09_contract_idx;


--
-- Name: price_bars_2025_09_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.price_bars_new_pkey ATTACH PARTITION public.price_bars_2025_09_pkey;


--
-- Name: price_bars_2025_09_symbol_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_ts ATTACH PARTITION public.price_bars_2025_09_symbol_ts_idx;


--
-- Name: price_bars_2025_09_symbol_ts_idx1; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_date ATTACH PARTITION public.price_bars_2025_09_symbol_ts_idx1;


--
-- Name: price_bars_2025_09_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_ts ATTACH PARTITION public.price_bars_2025_09_ts_idx;


--
-- Name: price_bars_2025_10_contract_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_contract ATTACH PARTITION public.price_bars_2025_10_contract_idx;


--
-- Name: price_bars_2025_10_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.price_bars_new_pkey ATTACH PARTITION public.price_bars_2025_10_pkey;


--
-- Name: price_bars_2025_10_symbol_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_ts ATTACH PARTITION public.price_bars_2025_10_symbol_ts_idx;


--
-- Name: price_bars_2025_10_symbol_ts_idx1; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_date ATTACH PARTITION public.price_bars_2025_10_symbol_ts_idx1;


--
-- Name: price_bars_2025_10_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_ts ATTACH PARTITION public.price_bars_2025_10_ts_idx;


--
-- Name: price_bars_2025_11_contract_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_contract ATTACH PARTITION public.price_bars_2025_11_contract_idx;


--
-- Name: price_bars_2025_11_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.price_bars_new_pkey ATTACH PARTITION public.price_bars_2025_11_pkey;


--
-- Name: price_bars_2025_11_symbol_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_ts ATTACH PARTITION public.price_bars_2025_11_symbol_ts_idx;


--
-- Name: price_bars_2025_11_symbol_ts_idx1; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_date ATTACH PARTITION public.price_bars_2025_11_symbol_ts_idx1;


--
-- Name: price_bars_2025_11_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_ts ATTACH PARTITION public.price_bars_2025_11_ts_idx;


--
-- Name: price_bars_2025_12_contract_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_contract ATTACH PARTITION public.price_bars_2025_12_contract_idx;


--
-- Name: price_bars_2025_12_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.price_bars_new_pkey ATTACH PARTITION public.price_bars_2025_12_pkey;


--
-- Name: price_bars_2025_12_symbol_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_ts ATTACH PARTITION public.price_bars_2025_12_symbol_ts_idx;


--
-- Name: price_bars_2025_12_symbol_ts_idx1; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_date ATTACH PARTITION public.price_bars_2025_12_symbol_ts_idx1;


--
-- Name: price_bars_2025_12_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_ts ATTACH PARTITION public.price_bars_2025_12_ts_idx;


--
-- Name: price_bars_2026_01_contract_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_contract ATTACH PARTITION public.price_bars_2026_01_contract_idx;


--
-- Name: price_bars_2026_01_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.price_bars_new_pkey ATTACH PARTITION public.price_bars_2026_01_pkey;


--
-- Name: price_bars_2026_01_symbol_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_ts ATTACH PARTITION public.price_bars_2026_01_symbol_ts_idx;


--
-- Name: price_bars_2026_01_symbol_ts_idx1; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_date ATTACH PARTITION public.price_bars_2026_01_symbol_ts_idx1;


--
-- Name: price_bars_2026_01_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_ts ATTACH PARTITION public.price_bars_2026_01_ts_idx;


--
-- Name: price_bars_2026_02_contract_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_contract ATTACH PARTITION public.price_bars_2026_02_contract_idx;


--
-- Name: price_bars_2026_02_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.price_bars_new_pkey ATTACH PARTITION public.price_bars_2026_02_pkey;


--
-- Name: price_bars_2026_02_symbol_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_ts ATTACH PARTITION public.price_bars_2026_02_symbol_ts_idx;


--
-- Name: price_bars_2026_02_symbol_ts_idx1; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_date ATTACH PARTITION public.price_bars_2026_02_symbol_ts_idx1;


--
-- Name: price_bars_2026_02_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_ts ATTACH PARTITION public.price_bars_2026_02_ts_idx;


--
-- Name: price_bars_2026_03_contract_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_contract ATTACH PARTITION public.price_bars_2026_03_contract_idx;


--
-- Name: price_bars_2026_03_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.price_bars_new_pkey ATTACH PARTITION public.price_bars_2026_03_pkey;


--
-- Name: price_bars_2026_03_symbol_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_ts ATTACH PARTITION public.price_bars_2026_03_symbol_ts_idx;


--
-- Name: price_bars_2026_03_symbol_ts_idx1; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_date ATTACH PARTITION public.price_bars_2026_03_symbol_ts_idx1;


--
-- Name: price_bars_2026_03_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_ts ATTACH PARTITION public.price_bars_2026_03_ts_idx;


--
-- Name: price_bars_2026_04_contract_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_contract ATTACH PARTITION public.price_bars_2026_04_contract_idx;


--
-- Name: price_bars_2026_04_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.price_bars_new_pkey ATTACH PARTITION public.price_bars_2026_04_pkey;


--
-- Name: price_bars_2026_04_symbol_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_ts ATTACH PARTITION public.price_bars_2026_04_symbol_ts_idx;


--
-- Name: price_bars_2026_04_symbol_ts_idx1; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_date ATTACH PARTITION public.price_bars_2026_04_symbol_ts_idx1;


--
-- Name: price_bars_2026_04_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_ts ATTACH PARTITION public.price_bars_2026_04_ts_idx;


--
-- Name: price_bars_2026_05_contract_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_contract ATTACH PARTITION public.price_bars_2026_05_contract_idx;


--
-- Name: price_bars_2026_05_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.price_bars_new_pkey ATTACH PARTITION public.price_bars_2026_05_pkey;


--
-- Name: price_bars_2026_05_symbol_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_ts ATTACH PARTITION public.price_bars_2026_05_symbol_ts_idx;


--
-- Name: price_bars_2026_05_symbol_ts_idx1; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_date ATTACH PARTITION public.price_bars_2026_05_symbol_ts_idx1;


--
-- Name: price_bars_2026_05_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_ts ATTACH PARTITION public.price_bars_2026_05_ts_idx;


--
-- Name: price_bars_2026_06_contract_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_contract ATTACH PARTITION public.price_bars_2026_06_contract_idx;


--
-- Name: price_bars_2026_06_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.price_bars_new_pkey ATTACH PARTITION public.price_bars_2026_06_pkey;


--
-- Name: price_bars_2026_06_symbol_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_ts ATTACH PARTITION public.price_bars_2026_06_symbol_ts_idx;


--
-- Name: price_bars_2026_06_symbol_ts_idx1; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_date ATTACH PARTITION public.price_bars_2026_06_symbol_ts_idx1;


--
-- Name: price_bars_2026_06_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_ts ATTACH PARTITION public.price_bars_2026_06_ts_idx;


--
-- Name: price_bars_2026_07_contract_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_contract ATTACH PARTITION public.price_bars_2026_07_contract_idx;


--
-- Name: price_bars_2026_07_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.price_bars_new_pkey ATTACH PARTITION public.price_bars_2026_07_pkey;


--
-- Name: price_bars_2026_07_symbol_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_ts ATTACH PARTITION public.price_bars_2026_07_symbol_ts_idx;


--
-- Name: price_bars_2026_07_symbol_ts_idx1; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_date ATTACH PARTITION public.price_bars_2026_07_symbol_ts_idx1;


--
-- Name: price_bars_2026_07_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_ts ATTACH PARTITION public.price_bars_2026_07_ts_idx;


--
-- Name: price_bars_2026_08_contract_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_contract ATTACH PARTITION public.price_bars_2026_08_contract_idx;


--
-- Name: price_bars_2026_08_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.price_bars_new_pkey ATTACH PARTITION public.price_bars_2026_08_pkey;


--
-- Name: price_bars_2026_08_symbol_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_ts ATTACH PARTITION public.price_bars_2026_08_symbol_ts_idx;


--
-- Name: price_bars_2026_08_symbol_ts_idx1; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_date ATTACH PARTITION public.price_bars_2026_08_symbol_ts_idx1;


--
-- Name: price_bars_2026_08_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_ts ATTACH PARTITION public.price_bars_2026_08_ts_idx;


--
-- Name: price_bars_2026_09_contract_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_contract ATTACH PARTITION public.price_bars_2026_09_contract_idx;


--
-- Name: price_bars_2026_09_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.price_bars_new_pkey ATTACH PARTITION public.price_bars_2026_09_pkey;


--
-- Name: price_bars_2026_09_symbol_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_ts ATTACH PARTITION public.price_bars_2026_09_symbol_ts_idx;


--
-- Name: price_bars_2026_09_symbol_ts_idx1; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_date ATTACH PARTITION public.price_bars_2026_09_symbol_ts_idx1;


--
-- Name: price_bars_2026_09_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_ts ATTACH PARTITION public.price_bars_2026_09_ts_idx;


--
-- Name: price_bars_2026_10_contract_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_contract ATTACH PARTITION public.price_bars_2026_10_contract_idx;


--
-- Name: price_bars_2026_10_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.price_bars_new_pkey ATTACH PARTITION public.price_bars_2026_10_pkey;


--
-- Name: price_bars_2026_10_symbol_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_ts ATTACH PARTITION public.price_bars_2026_10_symbol_ts_idx;


--
-- Name: price_bars_2026_10_symbol_ts_idx1; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_date ATTACH PARTITION public.price_bars_2026_10_symbol_ts_idx1;


--
-- Name: price_bars_2026_10_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_ts ATTACH PARTITION public.price_bars_2026_10_ts_idx;


--
-- Name: price_bars_2026_11_contract_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_contract ATTACH PARTITION public.price_bars_2026_11_contract_idx;


--
-- Name: price_bars_2026_11_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.price_bars_new_pkey ATTACH PARTITION public.price_bars_2026_11_pkey;


--
-- Name: price_bars_2026_11_symbol_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_ts ATTACH PARTITION public.price_bars_2026_11_symbol_ts_idx;


--
-- Name: price_bars_2026_11_symbol_ts_idx1; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_date ATTACH PARTITION public.price_bars_2026_11_symbol_ts_idx1;


--
-- Name: price_bars_2026_11_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_ts ATTACH PARTITION public.price_bars_2026_11_ts_idx;


--
-- Name: price_bars_2026_12_contract_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_contract ATTACH PARTITION public.price_bars_2026_12_contract_idx;


--
-- Name: price_bars_2026_12_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.price_bars_new_pkey ATTACH PARTITION public.price_bars_2026_12_pkey;


--
-- Name: price_bars_2026_12_symbol_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_ts ATTACH PARTITION public.price_bars_2026_12_symbol_ts_idx;


--
-- Name: price_bars_2026_12_symbol_ts_idx1; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_date ATTACH PARTITION public.price_bars_2026_12_symbol_ts_idx1;


--
-- Name: price_bars_2026_12_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_ts ATTACH PARTITION public.price_bars_2026_12_ts_idx;


--
-- Name: price_bars_2027_01_contract_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_contract ATTACH PARTITION public.price_bars_2027_01_contract_idx;


--
-- Name: price_bars_2027_01_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.price_bars_new_pkey ATTACH PARTITION public.price_bars_2027_01_pkey;


--
-- Name: price_bars_2027_01_symbol_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_ts ATTACH PARTITION public.price_bars_2027_01_symbol_ts_idx;


--
-- Name: price_bars_2027_01_symbol_ts_idx1; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_date ATTACH PARTITION public.price_bars_2027_01_symbol_ts_idx1;


--
-- Name: price_bars_2027_01_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_ts ATTACH PARTITION public.price_bars_2027_01_ts_idx;


--
-- Name: price_bars_2027_02_contract_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_contract ATTACH PARTITION public.price_bars_2027_02_contract_idx;


--
-- Name: price_bars_2027_02_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.price_bars_new_pkey ATTACH PARTITION public.price_bars_2027_02_pkey;


--
-- Name: price_bars_2027_02_symbol_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_ts ATTACH PARTITION public.price_bars_2027_02_symbol_ts_idx;


--
-- Name: price_bars_2027_02_symbol_ts_idx1; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_date ATTACH PARTITION public.price_bars_2027_02_symbol_ts_idx1;


--
-- Name: price_bars_2027_02_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_ts ATTACH PARTITION public.price_bars_2027_02_ts_idx;


--
-- Name: price_bars_2027_03_contract_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_contract ATTACH PARTITION public.price_bars_2027_03_contract_idx;


--
-- Name: price_bars_2027_03_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.price_bars_new_pkey ATTACH PARTITION public.price_bars_2027_03_pkey;


--
-- Name: price_bars_2027_03_symbol_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_ts ATTACH PARTITION public.price_bars_2027_03_symbol_ts_idx;


--
-- Name: price_bars_2027_03_symbol_ts_idx1; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_date ATTACH PARTITION public.price_bars_2027_03_symbol_ts_idx1;


--
-- Name: price_bars_2027_03_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_ts ATTACH PARTITION public.price_bars_2027_03_ts_idx;


--
-- Name: price_bars_2027_04_contract_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_contract ATTACH PARTITION public.price_bars_2027_04_contract_idx;


--
-- Name: price_bars_2027_04_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.price_bars_new_pkey ATTACH PARTITION public.price_bars_2027_04_pkey;


--
-- Name: price_bars_2027_04_symbol_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_ts ATTACH PARTITION public.price_bars_2027_04_symbol_ts_idx;


--
-- Name: price_bars_2027_04_symbol_ts_idx1; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_date ATTACH PARTITION public.price_bars_2027_04_symbol_ts_idx1;


--
-- Name: price_bars_2027_04_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_ts ATTACH PARTITION public.price_bars_2027_04_ts_idx;


--
-- Name: price_bars_2027_05_contract_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_contract ATTACH PARTITION public.price_bars_2027_05_contract_idx;


--
-- Name: price_bars_2027_05_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.price_bars_new_pkey ATTACH PARTITION public.price_bars_2027_05_pkey;


--
-- Name: price_bars_2027_05_symbol_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_ts ATTACH PARTITION public.price_bars_2027_05_symbol_ts_idx;


--
-- Name: price_bars_2027_05_symbol_ts_idx1; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_date ATTACH PARTITION public.price_bars_2027_05_symbol_ts_idx1;


--
-- Name: price_bars_2027_05_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_ts ATTACH PARTITION public.price_bars_2027_05_ts_idx;


--
-- Name: price_bars_2027_06_contract_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_contract ATTACH PARTITION public.price_bars_2027_06_contract_idx;


--
-- Name: price_bars_2027_06_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.price_bars_new_pkey ATTACH PARTITION public.price_bars_2027_06_pkey;


--
-- Name: price_bars_2027_06_symbol_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_ts ATTACH PARTITION public.price_bars_2027_06_symbol_ts_idx;


--
-- Name: price_bars_2027_06_symbol_ts_idx1; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_date ATTACH PARTITION public.price_bars_2027_06_symbol_ts_idx1;


--
-- Name: price_bars_2027_06_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_ts ATTACH PARTITION public.price_bars_2027_06_ts_idx;


--
-- Name: price_bars_2027_07_contract_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_contract ATTACH PARTITION public.price_bars_2027_07_contract_idx;


--
-- Name: price_bars_2027_07_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.price_bars_new_pkey ATTACH PARTITION public.price_bars_2027_07_pkey;


--
-- Name: price_bars_2027_07_symbol_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_ts ATTACH PARTITION public.price_bars_2027_07_symbol_ts_idx;


--
-- Name: price_bars_2027_07_symbol_ts_idx1; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_date ATTACH PARTITION public.price_bars_2027_07_symbol_ts_idx1;


--
-- Name: price_bars_2027_07_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_ts ATTACH PARTITION public.price_bars_2027_07_ts_idx;


--
-- Name: price_bars_2027_08_contract_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_contract ATTACH PARTITION public.price_bars_2027_08_contract_idx;


--
-- Name: price_bars_2027_08_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.price_bars_new_pkey ATTACH PARTITION public.price_bars_2027_08_pkey;


--
-- Name: price_bars_2027_08_symbol_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_ts ATTACH PARTITION public.price_bars_2027_08_symbol_ts_idx;


--
-- Name: price_bars_2027_08_symbol_ts_idx1; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_date ATTACH PARTITION public.price_bars_2027_08_symbol_ts_idx1;


--
-- Name: price_bars_2027_08_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_ts ATTACH PARTITION public.price_bars_2027_08_ts_idx;


--
-- Name: price_bars_2027_09_contract_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_contract ATTACH PARTITION public.price_bars_2027_09_contract_idx;


--
-- Name: price_bars_2027_09_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.price_bars_new_pkey ATTACH PARTITION public.price_bars_2027_09_pkey;


--
-- Name: price_bars_2027_09_symbol_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_ts ATTACH PARTITION public.price_bars_2027_09_symbol_ts_idx;


--
-- Name: price_bars_2027_09_symbol_ts_idx1; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_date ATTACH PARTITION public.price_bars_2027_09_symbol_ts_idx1;


--
-- Name: price_bars_2027_09_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_ts ATTACH PARTITION public.price_bars_2027_09_ts_idx;


--
-- Name: price_bars_2027_10_contract_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_contract ATTACH PARTITION public.price_bars_2027_10_contract_idx;


--
-- Name: price_bars_2027_10_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.price_bars_new_pkey ATTACH PARTITION public.price_bars_2027_10_pkey;


--
-- Name: price_bars_2027_10_symbol_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_ts ATTACH PARTITION public.price_bars_2027_10_symbol_ts_idx;


--
-- Name: price_bars_2027_10_symbol_ts_idx1; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_date ATTACH PARTITION public.price_bars_2027_10_symbol_ts_idx1;


--
-- Name: price_bars_2027_10_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_ts ATTACH PARTITION public.price_bars_2027_10_ts_idx;


--
-- Name: price_bars_2027_11_contract_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_contract ATTACH PARTITION public.price_bars_2027_11_contract_idx;


--
-- Name: price_bars_2027_11_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.price_bars_new_pkey ATTACH PARTITION public.price_bars_2027_11_pkey;


--
-- Name: price_bars_2027_11_symbol_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_ts ATTACH PARTITION public.price_bars_2027_11_symbol_ts_idx;


--
-- Name: price_bars_2027_11_symbol_ts_idx1; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_date ATTACH PARTITION public.price_bars_2027_11_symbol_ts_idx1;


--
-- Name: price_bars_2027_11_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_ts ATTACH PARTITION public.price_bars_2027_11_ts_idx;


--
-- Name: price_bars_2027_12_contract_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_contract ATTACH PARTITION public.price_bars_2027_12_contract_idx;


--
-- Name: price_bars_2027_12_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.price_bars_new_pkey ATTACH PARTITION public.price_bars_2027_12_pkey;


--
-- Name: price_bars_2027_12_symbol_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_ts ATTACH PARTITION public.price_bars_2027_12_symbol_ts_idx;


--
-- Name: price_bars_2027_12_symbol_ts_idx1; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_symbol_date ATTACH PARTITION public.price_bars_2027_12_symbol_ts_idx1;


--
-- Name: price_bars_2027_12_ts_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_price_bars_new_ts ATTACH PARTITION public.price_bars_2027_12_ts_idx;


--
-- Name: daily_logs update_daily_logs_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_daily_logs_updated_at BEFORE UPDATE ON public.daily_logs FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: trades update_trades_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_trades_updated_at BEFORE UPDATE ON public.trades FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: setup_outcome_backtest setup_outcome_backtest_setup_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.setup_outcome_backtest
    ADD CONSTRAINT setup_outcome_backtest_setup_id_fkey FOREIGN KEY (setup_id) REFERENCES public.active_setups(id) ON DELETE CASCADE;


--
-- Name: trade_feedback trade_feedback_setup_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trade_feedback
    ADD CONSTRAINT trade_feedback_setup_id_fkey FOREIGN KEY (setup_id) REFERENCES public.active_setups(id);


--
-- Name: trade_timeline_events trade_timeline_events_setup_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trade_timeline_events
    ADD CONSTRAINT trade_timeline_events_setup_id_fkey FOREIGN KEY (setup_id) REFERENCES public.active_setups(id);


--
-- Name: trades trades_log_date_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trades
    ADD CONSTRAINT trades_log_date_fkey FOREIGN KEY (log_date) REFERENCES public.daily_logs(log_date) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--


