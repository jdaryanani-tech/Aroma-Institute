import assert from "node:assert/strict";
import { checkServerIdentity } from "node:tls";
import test from "node:test";
import {
  buildSupabaseAvniReadPoolConfig,
  createSupabaseAvniReader,
  decodeConversationCursor,
  isSupabaseAvniReadConfigured,
  runSupabaseAvniReadDiagnostics,
  type SupabaseAvniDiagnosticConnector,
  type SupabaseAvniDiagnosticSession,
} from "./supabase-avni-readonly";

const CA = `-----BEGIN CERTIFICATE-----
MIIDJTCCAg2gAwIBAgIUFfudmdrK9wmI/y55NQlEzt4nbN4wDQYJKoZIhvcNAQEL
BQAwIjEgMB4GA1UEAwwXQUlDSE0gbWlncmF0aW9uIHRlc3QgQ0EwHhcNMjYxMTA2
MDYwMDMwWhcNMzYxMTAzMDYwMDMwWjAiMSAwHgYDVQQDDBdBSUNITSBtaWdyYXRp
b24gdGVzdCBDQTCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBAKWNPCud
fu3uexBhIRYCtgYi8tm5zdKRZc6aZ7LRnW1Wb5ehvXwIXctLWX0fgYvIA3X1HnPw
gdlSAcgcr1euvCDGU3g1x8//gDnNThD+BsjQuZgCDPNL8Pi5P+D5rmNghbvXC1aj
UnIQqTLJBiWqUaEH3eTSSLAw9jQbsmoWQCAhA0iRQysS3k7selhYxF7Msy9NB75d
n16DEs4S0CsfAsqiBJjOnpatTUiHTmuXbjXTFyAudRsratI/ohYSSN9CWhicm49e
iVXEqrXiia0jUQtLRR64saAGwNiHhBNLQ8LwYY0QTVKzjGliQzrnR+1UAJ2VcdDF
1igDobjCWxsmcYECAwEAAaNTMFEwHQYDVR0OBBYEFJwgtYOkGuJ+FlN7i2ROcVvv
PmtVMB8GA1UdIwQYMBaAFJwgtYOkGuJ+FlN7i2ROcVvvPmtVMA8GA1UdEwEB/wQF
MAMBAf8wDQYJKoZIhvcNAQELBQADggEBADi+lZFh5w0FJJaCitdQRQwjbVZ4Dcrh
JBsG9mPSIrBWbP5XVozBRkO43Eos9HV4Tfd/bY5P2CQs6LLVBhdMcXzTnCnyycO6
QoL++2BlKfWG29xrrvLZKxZxt5dUjXF2RXqhKJoguR+91p2TR+tVtyMzFu1sUP4V
NutqNkyYKIu2gAivT5ihSrQak5VzMh+7+8T17GMNjgpD4COI8dsMiaq34ZF6Mrpo
EpVrSxW3ixsN1ZD5Cyf6mTrhODxmfPo5+Fgf4+zZFi5hw1yFyE8tkd3PTBfenr3h
79RZVFW4DdULgp9i0Pk2r4k7jqsaxuDiKGukpesKcYPJNnwjpgAkJ1E=
-----END CERTIFICATE-----`;
const URI = "postgresql://aichm_crm_reader.xylqezjvqqqjozenuygh:placeholder@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres?sslmode=require";

function config(overrides: { uri?: string; ca?: string } = {}) {
  return buildSupabaseAvniReadPoolConfig({
    SUPABASE_AVNI_READONLY_DATABASE_URL: overrides.uri ?? URI,
    SUPABASE_DB_SSL_CA: overrides.ca ?? CA,
  });
}

test("read-only CRM connection rejects missing URL or CA and invalid role/project targets", () => {
  assert.throws(() => buildSupabaseAvniReadPoolConfig({ SUPABASE_DB_SSL_CA: CA }), /SUPABASE_AVNI_READONLY_DATABASE_URL is required/);
  assert.throws(() => buildSupabaseAvniReadPoolConfig({ SUPABASE_AVNI_READONLY_DATABASE_URL: URI }), /SUPABASE_DB_SSL_CA is required/);
  assert.throws(() => config({ uri: URI.replace("aichm_crm_reader.", "postgres.") }), /dedicated read-only CRM role/);
  assert.throws(() => config({ uri: URI.replace("sslmode=require", "sslmode=disable") }), /sslmode=require/);
  assert.throws(() => config({ uri: URI.replace("aws-0-ap-northeast-1", "wrong-host") }), /approved Supavisor host/);
  assert.throws(() => config({ ca: "not a PEM" }), /PEM-encoded certificate/);
});

