import { checkServerIdentity, type ConnectionOptions } from "node:tls";
import { Pool, type PoolConfig } from "pg";
import { z } from "zod";
import { normalizeSupabaseCaCertificate } from "./supabase-migration";

const PROJECT_REF = "xylqezjvqqqjozenuygh";
const POOLER_HOST = "aws-0-ap-northeast-1.pooler.supabase.com";
const URI_SECRET = "SUPABASE_AVNI_READONLY_DATABASE_URL";
const CA_SECRET = "SUPABASE_DB_SSL_CA";

export type SupabaseAvniReadEnvironment = Record<string, string | undefined>;
type QueryResult = { rows: Record<string, unknown>[] };
export type ReadonlyQueryable = {
  query(text: string, values?: unknown[]): Promise<QueryResult>;
};
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

const cursorSchema = z.object({
  at: z.string().datetime({ offset: true }),
  conversationId: z.string().uuid(),
  side: z.enum(["message", "ai_response"]),
}).strict();

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
    || url.hostname.toLowerCase() !== POOLER_HOST || url.port !== "5432" || url.pathname !== "/postgres") {
    throw new Error(`${URI_SECRET} must use the approved Supavisor host, port, and database.`);
  }
  let username = "";
  try {
    username = decodeURIComponent(url.username);
  } catch {
    throw new Error(`${URI_SECRET} has invalid username encoding.`);
  }
  if (username !== `aichm_crm_reader.${PROJECT_REF}` || !url.password) {
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
  };
}

export async function readSupabaseConversationPage(
  replitLeadId: string,
  cursor?: string,
  limit = 50,
) {
  return createSupabaseAvniReader(getPool()).readConversationPage(replitLeadId, cursor, limit);
}

export async function verifySupabaseAvniConfirmation(
  replitLeadId: string,
  conversationId: string,
  expectedType: "booking_confirmation" | "booking_cancellation",
) {
  return createSupabaseAvniReader(getPool()).verifyConfirmation(replitLeadId, conversationId, expectedType);
}
