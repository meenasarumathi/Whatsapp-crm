-- ============================================================================
-- WACRM — PostgreSQL schema (plain PostgreSQL 15+, no external services)
--
--   Database : wacrm         Port (Docker host) : 5433        Image : pgvector/pgvector:pg16
--
-- Apply to an EMPTY database:   psql -h localhost -p 5433 -U postgres -d wacrm -f db/schema.sql
-- (docker-compose.yml mounts this file into /docker-entrypoint-initdb.d, so a fresh
--  volume is initialised automatically. `npm run db:init` applies it to an existing server.)
--
-- Layout
--   0   Extensions, application role, session helpers
--   1   Enums
--   2   Tables (grouped by module)             <- includes `users` (sign-in accounts)
--   3   Foreign keys
--   4   Indexes
--   5   Functions (RPCs, trigger functions, RLS helper) + pgvector block
--   6   Triggers
--   7   Row Level Security (enable + policies)
--   8   Change notifications (LISTEN/NOTIFY feeding the live inbox)
--   9   Privileges for the application role
--  10   Recommended extra indexes
--
-- Access model
--   * The server connects as the owner (postgres): used for webhooks, cron, API-key routes.
--   * User requests run inside a transaction with  SET LOCAL ROLE wacrm_app  and
--     set_config('app.user_id', <uuid>, true)  so every RLS policy below applies.
-- ============================================================================

SET check_function_bodies = off;

-- ======================================================================
-- 0. EXTENSIONS, APPLICATION ROLE, SESSION HELPERS
-- ======================================================================
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$ BEGIN
  CREATE ROLE wacrm_app NOLOGIN;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
GRANT wacrm_app TO CURRENT_USER;   -- lets the owner connection do SET LOCAL ROLE wacrm_app

-- The signed-in user of the current transaction (set by the server, see header).
CREATE OR REPLACE FUNCTION public.current_user_id() RETURNS uuid
LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;

SET check_function_bodies = off;   -- functions may mention tables created later


-- ======================================================================
-- 1. ENUMS
-- ======================================================================

CREATE TYPE public.account_role_enum AS ENUM ('owner', 'admin', 'agent', 'viewer');

-- Note: every other 'enum-like' column (status, kind, trigger_type, ...) is plain text
-- guarded by a CHECK constraint in section 2, exactly as in the migrations.

-- ======================================================================
-- 2. APPLICATION TABLES
-- Ownership model: every business row has account_id (tenant). Most also keep the
-- legacy user_id (the user who created it) — account_id is what RLS uses.
-- ======================================================================


-- ----------------------------------------------------------------------
-- Sign-in accounts (replaces the former external auth service).
-- password_hash is bcrypt. session_version is bumped to sign a user out of every device.
-- ----------------------------------------------------------------------
CREATE TABLE public.users (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email               text NOT NULL,
  password_hash       text,
  raw_user_meta_data  jsonb NOT NULL DEFAULT '{}'::jsonb,
  email_confirmed_at  timestamptz,
  session_version     integer NOT NULL DEFAULT 1,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  last_sign_in_at     timestamptz
);
CREATE UNIQUE INDEX users_email_lower_key ON public.users (lower(email));
COMMENT ON TABLE public.users IS 'Sign-in accounts. Every other user_id / created_by column points here.';

CREATE TABLE public.password_reset_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_password_reset_tokens_user ON public.password_reset_tokens (user_id);
COMMENT ON TABLE public.password_reset_tokens IS 'One-time password reset links (SHA-256 of the token is stored).';
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.password_reset_tokens ENABLE ROW LEVEL SECURITY;
-- no policies: only the owner connection (server code) reads or writes these two tables

-- ----------------------------------------------------------------------
-- MODULE 1. Accounts, users and team roles
-- ----------------------------------------------------------------------

CREATE TABLE public.accounts (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  name text NOT NULL,
  owner_user_id uuid NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  default_currency text DEFAULT 'USD'::text NOT NULL,
  CONSTRAINT accounts_pkey PRIMARY KEY (id),
  CONSTRAINT accounts_default_currency_format CHECK ((default_currency ~ '^[A-Z]{3}$'::text))
);
COMMENT ON TABLE public.accounts IS 'Workspace (tenant). Every business table is scoped by account_id. One account per owner (idx_accounts_one_per_owner).';

CREATE TABLE public.profiles (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  user_id uuid NOT NULL,
  full_name text NOT NULL,
  email text NOT NULL,
  avatar_url text,
  role text DEFAULT 'user'::text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  beta_features text[] DEFAULT ARRAY[]::text[] NOT NULL,
  account_id uuid NOT NULL,
  account_role account_role_enum NOT NULL,
  CONSTRAINT profiles_user_id_key UNIQUE (user_id),
  CONSTRAINT profiles_pkey PRIMARY KEY (id)
);
COMMENT ON TABLE public.profiles IS 'One row per auth user: name, avatar, beta flags, the account the user belongs to and their account_role (owner/admin/agent/viewer).';

CREATE TABLE public.account_invitations (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  account_id uuid NOT NULL,
  token_hash text NOT NULL,
  role account_role_enum NOT NULL,
  created_by_user_id uuid,
  label text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  expires_at timestamp with time zone NOT NULL,
  accepted_at timestamp with time zone,
  accepted_by_user_id uuid,
  CONSTRAINT account_invitations_token_hash_key UNIQUE (token_hash),
  CONSTRAINT account_invitations_pkey PRIMARY KEY (id),
  CONSTRAINT account_invitations_role_check CHECK ((role <> 'owner'::account_role_enum))
);
COMMENT ON TABLE public.account_invitations IS 'Invite links. Only the SHA-256 token_hash is stored; redeemed through redeem_invitation().';

CREATE TABLE public.member_presence (
  user_id uuid NOT NULL,
  account_id uuid NOT NULL,
  status text DEFAULT 'online'::text NOT NULL,
  last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT member_presence_pkey PRIMARY KEY (user_id),
  CONSTRAINT member_presence_status_check CHECK ((status = ANY (ARRAY['online'::text, 'away'::text])))
);
COMMENT ON TABLE public.member_presence IS 'Online/away status of each team member per account (Realtime-enabled).';

-- ----------------------------------------------------------------------
-- MODULE 2. Platform roles and subscriptions
-- ----------------------------------------------------------------------

CREATE TABLE public.platform_users (
  user_id uuid NOT NULL,
  platform_role text DEFAULT 'subscriber'::text NOT NULL,
  subscription_status text DEFAULT 'trial'::text NOT NULL,
  trial_days integer,
  trial_started_at timestamp with time zone,
  trial_ends_at timestamp with time zone,
  allowed_tabs text[],
  notes text,
  updated_by uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT platform_users_pkey PRIMARY KEY (user_id),
  CONSTRAINT platform_users_platform_role_check CHECK ((platform_role = ANY (ARRAY['super_admin'::text, 'admin1'::text, 'admin2'::text, 'subscriber'::text]))),
  CONSTRAINT platform_users_subscription_status_check CHECK ((subscription_status = ANY (ARRAY['trial'::text, 'active'::text, 'expired'::text, 'suspended'::text]))),
  CONSTRAINT platform_users_trial_days_check CHECK (((trial_days IS NULL) OR (trial_days = ANY (ARRAY[1, 7, 15]))))
);
COMMENT ON TABLE public.platform_users IS 'Platform-level role (super_admin/admin1/admin2/subscriber), subscription status, trial window and per-user sidebar tab access. Written only by /api/platform/* under the service role.';

-- ----------------------------------------------------------------------
-- MODULE 3. WhatsApp connection and message templates
-- ----------------------------------------------------------------------

CREATE TABLE public.whatsapp_config (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  user_id uuid NOT NULL,
  phone_number_id text NOT NULL,
  waba_id text,
  access_token text NOT NULL,
  verify_token text,
  status text DEFAULT 'disconnected'::text NOT NULL,
  connected_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  registered_at timestamp with time zone,
  subscribed_apps_at timestamp with time zone,
  last_registration_error text,
  account_id uuid NOT NULL,
  mirror_inbound_media boolean DEFAULT true NOT NULL,
  CONSTRAINT whatsapp_config_account_id_key UNIQUE (account_id),
  CONSTRAINT whatsapp_config_phone_number_id_key UNIQUE (phone_number_id),
  CONSTRAINT whatsapp_config_pkey PRIMARY KEY (id),
  CONSTRAINT whatsapp_config_status_check CHECK ((status = ANY (ARRAY['connected'::text, 'disconnected'::text])))
);
COMMENT ON TABLE public.whatsapp_config IS 'Meta Cloud API connection for an account (one per account, phone_number_id unique across the install). access_token is stored AES-256-GCM encrypted.';

CREATE TABLE public.message_templates (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  user_id uuid NOT NULL,
  name text NOT NULL,
  category text DEFAULT 'Marketing'::text NOT NULL,
  language text DEFAULT 'en_US'::text,
  header_type text,
  header_content text,
  body_text text NOT NULL,
  footer_text text,
  buttons jsonb,
  status text DEFAULT 'DRAFT'::text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  sample_values jsonb,
  meta_template_id text,
  rejection_reason text,
  quality_score text,
  header_handle text,
  header_media_url text,
  submission_error text,
  last_submitted_at timestamp with time zone,
  account_id uuid NOT NULL,
  CONSTRAINT message_templates_pkey PRIMARY KEY (id),
  CONSTRAINT message_templates_buttons_shape_check CHECK (((buttons IS NULL) OR ((jsonb_typeof(buttons) = 'array'::text) AND (jsonb_array_length(buttons) <= 10)))),
  CONSTRAINT message_templates_category_check CHECK ((category = ANY (ARRAY['Marketing'::text, 'Utility'::text, 'Authentication'::text]))),
  CONSTRAINT message_templates_header_type_check CHECK ((header_type = ANY (ARRAY['text'::text, 'image'::text, 'video'::text, 'document'::text]))),
  CONSTRAINT message_templates_quality_score_check CHECK (((quality_score IS NULL) OR (quality_score = ANY (ARRAY['GREEN'::text, 'YELLOW'::text, 'RED'::text])))),
  CONSTRAINT message_templates_status_meta_check CHECK ((status = ANY (ARRAY['DRAFT'::text, 'PENDING'::text, 'APPROVED'::text, 'REJECTED'::text, 'PAUSED'::text, 'DISABLED'::text, 'IN_APPEAL'::text, 'PENDING_DELETION'::text])))
);
COMMENT ON TABLE public.message_templates IS 'WhatsApp message templates and their Meta approval state (status, meta_template_id, rejection_reason, quality_score).';

-- ----------------------------------------------------------------------
-- MODULE 4. Contacts, tags and custom fields
-- ----------------------------------------------------------------------

CREATE TABLE public.contacts (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  user_id uuid NOT NULL,
  phone text NOT NULL,
  name text,
  email text,
  company text,
  avatar_url text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  account_id uuid NOT NULL,
  phone_normalized text GENERATED ALWAYS AS (regexp_replace(phone, '\D'::text, ''::text, 'g'::text)) STORED,
  wa_user_id text,
  wa_parent_user_id text,
  wa_username text,
  CONSTRAINT contacts_pkey PRIMARY KEY (id)
);
COMMENT ON TABLE public.contacts IS 'People the business talks to. phone_normalized is unique per account; wa_user_id / wa_parent_user_id / wa_username hold Meta business-scoped ids.';

CREATE TABLE public.tags (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  user_id uuid NOT NULL,
  name text NOT NULL,
  color text DEFAULT '#3b82f6'::text NOT NULL,
  created_at timestamp with time zone DEFAULT now(),
  account_id uuid NOT NULL,
  CONSTRAINT tags_pkey PRIMARY KEY (id)
);
COMMENT ON TABLE public.tags IS 'Account-level labels that can be put on contacts.';

CREATE TABLE public.contact_tags (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  contact_id uuid NOT NULL,
  tag_id uuid NOT NULL,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT contact_tags_contact_id_tag_id_key UNIQUE (contact_id, tag_id),
  CONSTRAINT contact_tags_pkey PRIMARY KEY (id)
);
COMMENT ON TABLE public.contact_tags IS 'Junction table: contacts <-> tags (many-to-many).';

CREATE TABLE public.custom_fields (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  user_id uuid NOT NULL,
  field_name text NOT NULL,
  field_type text DEFAULT 'text'::text NOT NULL,
  field_options jsonb,
  created_at timestamp with time zone DEFAULT now(),
  account_id uuid NOT NULL,
  CONSTRAINT custom_fields_pkey PRIMARY KEY (id)
);
COMMENT ON TABLE public.custom_fields IS 'Account-defined extra contact fields (name, type, options).';

CREATE TABLE public.contact_custom_values (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  contact_id uuid NOT NULL,
  custom_field_id uuid NOT NULL,
  value text,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT contact_custom_values_contact_id_custom_field_id_key UNIQUE (contact_id, custom_field_id),
  CONSTRAINT contact_custom_values_pkey PRIMARY KEY (id)
);
COMMENT ON TABLE public.contact_custom_values IS 'Junction table: value of a custom field for a contact (one per contact + field).';

CREATE TABLE public.contact_notes (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  contact_id uuid NOT NULL,
  user_id uuid NOT NULL,
  note_text text NOT NULL,
  created_at timestamp with time zone DEFAULT now(),
  account_id uuid NOT NULL,
  CONSTRAINT contact_notes_pkey PRIMARY KEY (id)
);
COMMENT ON TABLE public.contact_notes IS 'Internal notes written on a contact.';

-- ----------------------------------------------------------------------
-- MODULE 5. Inbox: conversations, messages and quick replies
-- ----------------------------------------------------------------------

CREATE TABLE public.conversations (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  user_id uuid NOT NULL,
  contact_id uuid NOT NULL,
  status text DEFAULT 'open'::text NOT NULL,
  assigned_agent_id uuid,
  last_message_text text,
  last_message_at timestamp with time zone,
  unread_count integer DEFAULT 0,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  account_id uuid NOT NULL,
  ai_autoreply_disabled boolean DEFAULT false NOT NULL,
  ai_reply_count integer DEFAULT 0 NOT NULL,
  ai_handoff_summary text,
  CONSTRAINT conversations_pkey PRIMARY KEY (id),
  CONSTRAINT conversations_status_check CHECK ((status = ANY (ARRAY['open'::text, 'pending'::text, 'closed'::text])))
);
COMMENT ON TABLE public.conversations IS 'One thread per contact (unique account_id + contact_id). Holds assignment, status, unread count and AI auto-reply state.';

CREATE TABLE public.messages (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  conversation_id uuid NOT NULL,
  sender_type text NOT NULL,
  sender_id uuid,
  content_type text DEFAULT 'text'::text NOT NULL,
  content_text text,
  media_url text,
  template_name text,
  message_id text,
  status text DEFAULT 'sent'::text NOT NULL,
  created_at timestamp with time zone DEFAULT now(),
  reply_to_message_id uuid,
  interactive_reply_id text,
  ai_generated boolean DEFAULT false NOT NULL,
  interactive_payload jsonb,
  media_type text,
  error_code integer,
  error_title text,
  error_details text,
  CONSTRAINT messages_pkey PRIMARY KEY (id),
  CONSTRAINT messages_content_type_check CHECK ((content_type = ANY (ARRAY['text'::text, 'image'::text, 'document'::text, 'audio'::text, 'video'::text, 'location'::text, 'template'::text, 'interactive'::text]))),
  CONSTRAINT messages_sender_type_check CHECK ((sender_type = ANY (ARRAY['customer'::text, 'agent'::text, 'bot'::text]))),
  CONSTRAINT messages_status_check CHECK ((status = ANY (ARRAY['sending'::text, 'sent'::text, 'delivered'::text, 'read'::text, 'failed'::text])))
);
COMMENT ON TABLE public.messages IS 'Every inbound/outbound/internal message of a conversation, including media, interactive payloads, delivery status and failure details. Realtime-enabled.';