test("reader readiness validates the dedicated URI and CA shape without connecting", () => {
  assert.equal(isSupabaseAvniReadConfigured({
    SUPABASE_AVNI_READONLY_DATABASE_URL: URI,
    SUPABASE_DB_SSL_CA: CA,
  }), true);
  assert.equal(isSupabaseAvniReadConfigured({
    SUPABASE_AVNI_READONLY_DATABASE_URL: URI,
    SUPABASE_DB_SSL_CA: "invalid",
  }), false);
  assert.equal(isSupabaseAvniReadConfigured({ NODE_ENV: "test", SUPABASE_AVNI_READONLY_DATABASE_URL: URI, SUPABASE_DB_SSL_CA: CA }), false);
});

test("CRM reader pool strips only URI sslmode and enforces strict TLS plus read-only sessions", () => {
  const pool = config();
  assert.equal(pool.connectionString?.includes("sslmode"), false);
  assert.equal(pool.options, "-c default_transaction_read_only=on -c timezone=UTC");
  assert.equal(pool.application_name, "aichm-crm-supabase-readonly");
  assert.ok(pool.ssl && typeof pool.ssl === "object");
  if (!pool.ssl || typeof pool.ssl !== "object") return;
  assert.equal(pool.ssl.rejectUnauthorized, true);
  assert.equal(pool.ssl.checkServerIdentity, checkServerIdentity);
  assert.equal(pool.ssl.minVersion, "TLSv1.2");
  assert.equal(pool.ssl.ca, CA);
  assert.equal(Reflect.set(pool.ssl, "rejectUnauthorized", false), false);
});

