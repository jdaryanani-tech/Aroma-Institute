import { z } from "zod";

export type AvniPilotSupabaseClient = {
  query<T = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: T[] }>;
  release(): void;
};
export type AvniPilotSupabasePool = { connect(): Promise<AvniPilotSupabaseClient> };
export type AvniPilotSupabaseReader = {
  query<T = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: T[] }>;
};

const uuid = z.string().uuid();
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const idempotency = z.string().regex(/^message:v1:[0-9a-f]{64}$/);
const e164 = z.string().regex(/^\+[1-9][0-9]{7,14}$/);

export type PilotOutboxSnapshot = {
  outboxId: string;
  messageId: string;
  threadId: string;
  state: "pending" | "claimed" | "sending" | "accepted" | "delivered" | "failed" | "unknown" | "cancelled";
  controlVersion: number;
  attemptNumber: number;
};

export type PilotHumanClaim = {
  outboxId: string;
  messageId: string;
  threadId: string;
  attemptId: string;
  leaseToken: string;
  controlVersion: number;
  attemptNumber: number;
  leaseExpiresAt: string;
};

export type AvniPilotEnqueueResult =
  | { outcome: "queued" | "duplicate"; outboxId: string; messageId: string; threadId: string }
  | { outcome: "denied" | "unavailable" | "conflict"; outboxId: null; messageId: null; threadId: null };

function fail(code: string): never {
  throw new Error(code);
}

function exactlyOne<T>(rows: T[], code: string): T {
  if (rows.length !== 1) return fail(code);
  return rows[0];
}

function mapSnapshot(row: Record<string, unknown>): PilotOutboxSnapshot {
  const parsed = z.object({
    outbox_id: uuid,
    message_id: uuid,
    thread_id: uuid,
    state: z.enum(["pending", "claimed", "sending", "accepted", "delivered", "failed", "unknown", "cancelled"]),
    control_version: z.coerce.number().int().nonnegative().safe(),
    attempt_number: z.coerce.number().int().nonnegative().safe(),
  }).safeParse(row);
  if (!parsed.success) return fail("AVNI_PILOT_OUTBOX_RESPONSE_INVALID");
  return {
    outboxId: parsed.data.outbox_id,
    messageId: parsed.data.message_id,
    threadId: parsed.data.thread_id,
    state: parsed.data.state,
    controlVersion: parsed.data.control_version,
    attemptNumber: parsed.data.attempt_number,
  };
}

function mapClaim(row: Record<string, unknown>): PilotHumanClaim {
  const parsed = z.object({
    outbox_id: uuid,
    message_id: uuid,
    thread_id: uuid,
    attempt_id: uuid,
    lease_token: uuid,
    control_version: z.coerce.number().int().nonnegative().safe(),
    attempt_number: z.coerce.number().int().min(1).max(8),
    lease_expires_at: z.union([z.string().datetime({ offset: true }), z.date()]),
  }).safeParse(row);
  if (!parsed.success) return fail("AVNI_PILOT_CLAIM_RESPONSE_INVALID");
  return {
    outboxId: parsed.data.outbox_id,
    messageId: parsed.data.message_id,
    threadId: parsed.data.thread_id,
    attemptId: parsed.data.attempt_id,
    leaseToken: parsed.data.lease_token,
    controlVersion: parsed.data.control_version,
    attemptNumber: parsed.data.attempt_number,
    leaseExpiresAt: parsed.data.lease_expires_at instanceof Date
      ? parsed.data.lease_expires_at.toISOString()
      : parsed.data.lease_expires_at,
  };
}

/**
 * Fixed-RPC adapter for the server-only AVNI pilot path. It accepts an
 * injected writer pool rather than the read-only CRM pool; no URL or credential
 * is loaded here. The dedicated writer role must be provisioned and reviewed
 * before the adapter is wired into the application.
 */
export class AvniPilotSupabaseWriter {
  constructor(
    private readonly pool: AvniPilotSupabasePool,
    private readonly reader: AvniPilotSupabaseReader,
  ) {}

