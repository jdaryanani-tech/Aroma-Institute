import assert from "node:assert/strict";
import { checkServerIdentity } from "node:tls";
import test from "node:test";
import {
  buildSupabaseAvniReadPoolConfig,
  createSupabaseAvniReader,
  decodeConversationCursor,
  isSupabaseAvniReadConfigured,
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
