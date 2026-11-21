import { randomUUID } from "node:crypto";
import { checkServerIdentity, type ConnectionOptions } from "node:tls";
import { Pool, type PoolConfig } from "pg";
import { z } from "zod";
import { normalizeSupabaseCaCertificate } from "./supabase-migration";

export const SUPABASE_AVNI_PROJECT_REF = "xylqezjvqqqjozenuygh";
export const SUPABASE_AVNI_POOLER_HOST = "aws-0-ap-northeast-1.pooler.supabase.com";
const URI_SECRET = "SUPABASE_AVNI_READONLY_DATABASE_URL";
const CA_SECRET = "SUPABASE_DB_SSL_CA";

export type SupabaseAvniReadEnvironment = Record<string, string | undefined>;
type QueryResult = { rows: Record<string, unknown>[] };
export type ReadonlyQueryable = {
  query(text: string, values?: unknown[]): Promise<QueryResult>;
};
export type SupabaseAvniDiagnosticChecks = {
  readerUrlPresent: boolean;
  readerUrlValid: boolean;
  readerCaPresent: boolean;
  readerCaAccepted: boolean;
  tlsConfigStrict: boolean;
  tlsConnected: boolean;
  tlsChainVerified: boolean;
  tlsHostnameVerified: boolean;
  readerDatabaseIsPostgres: boolean;
  readerRoleIsDedicated: boolean;
  readerSessionIsReadOnly: boolean;
  conversationsRpcExecutes: boolean;
  syntheticConversationIsEmpty: boolean;
  confirmationRpcExecutes: boolean;
  syntheticConfirmationIsFalse: boolean;
  publicLeadsSelectDenied: boolean;
  publicConversationsSelectDenied: boolean;
};
export type SupabaseAvniDiagnosticSession = ReadonlyQueryable & {
  tls: {
    encrypted: boolean;
    authorized: boolean;
    authorizationErrorPresent: boolean;
    servername: string | null;
  };
  close(): Promise<void>;
};
export type SupabaseAvniDiagnosticConnector = (
  config: PoolConfig,
) => Promise<SupabaseAvniDiagnosticSession>;
export type ConversationCursor = {
  at: string;
  conversationId: string;
  side: "message" | "ai_response";
};
export type SupabaseConversationItem = {
  conversationId: string;
  side: ConversationCursor["side"];
  direction: string;
  messageType: string;
  body: string;
  deliveryState: string | null;
  providerMessageId: string | null;
  occurredAt: string;
};
export type SupabaseConversationPreflight = {
  outcome:
    | "invalid_request"
    | "crosswalk_missing"
    | "crosswalk_ambiguous"
    | "conversation_missing"
    | "conversation_ambiguous"
    | "conversation_closed"
    | "stale_control_version"
    | "preflight_ready";
  mode: "ai" | "human" | null;
  lifecycle: "open" | "closed" | null;
  controlVersion: number | null;
};
export type SupabasePilotOutboundStatus = {
  state: "pending" | "claimed" | "sending" | "accepted" | "delivered" |
    "failed" | "unknown" | "cancelled";
  attemptNumber: number;
};

const cursorSchema = z.object({
  at: z.string().datetime({ offset: true }),
  conversationId: z.string().uuid(),
  side: z.enum(["message", "ai_response"]),
}).strict();
const conversationPreflightSchema = z.object({
  outcome: z.enum([
    "invalid_request",
    "crosswalk_missing",
    "crosswalk_ambiguous",
    "conversation_missing",
    "conversation_ambiguous",
    "conversation_closed",
    "stale_control_version",
    "preflight_ready",
  ]),
  thread_id: z.string().uuid().nullable(),
  mode: z.enum(["ai", "human"]).nullable(),
  lifecycle: z.enum(["open", "closed"]).nullable(),
  control_version: z.union([z.number().int().nonnegative(), z.string().regex(/^\d+$/)])
    .nullable(),
}).strict().superRefine((row, context) => {
  if (row.outcome === "preflight_ready" && !row.thread_id) {
    context.addIssue({
      code: "custom",
      path: ["thread_id"],
      message: "Ready preflight requires one internal thread.",
    });
  }
});
const pilotOutboundStatusKeySchema = z.string().regex(/^message:v1:[0-9a-f]{64}$/);
const pilotOutboundStatusRowSchema = z.object({
  state: z.enum(["pending", "claimed", "sending", "accepted", "delivered", "failed", "unknown", "cancelled"]),
  attempt_number: z.union([
    z.number().int().min(0).max(8),
    z.string().regex(/^(?:[0-8])$/).transform(Number),
  ]),
}).passthrough();

function required(value: string | undefined, key: string) {
  const result = value?.trim();
  if (!result) throw new Error(`${key} is required for the read-only AVNI CRM connection.`);
  return result;
}

