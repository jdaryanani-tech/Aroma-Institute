-- Generated from a fresh production-primary schema-only catalog export.

-- Contains no application row data; Replit internal schemas and Calendar are excluded.

CREATE TYPE aichm.lms_certificate_status AS ENUM ('not_eligible', 'eligible', 'pending_review', 'approved', 'rejected');
CREATE TYPE aichm.lms_content_status AS ENUM ('draft', 'published', 'archived');
CREATE TYPE aichm.lms_enrollment_status AS ENUM ('active', 'completed', 'suspended', 'withdrawn');
CREATE TYPE aichm.lms_invitation_status AS ENUM ('active', 'revoked');
CREATE TYPE aichm.lms_role AS ENUM ('student', 'trainer', 'admin');

--
-- PostgreSQL database dump
--


-- Dumped from database version 16.15 (23d2a0d)
-- Dumped by pg_dump version 17.6

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: admissions_capture_limits; Type: TABLE; Schema: aichm; Owner: -
--

CREATE TABLE aichm.admissions_capture_limits (
    key_hash text NOT NULL,
    window_started_at timestamp with time zone NOT NULL,
    attempts integer NOT NULL
);


--
-- Name: admissions_crm_activities; Type: TABLE; Schema: aichm; Owner: -
--

CREATE TABLE aichm.admissions_crm_activities (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    inquiry_id integer NOT NULL,
    type text NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    actor_id integer NOT NULL,
    body text,
    data jsonb
);


--
-- Name: admissions_crm_profiles; Type: TABLE; Schema: aichm; Owner: -
--

CREATE TABLE aichm.admissions_crm_profiles (
    inquiry_id integer NOT NULL,
    stage text,
    stage_evidence jsonb,
    owner_id integer,
    follow_up_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by integer NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    CONSTRAINT admissions_crm_stage CHECK ((stage = ANY (ARRAY['new_enquiry'::text, 'contacted'::text, 'qualified'::text, 'vsl_shared'::text, 'vsl_watched'::text, 'form_submitted'::text, 'counselling_pending'::text, 'counselling_booked'::text, 'counselling_attended'::text, 'enrolled'::text, 'nurture'::text, 'lost'::text])))
);


--
-- Name: admissions_leads; Type: TABLE; Schema: aichm; Owner: -
--

CREATE TABLE aichm.admissions_leads (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    canonical_phone text NOT NULL,
    name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    registered_at timestamp with time zone,
    last_registered_at timestamp with time zone,
    entry_source text,
    entry_path text,
    entry_host text,
    questionnaire_status text DEFAULT 'not_submitted'::text NOT NULL,
    questionnaire_completed_at timestamp with time zone,
    legacy_match_status text DEFAULT 'none'::text NOT NULL,
    CONSTRAINT admissions_leads_indian_phone CHECK ((canonical_phone ~ '^91[6-9][0-9]{9}$'::text))
);


--
-- Name: admissions_vsl_events; Type: TABLE; Schema: aichm; Owner: -
--

CREATE TABLE aichm.admissions_vsl_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    lead_id uuid NOT NULL,
    event text NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    position_seconds double precision,
    duration_seconds double precision,
    CONSTRAINT admissions_vsl_event_kind CHECK ((event = ANY (ARRAY['started'::text, '25'::text, '50'::text, '75'::text, '90'::text, 'completed'::text])))
);


--
-- Name: admissions_vsl_playbacks; Type: TABLE; Schema: aichm; Owner: -
--

CREATE TABLE aichm.admissions_vsl_playbacks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    lead_id uuid NOT NULL,
    session_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_observed_at timestamp with time zone,
    last_position double precision,
    duration double precision,
    ranges jsonb DEFAULT '[]'::jsonb NOT NULL,
    sequence integer DEFAULT 0 NOT NULL
);


--
-- Name: counselling_delivery_attempts; Type: TABLE; Schema: aichm; Owner: -
--

CREATE TABLE aichm.counselling_delivery_attempts (
    id integer NOT NULL,
    inquiry_id integer NOT NULL,
    attempt_number integer NOT NULL,
    delivery_state text NOT NULL,
    attempted_at timestamp with time zone NOT NULL,
    response_at timestamp with time zone,
    http_status integer,
    error_summary text
);


--
-- Name: counselling_delivery_attempts_id_seq; Type: SEQUENCE; Schema: aichm; Owner: -
--

CREATE SEQUENCE aichm.counselling_delivery_attempts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: counselling_delivery_attempts_id_seq; Type: SEQUENCE OWNED BY; Schema: aichm; Owner: -
--

ALTER SEQUENCE aichm.counselling_delivery_attempts_id_seq OWNED BY aichm.counselling_delivery_attempts.id;


--
-- Name: inquiries; Type: TABLE; Schema: aichm; Owner: -
--

CREATE TABLE aichm.inquiries (
    id integer NOT NULL,
    name text NOT NULL,
    email text NOT NULL,
    phone text NOT NULL,
    program_interest text NOT NULL,
    message text,
    counselling_answers jsonb,
    counselling_submitted_at timestamp with time zone,
    counselling_delivery_status text DEFAULT 'not_applicable'::text NOT NULL,
    counselling_delivery_attempts integer DEFAULT 0 NOT NULL,
    counselling_delivery_last_attempt_at timestamp with time zone,
    counselling_delivery_last_result text,
    counselling_delivery_last_verified_at timestamp with time zone,
    counselling_delivery_last_verified_by integer,
    lead_id uuid
);


--
-- Name: inquiries_id_seq; Type: SEQUENCE; Schema: aichm; Owner: -
--

CREATE SEQUENCE aichm.inquiries_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: inquiries_id_seq; Type: SEQUENCE OWNED BY; Schema: aichm; Owner: -
--

ALTER SEQUENCE aichm.inquiries_id_seq OWNED BY aichm.inquiries.id;


--
-- Name: lms_assessment_attempts; Type: TABLE; Schema: aichm; Owner: -
--

