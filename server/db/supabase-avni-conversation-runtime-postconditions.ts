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
    "id:uuid:true", "provider:text:true", "provider_thread_key:text:true",
    "supabase_lead_id:uuid:false", "mapping_status:text:true", "mode:text:true",
    "lifecycle:text:true", "control_version:bigint:true", "created_at:timestamp with time zone:true",
    "updated_at:timestamp with time zone:true",
  ],
  conversation_messages: [
    "id:uuid:true", "thread_id:uuid:true", "provider:text:true", "provider_message_key:text:false",
    "idempotency_key:text:true", "message_fingerprint:text:true", "direction:text:true",
    "author:text:true", "message_type:text:true", "body:text:false", "media_ref:text:false",
    "delivery_state:text:false", "legacy_conversation_id:uuid:false", "occurred_at:timestamp with time zone:true",
    "received_at:timestamp with time zone:true", "created_at:timestamp with time zone:true",
  ],
  conversation_events: [
    "id:uuid:true", "thread_id:uuid:true", "provider:text:true", "provider_event_key:text:true",
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
    "provider_message_key:text:false", "state:text:true", "delivery_state:text:true",
    "lease_token:uuid:true", "lease_expires_at:timestamp with time zone:true",
    "started_at:timestamp with time zone:false", "finished_at:timestamp with time zone:false",
    "created_at:timestamp with time zone:true",
  ],
  conversation_delivery_receipts: [
    "id:uuid:true", "event_id:uuid:true", "attempt_id:uuid:true", "provider:text:true",
    "provider_receipt_key:text:true", "raw_provider_state:text:true", "normalized_state:text:true",
    "occurred_at:timestamp with time zone:true", "received_at:timestamp with time zone:true",
  ],
  conversation_control_events: [
    "id:uuid:true", "thread_id:uuid:true", "request_id:uuid:true", "action:text:true",
    "actor_ref:text:true", "reason:text:false", "prior_version:bigint:true",
    "resulting_version:bigint:true", "whatsapp_consent_granted:boolean:false",
    "whatsapp_opted_out:boolean:false", "occurred_at:timestamp with time zone:true",
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
  "avni_conversation_control_resume_evidence_ck",
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

export async function assertAvniConversationRuntimePostconditions(
  client: Queryable,
  allowApprovedRuntimeMembership = false,
): Promise<void> {
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

  const { rows: policies } = await client.query<{ policy_name: string; roles: string[] }>(`
    SELECT policyname AS policy_name,roles::text[] AS roles FROM pg_policies
    WHERE schemaname='aichm_private' AND tablename=ANY($1::text[])
    ORDER BY policyname
  `, [AVNI_CONVERSATION_RUNTIME_TABLES]);
  const expectedPolicies = [
    "avni_rpc_owner_attempts", "avni_rpc_owner_controls", "avni_rpc_owner_events",
    "avni_rpc_owner_messages", "avni_rpc_owner_outbox", "avni_rpc_owner_receipts",
    "avni_rpc_owner_threads",
  ];
  if (
    policies.length !== expectedPolicies.length ||
    policies.some((policy, index) =>
      policy.policy_name !== expectedPolicies[index] ||
      policy.roles.length !== 1 ||
      policy.roles[0] !== "aichm_conversation_owner"
    )
  ) fail("AVNI_CONVERSATION_RUNTIME_RLS_POLICY_DRIFTED");

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
    can_inherit: boolean;
    bypass_rls: boolean;
    is_superuser: boolean;
    can_create_db: boolean;
    can_create_role: boolean;
    can_replicate: boolean;
  }>(`
    SELECT rolname AS role_name,rolcanlogin AS can_login,rolinherit AS can_inherit,
      rolbypassrls AS bypass_rls,rolsuper AS is_superuser,
      rolcreatedb AS can_create_db,rolcreaterole AS can_create_role,rolreplication AS can_replicate
    FROM pg_roles WHERE rolname IN ('aichm_conversation_runtime','aichm_conversation_owner')
  `);
  if (
    roleRows.length !== 2 || roleRows.some(role =>
      role.can_login || role.can_inherit || role.bypass_rls || role.is_superuser ||
      role.can_create_db || role.can_create_role || role.can_replicate
    )
  ) {
    fail("AVNI_CONVERSATION_OWNER_OR_RUNTIME_ROLE_DRIFTED");
  }

  const { rows: tableOwners } = await client.query<{ table_name: string; owner_name: string }>(`
    SELECT c.relname AS table_name,r.rolname AS owner_name
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_roles r ON r.oid=c.relowner
    WHERE n.nspname='aichm_private' AND c.relkind='r'
      AND c.relname=ANY($1::text[])
    ORDER BY c.relname
  `, [AVNI_CONVERSATION_RUNTIME_TABLES]);
  if (
    tableOwners.length !== AVNI_CONVERSATION_RUNTIME_TABLES.length ||
    tableOwners.some(row => row.owner_name !== "aichm_conversation_owner")
  ) fail("AVNI_CONVERSATION_RUNTIME_TABLE_OWNER_DRIFTED");

  const { rows: schemaAcl } = await client.query<{ owner_create: boolean; runtime_usage: boolean }>(`
    SELECT has_schema_privilege('aichm_conversation_owner','aichm_private','CREATE') AS owner_create,
      has_schema_privilege('aichm_conversation_runtime','aichm_private','USAGE') AS runtime_usage
  `);
  if (schemaAcl[0]?.owner_create || !schemaAcl[0]?.runtime_usage) {
    fail("AVNI_CONVERSATION_RUNTIME_SCHEMA_PRIVILEGE_DRIFTED");
  }

  const { rows: sequences } = await client.query<{ count: string }>(`
    SELECT count(*)::text AS count FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='aichm_private' AND c.relkind='S'
  `);
  if (Number(sequences[0]?.count) !== 0) {
    fail("AVNI_CONVERSATION_RUNTIME_UNEXPECTED_SEQUENCE_FOUND");
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
    owner_name: string;
    identity_arguments: string;
    security_definer: boolean;
    configuration: string[] | null;
    runtime_execute: boolean;
    reader_execute: boolean;
    service_execute: boolean;
    anon_execute: boolean;
    authenticated_execute: boolean;
    public_execute: boolean;
  }>(`
    SELECT p.proname AS function_name,owner.rolname AS owner_name,
      oidvectortypes(p.proargtypes) AS identity_arguments,
      p.prosecdef AS security_definer,p.proconfig AS configuration,
      has_function_privilege('aichm_conversation_runtime',p.oid,'EXECUTE') AS runtime_execute,
      has_function_privilege('aichm_crm_reader',p.oid,'EXECUTE') AS reader_execute,
      has_function_privilege('service_role',p.oid,'EXECUTE') AS service_execute,
      has_function_privilege('anon',p.oid,'EXECUTE') AS anon_execute,
      has_function_privilege('authenticated',p.oid,'EXECUTE') AS authenticated_execute,
      EXISTS (
        SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
        WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE'
      ) AS public_execute
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    JOIN pg_roles owner ON owner.oid=p.proowner
    WHERE n.nspname='aichm_private' AND p.proname=ANY($1::text[])
    ORDER BY p.proname
  `, [rpcNames]);
  if (functions.length !== rpcNames.length) fail("AVNI_CONVERSATION_RUNTIME_RPC_MISSING");
  for (const fn of functions) {
    const searchPath = fn.configuration?.find(value => value.startsWith("search_path="));
    if (
      fn.identity_arguments !== EXPECTED_RPC_SIGNATURES[fn.function_name] ||
      !fn.security_definer ||
      fn.owner_name !== "aichm_conversation_owner" ||
      searchPath !== "search_path=pg_catalog, aichm_private, pg_temp" ||
      !fn.runtime_execute || fn.reader_execute || fn.service_execute ||
      fn.anon_execute || fn.authenticated_execute || fn.public_execute
    ) fail("AVNI_CONVERSATION_RUNTIME_RPC_PRIVILEGE_OR_PATH_DRIFTED");
  }

  const { rows: helper } = await client.query<{ exposed: boolean }>(`
    SELECT has_function_privilege('aichm_conversation_runtime',
      'aichm_private.delivery_transition_allowed(text,text)'::regprocedure,'EXECUTE')
      OR has_function_privilege('aichm_crm_reader',
      'aichm_private.delivery_transition_allowed(text,text)'::regprocedure,'EXECUTE')
      OR has_function_privilege('service_role',
      'aichm_private.delivery_transition_allowed(text,text)'::regprocedure,'EXECUTE')
      OR has_function_privilege('anon',
      'aichm_private.delivery_transition_allowed(text,text)'::regprocedure,'EXECUTE')
      OR has_function_privilege('authenticated',
      'aichm_private.delivery_transition_allowed(text,text)'::regprocedure,'EXECUTE')
      OR EXISTS (
        SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
        WHERE p.proname='delivery_transition_allowed' AND acl.grantee=0
          AND acl.privilege_type='EXECUTE'
      ) AS exposed
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='aichm_private' AND p.proname='delivery_transition_allowed'
  `);
  if (helper.length !== 1 || helper[0].exposed) {
    fail("AVNI_CONVERSATION_RUNTIME_INTERNAL_HELPER_EXPOSED");
  }

  const { rows: memberships } = await client.query<{ count: string }>(`
    SELECT count(*)::text AS count
    FROM pg_auth_members m
    JOIN pg_roles granted_role ON granted_role.oid=m.roleid
    JOIN pg_roles member_role ON member_role.oid=m.member
    WHERE (
      granted_role.rolname IN ('aichm_conversation_owner','aichm_conversation_runtime')
      OR member_role.rolname IN ('aichm_conversation_owner','aichm_conversation_runtime')
    )
    AND (NOT $1::boolean OR
      (granted_role.rolname='aichm_conversation_owner' OR member_role.rolname='aichm_conversation_owner'))
  `, [allowApprovedRuntimeMembership]);
  if (Number(memberships[0]?.count) !== 0) {
    fail("AVNI_CONVERSATION_OWNER_OR_RUNTIME_MEMBERSHIP_UNREVIEWED");
  }
}

