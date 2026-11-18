import type { PoolClient } from "pg";

type Queryable = Pick<PoolClient, "query">;

export const AVNI_CONVERSATION_RUNTIME_TABLES = [
  "conversation_threads",
  "conversation_messages",
  "conversation_events",
  "conversation_outbox",
  "conversation_outbox_attempts",
  "conversation_delivery_receipts",
  "conversation_control_events",
] as const;

const EXPECTED_COLUMNS: Record<string, readonly string[]> = {
  conversation_threads: [
    "id:uuid:true", "provider:text:true", "provider_thread_hash:text:true",
    "supabase_lead_id:uuid:false", "mapping_status:text:true", "mode:text:true",
    "lifecycle:text:true", "control_version:bigint:true", "created_at:timestamp with time zone:true",
    "updated_at:timestamp with time zone:true",
  ],
  conversation_messages: [
    "id:uuid:true", "thread_id:uuid:true", "provider:text:true", "provider_message_ref:text:false",
    "idempotency_key:text:true", "message_fingerprint:text:true", "direction:text:true",
    "author:text:true", "message_type:text:true", "body:text:false", "media_ref:text:false",
    "delivery_state:text:false", "legacy_conversation_id:uuid:false", "occurred_at:timestamp with time zone:true",
    "received_at:timestamp with time zone:true", "created_at:timestamp with time zone:true",
  ],
  conversation_events: [
    "id:uuid:true", "thread_id:uuid:true", "provider:text:true", "provider_event_ref:text:true",
    "idempotency_key:text:true", "event_fingerprint:text:true", "event_kind:text:true",
    "message_id:uuid:false", "occurred_at:timestamp with time zone:true", "received_at:timestamp with time zone:true",
  ],
  conversation_outbox: [
    "id:uuid:true", "thread_id:uuid:true", "message_id:uuid:true", "author:text:true",
    "actor_ref:text:false", "idempotency_key:text:true", "expected_control_version:bigint:true",
    "state:text:true", "attempt_count:smallint:true", "max_attempts:smallint:true",
    "available_at:timestamp with time zone:true", "lease_token:uuid:false",
    "lease_expires_at:timestamp with time zone:false", "last_error_code:text:false",
    "created_at:timestamp with time zone:true", "updated_at:timestamp with time zone:true",
  ],
  conversation_outbox_attempts: [
    "id:uuid:true", "outbox_id:uuid:true", "attempt_number:smallint:true", "provider:text:true",
    "provider_message_ref:text:false", "state:text:true", "delivery_state:text:true",
    "lease_token:uuid:true", "lease_expires_at:timestamp with time zone:true",
    "started_at:timestamp with time zone:false", "finished_at:timestamp with time zone:false",
    "created_at:timestamp with time zone:true",
  ],
  conversation_delivery_receipts: [
    "id:uuid:true", "event_id:uuid:true", "attempt_id:uuid:true", "provider:text:true",
    "provider_receipt_ref:text:true", "raw_provider_state:text:true", "normalized_state:text:true",
    "occurred_at:timestamp with time zone:true", "received_at:timestamp with time zone:true",
  ],
  conversation_control_events: [
    "id:uuid:true", "thread_id:uuid:true", "request_id:uuid:true", "action:text:true",
    "actor_ref:text:true", "reason:text:false", "prior_version:bigint:true",
    "resulting_version:bigint:true", "occurred_at:timestamp with time zone:true",
  ],
};

const EXPECTED_INDEXES: Record<string, boolean> = {
  avni_conversation_threads_mapped_lead_uq: true,
  avni_conversation_threads_lead_updated_idx: false,
  avni_conversation_messages_provider_ref_uq: true,
  avni_conversation_messages_idempotency_uq: true,
  avni_conversation_messages_thread_time_idx: false,
  avni_conversation_messages_delivery_idx: false,
  avni_conversation_events_thread_time_idx: false,
  avni_conversation_events_unlinked_idx: false,
  avni_conversation_outbox_due_idx: false,
  avni_conversation_outbox_lease_idx: false,
  avni_conversation_outbox_thread_state_idx: false,
  avni_conversation_attempts_provider_message_uq: true,
  avni_conversation_attempts_expiry_idx: false,
  avni_conversation_receipts_attempt_time_idx: false,
  avni_conversation_control_thread_time_idx: false,
};