test("history reader uses only the bounded Supabase RPC and keyset pagination", async () => {
  const seen: Array<{ text: string; values?: unknown[] }> = [];
  const fake = {
    async query(text: string, values?: unknown[]) {
      seen.push({ text, values });
      return { rows: [
        { source_conversation_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", message_side: "message", direction: "inbound", message_type: "text", body: "hello", delivery_state: "received", provider_message_id: "p1", occurred_at: "2026-11-07T10:00:00.000Z" },
        { source_conversation_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", message_side: "ai_response", direction: "outbound", message_type: "text", body: "welcome", delivery_state: "sent", provider_message_id: "p2", occurred_at: "2026-11-07T10:00:00.000Z" },
      ] };
    },
  };
  const reader = createSupabaseAvniReader(fake);
  const page = await reader.readConversationPage("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", undefined, 1);
  assert.match(seen[0].text, /aichm_crm_conversations_for_replit_lead/);
  assert.equal(seen[0].values?.[0], "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
  assert.equal(seen[0].values?.[4], 2);
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].side, "message");
  assert.ok(page.nextCursor);
  const cursor = decodeConversationCursor(page.nextCursor!);
  assert.equal(cursor?.side, "message");
  assert.equal((await reader.readConversationPage("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", page.nextCursor!, 10)).items.length, 2);
});

test("conversation preflight reader calls only the exact server RPC and validates its safe result", async () => {
  const seen: Array<{ text: string; values?: unknown[] }> = [];
  const reader = createSupabaseAvniReader({
    async query(text, values) {
      seen.push({ text, values });
      return { rows: [{
        outcome: "preflight_ready",
        thread_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        mode: "ai",
        lifecycle: "open",
        control_version: "9",
      }] };
    },
  });
  const result = await reader.preflightConversation(
    "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    9,
  );
  assert.match(seen[0].text, /preflight_conversation_for_replit_lead/);
  assert.deepEqual(seen[0].values, [
    "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    9,
  ]);
  assert.deepEqual(result, {
    outcome: "preflight_ready",
    mode: "ai",
    lifecycle: "open",
    controlVersion: 9,
  });

  const malformed = createSupabaseAvniReader({
    async query() {
      return { rows: [{
        outcome: "preflight_ready",
        thread_id: "not-a-uuid",
        mode: "ai",
        lifecycle: "open",
        control_version: "9",
        lead_phone: "must-not-be-accepted",
      }] };
    },
  });
  await assert.rejects(
    malformed.preflightConversation("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", 9),
    /Unrecognized key/,
  );
});

test("booking confirmation verification sends stable lead UUID and external Supabase message ID only", async () => {
  const calls: unknown[][] = [];
  const reader = createSupabaseAvniReader({
    async query(_text, values) {
      calls.push(values ?? []);
      return { rows: [{ verified: true }] };
    },
  });
  assert.equal(await reader.verifyConfirmation(
    "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "booking_confirmation",
  ), true);
  assert.deepEqual(calls[0], [
    "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "booking_confirmation",
  ]);
});

test("invalid history cursors are rejected", () => {
  assert.throws(() => decodeConversationCursor("not-a-cursor"), /invalid_conversation_cursor/);
  assert.throws(() => decodeConversationCursor(Buffer.from(JSON.stringify({
    at: "2026-11-07T10:00:00.000Z", conversationId: "bad", side: "message",
  })).toString("base64url")), /invalid_conversation_cursor/);
});

function diagnosticConnector(options: {
  tls?: SupabaseAvniDiagnosticSession["tls"];
  conversationError?: boolean;
  confirmationError?: boolean;
  publicSelectAllowed?: boolean;
  identity?: { database_name: string; role_name: string; read_only: string };
} = {}): SupabaseAvniDiagnosticConnector {
  return async () => ({
    tls: options.tls ?? {
      encrypted: true,
      authorized: true,
      authorizationErrorPresent: false,
      servername: "aws-0-ap-northeast-1.pooler.supabase.com",
    },
    async query(text, values) {
      if (text.includes("current_database()")) {
        return { rows: [options.identity ?? {
          database_name: "postgres",
          role_name: "aichm_crm_reader",
          read_only: "on",
        }] };
      }
      if (text.includes("aichm_crm_conversations_for_replit_lead")) {
        assert.match(String(values?.[0]), /^[0-9a-f-]{36}$/i);
        if (options.conversationError) throw new Error("test-only failure");
        return { rows: [{ message_count: 0 }] };
      }
      if (text.includes("aichm_crm_verify_confirmation")) {
        assert.match(String(values?.[0]), /^[0-9a-f-]{36}$/i);
        assert.match(String(values?.[1]), /^[0-9a-f-]{36}$/i);
        if (options.confirmationError) throw new Error("test-only failure");
        return { rows: [{ verified: false }] };
      }
      if (text.includes("has_table_privilege")) {
        const allowed = options.publicSelectAllowed ?? false;
        return { rows: [{ leads_select: allowed, conversations_select: allowed }] };
      }
      throw new Error("unexpected diagnostic query");
    },
    async close() {},
  });
}

test("read-only diagnostics pass strict TLS, synthetic RPC, role and privilege checks", async () => {
  const checks = await runSupabaseAvniReadDiagnostics({
    SUPABASE_AVNI_READONLY_DATABASE_URL: URI,
    SUPABASE_DB_SSL_CA: CA,
  }, diagnosticConnector());
  assert.ok(Object.values(checks).every((value) => value === true));
});

test("read-only diagnostics fail closed when URL or CA is missing or invalid", async () => {
  const unusedConnector = async () => {
    throw new Error("connector must not be called for invalid configuration");
  };
  const noUri = await runSupabaseAvniReadDiagnostics({ SUPABASE_DB_SSL_CA: CA }, unusedConnector);
  assert.equal(noUri.readerUrlPresent, false);
  assert.equal(noUri.readerUrlValid, false);

  const noCa = await runSupabaseAvniReadDiagnostics({ SUPABASE_AVNI_READONLY_DATABASE_URL: URI }, unusedConnector);
  assert.equal(noCa.readerCaPresent, false);
  assert.equal(noCa.readerCaAccepted, false);

  const invalidCa = await runSupabaseAvniReadDiagnostics({
    SUPABASE_AVNI_READONLY_DATABASE_URL: URI,
    SUPABASE_DB_SSL_CA: "not a certificate",
  }, unusedConnector);
  assert.equal(invalidCa.readerCaPresent, true);
  assert.equal(invalidCa.readerCaAccepted, false);
});

test("read-only diagnostics fail TLS verification without exposing connection errors", async () => {
  const checks = await runSupabaseAvniReadDiagnostics({
    SUPABASE_AVNI_READONLY_DATABASE_URL: URI,
    SUPABASE_DB_SSL_CA: CA,
  }, diagnosticConnector({
    tls: {
      encrypted: true,
      authorized: false,
      authorizationErrorPresent: true,
      servername: "wrong.example",
    },
  }));
  assert.equal(checks.tlsConnected, true);
  assert.equal(checks.tlsChainVerified, false);
  assert.equal(checks.tlsHostnameVerified, false);
});

test("read-only diagnostics fail private-function checks without returning driver details", async () => {
  const checks = await runSupabaseAvniReadDiagnostics({
    SUPABASE_AVNI_READONLY_DATABASE_URL: URI,
    SUPABASE_DB_SSL_CA: CA,
  }, diagnosticConnector({ conversationError: true, confirmationError: true }));
  assert.equal(checks.conversationsRpcExecutes, false);
  assert.equal(checks.confirmationRpcExecutes, false);
  assert.equal(checks.syntheticConversationIsEmpty, false);
  assert.equal(checks.syntheticConfirmationIsFalse, false);
});

test("read-only diagnostics fail when either public table grants direct SELECT", async () => {
  const checks = await runSupabaseAvniReadDiagnostics({
    SUPABASE_AVNI_READONLY_DATABASE_URL: URI,
    SUPABASE_DB_SSL_CA: CA,
  }, diagnosticConnector({ publicSelectAllowed: true }));
  assert.equal(checks.publicLeadsSelectDenied, false);
  assert.equal(checks.publicConversationsSelectDenied, false);
});