/**
 * This is a separate deployment-readiness assertion, not a migration postcondition.
 * It accepts exactly one explicitly named, constrained LOGIN member of the runtime
 * capability role. It never creates roles or grants memberships.
 */
export async function assertAvniConversationRuntimeReadiness(
  client: Queryable,
  approvedLoginRole: string,
): Promise<void> {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(approvedLoginRole)) {
    fail("AVNI_CONVERSATION_RUNTIME_LOGIN_NOT_APPROVED");
  }
  await assertAvniConversationRuntimePostconditions(client, true);
  const { rows } = await client.query<{
    role_name: string;
    can_login: boolean;
    can_inherit: boolean;
    is_superuser: boolean;
    can_create_db: boolean;
    can_create_role: boolean;
    bypass_rls: boolean;
    can_replicate: boolean;
    membership_count: string;
    runtime_membership: boolean;
  }>(`
    SELECT r.rolname AS role_name,r.rolcanlogin AS can_login,r.rolinherit AS can_inherit,
      r.rolsuper AS is_superuser,r.rolcreatedb AS can_create_db,
      r.rolcreaterole AS can_create_role,r.rolbypassrls AS bypass_rls,
      r.rolreplication AS can_replicate,
      (SELECT count(*)::text FROM pg_auth_members m WHERE m.member=r.oid) AS membership_count,
      EXISTS (
        SELECT 1 FROM pg_auth_members m
        JOIN pg_roles granted ON granted.oid=m.roleid
        WHERE m.member=r.oid AND granted.rolname='aichm_conversation_runtime'
      ) AS runtime_membership
    FROM pg_roles r WHERE r.rolname=$1
  `, [approvedLoginRole]);
  const login = rows[0];
  const { rows: runtimeMembers } = await client.query<{ count: string }>(`
    SELECT count(*)::text AS count
    FROM pg_auth_members m JOIN pg_roles granted ON granted.oid=m.roleid
    WHERE granted.rolname='aichm_conversation_runtime'
  `);
  if (
    rows.length !== 1 ||
    !login.can_login ||
    login.can_inherit ||
    login.is_superuser ||
    login.can_create_db ||
    login.can_create_role ||
    login.bypass_rls ||
    login.can_replicate ||
    Number(login.membership_count) !== 1 ||
    !login.runtime_membership ||
    Number(runtimeMembers[0]?.count) !== 1
  ) fail("AVNI_CONVERSATION_RUNTIME_LOGIN_NOT_APPROVED");
}