  private async call<T>(
    text: string,
    values: unknown[],
    map: (rows: Record<string, unknown>[]) => T,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      const result = await client.query<Record<string, unknown>>(text, values);
      return map(result.rows);
    } finally {
      client.release();
    }
  }

  async preflight(replitLeadId: string, expectedControlVersion: number) {
    if (!uuid.safeParse(replitLeadId).success
      || !Number.isSafeInteger(expectedControlVersion)
      || expectedControlVersion < 0) return {
      outcome: "invalid_request" as const,
      threadId: null,
      provider: null,
      mode: null,
      lifecycle: null,
      controlVersion: null,
    };
    const result = await this.reader.query<Record<string, unknown>>(
      "SELECT * FROM aichm_private.read_human_pilot_thread($1::uuid,$2::bigint)",
      [replitLeadId, expectedControlVersion],
    );
    return (() => {
        const rows = result.rows;
        const row = exactlyOne(rows, "AVNI_PILOT_PREFLIGHT_RESPONSE_INVALID");
        const parsed = z.object({
          outcome: z.enum([
            "preflight_ready", "invalid_request", "crosswalk_missing", "crosswalk_ambiguous",
            "conversation_missing", "conversation_ambiguous", "conversation_closed", "stale_control_version",
          ]),
          thread_id: uuid.nullable(),
          provider: z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/).nullable(),
          mode: z.enum(["ai", "human"]).nullable(),
          lifecycle: z.string().nullable(),
          control_version: z.coerce.number().int().nonnegative().safe().nullable(),
        }).safeParse(row);
        if (!parsed.success) return fail("AVNI_PILOT_PREFLIGHT_RESPONSE_INVALID");
        return {
          outcome: parsed.data.outcome,
          threadId: parsed.data.thread_id,
          provider: parsed.data.provider,
          mode: parsed.data.mode,
          lifecycle: parsed.data.lifecycle,
          controlVersion: parsed.data.control_version,
        };
      })();
  }

  async findByIdempotencyKey(key: string): Promise<PilotOutboxSnapshot | null> {
    if (!idempotency.safeParse(key).success) return fail("AVNI_PILOT_IDEMPOTENCY_INVALID");
    return this.call(
      "SELECT * FROM aichm_private.find_human_pilot_outbound($1::text)",
      [key],
      rows => rows.length === 0 ? null
        : rows.length === 1 ? mapSnapshot(rows[0])
          : fail("AVNI_PILOT_IDEMPOTENCY_AMBIGUOUS"),
    );
  }

  async enqueueHumanMessage(input: {
    threadId: string;
    expectedControlVersion: number;
    actorRef: `replit_lms_user:${number}`;
    idempotencyKey: string;
    messageFingerprint: string;
    text: string;
  }): Promise<AvniPilotEnqueueResult> {
    if (!uuid.safeParse(input.threadId).success
      || !Number.isSafeInteger(input.expectedControlVersion)
      || input.expectedControlVersion < 0
      || !/^replit_lms_user:[1-9][0-9]{0,9}$/.test(input.actorRef)
      || !idempotency.safeParse(input.idempotencyKey).success
      || !digest.safeParse(input.messageFingerprint).success
      || input.text.length < 1 || input.text.length > 1000) {
      return { outcome: "denied", outboxId: null, messageId: null, threadId: null };
    }
    return this.call(
      "SELECT * FROM aichm_private.enqueue_conversation_message($1::uuid,$2::bigint,'human_staff',$3::text,$4::text,$5::text,'text',$6::text,NULL)",
      [
        input.threadId,
        input.expectedControlVersion,
        input.actorRef,
        input.idempotencyKey,
        input.messageFingerprint,
        input.text,
      ],
      rows => {
        const row = exactlyOne(rows, "AVNI_PILOT_ENQUEUE_RESPONSE_INVALID");
        const parsed = z.object({
          outcome: z.enum([
            "queued", "duplicate", "denied", "unavailable", "conflict",
            "thread_not_found", "thread_mapping_unavailable", "conversation_closed",
            "version_conflict", "ownership_conflict",
          ]),
          outbox_id: uuid.nullable(),
          message_id: uuid.nullable(),
        }).safeParse(row);
        if (!parsed.success) return fail("AVNI_PILOT_ENQUEUE_RESPONSE_INVALID");
        if (parsed.data.outcome === "queued" || parsed.data.outcome === "duplicate") {
          if (!parsed.data.outbox_id || !parsed.data.message_id) {
            return fail("AVNI_PILOT_ENQUEUE_RESPONSE_INVALID");
          }
          return {
            outcome: parsed.data.outcome,
            outboxId: parsed.data.outbox_id,
            messageId: parsed.data.message_id,
            threadId: input.threadId,
          };
        }
        const outcome: "denied" | "unavailable" | "conflict" =
          parsed.data.outcome === "unavailable" ? "unavailable"
            : parsed.data.outcome === "version_conflict" || parsed.data.outcome === "ownership_conflict"
              ? "conflict" : "denied";
        return {
          outcome,
          outboxId: null,
          messageId: null,
          threadId: null,
        };
      },
    );
  }

  async claimHumanOutbox(outboxId: string, leaseSeconds = 30): Promise<PilotHumanClaim | null> {
    if (!uuid.safeParse(outboxId).success || !Number.isSafeInteger(leaseSeconds)
      || leaseSeconds < 5 || leaseSeconds > 60) return fail("AVNI_PILOT_CLAIM_INPUT_INVALID");
    return this.call(
      "SELECT * FROM aichm_private.claim_human_pilot_outbound($1::uuid,$2::integer)",
      [outboxId, leaseSeconds],
      rows => rows.length === 0 ? null
        : rows.length === 1 ? mapClaim(rows[0])
          : fail("AVNI_PILOT_CLAIM_RESPONSE_INVALID"),
    );
  }

  async beginHumanSend(input: {
    claim: PilotHumanClaim;
    expectedControlVersion: number;
    actorRef: `replit_lms_user:${number}`;
    payloadHash: string;
  }): Promise<"begun" | "denied" | "already_begun" | "unavailable"> {
    if (!Number.isSafeInteger(input.expectedControlVersion)
      || input.expectedControlVersion < 0
      || !/^replit_lms_user:[1-9][0-9]{0,9}$/.test(input.actorRef)
      || !digest.safeParse(input.payloadHash).success) return "denied";
    return this.call(
      "SELECT aichm_private.begin_human_pilot_send($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::bigint,$6::text,$7::text)",
      [
        input.claim.outboxId,
        input.claim.attemptId,
        input.claim.leaseToken,
        input.claim.threadId,
        input.expectedControlVersion,
        input.actorRef,
        input.payloadHash,
      ],
      rows => {
        const row = exactlyOne(rows, "AVNI_PILOT_BEGIN_RESPONSE_INVALID");
        return z.enum(["begun", "denied", "already_begun", "unavailable"])
          .parse(row.begin_human_pilot_send ?? row.outcome);
      },
    );
  }

  async recordResult(input: {
    claim: PilotHumanClaim;
    result: "sent" | "failed" | "unknown";
    providerReferenceAliases: string[];
  }): Promise<"sent" | "failed" | "unknown" | "lease_lost"> {
    if (!uuid.safeParse(input.claim.outboxId).success
      || !uuid.safeParse(input.claim.attemptId).success
      || !uuid.safeParse(input.claim.leaseToken).success
      || input.providerReferenceAliases.length > 16
      || input.providerReferenceAliases.some(token =>
        !/^hmac-sha256:v2:[a-z0-9][a-z0-9_-]{0,31}:[0-9a-f]{64}$/.test(token))) {
      return fail("AVNI_PILOT_RESULT_INPUT_INVALID");
    }
    return this.call(
      "SELECT aichm_private.record_human_pilot_send_result($1::uuid,$2::uuid,$3::uuid,$4::text,$5::text[]) AS outcome",
      [
        input.claim.outboxId,
        input.claim.attemptId,
        input.claim.leaseToken,
        input.result,
        input.providerReferenceAliases,
      ],
      rows => {
        const row = exactlyOne(rows, "AVNI_PILOT_RESULT_RESPONSE_INVALID");
        return z.enum(["sent", "failed", "unknown", "lease_lost"]).parse(row.outcome);
      },
    );
  }
}

export type AvniPilotSupabaseWriterContract = Pick<
  AvniPilotSupabaseWriter,
  "preflight" | "findByIdempotencyKey" | "enqueueHumanMessage" |
  "claimHumanOutbox" | "beginHumanSend" | "recordResult"
>;

export function validatePilotRecipient(input: string): boolean {
  return e164.safeParse(input).success;
}