CREATE TABLE public.message_reactions (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  message_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  actor_type text NOT NULL,
  actor_id uuid,
  emoji text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT message_reactions_message_id_actor_type_actor_id_key UNIQUE (message_id, actor_type, actor_id),
  CONSTRAINT message_reactions_pkey PRIMARY KEY (id),
  CONSTRAINT message_reactions_actor_type_check CHECK ((actor_type = ANY (ARRAY['customer'::text, 'agent'::text])))
);
COMMENT ON TABLE public.message_reactions IS 'Emoji reactions by an agent or the contact on a message (one per message + actor). Realtime-enabled.';

CREATE TABLE public.quick_replies (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  account_id uuid NOT NULL,
  user_id uuid NOT NULL,
  title text NOT NULL,
  kind text DEFAULT 'text'::text NOT NULL,
  content_text text,
  interactive_payload jsonb,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT quick_replies_pkey PRIMARY KEY (id),
  CONSTRAINT quick_replies_kind_check CHECK ((kind = ANY (ARRAY['text'::text, 'interactive'::text])))
);
COMMENT ON TABLE public.quick_replies IS 'Saved replies (plain text or interactive buttons/lists) agents can insert in the inbox.';

-- ----------------------------------------------------------------------
-- MODULE 6. Sales pipelines and deals
-- ----------------------------------------------------------------------

CREATE TABLE public.pipelines (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  user_id uuid NOT NULL,
  name text NOT NULL,
  created_at timestamp with time zone DEFAULT now(),
  account_id uuid NOT NULL,
  CONSTRAINT pipelines_pkey PRIMARY KEY (id)
);
COMMENT ON TABLE public.pipelines IS 'Kanban sales pipelines.';

CREATE TABLE public.pipeline_stages (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  pipeline_id uuid NOT NULL,
  name text NOT NULL,
  position integer DEFAULT 0 NOT NULL,
  color text DEFAULT '#3b82f6'::text NOT NULL,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT pipeline_stages_pkey PRIMARY KEY (id)
);
COMMENT ON TABLE public.pipeline_stages IS 'Ordered stages (columns) of a pipeline.';

CREATE TABLE public.deals (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  user_id uuid NOT NULL,
  pipeline_id uuid NOT NULL,
  stage_id uuid NOT NULL,
  contact_id uuid,
  conversation_id uuid,
  title text NOT NULL,
  value numeric(12,2) DEFAULT 0 NOT NULL,
  currency text DEFAULT 'USD'::text,
  notes text,
  expected_close_date date,
  status text DEFAULT 'open'::text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  assigned_to uuid,
  account_id uuid NOT NULL,
  CONSTRAINT deals_pkey PRIMARY KEY (id),
  CONSTRAINT deals_status_check CHECK ((status = ANY (ARRAY['open'::text, 'won'::text, 'lost'::text])))
);
COMMENT ON TABLE public.deals IS 'Opportunities placed in a pipeline stage, linked to a contact and optionally a conversation and an assignee.';

-- ----------------------------------------------------------------------
-- MODULE 7. Broadcasts
-- ----------------------------------------------------------------------

CREATE TABLE public.broadcasts (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  user_id uuid NOT NULL,
  name text NOT NULL,
  template_name text NOT NULL,
  template_language text DEFAULT 'en_US'::text NOT NULL,
  template_variables jsonb,
  audience_filter jsonb,
  scheduled_at timestamp with time zone,
  status text DEFAULT 'draft'::text NOT NULL,
  total_recipients integer DEFAULT 0,
  sent_count integer DEFAULT 0,
  delivered_count integer DEFAULT 0,
  read_count integer DEFAULT 0,
  replied_count integer DEFAULT 0,
  failed_count integer DEFAULT 0,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  account_id uuid NOT NULL,
  delivery_locked_at timestamp with time zone,
  CONSTRAINT broadcasts_pkey PRIMARY KEY (id),
  CONSTRAINT broadcasts_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'scheduled'::text, 'sending'::text, 'sent'::text, 'failed'::text])))
);
COMMENT ON TABLE public.broadcasts IS 'A template campaign sent to an audience; carries the delivery counters and the delivery lock used by resume.';

CREATE TABLE public.broadcast_recipients (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  broadcast_id uuid NOT NULL,
  contact_id uuid,
  status text DEFAULT 'pending'::text NOT NULL,
  sent_at timestamp with time zone,
  delivered_at timestamp with time zone,
  read_at timestamp with time zone,
  replied_at timestamp with time zone,
  error_message text,
  created_at timestamp with time zone DEFAULT now(),
  whatsapp_message_id text,
  template_params jsonb,
  CONSTRAINT broadcast_recipients_pkey PRIMARY KEY (id),
  CONSTRAINT broadcast_recipients_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'sent'::text, 'delivered'::text, 'read'::text, 'replied'::text, 'failed'::text])))
);
COMMENT ON TABLE public.broadcast_recipients IS 'One row per contact in a broadcast with per-recipient status timestamps and wamid; a trigger keeps the broadcast counters in sync.';

-- ----------------------------------------------------------------------
-- MODULE 8. Automations
-- ----------------------------------------------------------------------

CREATE TABLE public.automations (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  user_id uuid NOT NULL,
  name text NOT NULL,
  description text,
  trigger_type text NOT NULL,
  trigger_config jsonb DEFAULT '{}'::jsonb NOT NULL,
  is_active boolean DEFAULT false NOT NULL,
  execution_count integer DEFAULT 0 NOT NULL,
  last_executed_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  account_id uuid NOT NULL,
  CONSTRAINT automations_pkey PRIMARY KEY (id)
);
COMMENT ON TABLE public.automations IS 'No-code automations: trigger type/config and an execution counter.';

CREATE TABLE public.automation_steps (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  automation_id uuid NOT NULL,
  parent_step_id uuid,
  branch text,
  step_type text NOT NULL,
  step_config jsonb DEFAULT '{}'::jsonb NOT NULL,
  position integer NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT automation_steps_pkey PRIMARY KEY (id),
  CONSTRAINT automation_steps_branch_check CHECK ((branch = ANY (ARRAY['yes'::text, 'no'::text])))
);
COMMENT ON TABLE public.automation_steps IS 'Steps of an automation, nested by parent_step_id and branch (condition yes/no).';

CREATE TABLE public.automation_logs (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  automation_id uuid NOT NULL,
  user_id uuid NOT NULL,
  contact_id uuid,
  trigger_event text NOT NULL,
  steps_executed jsonb DEFAULT '[]'::jsonb NOT NULL,
  status text NOT NULL,
  error_message text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  account_id uuid NOT NULL,
  CONSTRAINT automation_logs_pkey PRIMARY KEY (id),
  CONSTRAINT automation_logs_status_check CHECK ((status = ANY (ARRAY['success'::text, 'partial'::text, 'failed'::text])))
);
COMMENT ON TABLE public.automation_logs IS 'One row per automation run with its outcome and the steps executed.';

CREATE TABLE public.automation_pending_executions (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  automation_id uuid NOT NULL,
  user_id uuid NOT NULL,
  contact_id uuid,
  log_id uuid,
  parent_step_id uuid,
  branch text,
  next_step_position integer NOT NULL,
  context jsonb DEFAULT '{}'::jsonb NOT NULL,
  status text DEFAULT 'pending'::text NOT NULL,
  run_at timestamp with time zone NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  account_id uuid NOT NULL,
  CONSTRAINT automation_pending_executions_pkey PRIMARY KEY (id),
  CONSTRAINT automation_pending_executions_branch_check CHECK ((branch = ANY (ARRAY['yes'::text, 'no'::text]))),
  CONSTRAINT automation_pending_executions_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'running'::text, 'done'::text, 'failed'::text])))
);
COMMENT ON TABLE public.automation_pending_executions IS 'Delayed (wait) steps queued to resume at run_at.';

-- ----------------------------------------------------------------------
-- MODULE 9. Flows (chatbot builder)
-- ----------------------------------------------------------------------

CREATE TABLE public.flows (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  user_id uuid NOT NULL,
  name text NOT NULL,
  description text,
  status text DEFAULT 'draft'::text NOT NULL,
  trigger_type text NOT NULL,
  trigger_config jsonb DEFAULT '{}'::jsonb NOT NULL,
  entry_node_id text,
  fallback_policy jsonb DEFAULT '{"on_exhaust": "handoff", "max_reprompts": 2, "on_timeout_hours": 24, "on_unknown_reply": "reprompt"}'::jsonb NOT NULL,
  execution_count integer DEFAULT 0 NOT NULL,
  last_executed_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  account_id uuid NOT NULL,
  CONSTRAINT flows_pkey PRIMARY KEY (id),
  CONSTRAINT flows_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'active'::text, 'archived'::text]))),
  CONSTRAINT flows_trigger_type_check CHECK ((trigger_type = ANY (ARRAY['keyword'::text, 'first_inbound_message'::text, 'manual'::text])))
);
COMMENT ON TABLE public.flows IS 'Chatbot flows (visual builder): trigger, entry node, fallback policy.';

CREATE TABLE public.flow_nodes (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  flow_id uuid NOT NULL,
  node_key text NOT NULL,
  node_type text NOT NULL,
  config jsonb DEFAULT '{}'::jsonb NOT NULL,
  position_x integer DEFAULT 0 NOT NULL,
  position_y integer DEFAULT 0 NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT flow_nodes_flow_id_node_key_key UNIQUE (flow_id, node_key),
  CONSTRAINT flow_nodes_pkey PRIMARY KEY (id),
  CONSTRAINT flow_nodes_node_type_check CHECK ((node_type = ANY (ARRAY['start'::text, 'send_buttons'::text, 'send_list'::text, 'send_message'::text, 'send_media'::text, 'collect_input'::text, 'condition'::text, 'set_tag'::text, 'handoff'::text, 'http_fetch'::text, 'end'::text])))
);
COMMENT ON TABLE public.flow_nodes IS 'Nodes of a flow, keyed by node_key with canvas position and JSON config.';

CREATE TABLE public.flow_runs (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  flow_id uuid NOT NULL,
  user_id uuid NOT NULL,
  contact_id uuid,
  conversation_id uuid,
  status text DEFAULT 'active'::text NOT NULL,
  current_node_key text,
  last_prompt_message_id uuid,
  vars jsonb DEFAULT '{}'::jsonb NOT NULL,
  reprompt_count integer DEFAULT 0 NOT NULL,
  started_at timestamp with time zone DEFAULT now() NOT NULL,
  last_advanced_at timestamp with time zone DEFAULT now() NOT NULL,
  ended_at timestamp with time zone,
  end_reason text,
  account_id uuid NOT NULL,
  CONSTRAINT flow_runs_pkey PRIMARY KEY (id),
  CONSTRAINT flow_runs_status_check CHECK ((status = ANY (ARRAY['active'::text, 'completed'::text, 'handed_off'::text, 'timed_out'::text, 'paused_by_agent'::text, 'failed'::text])))
);
COMMENT ON TABLE public.flow_runs IS 'A contact''s progress through a flow; at most one active run per contact (idx_one_active_run_per_contact). Realtime-enabled.';

CREATE TABLE public.flow_run_events (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  flow_run_id uuid NOT NULL,
  event_type text NOT NULL,
  node_key text,
  payload jsonb DEFAULT '{}'::jsonb NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT flow_run_events_pkey PRIMARY KEY (id),
  CONSTRAINT flow_run_events_event_type_check CHECK ((event_type = ANY (ARRAY['started'::text, 'node_entered'::text, 'message_sent'::text, 'reply_received'::text, 'fallback_fired'::text, 'handoff'::text, 'timeout'::text, 'error'::text, 'completed'::text])))
);
COMMENT ON TABLE public.flow_run_events IS 'Event log of a flow run, used by the test panel and the errors panel.';

-- ----------------------------------------------------------------------
-- MODULE 10. AI agent, knowledge base and Train AI
-- ----------------------------------------------------------------------

CREATE TABLE public.ai_configs (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  account_id uuid NOT NULL,
  created_by uuid,
  provider text NOT NULL,
  model text NOT NULL,
  api_key text NOT NULL,
  system_prompt text,
  is_active boolean DEFAULT false NOT NULL,
  auto_reply_enabled boolean DEFAULT false NOT NULL,
  auto_reply_max_per_conversation integer DEFAULT 3 NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  embeddings_api_key text,
  handoff_agent_id uuid,
  CONSTRAINT ai_configs_account_id_key UNIQUE (account_id),
  CONSTRAINT ai_configs_pkey PRIMARY KEY (id),
  CONSTRAINT ai_configs_auto_reply_max_per_conversation_check CHECK (((auto_reply_max_per_conversation >= 1) AND (auto_reply_max_per_conversation <= 20))),
  CONSTRAINT ai_configs_provider_check CHECK ((provider = ANY (ARRAY['openai'::text, 'anthropic'::text])))
);
COMMENT ON TABLE public.ai_configs IS 'AI reply assistant settings per account: provider, model, encrypted keys, auto-reply and handoff target.';

CREATE TABLE public.ai_knowledge_documents (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  account_id uuid NOT NULL,
  created_by uuid,
  title text NOT NULL,
  content text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT ai_knowledge_documents_pkey PRIMARY KEY (id)
);
COMMENT ON TABLE public.ai_knowledge_documents IS 'Knowledge-base documents (FAQs, policies) the AI answers from.';

CREATE TABLE public.ai_knowledge_chunks (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  document_id uuid NOT NULL,
  account_id uuid NOT NULL,
  chunk_index integer DEFAULT 0 NOT NULL,
  content text NOT NULL,
  fts tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, content)) STORED,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT ai_knowledge_chunks_pkey PRIMARY KEY (id)
);
COMMENT ON TABLE public.ai_knowledge_chunks IS 'Searchable chunks of a knowledge document: full-text vector (fts) and optional pgvector embedding.';

CREATE TABLE public.ai_usage_log (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  account_id uuid NOT NULL,
  conversation_id uuid,
  mode text NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  prompt_tokens integer DEFAULT 0 NOT NULL,
  completion_tokens integer DEFAULT 0 NOT NULL,
  total_tokens integer DEFAULT 0 NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT ai_usage_log_pkey PRIMARY KEY (id),
  CONSTRAINT ai_usage_log_mode_check CHECK ((mode = ANY (ARRAY['auto_reply'::text, 'draft'::text]))),
  CONSTRAINT ai_usage_log_provider_check CHECK ((provider = ANY (ARRAY['openai'::text, 'anthropic'::text])))
);
COMMENT ON TABLE public.ai_usage_log IS 'Token usage of every AI draft/auto-reply, shown on the dashboard.';

CREATE TABLE public.ai_training_profiles (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  account_id uuid NOT NULL,
  profile jsonb DEFAULT '{}'::jsonb NOT NULL,
  updated_by uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT ai_training_profiles_account_id_key UNIQUE (account_id),
  CONSTRAINT ai_training_profiles_pkey PRIMARY KEY (id)
);
COMMENT ON TABLE public.ai_training_profiles IS 'Train AI: one business profile (JSON) per account.';