/**
 * Verifies the read-only Replit-to-Supabase conversation preflight boundary.
 * This is a migration/catalog check only; it does not provision a login.
 */
export async function assertAvniConversationPreflightPostconditions(
  client: Queryable,
): Promise<void> {
  const { rows: crosswalkPrivileges } = await client.query<{
    owner_table_select: boolean;
    owner_id_select: boolean;
    owner_crosswalk_select: boolean;
    owner_other_column_select_count: string;
    owner_public_usage: boolean;
    owner_public_create: boolean;
    reader_table_select: boolean;
    runtime_table_select: boolean;
    service_table_select: boolean;
  }>(`
    SELECT
      has_table_privilege('aichm_conversation_owner','public.leads','SELECT') AS owner_table_select,
      has_column_privilege('aichm_conversation_owner','public.leads','id','SELECT') AS owner_id_select,
      has_column_privilege('aichm_conversation_owner','public.leads','replit_lead_id','SELECT') AS owner_crosswalk_select,
      (SELECT count(*)::text FROM pg_attribute a
       WHERE a.attrelid='public.leads'::regclass AND a.attnum>0 AND NOT a.attisdropped
         AND a.attname NOT IN ('id','replit_lead_id')
         AND has_column_privilege('aichm_conversation_owner','public.leads',a.attname,'SELECT')
      ) AS owner_other_column_select_count,
      has_schema_privilege('aichm_conversation_owner','public','USAGE') AS owner_public_usage,
      has_schema_privilege('aichm_conversation_owner','public','CREATE') AS owner_public_create,
      has_table_privilege('aichm_crm_reader','public.leads','SELECT') AS reader_table_select,
      has_table_privilege('aichm_conversation_runtime','public.leads','SELECT') AS runtime_table_select,
      has_table_privilege('service_role','public.leads','SELECT') AS service_table_select
  `);
  const crosswalk = crosswalkPrivileges[0];
  if (
    !crosswalk ||
    crosswalk.owner_table_select ||
    !crosswalk.owner_id_select ||
    !crosswalk.owner_crosswalk_select ||
    Number(crosswalk.owner_other_column_select_count) !== 0 ||
    !crosswalk.owner_public_usage ||
    crosswalk.owner_public_create ||
    crosswalk.reader_table_select ||
    crosswalk.runtime_table_select ||
    crosswalk.service_table_select
  ) fail("AVNI_CONVERSATION_PREFLIGHT_CROSSWALK_PRIVILEGE_DRIFTED");

  const { rows: policies } = await client.query<{
    owner_only_role: boolean;
    command: string;
    permissive: boolean;
    predicate: string | null;
  }>(`
    SELECT p.polroles=ARRAY[(SELECT oid FROM pg_roles WHERE rolname='aichm_conversation_owner')]::oid[]
        AS owner_only_role,
      p.polcmd AS command,p.polpermissive AS permissive,
      pg_get_expr(p.polqual,p.polrelid) AS predicate
    FROM pg_policy p
    WHERE p.polrelid='public.leads'::regclass
      AND p.polname='avni_conversation_owner_crosswalk_select'
  `);
  if (
    policies.length !== 1 ||
    policies[0].owner_only_role !== true ||
    policies[0].command !== "r" ||
    policies[0].permissive !== true ||
    !policies[0].predicate?.includes("replit_lead_id IS NOT NULL")
  ) fail("AVNI_CONVERSATION_PREFLIGHT_CROSSWALK_POLICY_DRIFTED");

  const { rows: functions } = await client.query<{
    owner_name: string;
    identity_arguments: string;
    security_definer: boolean;
    stable: boolean;
    configuration: string[] | null;
    reader_execute: boolean;
    runtime_execute: boolean;
    service_execute: boolean;
    anon_execute: boolean;
    authenticated_execute: boolean;
    public_execute: boolean;
  }>(`
    SELECT owner.rolname AS owner_name,oidvectortypes(p.proargtypes) AS identity_arguments,
      p.prosecdef AS security_definer,p.provolatile='s' AS stable,p.proconfig AS configuration,
      has_function_privilege('aichm_crm_reader',p.oid,'EXECUTE') AS reader_execute,
      has_function_privilege('aichm_conversation_runtime',p.oid,'EXECUTE') AS runtime_execute,
      has_function_privilege('service_role',p.oid,'EXECUTE') AS service_execute,
      has_function_privilege('anon',p.oid,'EXECUTE') AS anon_execute,
      has_function_privilege('authenticated',p.oid,'EXECUTE') AS authenticated_execute,
      EXISTS (
        SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
        WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE'
      ) AS public_execute
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    JOIN pg_roles owner ON owner.oid=p.proowner
    WHERE n.nspname='aichm_private' AND p.proname='preflight_conversation_for_replit_lead'
  `);
  const fn = functions[0];
  const searchPath = fn?.configuration?.find(value => value.startsWith("search_path="));
  if (
    functions.length !== 1 ||
    fn.owner_name !== "aichm_conversation_owner" ||
    fn.identity_arguments !== "uuid, bigint" ||
    !fn.security_definer ||
    !fn.stable ||
    searchPath !== "search_path=pg_catalog, aichm_private, pg_temp" ||
    !fn.reader_execute ||
    fn.runtime_execute ||
    fn.service_execute ||
    fn.anon_execute ||
    fn.authenticated_execute ||
    fn.public_execute
  ) fail("AVNI_CONVERSATION_PREFLIGHT_RPC_PRIVILEGE_OR_PATH_DRIFTED");
}