function validateUrl(raw: string) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${URI_SECRET} must be a valid PostgreSQL URI.`);
  }
  if (!["postgres:", "postgresql:"].includes(url.protocol)
    || url.hostname.toLowerCase() !== SUPABASE_AVNI_POOLER_HOST || url.port !== "5432" || url.pathname !== "/postgres") {
    throw new Error(`${URI_SECRET} must use the approved Supavisor host, port, and database.`);
  }
  let username = "";
  try {
    username = decodeURIComponent(url.username);
  } catch {
    throw new Error(`${URI_SECRET} has invalid username encoding.`);
  }
  if (username !== `aichm_crm_reader.${SUPABASE_AVNI_PROJECT_REF}` || !url.password) {
    throw new Error(`${URI_SECRET} must authenticate as the dedicated read-only CRM role.`);
  }
  const sslModes = Array.from(url.searchParams.entries()).filter(([key]) => key.toLowerCase() === "sslmode");
  if (sslModes.length !== 1 || sslModes[0][0] !== "sslmode" || sslModes[0][1] !== "require") {
    throw new Error(`${URI_SECRET} must include exactly one sslmode=require parameter.`);
  }
  if (Array.from(url.searchParams.keys()).some((key) => /^ssl(?:_|$)/i.test(key) && key.toLowerCase() !== "sslmode")) {
    throw new Error(`${URI_SECRET} must not override TLS settings in the URI.`);
  }
  const rawQuery = raw.split("?")[1] ?? "";
  if ((raw.match(/\?/g) ?? []).length !== 1 || !rawQuery || rawQuery.startsWith("&")
    || rawQuery.endsWith("&") || rawQuery.includes("&&")) {
    throw new Error(`${URI_SECRET} has malformed query separators.`);
  }
  return url;
}

export function isSupabaseAvniReadConfigured(environment: SupabaseAvniReadEnvironment = process.env) {
  if (environment.NODE_ENV === "test") return false;
  try {
    buildSupabaseAvniReadPoolConfig(environment);
    return true;
  } catch {
    return false;
  }
}

export function buildSupabaseAvniReadPoolConfig(
  environment: SupabaseAvniReadEnvironment = process.env,
): PoolConfig {
  const uri = required(environment[URI_SECRET], URI_SECRET);
  const ca = normalizeSupabaseCaCertificate(required(environment[CA_SECRET], CA_SECRET));
  const parsed = validateUrl(uri);
  const poolUrl = new URL(parsed.toString());
  poolUrl.searchParams.delete("sslmode");
  const ssl: ConnectionOptions = Object.freeze({
    ca,
    rejectUnauthorized: true,
    checkServerIdentity,
    minVersion: "TLSv1.2",
  });
  return Object.freeze({
    connectionString: poolUrl.toString(),
    ssl,
    options: "-c default_transaction_read_only=on -c timezone=UTC",
    application_name: "aichm-crm-supabase-readonly",
    max: 4,
  });
}

async function connectSupabaseAvniDiagnostic(config: PoolConfig): Promise<SupabaseAvniDiagnosticSession> {
  const pool = new Pool(config);
  pool.on("error", () => {
    // Diagnostic failures are represented by booleans; never log driver output.
  });
  try {
    const client = await pool.connect();
    const stream = (client as unknown as {
      connection?: {
        stream?: {
          encrypted?: boolean;
          authorized?: boolean;
          authorizationError?: Error | string | null;
          servername?: string;
        };
      };
    }).connection?.stream;
    return {
      query: async (text, values) => {
        const result = await client.query(text, values);
        return { rows: result.rows as Record<string, unknown>[] };
      },
      tls: {
        encrypted: stream?.encrypted === true,
        authorized: stream?.authorized === true,
        authorizationErrorPresent: Boolean(stream?.authorizationError),
        servername: stream?.servername ?? null,
      },
      close: async () => {
        client.release();
        await pool.end();
      },
    };
  } catch (error) {
    await pool.end().catch(() => {});
    throw error;
  }
}

/**
 * Read-only runtime diagnostic. It deliberately returns only booleans and
 * uses an aggregate RPC result plus privilege checks so no message rows or
 * public-table records are returned to the application.
 */
export async function runSupabaseAvniReadDiagnostics(
  environment: SupabaseAvniReadEnvironment = process.env,
  connector: SupabaseAvniDiagnosticConnector = connectSupabaseAvniDiagnostic,
): Promise<SupabaseAvniDiagnosticChecks> {
  const uri = environment[URI_SECRET];
  const caValue = environment[CA_SECRET];
  const checks: SupabaseAvniDiagnosticChecks = {
    readerUrlPresent: Boolean(uri?.trim()),
    readerUrlValid: false,
    readerCaPresent: Boolean(caValue?.trim()),
    readerCaAccepted: false,
    tlsConfigStrict: false,
    tlsConnected: false,
    tlsChainVerified: false,
    tlsHostnameVerified: false,
    readerDatabaseIsPostgres: false,
    readerRoleIsDedicated: false,
    readerSessionIsReadOnly: false,
    conversationsRpcExecutes: false,
    syntheticConversationIsEmpty: false,
    confirmationRpcExecutes: false,
    syntheticConfirmationIsFalse: false,
    publicLeadsSelectDenied: false,
    publicConversationsSelectDenied: false,
  };

  if (checks.readerUrlPresent) {
    try {
      validateUrl(required(uri, URI_SECRET));
      checks.readerUrlValid = true;
    } catch {
      checks.readerUrlValid = false;
    }
  }
  if (checks.readerCaPresent) {
    try {
      normalizeSupabaseCaCertificate(required(caValue, CA_SECRET));
      checks.readerCaAccepted = true;
    } catch {
      checks.readerCaAccepted = false;
    }
  }
  if (!checks.readerUrlValid || !checks.readerCaAccepted) return checks;

  let config: PoolConfig;
  try {
    config = buildSupabaseAvniReadPoolConfig(environment);
    const ssl = config.ssl;
    checks.tlsConfigStrict = Boolean(
      ssl
      && typeof ssl === "object"
      && ssl.rejectUnauthorized === true
      && ssl.checkServerIdentity === checkServerIdentity
      && Boolean(ssl.ca)
      && config.options?.includes("default_transaction_read_only=on"),
    );
  } catch {
    return checks;
  }
  if (!checks.tlsConfigStrict) return checks;

  let session: SupabaseAvniDiagnosticSession | undefined;
  try {
    session = await connector(config);
    checks.tlsConnected = session.tls.encrypted;
    checks.tlsChainVerified = session.tls.authorized && !session.tls.authorizationErrorPresent;
    checks.tlsHostnameVerified = checks.tlsChainVerified
      && session.tls.servername === SUPABASE_AVNI_POOLER_HOST;

    const identity = await session.query(
      `SELECT current_database() AS database_name, current_user AS role_name,
        current_setting('default_transaction_read_only') AS read_only`,
    );
    checks.readerDatabaseIsPostgres = identity.rows[0]?.database_name === "postgres";
    checks.readerRoleIsDedicated = identity.rows[0]?.role_name === "aichm_crm_reader";
    checks.readerSessionIsReadOnly = identity.rows[0]?.read_only === "on";

    try {
      const rows = await session.query(
        `SELECT count(*)::int AS message_count
         FROM aichm_private.aichm_crm_conversations_for_replit_lead(
           $1::uuid,NULL::timestamptz,NULL::uuid,NULL::text,$2::integer
         )`,
        [randomUUID(), 5],
      );
      checks.conversationsRpcExecutes = true;
      checks.syntheticConversationIsEmpty = rows.rows[0]?.message_count === 0;
    } catch {
      checks.conversationsRpcExecutes = false;
    }

    try {
      const rows = await session.query(
        `SELECT aichm_private.aichm_crm_verify_confirmation(
          $1::uuid,$2::uuid,$3::text
        ) AS verified`,
        [randomUUID(), randomUUID(), "booking_confirmation"],
      );
      checks.confirmationRpcExecutes = true;
      checks.syntheticConfirmationIsFalse = rows.rows[0]?.verified === false;
    } catch {
      checks.confirmationRpcExecutes = false;
    }

    try {
      const rows = await session.query(
        `SELECT
          has_table_privilege(current_user,'public.leads','SELECT') AS leads_select,
          has_table_privilege(current_user,'public.conversations','SELECT') AS conversations_select`,
      );
      checks.publicLeadsSelectDenied = rows.rows[0]?.leads_select === false;
      checks.publicConversationsSelectDenied = rows.rows[0]?.conversations_select === false;
    } catch {
      checks.publicLeadsSelectDenied = false;
      checks.publicConversationsSelectDenied = false;
    }
  } catch {
    // Do not expose network, authentication, certificate, or driver details.
  } finally {
    await session?.close().catch(() => {});
  }
  return checks;
}

let sharedPool: Pool | undefined;
function getPool(environment: SupabaseAvniReadEnvironment = process.env) {
  if (!sharedPool) sharedPool = new Pool(buildSupabaseAvniReadPoolConfig(environment));
  return sharedPool;
}

function encodeCursor(cursor: ConversationCursor) {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeConversationCursor(value: string | undefined): ConversationCursor | null {
  if (!value) return null;
  if (value.length > 512) throw new Error("invalid_conversation_cursor");
  try {
    const parsed = cursorSchema.parse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
    return { at: parsed.at, conversationId: parsed.conversationId, side: parsed.side };
  } catch {
    throw new Error("invalid_conversation_cursor");
  }
}

function mapConversationRow(row: Record<string, unknown>): SupabaseConversationItem {
  return {
    conversationId: String(row.source_conversation_id),
    side: row.message_side === "ai_response" ? "ai_response" : "message",
    direction: String(row.direction ?? "unknown"),
    messageType: String(row.message_type ?? "text"),
    body: String(row.body ?? ""),
    deliveryState: row.delivery_state == null ? null : String(row.delivery_state),
    providerMessageId: row.provider_message_id == null ? null : String(row.provider_message_id),
    occurredAt: new Date(String(row.occurred_at)).toISOString(),
  };
}

export function createSupabaseAvniReader(queryable: ReadonlyQueryable) {
  return {
    async readConversationPage(replitLeadId: string, cursor?: string, limit = 50) {
      const decoded = decodeConversationCursor(cursor);
      const boundedLimit = Math.max(1, Math.min(100, Math.trunc(limit) || 50));
      const { rows } = await queryable.query(
        `SELECT * FROM aichm_private.aichm_crm_conversations_for_replit_lead(
          $1::uuid,$2::timestamptz,$3::uuid,$4::text,$5::integer
        )`,
        [replitLeadId, decoded?.at ?? null, decoded?.conversationId ?? null, decoded?.side ?? null, boundedLimit + 1],
      );
      const hasMore = rows.length > boundedLimit;
      const descending = rows.slice(0, boundedLimit).map(mapConversationRow);
      const oldest = descending.at(-1);
      return {
        items: descending.reverse(),
        nextCursor: hasMore && oldest ? encodeCursor({
          at: oldest.occurredAt, conversationId: oldest.conversationId, side: oldest.side,
        }) : null,
      };
    },
    async preflightConversation(replitLeadId: string, expectedControlVersion: number) {
      const { rows } = await queryable.query(
        `SELECT * FROM aichm_private.preflight_conversation_for_replit_lead(
          $1::uuid,$2::bigint
        )`,
        [replitLeadId, expectedControlVersion],
      );
      if (rows.length !== 1) throw new Error("invalid_conversation_preflight_result");
      const parsed = conversationPreflightSchema.parse(rows[0]);
      const controlVersion = parsed.control_version === null
        ? null
        : Number(parsed.control_version);
      if (controlVersion !== null && !Number.isSafeInteger(controlVersion)) {
        throw new Error("invalid_conversation_preflight_result");
      }
      return {
        outcome: parsed.outcome,
        mode: parsed.mode,
        lifecycle: parsed.lifecycle,
        controlVersion,
      } satisfies SupabaseConversationPreflight;
    },
    async verifyConfirmation(
      replitLeadId: string,
      conversationId: string,
      expectedType: "booking_confirmation" | "booking_cancellation",
    ) {
      const { rows } = await queryable.query(
        `SELECT aichm_private.aichm_crm_verify_confirmation($1::uuid,$2::uuid,$3::text) AS verified`,
        [replitLeadId, conversationId, expectedType],
      );
      return rows[0]?.verified === true;
    },
    async readPilotOutboundStatus(idempotencyKey: string): Promise<SupabasePilotOutboundStatus | null> {
      if (!pilotOutboundStatusKeySchema.safeParse(idempotencyKey).success) {
        throw new Error("invalid_pilot_status_key");
      }
      const { rows } = await queryable.query(
        "SELECT * FROM aichm_private.find_human_pilot_outbound($1::text)",
        [idempotencyKey],
      );
      if (rows.length === 0) return null;
      if (rows.length !== 1) throw new Error("ambiguous_pilot_status_result");
      const parsed = pilotOutboundStatusRowSchema.parse(rows[0]);
      return {
        state: parsed.state,
        attemptNumber: Number(parsed.attempt_number),
      };
    },
  };
}

export async function readSupabaseConversationPage(
  replitLeadId: string,
  cursor?: string,
  limit = 50,
) {
  return createSupabaseAvniReader(getPool()).readConversationPage(replitLeadId, cursor, limit);
}

export async function readSupabaseConversationPreflight(
  replitLeadId: string,
  expectedControlVersion: number,
) {
  return createSupabaseAvniReader(getPool()).preflightConversation(
    replitLeadId,
    expectedControlVersion,
  );
}

export async function verifySupabaseAvniConfirmation(
  replitLeadId: string,
  conversationId: string,
  expectedType: "booking_confirmation" | "booking_cancellation",
) {
  return createSupabaseAvniReader(getPool()).verifyConfirmation(replitLeadId, conversationId, expectedType);
}

export async function readSupabasePilotOutboundStatus(idempotencyKey: string) {
  return createSupabaseAvniReader(getPool()).readPilotOutboundStatus(idempotencyKey);
}