CREATE TABLE public.ai_training_examples (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  account_id uuid NOT NULL,
  kind text DEFAULT 'qa'::text NOT NULL,
  question text,
  answer text NOT NULL,
  category text,
  source text DEFAULT 'manual'::text NOT NULL,
  is_active boolean DEFAULT true NOT NULL,
  use_count integer DEFAULT 0 NOT NULL,
  created_by uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT ai_training_examples_pkey PRIMARY KEY (id),
  CONSTRAINT ai_training_examples_check CHECK (((kind = 'rule'::text) OR ((question IS NOT NULL) AND (length(TRIM(BOTH FROM question)) > 0)))),
  CONSTRAINT ai_training_examples_kind_check CHECK ((kind = ANY (ARRAY['qa'::text, 'rule'::text]))),
  CONSTRAINT ai_training_examples_source_check CHECK ((source = ANY (ARRAY['manual'::text, 'conversation'::text, 'import'::text])))
);
COMMENT ON TABLE public.ai_training_examples IS 'Train AI: Q&A examples and rules (kind), with usage counter.';

-- ----------------------------------------------------------------------
-- MODULE 11. Public API and outbound webhooks
-- ----------------------------------------------------------------------

CREATE TABLE public.api_keys (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  account_id uuid NOT NULL,
  created_by uuid,
  name text NOT NULL,
  key_prefix text NOT NULL,
  key_hash text NOT NULL,
  scopes text[] DEFAULT '{}'::text[] NOT NULL,
  last_used_at timestamp with time zone,
  expires_at timestamp with time zone,
  revoked_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT api_keys_key_hash_key UNIQUE (key_hash),
  CONSTRAINT api_keys_pkey PRIMARY KEY (id)
);
COMMENT ON TABLE public.api_keys IS 'Public REST API keys; only the hash and a display prefix are stored.';

CREATE TABLE public.webhook_endpoints (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  account_id uuid NOT NULL,
  created_by uuid,
  url text NOT NULL,
  secret text NOT NULL,
  events text[] DEFAULT '{}'::text[] NOT NULL,
  is_active boolean DEFAULT true NOT NULL,
  last_delivery_at timestamp with time zone,
  failure_count integer DEFAULT 0 NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT webhook_endpoints_pkey PRIMARY KEY (id)
);
COMMENT ON TABLE public.webhook_endpoints IS 'Outbound webhook subscriptions with signing secret and failure counter.';

-- ----------------------------------------------------------------------
-- MODULE 12. Notifications
-- ----------------------------------------------------------------------

CREATE TABLE public.notifications (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  account_id uuid NOT NULL,
  user_id uuid NOT NULL,
  type text DEFAULT 'conversation_assigned'::text NOT NULL,
  conversation_id uuid,
  contact_id uuid,
  actor_user_id uuid,
  title text NOT NULL,
  body text,
  read_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT notifications_pkey PRIMARY KEY (id),
  CONSTRAINT notifications_type_check CHECK ((type = 'conversation_assigned'::text))
);
COMMENT ON TABLE public.notifications IS 'In-app notifications per user (assignment, mentions). Users may only update read_at.';

-- ----------------------------------------------------------------------
-- MODULE 13. Database administration (Backup > Database config)
-- ----------------------------------------------------------------------

CREATE TABLE public.db_maintenance_log (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  action text NOT NULL,
  tables text[] DEFAULT '{}'::text[] NOT NULL,
  row_counts jsonb DEFAULT '{}'::jsonb NOT NULL,
  performed_by uuid,
  performed_by_email text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT db_maintenance_log_pkey PRIMARY KEY (id)
);
COMMENT ON TABLE public.db_maintenance_log IS 'Audit log of Super-admin database maintenance such as table truncates. Service role only.';
COMMENT ON COLUMN public.broadcast_recipients.template_params IS 'Positional body values for this recipient''s template send ({{1}}, {{2}}, ...), frozen when the broadcast was planned. NULL on rows created before migration 038; a resume treats that as no params.';
COMMENT ON COLUMN public.broadcasts.delivery_locked_at IS 'Set while a server-side delivery pass is fanning out; NULL when idle. See 038_broadcast_resume.sql.';
COMMENT ON COLUMN public.contacts.wa_parent_user_id IS 'Portfolio-level BSUID (e.g. "US.ENT.11815799212886844830"). Stored for reference; not used as a lookup key.';
COMMENT ON COLUMN public.contacts.wa_user_id IS 'WhatsApp business-scoped user ID (e.g. "US.13491208655302741918"). Stable per (user, business portfolio) and the primary inbound key when Meta withholds the phone number.';
COMMENT ON COLUMN public.contacts.wa_username IS 'WhatsApp username, without the leading @. Display only — usernames are user-changeable and must never be used as an identity key.';
COMMENT ON COLUMN public.messages.error_code IS 'Meta''s numeric error code from a failed status webhook (errors[0].code). NULL unless the message failed. Not cleared by a later status update.';
COMMENT ON COLUMN public.messages.error_details IS 'Meta''s human-readable explanation from a failed status webhook (errors[0].error_data.details). NULL unless the message failed and Meta supplied details.';
COMMENT ON COLUMN public.messages.error_title IS 'Meta''s short error label from a failed status webhook (errors[0].title). NULL unless the message failed.';
COMMENT ON COLUMN public.messages.media_type IS 'MIME type of media_url''s content, as reported by Meta. Populated for INBOUND media only: an outbound media_url is a chat-media object whose path already carries the original filename and extension, so the type adds nothing there. Also NULL for text messages and for every row written before migration 039.';
COMMENT ON COLUMN public.whatsapp_config.mirror_inbound_media IS 'When true (default), the inbound webhook copies received media into the chat-media bucket so it outlives Meta''s ~30-day retention. Turn off to keep storage flat and accept that attachments expire.';

-- ======================================================================
-- 3. FOREIGN KEYS
-- ON DELETE rules are
-- as in the migrations: CASCADE for owned children, SET NULL for optional links.
-- ======================================================================