CREATE TABLE aichm.lms_assessment_attempts (
    id integer NOT NULL,
    enrollment_id integer NOT NULL,
    assessment_id integer NOT NULL,
    version_id integer NOT NULL,
    attempt_number integer NOT NULL,
    answers jsonb NOT NULL,
    score_percent integer NOT NULL,
    passed boolean NOT NULL,
    submitted_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: lms_assessment_attempts_id_seq; Type: SEQUENCE; Schema: aichm; Owner: -
--

CREATE SEQUENCE aichm.lms_assessment_attempts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: lms_assessment_attempts_id_seq; Type: SEQUENCE OWNED BY; Schema: aichm; Owner: -
--

ALTER SEQUENCE aichm.lms_assessment_attempts_id_seq OWNED BY aichm.lms_assessment_attempts.id;


--
-- Name: lms_assessment_options; Type: TABLE; Schema: aichm; Owner: -
--

CREATE TABLE aichm.lms_assessment_options (
    id integer NOT NULL,
    question_id integer NOT NULL,
    label text NOT NULL,
    is_correct boolean DEFAULT false NOT NULL,
    "position" integer DEFAULT 0 NOT NULL
);


--
-- Name: lms_assessment_options_id_seq; Type: SEQUENCE; Schema: aichm; Owner: -
--

CREATE SEQUENCE aichm.lms_assessment_options_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: lms_assessment_options_id_seq; Type: SEQUENCE OWNED BY; Schema: aichm; Owner: -
--

ALTER SEQUENCE aichm.lms_assessment_options_id_seq OWNED BY aichm.lms_assessment_options.id;


--
-- Name: lms_assessment_questions; Type: TABLE; Schema: aichm; Owner: -
--

CREATE TABLE aichm.lms_assessment_questions (
    id integer NOT NULL,
    version_id integer NOT NULL,
    prompt text NOT NULL,
    explanation text,
    "position" integer DEFAULT 0 NOT NULL
);


--
-- Name: lms_assessment_questions_id_seq; Type: SEQUENCE; Schema: aichm; Owner: -
--

CREATE SEQUENCE aichm.lms_assessment_questions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: lms_assessment_questions_id_seq; Type: SEQUENCE OWNED BY; Schema: aichm; Owner: -
--

ALTER SEQUENCE aichm.lms_assessment_questions_id_seq OWNED BY aichm.lms_assessment_questions.id;


--
-- Name: lms_assessment_versions; Type: TABLE; Schema: aichm; Owner: -
--

CREATE TABLE aichm.lms_assessment_versions (
    id integer NOT NULL,
    assessment_id integer NOT NULL,
    version integer NOT NULL,
    instructions text DEFAULT ''::text NOT NULL,
    passing_percent integer DEFAULT 100 NOT NULL,
    show_explanations_after_attempt boolean DEFAULT false NOT NULL,
    created_by integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: lms_assessment_versions_id_seq; Type: SEQUENCE; Schema: aichm; Owner: -
--

CREATE SEQUENCE aichm.lms_assessment_versions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: lms_assessment_versions_id_seq; Type: SEQUENCE OWNED BY; Schema: aichm; Owner: -
--

ALTER SEQUENCE aichm.lms_assessment_versions_id_seq OWNED BY aichm.lms_assessment_versions.id;


--
-- Name: lms_assessments; Type: TABLE; Schema: aichm; Owner: -
--

CREATE TABLE aichm.lms_assessments (
    id integer NOT NULL,
    chapter_id integer NOT NULL,
    title text NOT NULL,
    status aichm.lms_content_status DEFAULT 'draft'::aichm.lms_content_status NOT NULL,
    active_version integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: lms_assessments_id_seq; Type: SEQUENCE; Schema: aichm; Owner: -
--

CREATE SEQUENCE aichm.lms_assessments_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: lms_assessments_id_seq; Type: SEQUENCE OWNED BY; Schema: aichm; Owner: -
--

ALTER SEQUENCE aichm.lms_assessments_id_seq OWNED BY aichm.lms_assessments.id;


--
-- Name: lms_attendance; Type: TABLE; Schema: aichm; Owner: -
--

CREATE TABLE aichm.lms_attendance (
    id integer NOT NULL,
    live_session_id integer NOT NULL,
    student_id integer NOT NULL,
    status text DEFAULT 'unknown'::text NOT NULL,
    recorded_by integer,
    recorded_at timestamp with time zone
);


--
-- Name: lms_attendance_id_seq; Type: SEQUENCE; Schema: aichm; Owner: -
--

CREATE SEQUENCE aichm.lms_attendance_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: lms_attendance_id_seq; Type: SEQUENCE OWNED BY; Schema: aichm; Owner: -
--

ALTER SEQUENCE aichm.lms_attendance_id_seq OWNED BY aichm.lms_attendance.id;


--
-- Name: lms_audit_logs; Type: TABLE; Schema: aichm; Owner: -
--

CREATE TABLE aichm.lms_audit_logs (
    id integer NOT NULL,
    actor_id integer,
    action text NOT NULL,
    entity_type text NOT NULL,
    entity_id text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: lms_audit_logs_id_seq; Type: SEQUENCE; Schema: aichm; Owner: -
--

CREATE SEQUENCE aichm.lms_audit_logs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: lms_audit_logs_id_seq; Type: SEQUENCE OWNED BY; Schema: aichm; Owner: -
--

ALTER SEQUENCE aichm.lms_audit_logs_id_seq OWNED BY aichm.lms_audit_logs.id;


--
-- Name: lms_auth_rate_limits; Type: TABLE; Schema: aichm; Owner: -
--

CREATE TABLE aichm.lms_auth_rate_limits (
    key_hash character varying(64) NOT NULL,
    window_started_at timestamp with time zone NOT NULL,
    attempts integer DEFAULT 0 NOT NULL
);


--
-- Name: lms_certificates; Type: TABLE; Schema: aichm; Owner: -
--

CREATE TABLE aichm.lms_certificates (
    id integer NOT NULL,
    enrollment_id integer NOT NULL,
    status aichm.lms_certificate_status DEFAULT 'not_eligible'::aichm.lms_certificate_status NOT NULL,
    certificate_number character varying(64),
    approved_by integer,
    issued_at timestamp with time zone,
    review_note text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: lms_certificates_id_seq; Type: SEQUENCE; Schema: aichm; Owner: -
--

CREATE SEQUENCE aichm.lms_certificates_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: lms_certificates_id_seq; Type: SEQUENCE OWNED BY; Schema: aichm; Owner: -
--

ALTER SEQUENCE aichm.lms_certificates_id_seq OWNED BY aichm.lms_certificates.id;


--
-- Name: lms_chapters; Type: TABLE; Schema: aichm; Owner: -
--

CREATE TABLE aichm.lms_chapters (
    id integer NOT NULL,
    module_id integer NOT NULL,
    title text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    "position" integer DEFAULT 0 NOT NULL,
    status aichm.lms_content_status DEFAULT 'draft'::aichm.lms_content_status NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: lms_chapters_id_seq; Type: SEQUENCE; Schema: aichm; Owner: -
--

CREATE SEQUENCE aichm.lms_chapters_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: lms_chapters_id_seq; Type: SEQUENCE OWNED BY; Schema: aichm; Owner: -
--

ALTER SEQUENCE aichm.lms_chapters_id_seq OWNED BY aichm.lms_chapters.id;


--
-- Name: lms_courses; Type: TABLE; Schema: aichm; Owner: -
--

CREATE TABLE aichm.lms_courses (
    id integer NOT NULL,
    slug character varying(120) NOT NULL,
    title text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    status aichm.lms_content_status DEFAULT 'draft'::aichm.lms_content_status NOT NULL,
    created_by integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: lms_courses_id_seq; Type: SEQUENCE; Schema: aichm; Owner: -
--

CREATE SEQUENCE aichm.lms_courses_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: lms_courses_id_seq; Type: SEQUENCE OWNED BY; Schema: aichm; Owner: -
--

ALTER SEQUENCE aichm.lms_courses_id_seq OWNED BY aichm.lms_courses.id;


--
-- Name: lms_enrollments; Type: TABLE; Schema: aichm; Owner: -
--

CREATE TABLE aichm.lms_enrollments (
    id integer NOT NULL,
    student_id integer NOT NULL,
    course_id integer NOT NULL,
    status aichm.lms_enrollment_status DEFAULT 'active'::aichm.lms_enrollment_status NOT NULL,
    enrolled_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone
);


--
-- Name: lms_enrollments_id_seq; Type: SEQUENCE; Schema: aichm; Owner: -
--

CREATE SEQUENCE aichm.lms_enrollments_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: lms_enrollments_id_seq; Type: SEQUENCE OWNED BY; Schema: aichm; Owner: -
--

ALTER SEQUENCE aichm.lms_enrollments_id_seq OWNED BY aichm.lms_enrollments.id;


--
-- Name: lms_invitation_codes; Type: TABLE; Schema: aichm; Owner: -
--

CREATE TABLE aichm.lms_invitation_codes (
    id integer NOT NULL,
    code_hash character varying(64) NOT NULL,
    course_id integer NOT NULL,
    status aichm.lms_invitation_status DEFAULT 'active'::aichm.lms_invitation_status NOT NULL,
    expires_at timestamp with time zone,
    max_uses integer DEFAULT 1 NOT NULL,
    uses_count integer DEFAULT 0 NOT NULL,
    reserved_for_phone character varying(20),
    created_by integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    revoked_at timestamp with time zone
);


--
-- Name: lms_invitation_codes_id_seq; Type: SEQUENCE; Schema: aichm; Owner: -
--

CREATE SEQUENCE aichm.lms_invitation_codes_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: lms_invitation_codes_id_seq; Type: SEQUENCE OWNED BY; Schema: aichm; Owner: -
--

ALTER SEQUENCE aichm.lms_invitation_codes_id_seq OWNED BY aichm.lms_invitation_codes.id;


--
-- Name: lms_invitation_redemptions; Type: TABLE; Schema: aichm; Owner: -
--

CREATE TABLE aichm.lms_invitation_redemptions (
    id integer NOT NULL,
    invitation_id integer NOT NULL,
    student_id integer NOT NULL,
    enrollment_id integer NOT NULL,
    redeemed_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: lms_invitation_redemptions_id_seq; Type: SEQUENCE; Schema: aichm; Owner: -
--

CREATE SEQUENCE aichm.lms_invitation_redemptions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: lms_invitation_redemptions_id_seq; Type: SEQUENCE OWNED BY; Schema: aichm; Owner: -
--

ALTER SEQUENCE aichm.lms_invitation_redemptions_id_seq OWNED BY aichm.lms_invitation_redemptions.id;


--
-- Name: lms_lesson_progress; Type: TABLE; Schema: aichm; Owner: -
--

CREATE TABLE aichm.lms_lesson_progress (
    id integer NOT NULL,
    enrollment_id integer NOT NULL,
    lesson_id integer NOT NULL,
    completed_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: lms_lesson_progress_id_seq; Type: SEQUENCE; Schema: aichm; Owner: -
--

CREATE SEQUENCE aichm.lms_lesson_progress_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: lms_lesson_progress_id_seq; Type: SEQUENCE OWNED BY; Schema: aichm; Owner: -
--

ALTER SEQUENCE aichm.lms_lesson_progress_id_seq OWNED BY aichm.lms_lesson_progress.id;


--
-- Name: lms_lessons; Type: TABLE; Schema: aichm; Owner: -
--

CREATE TABLE aichm.lms_lessons (
    id integer NOT NULL,
    chapter_id integer NOT NULL,
    title text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    youtube_url text,
    duration_minutes integer,
    "position" integer DEFAULT 0 NOT NULL,
    required_for_assessment boolean DEFAULT true NOT NULL,
    status aichm.lms_content_status DEFAULT 'draft'::aichm.lms_content_status NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: lms_lessons_id_seq; Type: SEQUENCE; Schema: aichm; Owner: -
--

CREATE SEQUENCE aichm.lms_lessons_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: lms_lessons_id_seq; Type: SEQUENCE OWNED BY; Schema: aichm; Owner: -
--

ALTER SEQUENCE aichm.lms_lessons_id_seq OWNED BY aichm.lms_lessons.id;


--
-- Name: lms_live_sessions; Type: TABLE; Schema: aichm; Owner: -
--

CREATE TABLE aichm.lms_live_sessions (
    id integer NOT NULL,
    course_id integer NOT NULL,
    trainer_id integer,
    title text NOT NULL,
    topic text DEFAULT ''::text NOT NULL,
    meet_url text NOT NULL,
    starts_at timestamp with time zone NOT NULL,
    ends_at timestamp with time zone,
    status text DEFAULT 'scheduled'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: lms_live_sessions_id_seq; Type: SEQUENCE; Schema: aichm; Owner: -
--

CREATE SEQUENCE aichm.lms_live_sessions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: lms_live_sessions_id_seq; Type: SEQUENCE OWNED BY; Schema: aichm; Owner: -
--

ALTER SEQUENCE aichm.lms_live_sessions_id_seq OWNED BY aichm.lms_live_sessions.id;


--
-- Name: lms_modules; Type: TABLE; Schema: aichm; Owner: -
--

CREATE TABLE aichm.lms_modules (
    id integer NOT NULL,
    course_id integer NOT NULL,
    title text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    "position" integer DEFAULT 0 NOT NULL,
    status aichm.lms_content_status DEFAULT 'draft'::aichm.lms_content_status NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: lms_modules_id_seq; Type: SEQUENCE; Schema: aichm; Owner: -
--

CREATE SEQUENCE aichm.lms_modules_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: lms_modules_id_seq; Type: SEQUENCE OWNED BY; Schema: aichm; Owner: -
--

ALTER SEQUENCE aichm.lms_modules_id_seq OWNED BY aichm.lms_modules.id;


--
-- Name: lms_notifications; Type: TABLE; Schema: aichm; Owner: -
--

CREATE TABLE aichm.lms_notifications (
    id integer NOT NULL,
    user_id integer NOT NULL,
    title text NOT NULL,
    body text NOT NULL,
    category text NOT NULL,
    read_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: lms_notifications_id_seq; Type: SEQUENCE; Schema: aichm; Owner: -
--

CREATE SEQUENCE aichm.lms_notifications_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: lms_notifications_id_seq; Type: SEQUENCE OWNED BY; Schema: aichm; Owner: -
--

ALTER SEQUENCE aichm.lms_notifications_id_seq OWNED BY aichm.lms_notifications.id;


--
-- Name: lms_otp_challenges; Type: TABLE; Schema: aichm; Owner: -
--

CREATE TABLE aichm.lms_otp_challenges (
    id integer NOT NULL,
    phone_e164 character varying(20) NOT NULL,
    provider_challenge_id character varying(160),
    expires_at timestamp with time zone NOT NULL,
    resend_available_at timestamp with time zone NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    consumed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: lms_otp_challenges_id_seq; Type: SEQUENCE; Schema: aichm; Owner: -
--

CREATE SEQUENCE aichm.lms_otp_challenges_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: lms_otp_challenges_id_seq; Type: SEQUENCE OWNED BY; Schema: aichm; Owner: -
--

ALTER SEQUENCE aichm.lms_otp_challenges_id_seq OWNED BY aichm.lms_otp_challenges.id;


--
-- Name: lms_password_setup_tokens; Type: TABLE; Schema: aichm; Owner: -
--

CREATE TABLE aichm.lms_password_setup_tokens (
    id integer NOT NULL,
    user_id integer NOT NULL,
    token_hash character varying(64) NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    consumed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: lms_password_setup_tokens_id_seq; Type: SEQUENCE; Schema: aichm; Owner: -
--

CREATE SEQUENCE aichm.lms_password_setup_tokens_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: lms_password_setup_tokens_id_seq; Type: SEQUENCE OWNED BY; Schema: aichm; Owner: -
--

ALTER SEQUENCE aichm.lms_password_setup_tokens_id_seq OWNED BY aichm.lms_password_setup_tokens.id;


--
-- Name: lms_resources; Type: TABLE; Schema: aichm; Owner: -
--

CREATE TABLE aichm.lms_resources (
    id integer NOT NULL,
    lesson_id integer NOT NULL,
    file_name text NOT NULL,
    content_type text NOT NULL,
    byte_size integer NOT NULL,
    storage_key text NOT NULL,
    uploaded_by integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    file_data bytea
);


--
-- Name: lms_resources_id_seq; Type: SEQUENCE; Schema: aichm; Owner: -
--

CREATE SEQUENCE aichm.lms_resources_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: lms_resources_id_seq; Type: SEQUENCE OWNED BY; Schema: aichm; Owner: -
--

ALTER SEQUENCE aichm.lms_resources_id_seq OWNED BY aichm.lms_resources.id;


--
-- Name: lms_trainer_assignments; Type: TABLE; Schema: aichm; Owner: -
--

CREATE TABLE aichm.lms_trainer_assignments (
    id integer NOT NULL,
    trainer_id integer NOT NULL,
    course_id integer NOT NULL,
    assigned_by integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: lms_trainer_assignments_id_seq; Type: SEQUENCE; Schema: aichm; Owner: -
--

CREATE SEQUENCE aichm.lms_trainer_assignments_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: lms_trainer_assignments_id_seq; Type: SEQUENCE OWNED BY; Schema: aichm; Owner: -
--

ALTER SEQUENCE aichm.lms_trainer_assignments_id_seq OWNED BY aichm.lms_trainer_assignments.id;


--
-- Name: lms_user_roles; Type: TABLE; Schema: aichm; Owner: -
--

CREATE TABLE aichm.lms_user_roles (
    user_id integer NOT NULL,
    role aichm.lms_role NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: lms_users; Type: TABLE; Schema: aichm; Owner: -
--

CREATE TABLE aichm.lms_users (
    id integer NOT NULL,
    phone_e164 character varying(20) NOT NULL,
    display_name text,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    password_hash character varying(255)
);


--
-- Name: lms_users_id_seq; Type: SEQUENCE; Schema: aichm; Owner: -
--

CREATE SEQUENCE aichm.lms_users_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: lms_users_id_seq; Type: SEQUENCE OWNED BY; Schema: aichm; Owner: -
--

ALTER SEQUENCE aichm.lms_users_id_seq OWNED BY aichm.lms_users.id;


--
-- Name: sessions; Type: TABLE; Schema: aichm; Owner: -
--

CREATE TABLE aichm.sessions (
    sid character varying(255) NOT NULL,
    sess jsonb NOT NULL,
    expire timestamp(6) without time zone NOT NULL
);


--
-- Name: counselling_delivery_attempts id; Type: DEFAULT; Schema: aichm; Owner: -
--

ALTER TABLE ONLY aichm.counselling_delivery_attempts ALTER COLUMN id SET DEFAULT nextval('aichm.counselling_delivery_attempts_id_seq'::regclass);


--
-- Name: inquiries id; Type: DEFAULT; Schema: aichm; Owner: -
--

ALTER TABLE ONLY aichm.inquiries ALTER COLUMN id SET DEFAULT nextval('aichm.inquiries_id_seq'::regclass);


--
-- Name: lms_assessment_attempts id; Type: DEFAULT; Schema: aichm; Owner: -
--

ALTER TABLE ONLY aichm.lms_assessment_attempts ALTER COLUMN id SET DEFAULT nextval('aichm.lms_assessment_attempts_id_seq'::regclass);


--
-- Name: lms_assessment_options id; Type: DEFAULT; Schema: aichm; Owner: -
--

ALTER TABLE ONLY aichm.lms_assessment_options ALTER COLUMN id SET DEFAULT nextval('aichm.lms_assessment_options_id_seq'::regclass);


--
-- Name: lms_assessment_questions id; Type: DEFAULT; Schema: aichm; Owner: -
--

ALTER TABLE ONLY aichm.lms_assessment_questions ALTER COLUMN id SET DEFAULT nextval('aichm.lms_assessment_questions_id_seq'::regclass);


--
-- Name: lms_assessment_versions id; Type: DEFAULT; Schema: aichm; Owner: -
--

ALTER TABLE ONLY aichm.lms_assessment_versions ALTER COLUMN id SET DEFAULT nextval('aichm.lms_assessment_versions_id_seq'::regclass);


--
-- Name: lms_assessments id; Type: DEFAULT; Schema: aichm; Owner: -
--

ALTER TABLE ONLY aichm.lms_assessments ALTER COLUMN id SET DEFAULT nextval('aichm.lms_assessments_id_seq'::regclass);


--
-- Name: lms_attendance id; Type: DEFAULT; Schema: aichm; Owner: -
--

ALTER TABLE ONLY aichm.lms_attendance ALTER COLUMN id SET DEFAULT nextval('aichm.lms_attendance_id_seq'::regclass);


--
-- Name: lms_audit_logs id; Type: DEFAULT; Schema: aichm; Owner: -
--

ALTER TABLE ONLY aichm.lms_audit_logs ALTER COLUMN id SET DEFAULT nextval('aichm.lms_audit_logs_id_seq'::regclass);


--
-- Name: lms_certificates id; Type: DEFAULT; Schema: aichm; Owner: -
--

ALTER TABLE ONLY aichm.lms_certificates ALTER COLUMN id SET DEFAULT nextval('aichm.lms_certificates_id_seq'::regclass);


--
-- Name: lms_chapters id; Type: DEFAULT; Schema: aichm; Owner: -
--

ALTER TABLE ONLY aichm.lms_chapters ALTER COLUMN id SET DEFAULT nextval('aichm.lms_chapters_id_seq'::regclass);


--
-- Name: lms_courses id; Type: DEFAULT; Schema: aichm; Owner: -
--

ALTER TABLE ONLY aichm.lms_courses ALTER COLUMN id SET DEFAULT nextval('aichm.lms_courses_id_seq'::regclass);


--
-- Name: lms_enrollments id; Type: DEFAULT; Schema: aichm; Owner: -
--

ALTER TABLE ONLY aichm.lms_enrollments ALTER COLUMN id SET DEFAULT nextval('aichm.lms_enrollments_id_seq'::regclass);


--
-- Name: lms_invitation_codes id; Type: DEFAULT; Schema: aichm; Owner: -
--

ALTER TABLE ONLY aichm.lms_invitation_codes ALTER COLUMN id SET DEFAULT nextval('aichm.lms_invitation_codes_id_seq'::regclass);


--
-- Name: lms_invitation_redemptions id; Type: DEFAULT; Schema: aichm; Owner: -
--

ALTER TABLE ONLY aichm.lms_invitation_redemptions ALTER COLUMN id SET DEFAULT nextval('aichm.lms_invitation_redemptions_id_seq'::regclass);


--
-- Name: lms_lesson_progress id; Type: DEFAULT; Schema: aichm; Owner: -
--

ALTER TABLE ONLY aichm.lms_lesson_progress ALTER COLUMN id SET DEFAULT nextval('aichm.lms_lesson_progress_id_seq'::regclass);


--
-- Name: lms_lessons id; Type: DEFAULT; Schema: aichm; Owner: -
--

ALTER TABLE ONLY aichm.lms_lessons ALTER COLUMN id SET DEFAULT nextval('aichm.lms_lessons_id_seq'::regclass);


--
-- Name: lms_live_sessions id; Type: DEFAULT; Schema: aichm; Owner: -
--

ALTER TABLE ONLY aichm.lms_live_sessions ALTER COLUMN id SET DEFAULT nextval('aichm.lms_live_sessions_id_seq'::regclass);


--
-- Name: lms_modules id; Type: DEFAULT; Schema: aichm; Owner: -
--

ALTER TABLE ONLY aichm.lms_modules ALTER COLUMN id SET DEFAULT nextval('aichm.lms_modules_id_seq'::regclass);


--
-- Name: lms_notifications id; Type: DEFAULT; Schema: aichm; Owner: -
--

ALTER TABLE ONLY aichm.lms_notifications ALTER COLUMN id SET DEFAULT nextval('aichm.lms_notifications_id_seq'::regclass);


--
-- Name: lms_otp_challenges id; Type: DEFAULT; Schema: aichm; Owner: -
--

ALTER TABLE ONLY aichm.lms_otp_challenges ALTER COLUMN id SET DEFAULT nextval('aichm.lms_otp_challenges_id_seq'::regclass);


--
-- Name: lms_password_setup_tokens id; Type: DEFAULT; Schema: aichm; Owner: -
--

ALTER TABLE ONLY aichm.lms_password_setup_tokens ALTER COLUMN id SET DEFAULT nextval('aichm.lms_password_setup_tokens_id_seq'::regclass);


--
-- Name: lms_resources id; Type: DEFAULT; Schema: aichm; Owner: -
--

ALTER TABLE ONLY aichm.lms_resources ALTER COLUMN id SET DEFAULT nextval('aichm.lms_resources_id_seq'::regclass);


--
-- Name: lms_trainer_assignments id; Type: DEFAULT; Schema: aichm; Owner: -
--

ALTER TABLE ONLY aichm.lms_trainer_assignments ALTER COLUMN id SET DEFAULT nextval('aichm.lms_trainer_assignments_id_seq'::regclass);


--
-- Name: lms_users id; Type: DEFAULT; Schema: aichm; Owner: -
--

ALTER TABLE ONLY aichm.lms_users ALTER COLUMN id SET DEFAULT nextval('aichm.lms_users_id_seq'::regclass);


--
-- Name: admissions_capture_limits admissions_capture_limits_pkey; Type: CONSTRAINT; Schema: aichm; Owner: -
--

ALTER TABLE ONLY aichm.admissions_capture_limits
    ADD CONSTRAINT admissions_capture_limits_pkey PRIMARY KEY (key_hash);


--
-- Name: admissions_crm_activities admissions_crm_activities_pkey; Type: CONSTRAINT; Schema: aichm; Owner: -
--

ALTER TABLE ONLY aichm.admissions_crm_activities
    ADD CONSTRAINT admissions_crm_activities_pkey PRIMARY KEY (id);


--
-- Name: admissions_crm_profiles admissions_crm_profiles_pkey; Type: CONSTRAINT; Schema: aichm; Owner: -
--

ALTER TABLE ONLY aichm.admissions_crm_profiles
    ADD CONSTRAINT admissions_crm_profiles_pkey PRIMARY KEY (inquiry_id);


--
-- Name: admissions_leads admissions_leads_canonical_phone_unique; Type: CONSTRAINT; Schema: aichm; Owner: -
--

ALTER TABLE ONLY aichm.admissions_leads
    ADD CONSTRAINT admissions_leads_canonical_phone_unique UNIQUE (canonical_phone);


--
-- Name: admissions_leads admissions_leads_pkey; Type: CONSTRAINT; Schema: aichm; Owner: -
--

ALTER TABLE ONLY aichm.admissions_leads
    ADD CONSTRAINT admissions_leads_pkey PRIMARY KEY (id);


--
-- Name: admissions_vsl_events admissions_vsl_events_pkey; Type: CONSTRAINT; Schema: aichm; Owner: -
--

ALTER TABLE ONLY aichm.admissions_vsl_events
    ADD CONSTRAINT admissions_vsl_events_pkey PRIMARY KEY (id);


--
-- Name: admissions_vsl_playbacks admissions_vsl_playbacks_pkey; Type: CONSTRAINT; Schema: aichm; Owner: -
--

ALTER TABLE ONLY aichm.admissions_vsl_playbacks
    ADD CONSTRAINT admissions_vsl_playbacks_pkey PRIMARY KEY (id);


--
-- Name: counselling_delivery_attempts counselling_delivery_attempts_pkey; Type: CONSTRAINT; Schema: aichm; Owner: -
--

ALTER TABLE ONLY aichm.counselling_delivery_attempts
    ADD CONSTRAINT counselling_delivery_attempts_pkey PRIMARY KEY (id);


--
-- Name: inquiries inquiries_pkey; Type: CONSTRAINT; Schema: aichm; Owner: -
--

ALTER TABLE ONLY aichm.inquiries
    ADD CONSTRAINT inquiries_pkey PRIMARY KEY (id);


--
-- Name: lms_assessment_attempts lms_assessment_attempts_pkey; Type: CONSTRAINT; Schema: aichm; Owner: -
--

ALTER TABLE ONLY aichm.lms_assessment_attempts
    ADD CONSTRAINT lms_assessment_attempts_pkey PRIMARY KEY (id);


--
-- Name: lms_assessment_options lms_assessment_options_pkey; Type: CONSTRAINT; Schema: aichm; Owner: -
--

ALTER TABLE ONLY aichm.lms_assessment_options
    ADD CONSTRAINT lms_assessment_options_pkey PRIMARY KEY (id);


--
-- Name: lms_assessment_questions lms_assessment_questions_pkey; Type: CONSTRAINT; Schema: aichm; Owner: -
--

ALTER TABLE ONLY aichm.lms_assessment_questions
    ADD CONSTRAINT lms_assessment_questions_pkey PRIMARY KEY (id);


--
-- Name: lms_assessment_versions lms_assessment_versions_pkey; Type: CONSTRAINT; Schema: aichm; Owner: -
--

ALTER TABLE ONLY aichm.lms_assessment_versions
    ADD CONSTRAINT lms_assessment_versions_pkey PRIMARY KEY (id);


--
-- Name: lms_assessments lms_assessments_pkey; Type: CONSTRAINT; Schema: aichm; Owner: -
--

ALTER TABLE ONLY aichm.lms_assessments
    ADD CONSTRAINT lms_assessments_pkey PRIMARY KEY (id);


--
-- Name: lms_attendance lms_attendance_pkey; Type: CONSTRAINT; Schema: aichm; Owner: -
--

ALTER TABLE ONLY aichm.lms_attendance
    ADD CONSTRAINT lms_attendance_pkey PRIMARY KEY (id);


--
-- Name: lms_audit_logs lms_audit_logs_pkey; Type: CONSTRAINT; Schema: aichm; Owner: -
--

ALTER TABLE ONLY aichm.lms_audit_logs
    ADD CONSTRAINT lms_audit_logs_pkey PRIMARY KEY (id);


--
-- Name: lms_auth_rate_limits lms_auth_rate_limits_pkey; Type: CONSTRAINT; Schema: aichm; Owner: -
--

ALTER TABLE ONLY aichm.lms_auth_rate_limits
    ADD CONSTRAINT lms_auth_rate_limits_pkey PRIMARY KEY (key_hash);


--
-- Name: lms_certificates lms_certificates_certificate_number_unique; Type: CONSTRAINT; Schema: aichm; Owner: -
--

ALTER TABLE ONLY aichm.lms_certificates
    ADD CONSTRAINT lms_certificates_certificate_number_unique UNIQUE (certificate_number);


--
-- Name: lms_certificates lms_certificates_enrollment_id_unique; Type: CONSTRAINT; Schema: aichm; Owner: -
--

ALTER TABLE ONLY aichm.lms_certificates
    ADD CONSTRAINT lms_certificates_enrollment_id_unique UNIQUE (enrollment_id);


--
-- Name: lms_certificates lms_certificates_pkey; Type: CONSTRAINT; Schema: aichm; Owner: -
--

ALTER TABLE ONLY aichm.lms_certificates
    ADD CONSTRAINT lms_certificates_pkey PRIMARY KEY (id);


--
-- Name: lms_chapters lms_chapters_pkey; Type: CONSTRAINT; Schema: aichm; Owner: -
--

ALTER TABLE ONLY aichm.lms_chapters
    ADD CONSTRAINT lms_chapters_pkey PRIMARY KEY (id);


--
-- Name: lms_courses lms_courses_pkey; Type: CONSTRAINT; Schema: aichm; Owner: -
--

ALTER TABLE ONLY aichm.lms_courses
    ADD CONSTRAINT lms_courses_pkey PRIMARY KEY (id);


--
-- Name: lms_courses lms_courses_slug_unique; Type: CONSTRAINT; Schema: aichm; Owner: -
--

ALTER TABLE ONLY aichm.lms_courses
    ADD CONSTRAINT lms_courses_slug_unique UNIQUE (slug);


--
-- Name: lms_enrollments lms_enrollments_pkey; Type: CONSTRAINT; Schema: aichm; Owner: -
--

ALTER TABLE ONLY aichm.lms_enrollments
    ADD CONSTRAINT lms_enrollments_pkey PRIMARY KEY (id);


--
-- Name: lms_invitation_codes lms_invitation_codes_code_hash_unique; Type: CONSTRAINT; Schema: aichm; Owner: -
--

ALTER TABLE ONLY aichm.lms_invitation_codes
    ADD CONSTRAINT lms_invitation_codes_code_hash_unique UNIQUE (code_hash);


--
-- Name: lms_invitation_codes lms_invitation_codes_pkey; Type: CONSTRAINT; Schema: aichm; Owner: -
--

ALTER TABLE ONLY aichm.lms_invitation_codes
    ADD CONSTRAINT lms_invitation_codes_pkey PRIMARY KEY (id);


--
-- Name: lms_invitation_redemptions lms_invitation_redemptions_pkey; Type: CONSTRAINT; Schema: aichm; Owner: -
--

ALTER TABLE ONLY aichm.lms_invitation_redemptions
    ADD CONSTRAINT lms_invitation_redemptions_pkey PRIMARY KEY (id);


--
-- Name: lms_lesson_progress lms_lesson_progress_pkey; Type: CONSTRAINT; Schema: aichm; Owner: -
--

ALTER TABLE ONLY aichm.lms_lesson_progress
    ADD CONSTRAINT lms_lesson_progress_pkey PRIMARY KEY (id);


--
-- Name: lms_lessons lms_lessons_pkey; Type: CONSTRAINT; Schema: aichm; Owner: -
--

ALTER TABLE ONLY aichm.lms_lessons
    ADD CONSTRAINT lms_lessons_pkey PRIMARY KEY (id);


--
-- Name: lms_live_sessions lms_live_sessions_pkey; Type: CONSTRAINT; Schema: aichm; Owner: -
--

ALTER TABLE ONLY aichm.lms_live_sessions
    ADD CONSTRAINT lms_live_sessions_pkey PRIMARY KEY (id);


--
-- Name: lms_modules lms_modules_pkey; Type: CONSTRAINT; Schema: aichm; Owner: -
--

ALTER TABLE ONLY aichm.lms_modules
    ADD CONSTRAINT lms_modules_pkey PRIMARY KEY (id);


--
-- Name: lms_notifications lms_notifications_pkey; Type: CONSTRAINT; Schema: aichm; Owner: -
--

ALTER TABLE ONLY aichm.lms_notifications
    ADD CONSTRAINT lms_notifications_pkey PRIMARY KEY (id);


--
-- Name: lms_otp_challenges lms_otp_challenges_pkey; Type: CONSTRAINT; Schema: aichm; Owner: -
--

ALTER TABLE ONLY aichm.lms_otp_challenges
    ADD CONSTRAINT lms_otp_challenges_pkey PRIMARY KEY (id);


--
-- Name: lms_password_setup_tokens lms_password_setup_tokens_pkey; Type: CONSTRAINT; Schema: aichm; Owner: -
--

ALTER TABLE ONLY aichm.lms_password_setup_tokens
    ADD CONSTRAINT lms_password_setup_tokens_pkey PRIMARY KEY (id);


--
-- Name: lms_password_setup_tokens lms_password_setup_tokens_token_hash_unique; Type: CONSTRAINT; Schema: aichm; Owner: -
--

ALTER TABLE ONLY aichm.lms_password_setup_tokens
    ADD CONSTRAINT lms_password_setup_tokens_token_hash_unique UNIQUE (token_hash);


--
-- Name: lms_resources lms_resources_pkey; Type: CONSTRAINT; Schema: aichm; Owner: -
--

ALTER TABLE ONLY aichm.lms_resources
    ADD CONSTRAINT lms_resources_pkey PRIMARY KEY (id);


--
-- Name: lms_resources lms_resources_storage_key_unique; Type: CONSTRAINT; Schema: aichm; Owner: -
--

ALTER TABLE ONLY aichm.lms_resources
    ADD CONSTRAINT lms_resources_storage_key_unique UNIQUE (storage_key);


--
-- Name: lms_trainer_assignments lms_trainer_assignments_pkey; Type: CONSTRAINT; Schema: aichm; Owner: -
--

ALTER TABLE ONLY aichm.lms_trainer_assignments
    ADD CONSTRAINT lms_trainer_assignments_pkey PRIMARY KEY (id);


--
-- Name: lms_user_roles lms_user_roles_user_id_role_pk; Type: CONSTRAINT; Schema: aichm; Owner: -
--

ALTER TABLE ONLY aichm.lms_user_roles
    ADD CONSTRAINT lms_user_roles_user_id_role_pk PRIMARY KEY (user_id, role);


--
-- Name: lms_users lms_users_phone_e164_unique; Type: CONSTRAINT; Schema: aichm; Owner: -
--

ALTER TABLE ONLY aichm.lms_users
    ADD CONSTRAINT lms_users_phone_e164_unique UNIQUE (phone_e164);


--
-- Name: lms_users lms_users_pkey; Type: CONSTRAINT; Schema: aichm; Owner: -
--

ALTER TABLE ONLY aichm.lms_users
    ADD CONSTRAINT lms_users_pkey PRIMARY KEY (id);


--
-- Name: sessions sessions_pkey; Type: CONSTRAINT; Schema: aichm; Owner: -
--

ALTER TABLE ONLY aichm.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (sid);


--
-- Name: admissions_crm_activity_inquiry_idx; Type: INDEX; Schema: aichm; Owner: -
--

CREATE INDEX admissions_crm_activity_inquiry_idx ON aichm.admissions_crm_activities USING btree (inquiry_id, occurred_at);


--
-- Name: admissions_crm_follow_up_idx; Type: INDEX; Schema: aichm; Owner: -
--

CREATE INDEX admissions_crm_follow_up_idx ON aichm.admissions_crm_profiles USING btree (follow_up_at);


--
-- Name: admissions_crm_owner_idx; Type: INDEX; Schema: aichm; Owner: -
--

CREATE INDEX admissions_crm_owner_idx ON aichm.admissions_crm_profiles USING btree (owner_id);


--
-- Name: admissions_playbacks_lead_idx; Type: INDEX; Schema: aichm; Owner: -
--

CREATE INDEX admissions_playbacks_lead_idx ON aichm.admissions_vsl_playbacks USING btree (lead_id);


--
-- Name: admissions_vsl_event_unique; Type: INDEX; Schema: aichm; Owner: -
--

CREATE UNIQUE INDEX admissions_vsl_event_unique ON aichm.admissions_vsl_events USING btree (lead_id, event);


--
-- Name: counselling_delivery_attempts_inquiry_attempt_unique; Type: INDEX; Schema: aichm; Owner: -
--

CREATE UNIQUE INDEX counselling_delivery_attempts_inquiry_attempt_unique ON aichm.counselling_delivery_attempts USING btree (inquiry_id, attempt_number);


--
-- Name: inquiries_lead_id_idx; Type: INDEX; Schema: aichm; Owner: -
--

CREATE INDEX inquiries_lead_id_idx ON aichm.inquiries USING btree (lead_id);


--
-- Name: lms_assessment_attempts_assessment_idx; Type: INDEX; Schema: aichm; Owner: -
--

CREATE INDEX lms_assessment_attempts_assessment_idx ON aichm.lms_assessment_attempts USING btree (assessment_id);


--
-- Name: lms_assessment_attempts_enrollment_assessment_number_uq; Type: INDEX; Schema: aichm; Owner: -
--

CREATE UNIQUE INDEX lms_assessment_attempts_enrollment_assessment_number_uq ON aichm.lms_assessment_attempts USING btree (enrollment_id, assessment_id, attempt_number);


--
-- Name: lms_assessment_attempts_enrollment_idx; Type: INDEX; Schema: aichm; Owner: -
--

CREATE INDEX lms_assessment_attempts_enrollment_idx ON aichm.lms_assessment_attempts USING btree (enrollment_id);


--
-- Name: lms_assessment_options_question_position_idx; Type: INDEX; Schema: aichm; Owner: -
--

CREATE INDEX lms_assessment_options_question_position_idx ON aichm.lms_assessment_options USING btree (question_id, "position");


--
-- Name: lms_assessment_questions_version_position_idx; Type: INDEX; Schema: aichm; Owner: -
--

CREATE INDEX lms_assessment_questions_version_position_idx ON aichm.lms_assessment_questions USING btree (version_id, "position");


--
-- Name: lms_assessment_versions_assessment_idx; Type: INDEX; Schema: aichm; Owner: -
--

CREATE INDEX lms_assessment_versions_assessment_idx ON aichm.lms_assessment_versions USING btree (assessment_id);


--
-- Name: lms_assessment_versions_assessment_version_uq; Type: INDEX; Schema: aichm; Owner: -
--

CREATE UNIQUE INDEX lms_assessment_versions_assessment_version_uq ON aichm.lms_assessment_versions USING btree (assessment_id, version);


--
-- Name: lms_assessments_chapter_uq; Type: INDEX; Schema: aichm; Owner: -
--

CREATE UNIQUE INDEX lms_assessments_chapter_uq ON aichm.lms_assessments USING btree (chapter_id);


--
-- Name: lms_attendance_session_student_uq; Type: INDEX; Schema: aichm; Owner: -
--

CREATE UNIQUE INDEX lms_attendance_session_student_uq ON aichm.lms_attendance USING btree (live_session_id, student_id);


--
-- Name: lms_audit_logs_actor_idx; Type: INDEX; Schema: aichm; Owner: -
--

CREATE INDEX lms_audit_logs_actor_idx ON aichm.lms_audit_logs USING btree (actor_id);


--
-- Name: lms_audit_logs_created_idx; Type: INDEX; Schema: aichm; Owner: -
--

CREATE INDEX lms_audit_logs_created_idx ON aichm.lms_audit_logs USING btree (created_at);


--
-- Name: lms_audit_logs_entity_idx; Type: INDEX; Schema: aichm; Owner: -
--

CREATE INDEX lms_audit_logs_entity_idx ON aichm.lms_audit_logs USING btree (entity_type, entity_id);


--
-- Name: lms_auth_rate_limits_window_idx; Type: INDEX; Schema: aichm; Owner: -
--

CREATE INDEX lms_auth_rate_limits_window_idx ON aichm.lms_auth_rate_limits USING btree (window_started_at);


--
-- Name: lms_certificates_status_idx; Type: INDEX; Schema: aichm; Owner: -
--

CREATE INDEX lms_certificates_status_idx ON aichm.lms_certificates USING btree (status);


--
-- Name: lms_chapters_module_position_idx; Type: INDEX; Schema: aichm; Owner: -
--

CREATE INDEX lms_chapters_module_position_idx ON aichm.lms_chapters USING btree (module_id, "position");


--
-- Name: lms_courses_status_idx; Type: INDEX; Schema: aichm; Owner: -
--

CREATE INDEX lms_courses_status_idx ON aichm.lms_courses USING btree (status);


--
-- Name: lms_enrollments_course_status_idx; Type: INDEX; Schema: aichm; Owner: -
--

CREATE INDEX lms_enrollments_course_status_idx ON aichm.lms_enrollments USING btree (course_id, status);


--
-- Name: lms_enrollments_student_course_uq; Type: INDEX; Schema: aichm; Owner: -
--

CREATE UNIQUE INDEX lms_enrollments_student_course_uq ON aichm.lms_enrollments USING btree (student_id, course_id);


--
-- Name: lms_enrollments_student_status_idx; Type: INDEX; Schema: aichm; Owner: -
--

CREATE INDEX lms_enrollments_student_status_idx ON aichm.lms_enrollments USING btree (student_id, status);


--
-- Name: lms_invitation_codes_course_idx; Type: INDEX; Schema: aichm; Owner: -
--

CREATE INDEX lms_invitation_codes_course_idx ON aichm.lms_invitation_codes USING btree (course_id);


--
-- Name: lms_invitation_codes_status_expiry_idx; Type: INDEX; Schema: aichm; Owner: -
--

CREATE INDEX lms_invitation_codes_status_expiry_idx ON aichm.lms_invitation_codes USING btree (status, expires_at);


--
-- Name: lms_invitation_redemptions_invitation_student_uq; Type: INDEX; Schema: aichm; Owner: -
--

CREATE UNIQUE INDEX lms_invitation_redemptions_invitation_student_uq ON aichm.lms_invitation_redemptions USING btree (invitation_id, student_id);


--
-- Name: lms_invitation_redemptions_student_idx; Type: INDEX; Schema: aichm; Owner: -
--

CREATE INDEX lms_invitation_redemptions_student_idx ON aichm.lms_invitation_redemptions USING btree (student_id);


--
-- Name: lms_lesson_progress_enrollment_idx; Type: INDEX; Schema: aichm; Owner: -
--

CREATE INDEX lms_lesson_progress_enrollment_idx ON aichm.lms_lesson_progress USING btree (enrollment_id);


--
-- Name: lms_lesson_progress_enrollment_lesson_uq; Type: INDEX; Schema: aichm; Owner: -
--

CREATE UNIQUE INDEX lms_lesson_progress_enrollment_lesson_uq ON aichm.lms_lesson_progress USING btree (enrollment_id, lesson_id);


--
-- Name: lms_lessons_chapter_position_idx; Type: INDEX; Schema: aichm; Owner: -
--

CREATE INDEX lms_lessons_chapter_position_idx ON aichm.lms_lessons USING btree (chapter_id, "position");


--
-- Name: lms_lessons_status_idx; Type: INDEX; Schema: aichm; Owner: -
--

CREATE INDEX lms_lessons_status_idx ON aichm.lms_lessons USING btree (status);


--
-- Name: lms_live_sessions_course_start_idx; Type: INDEX; Schema: aichm; Owner: -
--

CREATE INDEX lms_live_sessions_course_start_idx ON aichm.lms_live_sessions USING btree (course_id, starts_at);


--
-- Name: lms_modules_course_position_idx; Type: INDEX; Schema: aichm; Owner: -
--

CREATE INDEX lms_modules_course_position_idx ON aichm.lms_modules USING btree (course_id, "position");


--
-- Name: lms_notifications_user_created_idx; Type: INDEX; Schema: aichm; Owner: -
--

CREATE INDEX lms_notifications_user_created_idx ON aichm.lms_notifications USING btree (user_id, created_at);


--
-- Name: lms_otp_challenges_expiry_idx; Type: INDEX; Schema: aichm; Owner: -
--

CREATE INDEX lms_otp_challenges_expiry_idx ON aichm.lms_otp_challenges USING btree (expires_at);


--
-- Name: lms_otp_challenges_phone_created_idx; Type: INDEX; Schema: aichm; Owner: -
--

CREATE INDEX lms_otp_challenges_phone_created_idx ON aichm.lms_otp_challenges USING btree (phone_e164, created_at);


--
-- Name: lms_password_setup_tokens_expiry_idx; Type: INDEX; Schema: aichm; Owner: -
--

CREATE INDEX lms_password_setup_tokens_expiry_idx ON aichm.lms_password_setup_tokens USING btree (expires_at);


--
-- Name: lms_password_setup_tokens_user_idx; Type: INDEX; Schema: aichm; Owner: -
--

CREATE INDEX lms_password_setup_tokens_user_idx ON aichm.lms_password_setup_tokens USING btree (user_id, created_at);


--
-- Name: lms_resources_lesson_idx; Type: INDEX; Schema: aichm; Owner: -
--

CREATE INDEX lms_resources_lesson_idx ON aichm.lms_resources USING btree (lesson_id);


--
-- Name: lms_trainer_assignments_course_idx; Type: INDEX; Schema: aichm; Owner: -
--

CREATE INDEX lms_trainer_assignments_course_idx ON aichm.lms_trainer_assignments USING btree (course_id);


--
-- Name: lms_trainer_assignments_trainer_course_uq; Type: INDEX; Schema: aichm; Owner: -
--

CREATE UNIQUE INDEX lms_trainer_assignments_trainer_course_uq ON aichm.lms_trainer_assignments USING btree (trainer_id, course_id);


--
-- Name: lms_users_active_idx; Type: INDEX; Schema: aichm; Owner: -
--

CREATE INDEX lms_users_active_idx ON aichm.lms_users USING btree (is_active);


--
-- Name: sessions_expire_idx; Type: INDEX; Schema: aichm; Owner: -
--

CREATE INDEX sessions_expire_idx ON aichm.sessions USING btree (expire);


--
-- Name: admissions_crm_activities admissions_crm_activities_actor_id_lms_users_id_fk; Type: FK CONSTRAINT; Schema: aichm; Owner: -
--

ALTER TABLE ONLY aichm.admissions_crm_activities
    ADD CONSTRAINT admissions_crm_activities_actor_id_lms_users_id_fk FOREIGN KEY (actor_id) REFERENCES aichm.lms_users(id);


--
-- Name: admissions_crm_activities admissions_crm_activities_inquiry_id_inquiries_id_fk; Type: FK CONSTRAINT; Schema: aichm; Owner: -
--

ALTER TABLE ONLY aichm.admissions_crm_activities
    ADD CONSTRAINT admissions_crm_activities_inquiry_id_inquiries_id_fk FOREIGN KEY (inquiry_id) REFERENCES aichm.inquiries(id);


--
-- Name: admissions_crm_profiles admissions_crm_profiles_inquiry_id_inquiries_id_fk; Type: FK CONSTRAINT; Schema: aichm; Owner: -
--

ALTER TABLE ONLY aichm.admissions_crm_profiles
    ADD CONSTRAINT admissions_crm_profiles_inquiry_id_inquiries_id_fk FOREIGN KEY (inquiry_id) REFERENCES aichm.inquiries(id);


--
-- Name: admissions_crm_profiles admissions_crm_profiles_owner_id_lms_users_id_fk; Type: FK CONSTRAINT; Schema: aichm; Owner: -
--

ALTER TABLE ONLY aichm.admissions_crm_profiles
    ADD CONSTRAINT admissions_crm_profiles_owner_id_lms_users_id_fk FOREIGN KEY (owner_id) REFERENCES aichm.lms_users(id);


--
-- Name: admissions_crm_profiles admissions_crm_profiles_updated_by_lms_users_id_fk; Type: FK CONSTRAINT; Schema: aichm; Owner: -
--

ALTER TABLE ONLY aichm.admissions_crm_profiles
    ADD CONSTRAINT admissions_crm_profiles_updated_by_lms_users_id_fk FOREIGN KEY (updated_by) REFERENCES aichm.lms_users(id);


--
-- Name: admissions_vsl_events admissions_vsl_events_lead_id_admissions_leads_id_fk; Type: FK CONSTRAINT; Schema: aichm; Owner: -
--

ALTER TABLE ONLY aichm.admissions_vsl_events
    ADD CONSTRAINT admissions_vsl_events_lead_id_admissions_leads_id_fk FOREIGN KEY (lead_id) REFERENCES aichm.admissions_leads(id);


--
-- Name: admissions_vsl_playbacks admissions_vsl_playbacks_lead_id_admissions_leads_id_fk; Type: FK CONSTRAINT; Schema: aichm; Owner: -
--

ALTER TABLE ONLY aichm.admissions_vsl_playbacks
    ADD CONSTRAINT admissions_vsl_playbacks_lead_id_admissions_leads_id_fk FOREIGN KEY (lead_id) REFERENCES aichm.admissions_leads(id);


--
-- Name: counselling_delivery_attempts counselling_delivery_attempts_inquiry_id_inquiries_id_fk; Type: FK CONSTRAINT; Schema: aichm; Owner: -
--

ALTER TABLE ONLY aichm.counselling_delivery_attempts
    ADD CONSTRAINT counselling_delivery_attempts_inquiry_id_inquiries_id_fk FOREIGN KEY (inquiry_id) REFERENCES aichm.inquiries(id) ON DELETE CASCADE;


--
-- Name: inquiries inquiries_lead_id_admissions_leads_id_fk; Type: FK CONSTRAINT; Schema: aichm; Owner: -
--

ALTER TABLE ONLY aichm.inquiries
    ADD CONSTRAINT inquiries_lead_id_admissions_leads_id_fk FOREIGN KEY (lead_id) REFERENCES aichm.admissions_leads(id);


--
-- Name: lms_assessment_attempts lms_assessment_attempts_assessment_id_lms_assessments_id_fk; Type: FK CONSTRAINT; Schema: aichm; Owner: -
--

ALTER TABLE ONLY aichm.lms_assessment_attempts
    ADD CONSTRAINT lms_assessment_attempts_assessment_id_lms_assessments_id_fk FOREIGN KEY (assessment_id) REFERENCES aichm.lms_assessments(id) ON DELETE RESTRICT;


--
-- Name: lms_assessment_attempts lms_assessment_attempts_enrollment_id_lms_enrollments_id_fk; Type: FK CONSTRAINT; Schema: aichm; Owner: -
--

ALTER TABLE ONLY aichm.lms_assessment_attempts
    ADD CONSTRAINT lms_assessment_attempts_enrollment_id_lms_enrollments_id_fk FOREIGN KEY (enrollment_id) REFERENCES aichm.lms_enrollments(id) ON DELETE RESTRICT;


--
-- Name: lms_assessment_attempts lms_assessment_attempts_version_id_lms_assessment_versions_id_f; Type: FK CONSTRAINT; Schema: aichm; Owner: -
--

ALTER TABLE ONLY aichm.lms_assessment_attempts
    ADD CONSTRAINT lms_assessment_attempts_version_id_lms_assessment_versions_id_f FOREIGN KEY (version_id) REFERENCES aichm.lms_assessment_versions(id) ON DELETE RESTRICT;


--
-- Name: lms_assessment_options lms_assessment_options_question_id_lms_assessment_questions_id_; Type: FK CONSTRAINT; Schema: aichm; Owner: -
--

ALTER TABLE ONLY aichm.lms_assessment_options
    ADD CONSTRAINT lms_assessment_options_question_id_lms_assessment_questions_id_ FOREIGN KEY (question_id) REFERENCES aichm.lms_assessment_questions(id) ON DELETE RESTRICT;


--
-- Name: lms_assessment_questions lms_assessment_questions_version_id_lms_assessment_versions_id_; Type: FK CONSTRAINT; Schema: aichm; Owner: -
--

ALTER TABLE ONLY aichm.lms_assessment_questions
    ADD CONSTRAINT lms_assessment_questions_version_id_lms_assessment_versions_id_ FOREIGN KEY (version_id) REFERENCES aichm.lms_assessment_versions(id) ON DELETE RESTRICT;


--
-- Name: lms_assessment_versions lms_assessment_versions_assessment_id_lms_assessments_id_fk; Type: FK CONSTRAINT; Schema: aichm; Owner: -
--

ALTER TABLE ONLY aichm.lms_assessment_versions
    ADD CONSTRAINT lms_assessment_versions_assessment_id_lms_assessments_id_fk FOREIGN KEY (assessment_id) REFERENCES aichm.lms_assessments(id) ON DELETE RESTRICT;


--
-- Name: lms_assessment_versions lms_assessment_versions_created_by_lms_users_id_fk; Type: FK CONSTRAINT; Schema: aichm; Owner: -
--

ALTER TABLE ONLY aichm.lms_assessment_versions
    ADD CONSTRAINT lms_assessment_versions_created_by_lms_users_id_fk FOREIGN KEY (created_by) REFERENCES aichm.lms_users(id) ON DELETE SET NULL;


--
-- Name: lms_assessments lms_assessments_chapter_id_lms_chapters_id_fk; Type: FK CONSTRAINT; Schema: aichm; Owner: -
--

ALTER TABLE ONLY aichm.lms_assessments
    ADD CONSTRAINT lms_assessments_chapter_id_lms_chapters_id_fk FOREIGN KEY (chapter_id) REFERENCES aichm.lms_chapters(id) ON DELETE RESTRICT;


--
-- Name: lms_attendance lms_attendance_live_session_id_lms_live_sessions_id_fk; Type: FK CONSTRAINT; Schema: aichm; Owner: -
--

ALTER TABLE ONLY aichm.lms_attendance
    ADD CONSTRAINT lms_attendance_live_session_id_lms_live_sessions_id_fk FOREIGN KEY (live_session_id) REFERENCES aichm.lms_live_sessions(id) ON DELETE RESTRICT;


--
-- Name: lms_attendance lms_attendance_recorded_by_lms_users_id_fk; Type: FK CONSTRAINT; Schema: aichm; Owner: -
--

ALTER TABLE ONLY aichm.lms_attendance
    ADD CONSTRAINT lms_attendance_recorded_by_lms_users_id_fk FOREIGN KEY (recorded_by) REFERENCES aichm.lms_users(id) ON DELETE SET NULL;


--
-- Name: lms_attendance lms_attendance_student_id_lms_users_id_fk; Type: FK CONSTRAINT; Schema: aichm; Owner: -
--

ALTER TABLE ONLY aichm.lms_attendance
    ADD CONSTRAINT lms_attendance_student_id_lms_users_id_fk FOREIGN KEY (student_id) REFERENCES aichm.lms_users(id) ON DELETE RESTRICT;


--
-- Name: lms_audit_logs lms_audit_logs_actor_id_lms_users_id_fk; Type: FK CONSTRAINT; Schema: aichm; Owner: -
--

ALTER TABLE ONLY aichm.lms_audit_logs
    ADD CONSTRAINT lms_audit_logs_actor_id_lms_users_id_fk FOREIGN KEY (actor_id) REFERENCES aichm.lms_users(id) ON DELETE SET NULL;


--
-- Name: lms_certificates lms_certificates_approved_by_lms_users_id_fk; Type: FK CONSTRAINT; Schema: aichm; Owner: -
--

ALTER TABLE ONLY aichm.lms_certificates
    ADD CONSTRAINT lms_certificates_approved_by_lms_users_id_fk FOREIGN KEY (approved_by) REFERENCES aichm.lms_users(id) ON DELETE SET NULL;


--
-- Name: lms_certificates lms_certificates_enrollment_id_lms_enrollments_id_fk; Type: FK CONSTRAINT; Schema: aichm; Owner: -
--

ALTER TABLE ONLY aichm.lms_certificates
    ADD CONSTRAINT lms_certificates_enrollment_id_lms_enrollments_id_fk FOREIGN KEY (enrollment_id) REFERENCES aichm.lms_enrollments(id) ON DELETE RESTRICT;


--
-- Name: lms_chapters lms_chapters_module_id_lms_modules_id_fk; Type: FK CONSTRAINT; Schema: aichm; Owner: -
--

ALTER TABLE ONLY aichm.lms_chapters
    ADD CONSTRAINT lms_chapters_module_id_lms_modules_id_fk FOREIGN KEY (module_id) REFERENCES aichm.lms_modules(id) ON DELETE RESTRICT;


--
-- Name: lms_courses lms_courses_created_by_lms_users_id_fk; Type: FK CONSTRAINT; Schema: aichm; Owner: -
--

ALTER TABLE ONLY aichm.lms_courses
    ADD CONSTRAINT lms_courses_created_by_lms_users_id_fk FOREIGN KEY (created_by) REFERENCES aichm.lms_users(id) ON DELETE SET NULL;


--
-- Name: lms_enrollments lms_enrollments_course_id_lms_courses_id_fk; Type: FK CONSTRAINT; Schema: aichm; Owner: -
--

ALTER TABLE ONLY aichm.lms_enrollments
    ADD CONSTRAINT lms_enrollments_course_id_lms_courses_id_fk FOREIGN KEY (course_id) REFERENCES aichm.lms_courses(id) ON DELETE RESTRICT;


--
-- Name: lms_enrollments lms_enrollments_student_id_lms_users_id_fk; Type: FK CONSTRAINT; Schema: aichm; Owner: -
--

ALTER TABLE ONLY aichm.lms_enrollments
    ADD CONSTRAINT lms_enrollments_student_id_lms_users_id_fk FOREIGN KEY (student_id) REFERENCES aichm.lms_users(id) ON DELETE RESTRICT;


--
-- Name: lms_invitation_codes lms_invitation_codes_course_id_lms_courses_id_fk; Type: FK CONSTRAINT; Schema: aichm; Owner: -
--

ALTER TABLE ONLY aichm.lms_invitation_codes
    ADD CONSTRAINT lms_invitation_codes_course_id_lms_courses_id_fk FOREIGN KEY (course_id) REFERENCES aichm.lms_courses(id) ON DELETE RESTRICT;


--
-- Name: lms_invitation_codes lms_invitation_codes_created_by_lms_users_id_fk; Type: FK CONSTRAINT; Schema: aichm; Owner: -
--

ALTER TABLE ONLY aichm.lms_invitation_codes
    ADD CONSTRAINT lms_invitation_codes_created_by_lms_users_id_fk FOREIGN KEY (created_by) REFERENCES aichm.lms_users(id) ON DELETE RESTRICT;


--
-- Name: lms_invitation_redemptions lms_invitation_redemptions_enrollment_id_lms_enrollments_id_fk; Type: FK CONSTRAINT; Schema: aichm; Owner: -
--

ALTER TABLE ONLY aichm.lms_invitation_redemptions
    ADD CONSTRAINT lms_invitation_redemptions_enrollment_id_lms_enrollments_id_fk FOREIGN KEY (enrollment_id) REFERENCES aichm.lms_enrollments(id) ON DELETE RESTRICT;


--
-- Name: lms_invitation_redemptions lms_invitation_redemptions_invitation_id_lms_invitation_codes_i; Type: FK CONSTRAINT; Schema: aichm; Owner: -
--

ALTER TABLE ONLY aichm.lms_invitation_redemptions
    ADD CONSTRAINT lms_invitation_redemptions_invitation_id_lms_invitation_codes_i FOREIGN KEY (invitation_id) REFERENCES aichm.lms_invitation_codes(id) ON DELETE RESTRICT;


--
-- Name: lms_invitation_redemptions lms_invitation_redemptions_student_id_lms_users_id_fk; Type: FK CONSTRAINT; Schema: aichm; Owner: -
--

ALTER TABLE ONLY aichm.lms_invitation_redemptions
    ADD CONSTRAINT lms_invitation_redemptions_student_id_lms_users_id_fk FOREIGN KEY (student_id) REFERENCES aichm.lms_users(id) ON DELETE RESTRICT;


--
-- Name: lms_lesson_progress lms_lesson_progress_enrollment_id_lms_enrollments_id_fk; Type: FK CONSTRAINT; Schema: aichm; Owner: -
--

ALTER TABLE ONLY aichm.lms_lesson_progress
    ADD CONSTRAINT lms_lesson_progress_enrollment_id_lms_enrollments_id_fk FOREIGN KEY (enrollment_id) REFERENCES aichm.lms_enrollments(id) ON DELETE CASCADE;


--
-- Name: lms_lesson_progress lms_lesson_progress_lesson_id_lms_lessons_id_fk; Type: FK CONSTRAINT; Schema: aichm; Owner: -
--

ALTER TABLE ONLY aichm.lms_lesson_progress
    ADD CONSTRAINT lms_lesson_progress_lesson_id_lms_lessons_id_fk FOREIGN KEY (lesson_id) REFERENCES aichm.lms_lessons(id) ON DELETE RESTRICT;


--
-- Name: lms_lessons lms_lessons_chapter_id_lms_chapters_id_fk; Type: FK CONSTRAINT; Schema: aichm; Owner: -
--

ALTER TABLE ONLY aichm.lms_lessons
    ADD CONSTRAINT lms_lessons_chapter_id_lms_chapters_id_fk FOREIGN KEY (chapter_id) REFERENCES aichm.lms_chapters(id) ON DELETE RESTRICT;


--
-- Name: lms_live_sessions lms_live_sessions_course_id_lms_courses_id_fk; Type: FK CONSTRAINT; Schema: aichm; Owner: -
--

ALTER TABLE ONLY aichm.lms_live_sessions
    ADD CONSTRAINT lms_live_sessions_course_id_lms_courses_id_fk FOREIGN KEY (course_id) REFERENCES aichm.lms_courses(id) ON DELETE RESTRICT;


--
-- Name: lms_live_sessions lms_live_sessions_trainer_id_lms_users_id_fk; Type: FK CONSTRAINT; Schema: aichm; Owner: -
--

ALTER TABLE ONLY aichm.lms_live_sessions
    ADD CONSTRAINT lms_live_sessions_trainer_id_lms_users_id_fk FOREIGN KEY (trainer_id) REFERENCES aichm.lms_users(id) ON DELETE SET NULL;


--
-- Name: lms_modules lms_modules_course_id_lms_courses_id_fk; Type: FK CONSTRAINT; Schema: aichm; Owner: -
--

ALTER TABLE ONLY aichm.lms_modules
    ADD CONSTRAINT lms_modules_course_id_lms_courses_id_fk FOREIGN KEY (course_id) REFERENCES aichm.lms_courses(id) ON DELETE RESTRICT;


--
-- Name: lms_notifications lms_notifications_user_id_lms_users_id_fk; Type: FK CONSTRAINT; Schema: aichm; Owner: -
--

ALTER TABLE ONLY aichm.lms_notifications
    ADD CONSTRAINT lms_notifications_user_id_lms_users_id_fk FOREIGN KEY (user_id) REFERENCES aichm.lms_users(id) ON DELETE CASCADE;


--
-- Name: lms_password_setup_tokens lms_password_setup_tokens_user_id_lms_users_id_fk; Type: FK CONSTRAINT; Schema: aichm; Owner: -
--

ALTER TABLE ONLY aichm.lms_password_setup_tokens
    ADD CONSTRAINT lms_password_setup_tokens_user_id_lms_users_id_fk FOREIGN KEY (user_id) REFERENCES aichm.lms_users(id) ON DELETE CASCADE;


--
-- Name: lms_resources lms_resources_lesson_id_lms_lessons_id_fk; Type: FK CONSTRAINT; Schema: aichm; Owner: -
--

ALTER TABLE ONLY aichm.lms_resources
    ADD CONSTRAINT lms_resources_lesson_id_lms_lessons_id_fk FOREIGN KEY (lesson_id) REFERENCES aichm.lms_lessons(id) ON DELETE RESTRICT;


--
-- Name: lms_resources lms_resources_uploaded_by_lms_users_id_fk; Type: FK CONSTRAINT; Schema: aichm; Owner: -
--

ALTER TABLE ONLY aichm.lms_resources
    ADD CONSTRAINT lms_resources_uploaded_by_lms_users_id_fk FOREIGN KEY (uploaded_by) REFERENCES aichm.lms_users(id) ON DELETE SET NULL;


--
-- Name: lms_trainer_assignments lms_trainer_assignments_assigned_by_lms_users_id_fk; Type: FK CONSTRAINT; Schema: aichm; Owner: -
--

ALTER TABLE ONLY aichm.lms_trainer_assignments
    ADD CONSTRAINT lms_trainer_assignments_assigned_by_lms_users_id_fk FOREIGN KEY (assigned_by) REFERENCES aichm.lms_users(id) ON DELETE RESTRICT;


--
-- Name: lms_trainer_assignments lms_trainer_assignments_course_id_lms_courses_id_fk; Type: FK CONSTRAINT; Schema: aichm; Owner: -
--

ALTER TABLE ONLY aichm.lms_trainer_assignments
    ADD CONSTRAINT lms_trainer_assignments_course_id_lms_courses_id_fk FOREIGN KEY (course_id) REFERENCES aichm.lms_courses(id) ON DELETE RESTRICT;


--
-- Name: lms_trainer_assignments lms_trainer_assignments_trainer_id_lms_users_id_fk; Type: FK CONSTRAINT; Schema: aichm; Owner: -
--

ALTER TABLE ONLY aichm.lms_trainer_assignments
    ADD CONSTRAINT lms_trainer_assignments_trainer_id_lms_users_id_fk FOREIGN KEY (trainer_id) REFERENCES aichm.lms_users(id) ON DELETE RESTRICT;


--
-- Name: lms_user_roles lms_user_roles_user_id_lms_users_id_fk; Type: FK CONSTRAINT; Schema: aichm; Owner: -
--

ALTER TABLE ONLY aichm.lms_user_roles
    ADD CONSTRAINT lms_user_roles_user_id_lms_users_id_fk FOREIGN KEY (user_id) REFERENCES aichm.lms_users(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--

ALTER TABLE aichm.lms_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE aichm.lms_user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE aichm.lms_auth_rate_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE aichm.lms_otp_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE aichm.lms_password_setup_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE aichm.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE aichm.admissions_capture_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE aichm.admissions_leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE aichm.lms_courses ENABLE ROW LEVEL SECURITY;
ALTER TABLE aichm.lms_modules ENABLE ROW LEVEL SECURITY;
ALTER TABLE aichm.lms_chapters ENABLE ROW LEVEL SECURITY;
ALTER TABLE aichm.lms_lessons ENABLE ROW LEVEL SECURITY;
ALTER TABLE aichm.lms_assessments ENABLE ROW LEVEL SECURITY;
ALTER TABLE aichm.lms_assessment_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE aichm.lms_assessment_questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE aichm.lms_assessment_options ENABLE ROW LEVEL SECURITY;
ALTER TABLE aichm.lms_enrollments ENABLE ROW LEVEL SECURITY;
ALTER TABLE aichm.lms_lesson_progress ENABLE ROW LEVEL SECURITY;
ALTER TABLE aichm.lms_assessment_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE aichm.lms_certificates ENABLE ROW LEVEL SECURITY;
ALTER TABLE aichm.lms_invitation_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE aichm.lms_invitation_redemptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE aichm.lms_trainer_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE aichm.lms_live_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE aichm.lms_attendance ENABLE ROW LEVEL SECURITY;
ALTER TABLE aichm.lms_resources ENABLE ROW LEVEL SECURITY;
ALTER TABLE aichm.lms_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE aichm.lms_audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE aichm.inquiries ENABLE ROW LEVEL SECURITY;
ALTER TABLE aichm.counselling_delivery_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE aichm.admissions_vsl_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE aichm.admissions_vsl_playbacks ENABLE ROW LEVEL SECURITY;
ALTER TABLE aichm.admissions_crm_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE aichm.admissions_crm_activities ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON SCHEMA aichm FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON ALL TABLES IN SCHEMA aichm FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA aichm FROM PUBLIC, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA aichm
  REVOKE ALL ON TABLES FROM PUBLIC, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA aichm
  REVOKE ALL ON SEQUENCES FROM PUBLIC, anon, authenticated, service_role;

INSERT INTO aichm.schema_migrations (version, migration_name)
VALUES ('aichm-app-schema-v1', 'empty-production-application-schema')
ON CONFLICT (version) DO NOTHING;