const EXPECTED_CONSTRAINTS = [
  "avni_conversation_threads_provider_ck",
  "avni_conversation_threads_thread_hash_ck",
  "avni_conversation_threads_mapping_ck",
  "avni_conversation_threads_mode_ck",
  "avni_conversation_threads_lifecycle_ck",
  "avni_conversation_threads_version_ck",
  "avni_conversation_threads_provider_thread_uq",
  "avni_conversation_messages_provider_ck",
  "avni_conversation_messages_provider_ref_ck",
  "avni_conversation_messages_idempotency_ck",
  "avni_conversation_messages_fingerprint_ck",
  "avni_conversation_messages_direction_author_ck",
  "avni_conversation_messages_type_ck",
  "avni_conversation_messages_body_ck",
  "avni_conversation_messages_media_ref_ck",
  "avni_conversation_messages_content_ck",
  "avni_conversation_messages_delivery_ck",
  "avni_conversation_messages_inbound_delivery_ck",
  "avni_conversation_messages_legacy_fk_uq",
  "avni_conversation_events_provider_ck",
  "avni_conversation_events_provider_ref_ck",
  "avni_conversation_events_idempotency_ck",
  "avni_conversation_events_fingerprint_ck",
  "avni_conversation_events_kind_ck",
  "avni_conversation_events_provider_event_uq",
  "avni_conversation_events_idempotency_uq",
  "avni_conversation_outbox_author_ck",
  "avni_conversation_outbox_actor_ck",
  "avni_conversation_outbox_idempotency_ck",
  "avni_conversation_outbox_version_ck",
  "avni_conversation_outbox_state_ck",
  "avni_conversation_outbox_attempts_ck",
  "avni_conversation_outbox_lease_ck",
  "avni_conversation_attempts_number_ck",
  "avni_conversation_attempts_provider_ck",
  "avni_conversation_attempts_provider_ref_ck",
  "avni_conversation_attempts_state_ck",
  "avni_conversation_attempts_delivery_ck",
  "avni_conversation_attempts_outbox_number_uq",
  "avni_conversation_receipts_provider_ck",
  "avni_conversation_receipts_ref_ck",
  "avni_conversation_receipts_raw_state_ck",
  "avni_conversation_receipts_state_ck",
  "avni_conversation_receipts_provider_ref_uq",
  "avni_conversation_control_action_ck",
  "avni_conversation_control_actor_ck",
  "avni_conversation_control_reason_ck",
  "avni_conversation_control_versions_ck",
  "avni_conversation_control_thread_version_uq",
] as const;

const EXPECTED_RPC_SIGNATURES: Record<string, string> = {
  accept_provider_event: "text, text, text, text, text, timestamp with time zone, text, text, text, text, text, text, text, text, text, text, text",
  link_conversation_thread: "uuid, uuid, bigint, text, uuid, text",
  enqueue_conversation_message: "uuid, bigint, text, text, text, text, text, text, text, boolean",
  claim_next_conversation_outbound: "boolean, integer",
  authorize_conversation_outbound_attempt: "uuid, uuid, uuid, boolean",
  record_conversation_send_result: "uuid, uuid, uuid, text, text",
  transition_conversation_control: "uuid, bigint, text, text, uuid, text, boolean, boolean",
};

function fail(code: string): never {
  const error = new Error(code) as Error & { code: string };
  error.code = code;
  throw error;
}