-- 1. Accounts, users and team roles
ALTER TABLE public.accounts ADD CONSTRAINT accounts_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE RESTRICT;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
ALTER TABLE public.account_invitations ADD CONSTRAINT account_invitations_accepted_by_user_id_fkey FOREIGN KEY (accepted_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;
ALTER TABLE public.account_invitations ADD CONSTRAINT account_invitations_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE;
ALTER TABLE public.account_invitations ADD CONSTRAINT account_invitations_created_by_user_id_fkey FOREIGN KEY (created_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;
ALTER TABLE public.member_presence ADD CONSTRAINT member_presence_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE;
ALTER TABLE public.member_presence ADD CONSTRAINT member_presence_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

-- 2. Platform roles and subscriptions
ALTER TABLE public.platform_users ADD CONSTRAINT platform_users_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;
ALTER TABLE public.platform_users ADD CONSTRAINT platform_users_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

-- 3. WhatsApp connection and message templates
ALTER TABLE public.whatsapp_config ADD CONSTRAINT whatsapp_config_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE;
ALTER TABLE public.whatsapp_config ADD CONSTRAINT whatsapp_config_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
ALTER TABLE public.message_templates ADD CONSTRAINT message_templates_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE;
ALTER TABLE public.message_templates ADD CONSTRAINT message_templates_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

-- 4. Contacts, tags and custom fields
ALTER TABLE public.contacts ADD CONSTRAINT contacts_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE;
ALTER TABLE public.contacts ADD CONSTRAINT contacts_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
ALTER TABLE public.tags ADD CONSTRAINT tags_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE;
ALTER TABLE public.tags ADD CONSTRAINT tags_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
ALTER TABLE public.contact_tags ADD CONSTRAINT contact_tags_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE;
ALTER TABLE public.contact_tags ADD CONSTRAINT contact_tags_tag_id_fkey FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE;
ALTER TABLE public.custom_fields ADD CONSTRAINT custom_fields_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE;
ALTER TABLE public.custom_fields ADD CONSTRAINT custom_fields_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
ALTER TABLE public.contact_custom_values ADD CONSTRAINT contact_custom_values_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE;
ALTER TABLE public.contact_custom_values ADD CONSTRAINT contact_custom_values_custom_field_id_fkey FOREIGN KEY (custom_field_id) REFERENCES custom_fields(id) ON DELETE CASCADE;
ALTER TABLE public.contact_notes ADD CONSTRAINT contact_notes_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE;
ALTER TABLE public.contact_notes ADD CONSTRAINT contact_notes_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE;
ALTER TABLE public.contact_notes ADD CONSTRAINT contact_notes_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

-- 5. Inbox: conversations, messages and quick replies
ALTER TABLE public.conversations ADD CONSTRAINT conversations_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE;
ALTER TABLE public.conversations ADD CONSTRAINT conversations_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE;
ALTER TABLE public.conversations ADD CONSTRAINT conversations_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
ALTER TABLE public.messages ADD CONSTRAINT messages_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE;
ALTER TABLE public.messages ADD CONSTRAINT messages_reply_to_message_id_fkey FOREIGN KEY (reply_to_message_id) REFERENCES messages(id) ON DELETE SET NULL;
ALTER TABLE public.message_reactions ADD CONSTRAINT message_reactions_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE;
ALTER TABLE public.message_reactions ADD CONSTRAINT message_reactions_message_id_fkey FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE;
ALTER TABLE public.quick_replies ADD CONSTRAINT quick_replies_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE;
ALTER TABLE public.quick_replies ADD CONSTRAINT quick_replies_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

-- 6. Sales pipelines and deals
ALTER TABLE public.pipelines ADD CONSTRAINT pipelines_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE;
ALTER TABLE public.pipelines ADD CONSTRAINT pipelines_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
ALTER TABLE public.pipeline_stages ADD CONSTRAINT pipeline_stages_pipeline_id_fkey FOREIGN KEY (pipeline_id) REFERENCES pipelines(id) ON DELETE CASCADE;
ALTER TABLE public.deals ADD CONSTRAINT deals_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE;
ALTER TABLE public.deals ADD CONSTRAINT deals_assigned_to_fkey FOREIGN KEY (assigned_to) REFERENCES profiles(id) ON DELETE SET NULL;
ALTER TABLE public.deals ADD CONSTRAINT deals_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE SET NULL;
ALTER TABLE public.deals ADD CONSTRAINT deals_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES conversations(id);
ALTER TABLE public.deals ADD CONSTRAINT deals_pipeline_id_fkey FOREIGN KEY (pipeline_id) REFERENCES pipelines(id) ON DELETE CASCADE;
ALTER TABLE public.deals ADD CONSTRAINT deals_stage_id_fkey FOREIGN KEY (stage_id) REFERENCES pipeline_stages(id);
ALTER TABLE public.deals ADD CONSTRAINT deals_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

-- 7. Broadcasts
ALTER TABLE public.broadcasts ADD CONSTRAINT broadcasts_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE;
ALTER TABLE public.broadcasts ADD CONSTRAINT broadcasts_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
ALTER TABLE public.broadcast_recipients ADD CONSTRAINT broadcast_recipients_broadcast_id_fkey FOREIGN KEY (broadcast_id) REFERENCES broadcasts(id) ON DELETE CASCADE;
ALTER TABLE public.broadcast_recipients ADD CONSTRAINT broadcast_recipients_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE SET NULL;

-- 8. Automations
ALTER TABLE public.automations ADD CONSTRAINT automations_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE;
ALTER TABLE public.automations ADD CONSTRAINT automations_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
ALTER TABLE public.automation_steps ADD CONSTRAINT automation_steps_automation_id_fkey FOREIGN KEY (automation_id) REFERENCES automations(id) ON DELETE CASCADE;
ALTER TABLE public.automation_steps ADD CONSTRAINT automation_steps_parent_step_id_fkey FOREIGN KEY (parent_step_id) REFERENCES automation_steps(id) ON DELETE CASCADE;
ALTER TABLE public.automation_logs ADD CONSTRAINT automation_logs_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE;
ALTER TABLE public.automation_logs ADD CONSTRAINT automation_logs_automation_id_fkey FOREIGN KEY (automation_id) REFERENCES automations(id) ON DELETE CASCADE;
ALTER TABLE public.automation_logs ADD CONSTRAINT automation_logs_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE SET NULL;
ALTER TABLE public.automation_logs ADD CONSTRAINT automation_logs_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
ALTER TABLE public.automation_pending_executions ADD CONSTRAINT automation_pending_executions_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE;
ALTER TABLE public.automation_pending_executions ADD CONSTRAINT automation_pending_executions_automation_id_fkey FOREIGN KEY (automation_id) REFERENCES automations(id) ON DELETE CASCADE;
ALTER TABLE public.automation_pending_executions ADD CONSTRAINT automation_pending_executions_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE SET NULL;
ALTER TABLE public.automation_pending_executions ADD CONSTRAINT automation_pending_executions_log_id_fkey FOREIGN KEY (log_id) REFERENCES automation_logs(id) ON DELETE CASCADE;
ALTER TABLE public.automation_pending_executions ADD CONSTRAINT automation_pending_executions_parent_step_id_fkey FOREIGN KEY (parent_step_id) REFERENCES automation_steps(id) ON DELETE SET NULL;
ALTER TABLE public.automation_pending_executions ADD CONSTRAINT automation_pending_executions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

-- 9. Flows (chatbot builder)
ALTER TABLE public.flows ADD CONSTRAINT flows_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE;
ALTER TABLE public.flows ADD CONSTRAINT flows_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
ALTER TABLE public.flow_nodes ADD CONSTRAINT flow_nodes_flow_id_fkey FOREIGN KEY (flow_id) REFERENCES flows(id) ON DELETE CASCADE;
ALTER TABLE public.flow_runs ADD CONSTRAINT flow_runs_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE;
ALTER TABLE public.flow_runs ADD CONSTRAINT flow_runs_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE SET NULL;
ALTER TABLE public.flow_runs ADD CONSTRAINT flow_runs_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE SET NULL;
ALTER TABLE public.flow_runs ADD CONSTRAINT flow_runs_flow_id_fkey FOREIGN KEY (flow_id) REFERENCES flows(id) ON DELETE CASCADE;
ALTER TABLE public.flow_runs ADD CONSTRAINT flow_runs_last_prompt_message_id_fkey FOREIGN KEY (last_prompt_message_id) REFERENCES messages(id) ON DELETE SET NULL;
ALTER TABLE public.flow_runs ADD CONSTRAINT flow_runs_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
ALTER TABLE public.flow_run_events ADD CONSTRAINT flow_run_events_flow_run_id_fkey FOREIGN KEY (flow_run_id) REFERENCES flow_runs(id) ON DELETE CASCADE;

-- 10. AI agent, knowledge base and Train AI
ALTER TABLE public.ai_configs ADD CONSTRAINT ai_configs_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE;
ALTER TABLE public.ai_configs ADD CONSTRAINT ai_configs_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;
ALTER TABLE public.ai_configs ADD CONSTRAINT ai_configs_handoff_agent_id_fkey FOREIGN KEY (handoff_agent_id) REFERENCES public.users(id) ON DELETE SET NULL;
ALTER TABLE public.ai_knowledge_documents ADD CONSTRAINT ai_knowledge_documents_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE;
ALTER TABLE public.ai_knowledge_documents ADD CONSTRAINT ai_knowledge_documents_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;
ALTER TABLE public.ai_knowledge_chunks ADD CONSTRAINT ai_knowledge_chunks_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE;
ALTER TABLE public.ai_knowledge_chunks ADD CONSTRAINT ai_knowledge_chunks_document_id_fkey FOREIGN KEY (document_id) REFERENCES ai_knowledge_documents(id) ON DELETE CASCADE;
ALTER TABLE public.ai_usage_log ADD CONSTRAINT ai_usage_log_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE;
ALTER TABLE public.ai_usage_log ADD CONSTRAINT ai_usage_log_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE SET NULL;
ALTER TABLE public.ai_training_profiles ADD CONSTRAINT ai_training_profiles_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE;
ALTER TABLE public.ai_training_profiles ADD CONSTRAINT ai_training_profiles_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;
ALTER TABLE public.ai_training_examples ADD CONSTRAINT ai_training_examples_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE;
ALTER TABLE public.ai_training_examples ADD CONSTRAINT ai_training_examples_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;

-- 11. Public API and outbound webhooks
ALTER TABLE public.api_keys ADD CONSTRAINT api_keys_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE;
ALTER TABLE public.api_keys ADD CONSTRAINT api_keys_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;
ALTER TABLE public.webhook_endpoints ADD CONSTRAINT webhook_endpoints_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE;
ALTER TABLE public.webhook_endpoints ADD CONSTRAINT webhook_endpoints_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;

-- 12. Notifications
ALTER TABLE public.notifications ADD CONSTRAINT notifications_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE;
ALTER TABLE public.notifications ADD CONSTRAINT notifications_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES public.users(id) ON DELETE SET NULL;
ALTER TABLE public.notifications ADD CONSTRAINT notifications_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE SET NULL;
ALTER TABLE public.notifications ADD CONSTRAINT notifications_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE;
ALTER TABLE public.notifications ADD CONSTRAINT notifications_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

-- 13. Database administration (Backup > Database config)
ALTER TABLE public.db_maintenance_log ADD CONSTRAINT db_maintenance_log_performed_by_fkey FOREIGN KEY (performed_by) REFERENCES public.users(id) ON DELETE SET NULL;


-- ======================================================================
-- 4. INDEXES
-- Indexes that back a PK / UNIQUE constraint are created by section 2.
-- ======================================================================

-- 1. Accounts, users and team roles
CREATE UNIQUE INDEX idx_accounts_one_per_owner ON public.accounts USING btree (owner_user_id);
CREATE INDEX idx_profiles_account_role ON public.profiles USING btree (account_id, account_role);
CREATE INDEX idx_account_invitations_account_pending ON public.account_invitations USING btree (account_id, expires_at) WHERE (accepted_at IS NULL);
CREATE INDEX member_presence_account_idx ON public.member_presence USING btree (account_id);

-- 2. Platform roles and subscriptions
CREATE INDEX idx_platform_users_role ON public.platform_users USING btree (platform_role);

-- 3. WhatsApp connection and message templates
CREATE INDEX idx_whatsapp_config_account ON public.whatsapp_config USING btree (account_id);
CREATE INDEX idx_whatsapp_config_registered_at ON public.whatsapp_config USING btree (registered_at) WHERE (registered_at IS NULL);
CREATE INDEX idx_message_templates_account ON public.message_templates USING btree (account_id);
CREATE INDEX idx_message_templates_meta_template_id ON public.message_templates USING btree (meta_template_id) WHERE (meta_template_id IS NOT NULL);
CREATE UNIQUE INDEX message_templates_user_name_language_key ON public.message_templates USING btree (user_id, name, language);

-- 4. Contacts, tags and custom fields
CREATE INDEX idx_contacts_account ON public.contacts USING btree (account_id);
CREATE UNIQUE INDEX idx_contacts_account_phone_normalized ON public.contacts USING btree (account_id, phone_normalized) WHERE (phone_normalized <> ''::text);
CREATE UNIQUE INDEX idx_contacts_account_wa_user_id ON public.contacts USING btree (account_id, wa_user_id) WHERE (wa_user_id IS NOT NULL);
CREATE INDEX idx_contacts_phone ON public.contacts USING btree (phone);
CREATE INDEX idx_contacts_user_id ON public.contacts USING btree (user_id);
CREATE INDEX idx_tags_account ON public.tags USING btree (account_id);
CREATE INDEX idx_contact_tags_contact ON public.contact_tags USING btree (contact_id);
CREATE INDEX idx_contact_tags_tag ON public.contact_tags USING btree (tag_id);
CREATE INDEX idx_custom_fields_account ON public.custom_fields USING btree (account_id);
CREATE INDEX idx_contact_notes_account ON public.contact_notes USING btree (account_id);

-- 5. Inbox: conversations, messages and quick replies
CREATE INDEX idx_conversations_account ON public.conversations USING btree (account_id);
CREATE UNIQUE INDEX idx_conversations_account_contact ON public.conversations USING btree (account_id, contact_id);
CREATE INDEX idx_conversations_contact_id ON public.conversations USING btree (contact_id);
CREATE INDEX idx_conversations_user_id ON public.conversations USING btree (user_id);
CREATE INDEX idx_messages_conversation ON public.messages USING btree (conversation_id);
CREATE UNIQUE INDEX idx_messages_conversation_message_id ON public.messages USING btree (conversation_id, message_id);
CREATE INDEX idx_messages_message_id ON public.messages USING btree (message_id);
CREATE INDEX idx_messages_reply_to ON public.messages USING btree (reply_to_message_id) WHERE (reply_to_message_id IS NOT NULL);
CREATE INDEX idx_message_reactions_conversation ON public.message_reactions USING btree (conversation_id);
CREATE INDEX idx_message_reactions_message ON public.message_reactions USING btree (message_id);
CREATE INDEX idx_quick_replies_account ON public.quick_replies USING btree (account_id);

-- 6. Sales pipelines and deals
CREATE INDEX idx_pipelines_account ON public.pipelines USING btree (account_id);
CREATE INDEX idx_pipeline_stages_pipeline ON public.pipeline_stages USING btree (pipeline_id);
CREATE INDEX idx_deals_account ON public.deals USING btree (account_id);
CREATE INDEX idx_deals_assigned_to ON public.deals USING btree (assigned_to);
CREATE INDEX idx_deals_pipeline ON public.deals USING btree (pipeline_id);
CREATE INDEX idx_deals_stage ON public.deals USING btree (stage_id);

-- 7. Broadcasts
CREATE INDEX idx_broadcasts_account ON public.broadcasts USING btree (account_id);
CREATE INDEX idx_broadcast_recipients_broadcast ON public.broadcast_recipients USING btree (broadcast_id);
CREATE INDEX idx_broadcast_recipients_broadcast_status ON public.broadcast_recipients USING btree (broadcast_id, status);
CREATE UNIQUE INDEX idx_broadcast_recipients_wamid ON public.broadcast_recipients USING btree (whatsapp_message_id) WHERE (whatsapp_message_id IS NOT NULL);

-- 8. Automations
CREATE INDEX idx_automations_account ON public.automations USING btree (account_id);
CREATE INDEX idx_automations_account_active_trigger ON public.automations USING btree (account_id, trigger_type) WHERE (is_active = true);
CREATE INDEX idx_automations_active_trigger ON public.automations USING btree (trigger_type) WHERE (is_active = true);
CREATE INDEX idx_automations_user_id ON public.automations USING btree (user_id);
CREATE INDEX idx_automation_steps_automation_id ON public.automation_steps USING btree (automation_id, "position");
CREATE INDEX idx_automation_steps_parent ON public.automation_steps USING btree (parent_step_id) WHERE (parent_step_id IS NOT NULL);
CREATE INDEX idx_automation_logs_account ON public.automation_logs USING btree (account_id);
CREATE INDEX idx_automation_logs_automation ON public.automation_logs USING btree (automation_id, created_at DESC);
CREATE INDEX idx_automation_logs_user ON public.automation_logs USING btree (user_id);
CREATE INDEX idx_automation_pending_account ON public.automation_pending_executions USING btree (account_id);
CREATE INDEX idx_automation_pending_due ON public.automation_pending_executions USING btree (run_at) WHERE (status = 'pending'::text);

-- 9. Flows (chatbot builder)
CREATE INDEX idx_flows_account ON public.flows USING btree (account_id);
CREATE INDEX idx_flows_account_active ON public.flows USING btree (account_id) WHERE (status = 'active'::text);
CREATE INDEX idx_flows_active_trigger ON public.flows USING btree (user_id, trigger_type) WHERE (status = 'active'::text);
CREATE INDEX idx_flow_nodes_flow ON public.flow_nodes USING btree (flow_id);
CREATE INDEX idx_flow_runs_account ON public.flow_runs USING btree (account_id);
CREATE INDEX idx_flow_runs_active_advanced ON public.flow_runs USING btree (last_advanced_at) WHERE (status = 'active'::text);
CREATE INDEX idx_flow_runs_flow_started ON public.flow_runs USING btree (flow_id, started_at DESC);
CREATE UNIQUE INDEX idx_one_active_run_per_contact ON public.flow_runs USING btree (account_id, contact_id) WHERE (status = 'active'::text);
CREATE INDEX idx_flow_run_events_run_time ON public.flow_run_events USING btree (flow_run_id, created_at DESC);
CREATE INDEX idx_flow_run_events_run_type ON public.flow_run_events USING btree (flow_run_id, event_type);

-- 10. AI agent, knowledge base and Train AI
CREATE INDEX ai_knowledge_documents_account_id_idx ON public.ai_knowledge_documents USING btree (account_id);
CREATE INDEX ai_knowledge_chunks_account_id_idx ON public.ai_knowledge_chunks USING btree (account_id);
CREATE INDEX ai_knowledge_chunks_document_id_idx ON public.ai_knowledge_chunks USING btree (document_id);
CREATE INDEX ai_knowledge_chunks_fts_idx ON public.ai_knowledge_chunks USING gin (fts);
CREATE INDEX idx_ai_usage_log_account_created ON public.ai_usage_log USING btree (account_id, created_at DESC);
CREATE INDEX idx_ai_training_examples_account ON public.ai_training_examples USING btree (account_id, kind, is_active);

-- 11. Public API and outbound webhooks
CREATE INDEX api_keys_account_id_idx ON public.api_keys USING btree (account_id);
CREATE INDEX api_keys_key_hash_idx ON public.api_keys USING btree (key_hash);
CREATE INDEX webhook_endpoints_account_id_idx ON public.webhook_endpoints USING btree (account_id);

-- 12. Notifications
CREATE INDEX idx_notifications_user_created ON public.notifications USING btree (user_id, created_at DESC);
CREATE INDEX idx_notifications_user_unread ON public.notifications USING btree (user_id) WHERE (read_at IS NULL);

-- 13. Database administration (Backup > Database config)
CREATE INDEX idx_db_maintenance_log_created ON public.db_maintenance_log USING btree (created_at DESC);


-- ======================================================================
-- 5. FUNCTIONS
-- SECURITY DEFINER functions set an explicit search_path. EXECUTE rights are in section 11.
-- ======================================================================

-- Shared helpers
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.is_account_member(target_account_id uuid, min_role account_role_enum DEFAULT 'viewer'::account_role_enum)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM profiles p
    WHERE p.user_id = current_user_id()
      AND p.account_id = target_account_id
      AND CASE p.account_role
            WHEN 'owner'  THEN 4
            WHEN 'admin'  THEN 3
            WHEN 'agent'  THEN 2
            WHEN 'viewer' THEN 1
          END
        >=
          CASE min_role
            WHEN 'owner'  THEN 4
            WHEN 'admin'  THEN 3
            WHEN 'agent'  THEN 2
            WHEN 'viewer' THEN 1
          END
  );
$function$;

-- Accounts, invitations and roles
CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_full_name TEXT;
  v_account_id UUID;
BEGIN
  v_full_name := COALESCE(NEW.raw_user_meta_data->>'full_name', '');

  INSERT INTO public.accounts (name, owner_user_id)
  VALUES (COALESCE(NULLIF(v_full_name, ''), NEW.email, 'My account'), NEW.id)
  RETURNING id INTO v_account_id;

  INSERT INTO public.profiles (user_id, full_name, email, account_id, account_role)
  VALUES (NEW.id, v_full_name, NEW.email, v_account_id, 'owner');

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Failed to bootstrap account/profile for user %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.enforce_profile_privilege_columns()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF (NEW.account_role IS DISTINCT FROM OLD.account_role
      OR NEW.account_id IS DISTINCT FROM OLD.account_id)
     AND current_user = 'wacrm_app'
  THEN
    RAISE EXCEPTION
      'account_role and account_id cannot be changed directly; use the account member/invitation RPCs'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.peek_invitation(p_token_hash text)
 RETURNS json
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_inv account_invitations%ROWTYPE;
  v_account_name TEXT;
BEGIN
  SELECT * INTO v_inv
  FROM account_invitations
  WHERE token_hash = p_token_hash;

  IF NOT FOUND THEN
    RETURN json_build_object('ok', false, 'reason', 'not_found');
  END IF;

  IF v_inv.accepted_at IS NOT NULL THEN
    RETURN json_build_object('ok', false, 'reason', 'used');
  END IF;

  IF v_inv.expires_at <= NOW() THEN
    RETURN json_build_object('ok', false, 'reason', 'expired');
  END IF;

  SELECT name INTO v_account_name
  FROM accounts
  WHERE id = v_inv.account_id;

  RETURN json_build_object(
    'ok', true,
    'account_name', v_account_name,
    'role', v_inv.role,
    'expires_at', v_inv.expires_at
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.redeem_invitation(p_token_hash text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller_id UUID := current_user_id();
  v_inv account_invitations%ROWTYPE;
  v_old_account_id UUID;
  v_old_account_owner UUID;
  v_has_data BOOLEAN;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_inv
  FROM account_invitations
  WHERE token_hash = p_token_hash
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invitation not found' USING ERRCODE = '22023';
  END IF;
  IF v_inv.accepted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Invitation has already been redeemed'
      USING ERRCODE = '22023';
  END IF;
  IF v_inv.expires_at <= NOW() THEN
    RAISE EXCEPTION 'Invitation has expired' USING ERRCODE = '22023';
  END IF;

  -- Caller's current account + its owner.
  SELECT p.account_id, a.owner_user_id
  INTO v_old_account_id, v_old_account_owner
  FROM profiles p
  JOIN accounts a ON a.id = p.account_id
  WHERE p.user_id = v_caller_id;

  IF v_old_account_id IS NULL THEN
    -- Defensive — every authenticated user has a profile post-017.
    RAISE EXCEPTION 'Caller has no profile' USING ERRCODE = '42501';
  END IF;

  -- Edge case: the inviter sent themselves a link, or the
  -- caller is somehow already in the inviter's account.
  IF v_old_account_id = v_inv.account_id THEN
    RAISE EXCEPTION 'You are already a member of this account'
      USING ERRCODE = '23505';
  END IF;

  -- Safety: the caller must be the SOLE OWNER of their current
  -- account (i.e. their fresh personal account from signup or a
  -- prior removal). Any other state means they're either:
  --   - a member of another shared account (joining a second
  --     would silently orphan their access to the first), or
  --   - the owner of an account with teammates (they'd abandon
  --     their team to join the inviter's).
  -- Either way, the safe answer is "make a different login".
  IF v_old_account_owner <> v_caller_id THEN
    RAISE EXCEPTION 'You are already in a shared account; sign up with a different email to join this one'
      USING ERRCODE = '23505';
  END IF;

  -- Belt: even if they own their account, refuse if it has any
  -- domain data — joining would orphan their contacts, deals,
  -- broadcasts, automations, flows, templates, etc.
  SELECT EXISTS (
    SELECT 1 FROM contacts WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM conversations WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM broadcasts WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM automations WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM flows WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM pipelines WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM message_templates WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM tags WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM custom_fields WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM contact_notes WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM whatsapp_config WHERE account_id = v_old_account_id
    LIMIT 1
  ) INTO v_has_data;

  IF v_has_data THEN
    RAISE EXCEPTION 'Your account already contains data; sign up with a different email to join this one'
      USING ERRCODE = '23505';
  END IF;

  -- Move the profile first so the cascade-on-delete of the old
  -- account doesn't try to nuke this user's profile too.
  UPDATE profiles
  SET account_id = v_inv.account_id,
      account_role = v_inv.role
  WHERE user_id = v_caller_id;

  UPDATE account_invitations
  SET accepted_at = NOW(),
      accepted_by_user_id = v_caller_id
  WHERE id = v_inv.id;

  -- Clean up the orphan personal account. Empty by the checks
  -- above, so this is purely housekeeping — no cascades fire
  -- because no other rows reference it.
  DELETE FROM accounts WHERE id = v_old_account_id;

  RETURN v_inv.account_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.set_member_role(p_user_id uuid, p_new_role account_role_enum)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller_account_id UUID;
  v_caller_role account_role_enum;
  v_target_account_id UUID;
  v_target_role account_role_enum;
BEGIN
  -- Caller must be authenticated.
  IF current_user_id() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  -- Resolve caller's account + role.
  SELECT account_id, account_role
  INTO v_caller_account_id, v_caller_role
  FROM profiles
  WHERE user_id = current_user_id();

  IF v_caller_account_id IS NULL THEN
    RAISE EXCEPTION 'Caller has no account' USING ERRCODE = '42501';
  END IF;

  -- Caller must be admin+.
  IF v_caller_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'This action requires the admin role or higher'
      USING ERRCODE = '42501';
  END IF;

  -- Can't change own role via this endpoint.
  IF p_user_id = current_user_id() THEN
    RAISE EXCEPTION 'Cannot change your own role'
      USING ERRCODE = '22023';
  END IF;

  -- Resolve target.
  SELECT account_id, account_role
  INTO v_target_account_id, v_target_role
  FROM profiles
  WHERE user_id = p_user_id;

  IF v_target_account_id IS NULL THEN
    RAISE EXCEPTION 'Target user not found' USING ERRCODE = '22023';
  END IF;

  -- Target must be in caller's account.
  IF v_target_account_id <> v_caller_account_id THEN
    RAISE EXCEPTION 'Target user is not a member of your account'
      USING ERRCODE = '42501';
  END IF;

  -- Owner role changes go through transfer_account_ownership.
  IF v_target_role = 'owner' THEN
    RAISE EXCEPTION 'Use transfer_account_ownership to demote an owner'
      USING ERRCODE = '22023';
  END IF;
  IF p_new_role = 'owner' THEN
    RAISE EXCEPTION 'Use transfer_account_ownership to promote to owner'
      USING ERRCODE = '22023';
  END IF;

  UPDATE profiles
  SET account_role = p_new_role
  WHERE user_id = p_user_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.remove_account_member(p_user_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller_account_id UUID;
  v_caller_role account_role_enum;
  v_target_account_id UUID;
  v_target_role account_role_enum;
  v_target_name TEXT;
  v_target_email TEXT;
  v_new_account_id UUID;
BEGIN
  IF current_user_id() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT account_id, account_role
  INTO v_caller_account_id, v_caller_role
  FROM profiles
  WHERE user_id = current_user_id();

  IF v_caller_account_id IS NULL THEN
    RAISE EXCEPTION 'Caller has no account' USING ERRCODE = '42501';
  END IF;

  IF v_caller_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'This action requires the admin role or higher'
      USING ERRCODE = '42501';
  END IF;

  IF p_user_id = current_user_id() THEN
    RAISE EXCEPTION 'Cannot remove yourself; transfer ownership or leave the account instead'
      USING ERRCODE = '22023';
  END IF;

  SELECT account_id, account_role, full_name, email
  INTO v_target_account_id, v_target_role, v_target_name, v_target_email
  FROM profiles
  WHERE user_id = p_user_id;

  IF v_target_account_id IS NULL THEN
    RAISE EXCEPTION 'Target user not found' USING ERRCODE = '22023';
  END IF;

  IF v_target_account_id <> v_caller_account_id THEN
    RAISE EXCEPTION 'Target user is not a member of your account'
      USING ERRCODE = '42501';
  END IF;

  IF v_target_role = 'owner' THEN
    RAISE EXCEPTION 'Cannot remove the account owner; transfer ownership first'
      USING ERRCODE = '22023';
  END IF;

  -- Spin up a fresh personal account for the removed user. Mirror
  -- of handle_new_user's logic — keep them whole, just relocated.
  INSERT INTO accounts (name, owner_user_id)
  VALUES (
    COALESCE(NULLIF(v_target_name, ''), v_target_email, 'My account'),
    p_user_id
  )
  RETURNING id INTO v_new_account_id;

  UPDATE profiles
  SET account_id = v_new_account_id,
      account_role = 'owner'
  WHERE user_id = p_user_id;

  RETURN v_new_account_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.transfer_account_ownership(p_new_owner_user_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller_account_id UUID;
  v_caller_role account_role_enum;
  v_target_account_id UUID;
  v_target_role account_role_enum;
BEGIN
  IF current_user_id() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT account_id, account_role
  INTO v_caller_account_id, v_caller_role
  FROM profiles
  WHERE user_id = current_user_id();

  IF v_caller_account_id IS NULL THEN
    RAISE EXCEPTION 'Caller has no account' USING ERRCODE = '42501';
  END IF;

  IF v_caller_role <> 'owner' THEN
    RAISE EXCEPTION 'Only the account owner can transfer ownership'
      USING ERRCODE = '42501';
  END IF;

  IF p_new_owner_user_id = current_user_id() THEN
    RAISE EXCEPTION 'You are already the owner'
      USING ERRCODE = '22023';
  END IF;

  SELECT account_id, account_role
  INTO v_target_account_id, v_target_role
  FROM profiles
  WHERE user_id = p_new_owner_user_id;

  IF v_target_account_id IS NULL THEN
    RAISE EXCEPTION 'Target user not found' USING ERRCODE = '22023';
  END IF;

  IF v_target_account_id <> v_caller_account_id THEN
    RAISE EXCEPTION 'Target user is not a member of your account'
      USING ERRCODE = '42501';
  END IF;

  -- Demote current owner first so the temporary state where the
  -- account has zero owners is never visible — both writes happen
  -- in the same function transaction.
  UPDATE profiles SET account_role = 'admin'
  WHERE user_id = current_user_id();

  UPDATE profiles SET account_role = 'owner'
  WHERE user_id = p_new_owner_user_id;

  UPDATE accounts SET owner_user_id = p_new_owner_user_id
  WHERE id = v_caller_account_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.touch_presence(p_status text DEFAULT 'online'::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_account_id UUID;
BEGIN
  IF current_user_id() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  IF p_status NOT IN ('online', 'away') THEN
    RAISE EXCEPTION 'Invalid presence status: %', p_status
      USING ERRCODE = '22023';
  END IF;

  SELECT account_id INTO v_account_id
  FROM profiles
  WHERE user_id = current_user_id();

  IF v_account_id IS NULL THEN
    RAISE EXCEPTION 'No account for caller' USING ERRCODE = '22023';
  END IF;

  INSERT INTO member_presence (user_id, account_id, status, last_seen_at)
  VALUES (current_user_id(), v_account_id, p_status, now())
  ON CONFLICT (user_id) DO UPDATE
    SET status       = excluded.status,
        last_seen_at = now(),
        account_id   = excluded.account_id;
END;
$function$;

-- Platform subscriptions
CREATE OR REPLACE FUNCTION public.handle_new_platform_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  INSERT INTO public.platform_users (
    user_id, platform_role, subscription_status,
    trial_days, trial_started_at, trial_ends_at
  )
  VALUES (
    NEW.id,
    CASE WHEN EXISTS (SELECT 1 FROM public.platform_users WHERE platform_role = 'super_admin')
         THEN 'subscriber' ELSE 'super_admin' END,
    CASE WHEN EXISTS (SELECT 1 FROM public.platform_users WHERE platform_role = 'super_admin')
         THEN 'trial' ELSE 'active' END,
    7, now(), now() + interval '7 days'
  )
  ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'handle_new_platform_user failed for %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$function$;

-- Contacts and inbox
CREATE OR REPLACE FUNCTION public.filter_contacts_by_tags(p_tag_ids uuid[], p_search text DEFAULT NULL::text, p_limit integer DEFAULT 25, p_offset integer DEFAULT 0)
 RETURNS TABLE(contact contacts, total_count bigint)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH matched AS (
    -- Distinct contacts having ANY of the selected tags (OR),
    -- narrowed by the same name/phone/email search as the list.
    SELECT DISTINCT c.id, c.created_at
    FROM contacts c
    JOIN contact_tags ct ON ct.contact_id = c.id
    WHERE ct.tag_id = ANY(p_tag_ids)
      AND (
        p_search IS NULL
        OR c.name ILIKE '%' || p_search || '%'
        OR c.phone ILIKE '%' || p_search || '%'
        OR c.email ILIKE '%' || p_search || '%'
      )
  ),
  page AS (
    -- count(*) OVER() is evaluated before LIMIT, so it is the full
    -- match total regardless of the page being returned.
    SELECT id, count(*) OVER() AS total_count
    FROM matched
    ORDER BY created_at DESC, id
    LIMIT p_limit OFFSET p_offset
  )
  SELECT c AS contact, page.total_count
  FROM page
  JOIN contacts c ON c.id = page.id
  ORDER BY c.created_at DESC, c.id;
$function$;

CREATE OR REPLACE FUNCTION public.merge_duplicate_contacts()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_group   RECORD;
  v_survivor UUID;
  v_losers   UUID[];
  v_merged   INTEGER := 0;
BEGIN
  FOR v_group IN
    SELECT account_id,
           phone_normalized,
           array_agg(id ORDER BY created_at ASC, id ASC) AS ids
    FROM contacts
    WHERE phone_normalized <> ''
    GROUP BY account_id, phone_normalized
    HAVING count(*) > 1
  LOOP
    v_survivor := v_group.ids[1];
    v_losers   := v_group.ids[2:array_length(v_group.ids, 1)];

    -- Plain re-point: these tables have no contact-scoped unique
    -- constraint. `conversations` is ON DELETE CASCADE, so this
    -- re-point is what saves its rows (and their messages) from
    -- being deleted with the loser contact.
    UPDATE conversations                 SET contact_id = v_survivor WHERE contact_id = ANY(v_losers);
    UPDATE contact_notes                 SET contact_id = v_survivor WHERE contact_id = ANY(v_losers);
    UPDATE deals                         SET contact_id = v_survivor WHERE contact_id = ANY(v_losers);
    UPDATE broadcast_recipients          SET contact_id = v_survivor WHERE contact_id = ANY(v_losers);
    UPDATE automation_logs               SET contact_id = v_survivor WHERE contact_id = ANY(v_losers);
    UPDATE automation_pending_executions SET contact_id = v_survivor WHERE contact_id = ANY(v_losers);

    -- Conflict-guarded re-point for UNIQUE(contact_id, tag_id):
    -- move only tags the survivor doesn't already have, drop the rest.
    UPDATE contact_tags ct SET contact_id = v_survivor
      WHERE ct.contact_id = ANY(v_losers)
        AND NOT EXISTS (
          SELECT 1 FROM contact_tags s
          WHERE s.contact_id = v_survivor AND s.tag_id = ct.tag_id
        );
    DELETE FROM contact_tags WHERE contact_id = ANY(v_losers);

    -- Same guard for UNIQUE(contact_id, custom_field_id). Survivor's
    -- own value wins on conflict.
    UPDATE contact_custom_values cv SET contact_id = v_survivor
      WHERE cv.contact_id = ANY(v_losers)
        AND NOT EXISTS (
          SELECT 1 FROM contact_custom_values s
          WHERE s.contact_id = v_survivor AND s.custom_field_id = cv.custom_field_id
        );
    DELETE FROM contact_custom_values WHERE contact_id = ANY(v_losers);

    -- flow_runs has a partial UNIQUE on active runs per contact.
    -- Re-point only NON-active runs (exempt from the partial index)
    -- to preserve history; any active loser run is left to be
    -- NULLed by its FK's ON DELETE SET NULL when the loser is
    -- removed below — avoids colliding with the survivor's active run.
    UPDATE flow_runs SET contact_id = v_survivor
      WHERE contact_id = ANY(v_losers) AND status <> 'active';

    DELETE FROM contacts WHERE id = ANY(v_losers);

    v_merged := v_merged + COALESCE(array_length(v_losers, 1), 0);
  END LOOP;

  RETURN v_merged;
END;
$function$;

CREATE OR REPLACE FUNCTION public.merge_duplicate_conversations()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_group    RECORD;
  v_survivor UUID;
  v_losers   UUID[];
  v_all      UUID[];
  v_merged   INTEGER := 0;
BEGIN
  FOR v_group IN
    SELECT account_id,
           contact_id,
           array_agg(id ORDER BY created_at ASC, id ASC) AS ids,
           COALESCE(SUM(unread_count), 0)                AS total_unread
    FROM conversations
    GROUP BY account_id, contact_id
    HAVING count(*) > 1
  LOOP
    v_all      := v_group.ids;
    v_survivor := v_all[1];
    v_losers   := v_all[2:array_length(v_all, 1)];

    -- Re-point every conversation-scoped child from the losers onto
    -- the survivor. None of these carry a conversation-scoped unique
    -- constraint (message_id is intentionally non-unique — see
    -- migration 009), so a plain UPDATE is safe. Doing this BEFORE the
    -- delete is what saves the ON DELETE CASCADE children (messages,
    -- message_reactions, notifications) from being removed with the
    -- loser conversations.
    UPDATE messages          SET conversation_id = v_survivor WHERE conversation_id = ANY(v_losers);
    UPDATE message_reactions SET conversation_id = v_survivor WHERE conversation_id = ANY(v_losers);
    UPDATE deals             SET conversation_id = v_survivor WHERE conversation_id = ANY(v_losers);
    UPDATE flow_runs         SET conversation_id = v_survivor WHERE conversation_id = ANY(v_losers);
    UPDATE notifications     SET conversation_id = v_survivor WHERE conversation_id = ANY(v_losers);
    UPDATE ai_usage_log      SET conversation_id = v_survivor WHERE conversation_id = ANY(v_losers);

    -- Roll the merged unread counts onto the survivor and re-derive
    -- its last-message summary from the now-complete message set, so
    -- the surviving thread reflects the full history.
    UPDATE conversations c
    SET unread_count      = v_group.total_unread,
        last_message_text = lm.content_text,
        last_message_at   = lm.created_at,
        updated_at        = NOW()
    FROM (
      SELECT content_text, created_at
      FROM messages
      WHERE conversation_id = v_survivor
      ORDER BY created_at DESC
      LIMIT 1
    ) lm
    WHERE c.id = v_survivor;

    -- Survivor may have no messages at all (edge case). Still fold in
    -- the merged unread count in that case.
    UPDATE conversations
    SET unread_count = v_group.total_unread,
        updated_at   = NOW()
    WHERE id = v_survivor
      AND NOT EXISTS (SELECT 1 FROM messages WHERE conversation_id = v_survivor);

    DELETE FROM conversations WHERE id = ANY(v_losers);

    v_merged := v_merged + COALESCE(array_length(v_losers, 1), 0);
  END LOOP;

  RETURN v_merged;
END;
$function$;

CREATE OR REPLACE FUNCTION public.bump_conversation_on_inbound(p_conversation_id uuid, p_last_message_text text)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  UPDATE conversations
  SET unread_count      = COALESCE(unread_count, 0) + 1,
      last_message_text = p_last_message_text,
      last_message_at   = NOW(),
      updated_at        = NOW()
  WHERE id = p_conversation_id;
$function$;

CREATE OR REPLACE FUNCTION public.notify_conversation_assigned()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_contact_name TEXT;
  v_actor_name TEXT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.assigned_agent_id IS NULL THEN
      RETURN NEW;
    END IF;
  ELSE
    IF NEW.assigned_agent_id IS NULL
       OR NEW.assigned_agent_id IS NOT DISTINCT FROM OLD.assigned_agent_id THEN
      RETURN NEW;
    END IF;
  END IF;

  -- Skip self-assignment — nothing to notify the agent about.
  IF current_user_id() IS NOT NULL AND current_user_id() = NEW.assigned_agent_id THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(NULLIF(name, ''), phone) INTO v_contact_name
  FROM contacts WHERE id = NEW.contact_id;

  IF current_user_id() IS NOT NULL THEN
    SELECT full_name INTO v_actor_name
    FROM profiles WHERE user_id = current_user_id();
  END IF;

  INSERT INTO notifications (
    account_id, user_id, type, conversation_id, contact_id,
    actor_user_id, title, body
  ) VALUES (
    NEW.account_id,
    NEW.assigned_agent_id,
    'conversation_assigned',
    NEW.id,
    NEW.contact_id,
    current_user_id(),
    'New conversation assigned',
    COALESCE(v_actor_name, 'Someone') || ' assigned you a conversation with '
      || COALESCE(v_contact_name, 'a contact')
  );

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Never let a notification failure block the assignment itself.
  RAISE WARNING 'Failed to create assignment notification for conversation %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$function$;

-- Broadcasts
CREATE OR REPLACE FUNCTION public.create_broadcast_with_recipients(p_account_id uuid, p_user_id uuid, p_name text, p_template_name text, p_template_language text, p_total_recipients integer, p_contact_ids uuid[], p_template_params jsonb[])
 RETURNS TABLE(broadcast_id uuid, recipient_id uuid, contact_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_broadcast_id UUID;
BEGIN
  INSERT INTO broadcasts (
    account_id, user_id, name, template_name,
    template_language, status, total_recipients
  )
  VALUES (
    p_account_id, p_user_id, p_name, p_template_name,
    p_template_language, 'sending', p_total_recipients
  )
  RETURNING id INTO v_broadcast_id;

  -- Two-array unnest pairs each contact with its params positionally.
  -- A shorter params array pads with NULL, which the resume path reads
  -- as "no params" — the same as a pre-038 row.
  RETURN QUERY
  WITH ins AS (
    INSERT INTO broadcast_recipients (
      broadcast_id, contact_id, status, template_params
    )
    SELECT v_broadcast_id, t.cid, 'pending', t.prm
    FROM unnest(p_contact_ids, p_template_params) AS t(cid, prm)
    -- Qualified: a bare `contact_id` collides with the RETURNS TABLE
    -- output variable of the same name. This is the whole fix.
    RETURNING id, broadcast_recipients.contact_id
  )
  SELECT v_broadcast_id, ins.id, ins.contact_id
  FROM ins;
END;
$function$;

CREATE OR REPLACE FUNCTION public.recompute_broadcast_counts(bid uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  UPDATE broadcasts b SET
    sent_count      = agg.sent_count,
    delivered_count = agg.delivered_count,
    read_count      = agg.read_count,
    replied_count   = agg.replied_count,
    failed_count    = agg.failed_count,
    updated_at      = NOW()
  FROM (
    SELECT
      COUNT(*) FILTER (WHERE status IN ('sent','delivered','read','replied')) AS sent_count,
      COUNT(*) FILTER (WHERE status IN ('delivered','read','replied'))        AS delivered_count,
      COUNT(*) FILTER (WHERE status IN ('read','replied'))                    AS read_count,
      COUNT(*) FILTER (WHERE status = 'replied')                              AS replied_count,
      COUNT(*) FILTER (WHERE status = 'failed')                               AS failed_count
    FROM broadcast_recipients
    WHERE broadcast_id = bid
  ) agg
  WHERE b.id = bid;
END;
$function$;

CREATE OR REPLACE FUNCTION public.broadcast_recipient_aggregate_trigger()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  old_cols TEXT[];
  new_cols TEXT[];
  c TEXT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    new_cols := _bcast_cols_for_status(NEW.status);
    FOREACH c IN ARRAY new_cols LOOP
      PERFORM _bcast_bump(NEW.broadcast_id, c, 1);
    END LOOP;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    old_cols := _bcast_cols_for_status(OLD.status);
    FOREACH c IN ARRAY old_cols LOOP
      PERFORM _bcast_bump(OLD.broadcast_id, c, -1);
    END LOOP;
    RETURN OLD;
  END IF;

  -- UPDATE: only care if status changed.
  IF OLD.status IS DISTINCT FROM NEW.status THEN
    old_cols := _bcast_cols_for_status(OLD.status);
    new_cols := _bcast_cols_for_status(NEW.status);
    -- Subtract the old contributions, add the new.
    FOREACH c IN ARRAY old_cols LOOP
      PERFORM _bcast_bump(NEW.broadcast_id, c, -1);
    END LOOP;
    FOREACH c IN ARRAY new_cols LOOP
      PERFORM _bcast_bump(NEW.broadcast_id, c, 1);
    END LOOP;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public._bcast_bump(bid uuid, col text, delta integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  EXECUTE format(
    'UPDATE broadcasts SET %I = GREATEST(0, %I + $1), updated_at = NOW() WHERE id = $2',
    col, col
  ) USING delta, bid;
END;
$function$;

CREATE OR REPLACE FUNCTION public._bcast_cols_for_status(s text)
 RETURNS text[]
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
BEGIN
  -- 'pending' contributes to nothing.
  IF s = 'pending' THEN RETURN ARRAY[]::TEXT[]; END IF;
  IF s = 'sent'      THEN RETURN ARRAY['sent_count']; END IF;
  IF s = 'delivered' THEN RETURN ARRAY['sent_count','delivered_count']; END IF;
  IF s = 'read'      THEN RETURN ARRAY['sent_count','delivered_count','read_count']; END IF;
  IF s = 'replied'   THEN RETURN ARRAY['sent_count','delivered_count','read_count','replied_count']; END IF;
  IF s = 'failed'    THEN RETURN ARRAY['failed_count']; END IF;
  RETURN ARRAY[]::TEXT[];
END;
$function$;

-- Automations and flows
CREATE OR REPLACE FUNCTION public.increment_automation_execution_count(p_automation_id uuid)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  UPDATE automations
  SET
    execution_count = execution_count + 1,
    last_executed_at = NOW()
  WHERE id = p_automation_id;
$function$;

CREATE OR REPLACE FUNCTION public.increment_flow_execution_count(p_flow_id uuid)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  UPDATE flows
  SET
    execution_count = execution_count + 1,
    last_executed_at = NOW()
  WHERE id = p_flow_id;
$function$;

-- AI and Train AI
CREATE OR REPLACE FUNCTION public.claim_ai_reply_slot(conversation_id uuid, max_replies integer)
 RETURNS boolean
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH claimed AS (
    UPDATE conversations
    SET ai_reply_count = ai_reply_count + 1
    WHERE id = conversation_id
      AND ai_reply_count < max_replies
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM claimed);
$function$;

CREATE OR REPLACE FUNCTION public.match_ai_knowledge_fts(p_account_id uuid, p_query text, p_match_count integer)
 RETURNS TABLE(id uuid, content text, rank real)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  SELECT c.id,
         c.content,
         ts_rank(c.fts, plainto_tsquery('simple', p_query)) AS rank
  FROM ai_knowledge_chunks c
  WHERE c.account_id = p_account_id
    AND c.fts @@ plainto_tsquery('simple', p_query)
  ORDER BY rank DESC
  LIMIT GREATEST(p_match_count, 0);
$function$;

-- (match_ai_knowledge_semantic is created in the pgvector block at the end of section 5)

CREATE OR REPLACE FUNCTION public.update_ai_configs_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.update_ai_knowledge_documents_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.bump_ai_training_use(p_ids uuid[])
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  UPDATE ai_training_examples
  SET use_count = use_count + 1
  WHERE id = ANY(p_ids)
    AND (current_setting('app.mode', true) IS DISTINCT FROM 'user' OR is_account_member(account_id));
$function$;

-- Webhooks
CREATE OR REPLACE FUNCTION public.record_webhook_failure(endpoint_id uuid, max_failures integer)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  UPDATE webhook_endpoints
  SET failure_count = failure_count + 1,
      is_active = CASE
        WHEN failure_count + 1 >= max_failures THEN false
        ELSE is_active
      END
  WHERE id = endpoint_id;
$function$;

-- Database config (migration 045, REBUILT)
CREATE OR REPLACE FUNCTION public.db_config_tables()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
  SELECT coalesce(jsonb_agg(t.obj ORDER BY t.obj->>'name'), '[]'::jsonb)
  FROM (
    SELECT jsonb_build_object(
      'name', c.relname,
      'rls', c.relrowsecurity,
      'rows', (
        xpath(
          '/row/c/text()',
          query_to_xml(format('SELECT count(*) AS c FROM public.%I', c.relname), false, true, '')
        )
      )[1]::text::bigint,
      'columns', (
        SELECT coalesce(jsonb_agg(jsonb_build_object(
          'name', a.attname,
          'type', format_type(a.atttypid, a.atttypmod),
          'nullable', NOT a.attnotnull,
          'default', pg_get_expr(d.adbin, d.adrelid),
          'primary_key', EXISTS (
            SELECT 1 FROM pg_constraint pk
            WHERE pk.conrelid = c.oid AND pk.contype = 'p' AND a.attnum = ANY (pk.conkey)
          ),
          'generated', a.attgenerated <> '',
          'identity', a.attidentity <> ''
        ) ORDER BY a.attnum), '[]'::jsonb)
        FROM pg_attribute a
        LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      ),
      'references', (
        SELECT coalesce(jsonb_agg(DISTINCT rc.relname), '[]'::jsonb)
        FROM pg_constraint f
        JOIN pg_class rc ON rc.oid = f.confrelid
        JOIN pg_namespace rn ON rn.oid = rc.relnamespace
        WHERE f.conrelid = c.oid AND f.contype = 'f'
          AND rn.nspname = 'public' AND f.confrelid <> c.oid
      ),
      'referenced_by', (
        SELECT coalesce(jsonb_agg(DISTINCT cc.relname), '[]'::jsonb)
        FROM pg_constraint f
        JOIN pg_class cc ON cc.oid = f.conrelid
        JOIN pg_namespace cn ON cn.oid = cc.relnamespace
        WHERE f.confrelid = c.oid AND f.contype = 'f'
          AND cn.nspname = 'public' AND f.conrelid <> c.oid
      )
    ) AS obj
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
  ) t;
$function$;

CREATE OR REPLACE FUNCTION public.db_config_schema_sql()
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  out  text := '';
  r    record;
  cols text;
BEGIN
  out := out || E'-- Schema of the "public" schema, generated by wacrm (Settings > Backup).\n';
  out := out || E'-- Run it with psql (or any SQL client) against an empty database to recreate the structure.\n';
  out := out || E'SET check_function_bodies = off;\n\n';

  FOR r IN SELECT extname FROM pg_extension WHERE extname NOT IN ('plpgsql') ORDER BY 1 LOOP
    out := out || format(E'CREATE EXTENSION IF NOT EXISTS %I;\n', r.extname);
  END LOOP;
  out := out || E'\n';

  -- enums
  FOR r IN
    SELECT t.typname, string_agg(quote_literal(e.enumlabel), ', ' ORDER BY e.enumsortorder) AS labels
    FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' GROUP BY t.typname ORDER BY 1
  LOOP
    out := out || format(E'DO $$ BEGIN CREATE TYPE public.%I AS ENUM (%s); EXCEPTION WHEN duplicate_object THEN NULL; END $$;\n', r.typname, r.labels);
  END LOOP;
  out := out || E'\n';

  -- sequences owned by no column (rare); skipped: serial/identity columns are in the table text.

  -- tables (columns only)
  FOR r IN
    SELECT c.oid, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY c.relname
  LOOP
    SELECT string_agg(
             format('  %I %s%s%s', a.attname, format_type(a.atttypid, a.atttypmod),
                    CASE WHEN a.attgenerated <> '' THEN ' GENERATED ALWAYS AS (' || pg_get_expr(d.adbin, d.adrelid) || ') STORED'
                         WHEN d.adbin IS NOT NULL THEN ' DEFAULT ' || pg_get_expr(d.adbin, d.adrelid) ELSE '' END,
                    CASE WHEN a.attnotnull THEN ' NOT NULL' ELSE '' END),
             E',\n' ORDER BY a.attnum)
      INTO cols
      FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
     WHERE a.attrelid = r.oid AND a.attnum > 0 AND NOT a.attisdropped;
    out := out || format(E'CREATE TABLE IF NOT EXISTS public.%I (\n%s\n);\n\n', r.relname, cols);
  END LOOP;

  -- functions (after tables: some take table row types)
  FOR r IN
    SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prokind = 'f'
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
    ORDER BY p.proname
  LOOP
    out := out || pg_get_functiondef(r.oid) || E';\n\n';
  END LOOP;

  -- constraints: primary / unique / check first, foreign keys last
  FOR r IN
    SELECT c.conrelid::regclass AS tbl, c.conname, pg_get_constraintdef(c.oid) AS def
    FROM pg_constraint c WHERE c.connamespace = 'public'::regnamespace AND c.contype IN ('p', 'u', 'c')
    ORDER BY c.conrelid::regclass::text, c.contype, c.conname
  LOOP
    out := out || format(E'DO $$ BEGIN ALTER TABLE %s ADD CONSTRAINT %I %s; EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;\n', r.tbl, r.conname, r.def);
  END LOOP;
  FOR r IN
    SELECT c.conrelid::regclass AS tbl, c.conname, pg_get_constraintdef(c.oid) AS def
    FROM pg_constraint c WHERE c.connamespace = 'public'::regnamespace AND c.contype = 'f'
    ORDER BY c.conrelid::regclass::text, c.conname
  LOOP
    out := out || format(E'DO $$ BEGIN ALTER TABLE %s ADD CONSTRAINT %I %s; EXCEPTION WHEN duplicate_object THEN NULL; END $$;\n', r.tbl, r.conname, r.def);
  END LOOP;
  out := out || E'\n';

  -- indexes that are not backing a constraint
  FOR r IN
    SELECT i.indexdef FROM pg_indexes i
    WHERE i.schemaname = 'public'
      AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conname = i.indexname AND c.connamespace = 'public'::regnamespace)
    ORDER BY i.tablename, i.indexname
  LOOP
    out := out || replace(r.indexdef, 'CREATE INDEX', 'CREATE INDEX IF NOT EXISTS') || E';\n';
  END LOOP;
  out := out || E'\n';

  -- triggers
  FOR r IN
    SELECT pg_get_triggerdef(t.oid) AS def FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    WHERE c.relnamespace = 'public'::regnamespace AND NOT t.tgisinternal ORDER BY c.relname, t.tgname
  LOOP
    out := out || r.def || E';\n';
  END LOOP;
  out := out || E'\n';

  -- RLS + policies
  FOR r IN
    SELECT c.relname FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND c.relrowsecurity ORDER BY 1
  LOOP
    out := out || format(E'ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;\n', r.relname);
  END LOOP;
  FOR r IN
    SELECT p.polname, c.relname, p.polcmd, p.polpermissive,
           pg_get_expr(p.polqual, p.polrelid) AS q, pg_get_expr(p.polwithcheck, p.polrelid) AS w,
           (SELECT string_agg(quote_ident(rolname), ', ') FROM pg_roles WHERE oid = ANY (p.polroles)) AS roles
    FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
    WHERE c.relnamespace = 'public'::regnamespace ORDER BY c.relname, p.polname
  LOOP
    out := out || format(E'DROP POLICY IF EXISTS %I ON public.%I;\nCREATE POLICY %I ON public.%I AS %s FOR %s%s%s%s;\n',
      r.polname, r.relname, r.polname, r.relname,
      CASE WHEN r.polpermissive THEN 'PERMISSIVE' ELSE 'RESTRICTIVE' END,
      CASE r.polcmd WHEN 'r' THEN 'SELECT' WHEN 'a' THEN 'INSERT' WHEN 'w' THEN 'UPDATE' WHEN 'd' THEN 'DELETE' ELSE 'ALL' END,
      CASE WHEN r.roles IS NOT NULL THEN ' TO ' || r.roles ELSE '' END,
      CASE WHEN r.q IS NOT NULL THEN ' USING (' || r.q || ')' ELSE '' END,
      CASE WHEN r.w IS NOT NULL THEN ' WITH CHECK (' || r.w || ')' ELSE '' END);
  END LOOP;

  RETURN out;
END;
$function$;

CREATE OR REPLACE FUNCTION public.db_config_truncate(p_tables text[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  t       text;
  n       bigint;
  counts  jsonb := '{}'::jsonb;
  locked  constant text[] := ARRAY['accounts', 'profiles', 'platform_users', 'db_maintenance_log'];
BEGIN
  IF p_tables IS NULL OR cardinality(p_tables) = 0 THEN
    RAISE EXCEPTION 'No tables given' USING ERRCODE = '22023';
  END IF;

  FOREACH t IN ARRAY p_tables LOOP
    IF t = ANY (locked) THEN
      RAISE EXCEPTION 'Table % is protected and cannot be truncated', t USING ERRCODE = '42501';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND c.relname = t
    ) THEN
      RAISE EXCEPTION 'Unknown table %', t USING ERRCODE = '42P01';
    END IF;
  END LOOP;

  FOREACH t IN ARRAY p_tables LOOP
    EXECUTE format('SELECT count(*) FROM public.%I', t) INTO n;
    counts := counts || jsonb_build_object(t, n);
  END LOOP;

  -- One statement so Postgres can accept a set that references itself.
  -- No CASCADE: a table still referenced from outside the list makes
  -- Postgres refuse, which the route reports as a 409.
  EXECUTE 'TRUNCATE TABLE ' ||
    (SELECT string_agg(format('public.%I', x), ', ') FROM unnest(p_tables) AS x) ||
    ' RESTART IDENTITY';

  RETURN counts;
END;
$function$;


-- pgvector block: semantic search needs the `vector` extension (the pgvector/pgvector
-- image has it). Without it everything else works and search falls back to full text.
DO $pgv$
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS vector;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'pgvector not available: semantic search disabled (%).', SQLERRM;
  END;

  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    ALTER TABLE public.ai_knowledge_chunks ADD COLUMN IF NOT EXISTS embedding vector(1536);
    CREATE INDEX IF NOT EXISTS ai_knowledge_chunks_embedding_idx
      ON public.ai_knowledge_chunks USING hnsw (embedding vector_cosine_ops);
    EXECUTE $q$ CREATE OR REPLACE FUNCTION public.match_ai_knowledge_semantic(p_account_id uuid, p_query_embedding text, p_match_count integer)
 RETURNS TABLE(id uuid, content text, distance real)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $f$
  SELECT c.id,
         c.content,
         (c.embedding <=> p_query_embedding::vector(1536)) AS distance
  FROM ai_knowledge_chunks c
  WHERE c.account_id = p_account_id
    AND c.embedding IS NOT NULL
  ORDER BY c.embedding <=> p_query_embedding::vector(1536)
  LIMIT GREATEST(p_match_count, 0);
$f$ $q$;
  ELSE
    ALTER TABLE public.ai_knowledge_chunks ADD COLUMN IF NOT EXISTS embedding real[];
    EXECUTE $q$
      CREATE OR REPLACE FUNCTION public.match_ai_knowledge_semantic(p_account_id uuid, p_query_embedding text, p_limit integer)
       RETURNS TABLE(id uuid, document_id uuid, content text, distance double precision)
       LANGUAGE plpgsql AS $f$ BEGIN RAISE EXCEPTION 'pgvector is not installed'; END $f$ $q$;
  END IF;
END
$pgv$;

-- ======================================================================
-- 6. TRIGGERS (application tables)
-- ======================================================================

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.accounts FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER ai_configs_updated_at BEFORE UPDATE ON public.ai_configs FOR EACH ROW EXECUTE FUNCTION update_ai_configs_updated_at();
CREATE TRIGGER ai_knowledge_documents_updated_at BEFORE UPDATE ON public.ai_knowledge_documents FOR EACH ROW EXECUTE FUNCTION update_ai_knowledge_documents_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.ai_training_examples FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.ai_training_profiles FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.automations FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER broadcast_recipients_aggregate AFTER INSERT OR DELETE OR UPDATE ON public.broadcast_recipients FOR EACH ROW EXECUTE FUNCTION broadcast_recipient_aggregate_trigger();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.broadcasts FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.contacts FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER on_conversation_assigned AFTER INSERT OR UPDATE OF assigned_agent_id ON public.conversations FOR EACH ROW EXECUTE FUNCTION notify_conversation_assigned();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.conversations FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.deals FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.flows FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.message_templates FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.platform_users FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER enforce_profile_privilege_columns BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION enforce_profile_privilege_columns();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.quick_replies FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.whatsapp_config FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- New sign-ups: account + profile (handle_new_user) and the platform row with its trial.
CREATE TRIGGER on_user_created AFTER INSERT ON public.users FOR EACH ROW EXECUTE FUNCTION handle_new_user();
CREATE TRIGGER on_user_created_platform AFTER INSERT ON public.users FOR EACH ROW EXECUTE FUNCTION handle_new_platform_user();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.users FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ======================================================================
-- 7. ROW LEVEL SECURITY
-- Every application table has RLS enabled. Helper: is_account_member(account_id, min_role).
-- Role order: owner > admin > agent > viewer. The service role bypasses RLS (webhook, cron, API-key routes).
-- ======================================================================

ALTER TABLE public.accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.account_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.member_presence ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.message_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contact_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.custom_fields ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contact_custom_values ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contact_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.message_reactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.quick_replies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pipelines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pipeline_stages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.deals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.broadcasts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.broadcast_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.automations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.automation_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.automation_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.automation_pending_executions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.flows ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.flow_nodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.flow_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.flow_run_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_knowledge_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_knowledge_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_usage_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_training_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_training_examples ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.webhook_endpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.db_maintenance_log ENABLE ROW LEVEL SECURITY;

-- 1. Accounts, users and team roles
CREATE POLICY "accounts_select" ON public.accounts FOR SELECT
  USING (is_account_member(id));
CREATE POLICY "accounts_update" ON public.accounts FOR UPDATE
  USING (is_account_member(id, 'admin'::account_role_enum))
  WITH CHECK (is_account_member(id, 'admin'::account_role_enum));
CREATE POLICY "profiles_insert" ON public.profiles FOR INSERT
  WITH CHECK ((current_user_id() = user_id));
CREATE POLICY "profiles_select" ON public.profiles FOR SELECT
  USING (((current_user_id() = user_id) OR is_account_member(account_id)));
CREATE POLICY "profiles_update" ON public.profiles FOR UPDATE
  USING ((current_user_id() = user_id))
  WITH CHECK ((current_user_id() = user_id));
CREATE POLICY "account_invitations_modify" ON public.account_invitations FOR ALL
  USING (is_account_member(account_id, 'admin'::account_role_enum))
  WITH CHECK (is_account_member(account_id, 'admin'::account_role_enum));
CREATE POLICY "account_invitations_select" ON public.account_invitations FOR SELECT
  USING (is_account_member(account_id, 'admin'::account_role_enum));
CREATE POLICY "member_presence_select" ON public.member_presence FOR SELECT
  USING (is_account_member(account_id));

-- 2. Platform roles and subscriptions
CREATE POLICY "platform_users_select_own" ON public.platform_users FOR SELECT
  USING ((user_id = current_user_id()));

-- 3. WhatsApp connection and message templates
CREATE POLICY "whatsapp_config_delete" ON public.whatsapp_config FOR DELETE
  USING (is_account_member(account_id, 'admin'::account_role_enum));
CREATE POLICY "whatsapp_config_insert" ON public.whatsapp_config FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'::account_role_enum));
CREATE POLICY "whatsapp_config_select" ON public.whatsapp_config FOR SELECT
  USING (is_account_member(account_id));
CREATE POLICY "whatsapp_config_update" ON public.whatsapp_config FOR UPDATE
  USING (is_account_member(account_id, 'admin'::account_role_enum));
CREATE POLICY "message_templates_delete" ON public.message_templates FOR DELETE
  USING (is_account_member(account_id, 'admin'::account_role_enum));
CREATE POLICY "message_templates_insert" ON public.message_templates FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'::account_role_enum));
CREATE POLICY "message_templates_select" ON public.message_templates FOR SELECT
  USING (is_account_member(account_id));
CREATE POLICY "message_templates_update" ON public.message_templates FOR UPDATE
  USING (is_account_member(account_id, 'admin'::account_role_enum));

-- 4. Contacts, tags and custom fields
CREATE POLICY "contacts_delete" ON public.contacts FOR DELETE
  USING (is_account_member(account_id, 'agent'::account_role_enum));
CREATE POLICY "contacts_insert" ON public.contacts FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'::account_role_enum));
CREATE POLICY "contacts_select" ON public.contacts FOR SELECT
  USING (is_account_member(account_id));
CREATE POLICY "contacts_update" ON public.contacts FOR UPDATE
  USING (is_account_member(account_id, 'agent'::account_role_enum));
CREATE POLICY "tags_delete" ON public.tags FOR DELETE
  USING (is_account_member(account_id, 'admin'::account_role_enum));
CREATE POLICY "tags_insert" ON public.tags FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'::account_role_enum));
CREATE POLICY "tags_select" ON public.tags FOR SELECT
  USING (is_account_member(account_id));
CREATE POLICY "tags_update" ON public.tags FOR UPDATE
  USING (is_account_member(account_id, 'admin'::account_role_enum));
CREATE POLICY "contact_tags_modify" ON public.contact_tags FOR ALL
  USING ((EXISTS ( SELECT 1
   FROM contacts c
  WHERE ((c.id = contact_tags.contact_id) AND is_account_member(c.account_id, 'agent'::account_role_enum)))))
  WITH CHECK ((EXISTS ( SELECT 1
   FROM contacts c
  WHERE ((c.id = contact_tags.contact_id) AND is_account_member(c.account_id, 'agent'::account_role_enum)))));
CREATE POLICY "contact_tags_select" ON public.contact_tags FOR SELECT
  USING ((EXISTS ( SELECT 1
   FROM contacts c
  WHERE ((c.id = contact_tags.contact_id) AND is_account_member(c.account_id)))));
CREATE POLICY "custom_fields_delete" ON public.custom_fields FOR DELETE
  USING (is_account_member(account_id, 'admin'::account_role_enum));
CREATE POLICY "custom_fields_insert" ON public.custom_fields FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'::account_role_enum));
CREATE POLICY "custom_fields_select" ON public.custom_fields FOR SELECT
  USING (is_account_member(account_id));
CREATE POLICY "custom_fields_update" ON public.custom_fields FOR UPDATE
  USING (is_account_member(account_id, 'admin'::account_role_enum));
CREATE POLICY "contact_custom_values_modify" ON public.contact_custom_values FOR ALL
  USING ((EXISTS ( SELECT 1
   FROM contacts c
  WHERE ((c.id = contact_custom_values.contact_id) AND is_account_member(c.account_id, 'agent'::account_role_enum)))))
  WITH CHECK ((EXISTS ( SELECT 1
   FROM contacts c
  WHERE ((c.id = contact_custom_values.contact_id) AND is_account_member(c.account_id, 'agent'::account_role_enum)))));
CREATE POLICY "contact_custom_values_select" ON public.contact_custom_values FOR SELECT
  USING ((EXISTS ( SELECT 1
   FROM contacts c
  WHERE ((c.id = contact_custom_values.contact_id) AND is_account_member(c.account_id)))));
CREATE POLICY "contact_notes_delete" ON public.contact_notes FOR DELETE
  USING (is_account_member(account_id, 'agent'::account_role_enum));
CREATE POLICY "contact_notes_insert" ON public.contact_notes FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'::account_role_enum));
CREATE POLICY "contact_notes_select" ON public.contact_notes FOR SELECT
  USING (is_account_member(account_id));
CREATE POLICY "contact_notes_update" ON public.contact_notes FOR UPDATE
  USING (is_account_member(account_id, 'agent'::account_role_enum));

-- 5. Inbox: conversations, messages and quick replies
CREATE POLICY "conversations_delete" ON public.conversations FOR DELETE
  USING (is_account_member(account_id, 'agent'::account_role_enum));
CREATE POLICY "conversations_insert" ON public.conversations FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'::account_role_enum));
CREATE POLICY "conversations_select" ON public.conversations FOR SELECT
  USING (is_account_member(account_id));
CREATE POLICY "conversations_update" ON public.conversations FOR UPDATE
  USING (is_account_member(account_id, 'agent'::account_role_enum));
CREATE POLICY "messages_modify" ON public.messages FOR ALL
  USING ((EXISTS ( SELECT 1
   FROM conversations c
  WHERE ((c.id = messages.conversation_id) AND is_account_member(c.account_id, 'agent'::account_role_enum)))))
  WITH CHECK ((EXISTS ( SELECT 1
   FROM conversations c
  WHERE ((c.id = messages.conversation_id) AND is_account_member(c.account_id, 'agent'::account_role_enum)))));
CREATE POLICY "messages_select" ON public.messages FOR SELECT
  USING ((EXISTS ( SELECT 1
   FROM conversations c
  WHERE ((c.id = messages.conversation_id) AND is_account_member(c.account_id)))));
CREATE POLICY "message_reactions_modify" ON public.message_reactions FOR ALL
  USING ((EXISTS ( SELECT 1
   FROM (messages m
     JOIN conversations c ON ((c.id = m.conversation_id)))
  WHERE ((m.id = message_reactions.message_id) AND is_account_member(c.account_id, 'agent'::account_role_enum)))))
  WITH CHECK ((EXISTS ( SELECT 1
   FROM (messages m
     JOIN conversations c ON ((c.id = m.conversation_id)))
  WHERE ((m.id = message_reactions.message_id) AND is_account_member(c.account_id, 'agent'::account_role_enum)))));
CREATE POLICY "message_reactions_select" ON public.message_reactions FOR SELECT
  USING ((EXISTS ( SELECT 1
   FROM (messages m
     JOIN conversations c ON ((c.id = m.conversation_id)))
  WHERE ((m.id = message_reactions.message_id) AND is_account_member(c.account_id)))));
CREATE POLICY "quick_replies_delete" ON public.quick_replies FOR DELETE
  USING (is_account_member(account_id, 'agent'::account_role_enum));
CREATE POLICY "quick_replies_insert" ON public.quick_replies FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'::account_role_enum));
CREATE POLICY "quick_replies_select" ON public.quick_replies FOR SELECT
  USING (is_account_member(account_id));
CREATE POLICY "quick_replies_update" ON public.quick_replies FOR UPDATE
  USING (is_account_member(account_id, 'agent'::account_role_enum));

-- 6. Sales pipelines and deals
CREATE POLICY "pipelines_delete" ON public.pipelines FOR DELETE
  USING (is_account_member(account_id, 'admin'::account_role_enum));
CREATE POLICY "pipelines_insert" ON public.pipelines FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'::account_role_enum));
CREATE POLICY "pipelines_select" ON public.pipelines FOR SELECT
  USING (is_account_member(account_id));
CREATE POLICY "pipelines_update" ON public.pipelines FOR UPDATE
  USING (is_account_member(account_id, 'admin'::account_role_enum));
CREATE POLICY "pipeline_stages_modify" ON public.pipeline_stages FOR ALL
  USING ((EXISTS ( SELECT 1
   FROM pipelines p
  WHERE ((p.id = pipeline_stages.pipeline_id) AND is_account_member(p.account_id, 'admin'::account_role_enum)))))
  WITH CHECK ((EXISTS ( SELECT 1
   FROM pipelines p
  WHERE ((p.id = pipeline_stages.pipeline_id) AND is_account_member(p.account_id, 'admin'::account_role_enum)))));
CREATE POLICY "pipeline_stages_select" ON public.pipeline_stages FOR SELECT
  USING ((EXISTS ( SELECT 1
   FROM pipelines p
  WHERE ((p.id = pipeline_stages.pipeline_id) AND is_account_member(p.account_id)))));
CREATE POLICY "deals_delete" ON public.deals FOR DELETE
  USING (is_account_member(account_id, 'agent'::account_role_enum));
CREATE POLICY "deals_insert" ON public.deals FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'::account_role_enum));
CREATE POLICY "deals_select" ON public.deals FOR SELECT
  USING (is_account_member(account_id));
CREATE POLICY "deals_update" ON public.deals FOR UPDATE
  USING (is_account_member(account_id, 'agent'::account_role_enum));

-- 7. Broadcasts
CREATE POLICY "broadcasts_delete" ON public.broadcasts FOR DELETE
  USING (is_account_member(account_id, 'agent'::account_role_enum));
CREATE POLICY "broadcasts_insert" ON public.broadcasts FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'::account_role_enum));
CREATE POLICY "broadcasts_select" ON public.broadcasts FOR SELECT
  USING (is_account_member(account_id));
CREATE POLICY "broadcasts_update" ON public.broadcasts FOR UPDATE
  USING (is_account_member(account_id, 'agent'::account_role_enum));
CREATE POLICY "broadcast_recipients_modify" ON public.broadcast_recipients FOR ALL
  USING ((EXISTS ( SELECT 1
   FROM broadcasts b
  WHERE ((b.id = broadcast_recipients.broadcast_id) AND is_account_member(b.account_id, 'agent'::account_role_enum)))))
  WITH CHECK ((EXISTS ( SELECT 1
   FROM broadcasts b
  WHERE ((b.id = broadcast_recipients.broadcast_id) AND is_account_member(b.account_id, 'agent'::account_role_enum)))));
CREATE POLICY "broadcast_recipients_select" ON public.broadcast_recipients FOR SELECT
  USING ((EXISTS ( SELECT 1
   FROM broadcasts b
  WHERE ((b.id = broadcast_recipients.broadcast_id) AND is_account_member(b.account_id)))));

-- 8. Automations
CREATE POLICY "automations_delete" ON public.automations FOR DELETE
  USING (is_account_member(account_id, 'agent'::account_role_enum));
CREATE POLICY "automations_insert" ON public.automations FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'::account_role_enum));
CREATE POLICY "automations_select" ON public.automations FOR SELECT
  USING (is_account_member(account_id));
CREATE POLICY "automations_update" ON public.automations FOR UPDATE
  USING (is_account_member(account_id, 'agent'::account_role_enum));
CREATE POLICY "automation_steps_modify" ON public.automation_steps FOR ALL
  USING ((EXISTS ( SELECT 1
   FROM automations a
  WHERE ((a.id = automation_steps.automation_id) AND is_account_member(a.account_id, 'agent'::account_role_enum)))))
  WITH CHECK ((EXISTS ( SELECT 1
   FROM automations a
  WHERE ((a.id = automation_steps.automation_id) AND is_account_member(a.account_id, 'agent'::account_role_enum)))));
CREATE POLICY "automation_steps_select" ON public.automation_steps FOR SELECT
  USING ((EXISTS ( SELECT 1
   FROM automations a
  WHERE ((a.id = automation_steps.automation_id) AND is_account_member(a.account_id)))));
CREATE POLICY "automation_logs_select" ON public.automation_logs FOR SELECT
  USING (is_account_member(account_id));

-- 9. Flows (chatbot builder)
CREATE POLICY "flows_delete" ON public.flows FOR DELETE
  USING (is_account_member(account_id, 'agent'::account_role_enum));
CREATE POLICY "flows_insert" ON public.flows FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'::account_role_enum));
CREATE POLICY "flows_select" ON public.flows FOR SELECT
  USING (is_account_member(account_id));
CREATE POLICY "flows_update" ON public.flows FOR UPDATE
  USING (is_account_member(account_id, 'agent'::account_role_enum));
CREATE POLICY "flow_nodes_modify" ON public.flow_nodes FOR ALL
  USING ((EXISTS ( SELECT 1
   FROM flows f
  WHERE ((f.id = flow_nodes.flow_id) AND is_account_member(f.account_id, 'agent'::account_role_enum)))))
  WITH CHECK ((EXISTS ( SELECT 1
   FROM flows f
  WHERE ((f.id = flow_nodes.flow_id) AND is_account_member(f.account_id, 'agent'::account_role_enum)))));
CREATE POLICY "flow_nodes_select" ON public.flow_nodes FOR SELECT
  USING ((EXISTS ( SELECT 1
   FROM flows f
  WHERE ((f.id = flow_nodes.flow_id) AND is_account_member(f.account_id)))));
CREATE POLICY "flow_runs_select" ON public.flow_runs FOR SELECT
  USING (is_account_member(account_id));
CREATE POLICY "flow_run_events_select" ON public.flow_run_events FOR SELECT
  USING ((EXISTS ( SELECT 1
   FROM flow_runs r
  WHERE ((r.id = flow_run_events.flow_run_id) AND is_account_member(r.account_id)))));

-- 10. AI agent, knowledge base and Train AI
CREATE POLICY "ai_configs_delete" ON public.ai_configs FOR DELETE
  USING (is_account_member(account_id, 'admin'::account_role_enum));
CREATE POLICY "ai_configs_insert" ON public.ai_configs FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'::account_role_enum));
CREATE POLICY "ai_configs_select" ON public.ai_configs FOR SELECT
  USING (is_account_member(account_id));
CREATE POLICY "ai_configs_update" ON public.ai_configs FOR UPDATE
  USING (is_account_member(account_id, 'admin'::account_role_enum));
CREATE POLICY "ai_knowledge_documents_delete" ON public.ai_knowledge_documents FOR DELETE
  USING (is_account_member(account_id, 'admin'::account_role_enum));
CREATE POLICY "ai_knowledge_documents_insert" ON public.ai_knowledge_documents FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'::account_role_enum));
CREATE POLICY "ai_knowledge_documents_select" ON public.ai_knowledge_documents FOR SELECT
  USING (is_account_member(account_id));
CREATE POLICY "ai_knowledge_documents_update" ON public.ai_knowledge_documents FOR UPDATE
  USING (is_account_member(account_id, 'admin'::account_role_enum));
CREATE POLICY "ai_knowledge_chunks_delete" ON public.ai_knowledge_chunks FOR DELETE
  USING (is_account_member(account_id, 'admin'::account_role_enum));
CREATE POLICY "ai_knowledge_chunks_insert" ON public.ai_knowledge_chunks FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'::account_role_enum));
CREATE POLICY "ai_knowledge_chunks_select" ON public.ai_knowledge_chunks FOR SELECT
  USING (is_account_member(account_id));
CREATE POLICY "ai_knowledge_chunks_update" ON public.ai_knowledge_chunks FOR UPDATE
  USING (is_account_member(account_id, 'admin'::account_role_enum));
CREATE POLICY "ai_usage_log_select" ON public.ai_usage_log FOR SELECT
  USING (is_account_member(account_id, 'admin'::account_role_enum));
CREATE POLICY "ai_training_profiles_insert" ON public.ai_training_profiles FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'::account_role_enum));
CREATE POLICY "ai_training_profiles_select" ON public.ai_training_profiles FOR SELECT
  USING (is_account_member(account_id));
CREATE POLICY "ai_training_profiles_update" ON public.ai_training_profiles FOR UPDATE
  USING (is_account_member(account_id, 'agent'::account_role_enum));
CREATE POLICY "ai_training_examples_delete" ON public.ai_training_examples FOR DELETE
  USING (is_account_member(account_id, 'agent'::account_role_enum));
CREATE POLICY "ai_training_examples_insert" ON public.ai_training_examples FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'::account_role_enum));
CREATE POLICY "ai_training_examples_select" ON public.ai_training_examples FOR SELECT
  USING (is_account_member(account_id));
CREATE POLICY "ai_training_examples_update" ON public.ai_training_examples FOR UPDATE
  USING (is_account_member(account_id, 'agent'::account_role_enum));

-- 11. Public API and outbound webhooks
CREATE POLICY "api_keys_delete" ON public.api_keys FOR DELETE
  USING (is_account_member(account_id, 'admin'::account_role_enum));
CREATE POLICY "api_keys_insert" ON public.api_keys FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'::account_role_enum));
CREATE POLICY "api_keys_select" ON public.api_keys FOR SELECT
  USING (is_account_member(account_id));
CREATE POLICY "api_keys_update" ON public.api_keys FOR UPDATE
  USING (is_account_member(account_id, 'admin'::account_role_enum));
CREATE POLICY "webhook_endpoints_delete" ON public.webhook_endpoints FOR DELETE
  USING (is_account_member(account_id, 'admin'::account_role_enum));
CREATE POLICY "webhook_endpoints_insert" ON public.webhook_endpoints FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'::account_role_enum));
CREATE POLICY "webhook_endpoints_select" ON public.webhook_endpoints FOR SELECT
  USING (is_account_member(account_id));
CREATE POLICY "webhook_endpoints_update" ON public.webhook_endpoints FOR UPDATE
  USING (is_account_member(account_id, 'admin'::account_role_enum));

-- 12. Notifications
CREATE POLICY "notifications_select" ON public.notifications FOR SELECT
  USING ((current_user_id() = user_id));
CREATE POLICY "notifications_update" ON public.notifications FOR UPDATE
  USING ((current_user_id() = user_id))
  WITH CHECK ((current_user_id() = user_id));

-- RLS enabled with NO policy (deny-all to anon/authenticated; service role only): automation_pending_executions, db_maintenance_log

-- ======================================================================
-- 8. CHANGE NOTIFICATIONS (live inbox)
-- Each change on these tables emits a small NOTIFY on channel wacrm_changes. The app's
-- /api/realtime endpoint LISTENs and pushes the changes to the browsers of the right account.
-- ======================================================================
CREATE OR REPLACE FUNCTION public.notify_row_change() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  r jsonb;
  acct jsonb;
BEGIN
  r := to_jsonb(CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END);
  acct := r->'account_id';
  IF acct IS NULL AND r->>'conversation_id' IS NOT NULL THEN
    SELECT to_jsonb(c.account_id) INTO acct FROM public.conversations c WHERE c.id = (r->>'conversation_id')::uuid;
  END IF;
  IF acct IS NULL THEN RETURN NULL; END IF;  -- parent already gone (cascade); the parent's own event covers it
  PERFORM pg_notify('wacrm_changes', jsonb_build_object(
    'table', TG_TABLE_NAME, 'op', TG_OP,
    'id', COALESCE(r->'id', r->'user_id'), 'account_id', acct, 'user_id', r->'user_id',
    'conversation_id', r->'conversation_id')::text);
  RETURN NULL;
END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['messages','conversations','message_reactions','flow_runs','member_presence','notifications'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', 'notify_' || t, t);
    EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.notify_row_change()', 'notify_' || t, t);
  END LOOP;
END $$;

-- ======================================================================
-- 9. PRIVILEGES FOR THE APPLICATION ROLE (wacrm_app = a signed-in user, RLS applies)
-- ======================================================================
GRANT USAGE ON SCHEMA public TO wacrm_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO wacrm_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO wacrm_app;
REVOKE ALL ON public.users, public.password_reset_tokens, public.db_maintenance_log FROM wacrm_app;
-- notifications: users may only mark their own notifications read.
REVOKE UPDATE ON public.notifications FROM wacrm_app;
GRANT UPDATE (read_at) ON public.notifications TO wacrm_app;

-- Functions: PUBLIC may execute by default; the sensitive ones are narrowed to the owner.
REVOKE ALL ON FUNCTION bump_conversation_on_inbound(uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION create_broadcast_with_recipients(uuid,uuid,text,text,text,integer,uuid[],jsonb[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION claim_ai_reply_slot(uuid,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION increment_automation_execution_count(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION increment_flow_execution_count(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION record_webhook_failure(uuid,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION merge_duplicate_contacts() FROM PUBLIC;
REVOKE ALL ON FUNCTION merge_duplicate_conversations() FROM PUBLIC;
REVOKE ALL ON FUNCTION handle_new_user() FROM PUBLIC;
REVOKE ALL ON FUNCTION handle_new_platform_user() FROM PUBLIC;
REVOKE ALL ON FUNCTION db_config_tables() FROM PUBLIC;
REVOKE ALL ON FUNCTION db_config_schema_sql() FROM PUBLIC;
REVOKE ALL ON FUNCTION db_config_truncate(text[]) FROM PUBLIC;

-- ======================================================================
-- 10. RECOMMENDED EXTRA INDEXES (optional)
-- These foreign-key columns have no index today. They speed up ON DELETE CASCADE / SET NULL
-- when a contact, conversation or automation is deleted, and the lookups noted. Safe to skip.
-- ======================================================================

CREATE INDEX IF NOT EXISTS idx_contact_notes_contact_id ON public.contact_notes (contact_id);  -- contact timeline
CREATE INDEX IF NOT EXISTS idx_deals_contact_id ON public.deals (contact_id);  -- deals of a contact; contact delete
CREATE INDEX IF NOT EXISTS idx_deals_conversation_id ON public.deals (conversation_id);  -- inbox sidebar; conversation delete
CREATE INDEX IF NOT EXISTS idx_broadcast_recipients_contact_id ON public.broadcast_recipients (contact_id);  -- contact delete; reply attribution
CREATE INDEX IF NOT EXISTS idx_contact_custom_values_field_id ON public.contact_custom_values (custom_field_id);  -- custom field delete
CREATE INDEX IF NOT EXISTS idx_automation_logs_contact_id ON public.automation_logs (contact_id);  -- contact delete
CREATE INDEX IF NOT EXISTS idx_automation_pending_automation_id ON public.automation_pending_executions (automation_id);  -- automation delete
CREATE INDEX IF NOT EXISTS idx_automation_pending_contact_id ON public.automation_pending_executions (contact_id);  -- contact delete
CREATE INDEX IF NOT EXISTS idx_flow_runs_contact_id ON public.flow_runs (contact_id);  -- contact delete; run lookup
CREATE INDEX IF NOT EXISTS idx_flow_runs_conversation_id ON public.flow_runs (conversation_id);  -- conversation delete
CREATE INDEX IF NOT EXISTS idx_notifications_conversation_id ON public.notifications (conversation_id);  -- conversation delete
CREATE INDEX IF NOT EXISTS idx_ai_usage_log_conversation_id ON public.ai_usage_log (conversation_id);  -- conversation delete

-- End of schema.