export async function assertAvniConversationRuntimePostconditions(client: Queryable): Promise<void> {
  const { rows: tables } = await client.query<{
    table_name: string;
    row_security: boolean;
  }>(`
    SELECT c.relname AS table_name,c.relrowsecurity AS row_security
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='aichm_private' AND c.relkind='r'
      AND c.relname=ANY($1::text[])
    ORDER BY c.relname
  `, [AVNI_CONVERSATION_RUNTIME_TABLES]);
  if (
    tables.length !== AVNI_CONVERSATION_RUNTIME_TABLES.length ||
    tables.some(table => table.row_security !== true) ||
    tables.map(table => table.table_name).join(",") !== [...AVNI_CONVERSATION_RUNTIME_TABLES].sort().join(",")
  ) fail("AVNI_CONVERSATION_RUNTIME_TABLES_OR_RLS_DRIFTED");

  const { rows: columns } = await client.query<{
    table_name: string;
    column_name: string;
    data_type: string;
    not_null: boolean;
  }>(`
    SELECT c.relname AS table_name,a.attname AS column_name,
      format_type(a.atttypid,a.atttypmod) AS data_type,a.attnotnull AS not_null
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_attribute a ON a.attrelid=c.oid
    WHERE n.nspname='aichm_private' AND c.relkind='r'
      AND c.relname=ANY($1::text[]) AND a.attnum>0 AND NOT a.attisdropped
    ORDER BY c.relname,a.attname
  `, [AVNI_CONVERSATION_RUNTIME_TABLES]);
  const actualColumns = columns.map(column =>
    `${column.table_name}.${column.column_name}:${column.data_type}:${column.not_null}`,
  ).sort();
  const expectedColumns = Object.entries(EXPECTED_COLUMNS)
    .flatMap(([table, specs]) => specs.map(spec => `${table}.${spec}`)).sort();
  if (actualColumns.length !== expectedColumns.length ||
      actualColumns.some((column, index) => column !== expectedColumns[index])) {
    fail("AVNI_CONVERSATION_RUNTIME_COLUMNS_DRIFTED");
  }

  const { rows: policies } = await client.query<{ count: string }>(`
    SELECT count(*)::text AS count FROM pg_policies
    WHERE schemaname='aichm_private' AND tablename=ANY($1::text[])
  `, [AVNI_CONVERSATION_RUNTIME_TABLES]);
  if (Number(policies[0]?.count) !== 0) fail("AVNI_CONVERSATION_RUNTIME_RLS_POLICY_FOUND");

  const expectedIndexNames = Object.keys(EXPECTED_INDEXES);
  const { rows: indexes } = await client.query<{
    index_name: string;
    valid: boolean;
    unique_index: boolean;
  }>(`
    SELECT ic.relname AS index_name,i.indisvalid AS valid,i.indisunique AS unique_index
    FROM pg_index i JOIN pg_class tc ON tc.oid=i.indrelid
    JOIN pg_namespace n ON n.oid=tc.relnamespace
    JOIN pg_class ic ON ic.oid=i.indexrelid
    WHERE n.nspname='aichm_private' AND ic.relname=ANY($1::text[])
  `, [expectedIndexNames]);
  if (
    indexes.length !== expectedIndexNames.length ||
    indexes.some(index => !index.valid || EXPECTED_INDEXES[index.index_name] !== index.unique_index)
  ) {
    fail("AVNI_CONVERSATION_RUNTIME_INDEXES_DRIFTED");
  }

  const { rows: constraints } = await client.query<{ constraint_name: string; validated: boolean }>(`
    SELECT conname AS constraint_name,convalidated AS validated
    FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='aichm_private' AND conname=ANY($1::text[])
  `, [EXPECTED_CONSTRAINTS]);
  if (
    constraints.length !== EXPECTED_CONSTRAINTS.length ||
    constraints.some(constraint => !constraint.validated)
  ) fail("AVNI_CONVERSATION_RUNTIME_CONSTRAINTS_DRIFTED");

  const { rows: roleRows } = await client.query<{
    role_name: string;
    can_login: boolean;
    bypass_rls: boolean;
    is_superuser: boolean;
  }>(`
    SELECT rolname AS role_name,rolcanlogin AS can_login,rolbypassrls AS bypass_rls,
      rolsuper AS is_superuser
    FROM pg_roles WHERE rolname='aichm_conversation_runtime'
  `);
  if (roleRows.length !== 1 || roleRows[0].can_login || roleRows[0].bypass_rls || roleRows[0].is_superuser) {
    fail("AVNI_CONVERSATION_RUNTIME_ROLE_DRIFTED");
  }

  const { rows: privileges } = await client.query<{
    table_name: string;
    role_name: string;
    privilege: string;
    allowed: boolean;
  }>(`
    SELECT c.relname AS table_name,r.role_name,p.privilege,
      has_table_privilege(r.role_name,c.oid,p.privilege) AS allowed
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    CROSS JOIN (VALUES ('aichm_conversation_runtime'),('aichm_crm_reader'),
      ('anon'),('authenticated'),('service_role')) AS r(role_name)
    CROSS JOIN (VALUES ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE')) AS p(privilege)
    WHERE n.nspname='aichm_private' AND c.relkind='r'
      AND c.relname=ANY($1::text[])
  `, [AVNI_CONVERSATION_RUNTIME_TABLES]);
  if (privileges.some(privilege => privilege.allowed)) {
    fail("AVNI_CONVERSATION_RUNTIME_DIRECT_TABLE_PRIVILEGE_FOUND");
  }

  const rpcNames = Object.keys(EXPECTED_RPC_SIGNATURES);
  const { rows: functions } = await client.query<{
    function_name: string;
    identity_arguments: string;
    security_definer: boolean;
    configuration: string[] | null;
    runtime_execute: boolean;
    reader_execute: boolean;
    service_execute: boolean;
    public_execute: boolean;
  }>(`
    SELECT p.proname AS function_name,oidvectortypes(p.proargtypes) AS identity_arguments,
      p.prosecdef AS security_definer,p.proconfig AS configuration,
      has_function_privilege('aichm_conversation_runtime',p.oid,'EXECUTE') AS runtime_execute,
      has_function_privilege('aichm_crm_reader',p.oid,'EXECUTE') AS reader_execute,
      has_function_privilege('service_role',p.oid,'EXECUTE') AS service_execute,
      EXISTS (
        SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
        WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE'
      ) AS public_execute
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='aichm_private' AND p.proname=ANY($1::text[])
    ORDER BY p.proname
  `, [rpcNames]);
  if (functions.length !== rpcNames.length) fail("AVNI_CONVERSATION_RUNTIME_RPC_MISSING");
  for (const fn of functions) {
    const searchPath = fn.configuration?.find(value => value.startsWith("search_path="));
    if (
      fn.identity_arguments !== EXPECTED_RPC_SIGNATURES[fn.function_name] ||
      !fn.security_definer ||
      searchPath !== "search_path=pg_catalog, aichm_private, public" ||
      !fn.runtime_execute || fn.reader_execute || fn.service_execute || fn.public_execute
    ) fail("AVNI_CONVERSATION_RUNTIME_RPC_PRIVILEGE_OR_PATH_DRIFTED");
  }
}
