import assert from "node:assert/strict";
import test from "node:test";
import type { PoolConfig } from "pg";
import {
  AVNI_RUNTIME_WRITER_ENABLED_ENV,
  avniRuntimeWriterSafeStatus,
  buildAvniRuntimeWriterPoolConfig,
  initializeAvniRuntimeWriter,
  SUPABASE_AVNI_RUNTIME_DATABASE_URL_ENV,
} from "./avni-runtime-writer";
import {
  AVNI_PROVIDER_REFERENCE_HMAC_KEYRING_ENV,
  readAvniHmacKeyringConfig,
} from "./avni-provider-reference-hmac-config";
import type { AvniPilotSupabasePool, AvniPilotSupabaseReader, AvniPilotSupabaseWriterContract } from "./avni-pilot-supabase-writer";

const loginRole = "aichm_test_runtime_login";
const runtimeUrl = `postgresql://${loginRole}.xylqezjvqqqjozenuygh:synthetic-only@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres?sslmode=require`;
const syntheticKey = Buffer.alloc(32, 0x54).toString("base64");
const testCa = `-----BEGIN CERTIFICATE-----
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
const validKeyring = readAvniHmacKeyringConfig({
  [AVNI_PROVIDER_REFERENCE_HMAC_KEYRING_ENV]: JSON.stringify({
    activeKeyId: "synthetic-a",
    keys: [{ keyId: "synthetic-a", keyBase64: syntheticKey }],
  }),
});
const malformedKeyring = readAvniHmacKeyringConfig({
  [AVNI_PROVIDER_REFERENCE_HMAC_KEYRING_ENV]: "{not-json",
});

function environment(overrides: Record<string, string | undefined> = {}) {
  return {
    [AVNI_RUNTIME_WRITER_ENABLED_ENV]: "true",
    [SUPABASE_AVNI_RUNTIME_DATABASE_URL_ENV]: runtimeUrl,
    SUPABASE_DB_SSL_CA: "synthetic-ca",
    ...overrides,
  };
}

function fakeDependencies() {
  let poolsCreated = 0;
  let connectionsOpened = 0;
  let writerCreations = 0;
  let receivedConfig: PoolConfig | null = null;
  const pool: RuntimeTestPool = {
    async connect() {
      connectionsOpened++;
      return {
        async query() { return { rows: [] }; },
        release() {},
      };
    },
    async query() { return { rows: [] }; },
  };
  const writer = {} as AvniPilotSupabaseWriterContract;
  return {
    pool,
    writer,
    get poolsCreated() { return poolsCreated; },
    get connectionsOpened() { return connectionsOpened; },
    get writerCreations() { return writerCreations; },
    get receivedConfig() { return receivedConfig; },
    dependencies: {
      buildPoolConfig: (_environment: Record<string, string | undefined>, role: string) => {
        assert.equal(role, loginRole);
        return { application_name: "mock-only-runtime-writer" } as PoolConfig;
      },
      createPool: (config: PoolConfig) => {
        poolsCreated++;
        receivedConfig = config;
        return pool;
      },
      createWriter: (_pool: RuntimeTestPool, _reader: AvniPilotSupabaseReader) => {
        writerCreations++;
        return writer;
      },
    },
  };
}

type RuntimeTestPool = AvniPilotSupabasePool & AvniPilotSupabaseReader;

function initialize(
  env: Record<string, string | undefined>,
  options: {
    keyring?: typeof validKeyring;
    role?: string | null;
    rolePreflightPassed?: boolean;
    schemaPreflightPassed?: boolean;
    dependencies?: ReturnType<typeof fakeDependencies>["dependencies"];
  } = {},
) {
  return initializeAvniRuntimeWriter({
    environment: env,
    keyring: options.keyring ?? validKeyring,
    approvedRuntimeLoginRole: options.role === undefined ? loginRole : options.role,
    runtimeRolePreflightPassed: options.rolePreflightPassed ?? true,
    runtimeSchemaPreflightPassed: options.schemaPreflightPassed ?? true,
    dependencies: options.dependencies,
  });
}

test("runtime writer is disabled by default without building a pool or writer", () => {
  const mocks = fakeDependencies();
  const result = initialize(environment({ [AVNI_RUNTIME_WRITER_ENABLED_ENV]: undefined }), {
    dependencies: mocks.dependencies,
  });
  assert.equal(result.state, "disabled");
  assert.equal(result.writerAvailable, false);
  assert.equal(result.poolWired, false);
  assert.equal(mocks.poolsCreated, 0);
  assert.equal(mocks.writerCreations, 0);
  assert.equal(mocks.connectionsOpened, 0);
});

test("missing and malformed runtime URLs stay unavailable before pool creation", () => {
  const missingMocks = fakeDependencies();
  const missing = initialize(environment({
    [SUPABASE_AVNI_RUNTIME_DATABASE_URL_ENV]: undefined,
  }), { dependencies: missingMocks.dependencies });
  assert.equal(missing.state, "runtime_url_missing");
  assert.equal(missing.writerAvailable, false);
  assert.equal(missingMocks.poolsCreated, 0);

  const malformedMocks = fakeDependencies();
  const malformed = initialize(environment({
    [SUPABASE_AVNI_RUNTIME_DATABASE_URL_ENV]: "not-a-database-uri",
    SUPABASE_DB_SSL_CA: testCa,
  }), {
    dependencies: {
      ...malformedMocks.dependencies,
      buildPoolConfig: buildAvniRuntimeWriterPoolConfig,
    },
  });
  assert.equal(malformed.state, "runtime_configuration_invalid");
  assert.equal(malformed.writerAvailable, false);
  assert.equal(malformedMocks.poolsCreated, 0);
});

test("malformed HMAC key ring does not create or expose a writer", () => {
  const mocks = fakeDependencies();
  const result = initialize(environment(), {
    keyring: malformedKeyring,
    dependencies: mocks.dependencies,
  });
  assert.equal(result.state, "hmac_keyring_invalid");
  assert.equal(result.writerAvailable, false);
  assert.equal(mocks.poolsCreated, 0);
});

test("missing HMAC key ring blocks initialization", () => {
  const mocks = fakeDependencies();
  const missingKeyring = readAvniHmacKeyringConfig({});
  const result = initialize(environment(), {
    keyring: missingKeyring,
    dependencies: mocks.dependencies,
  });
  assert.equal(result.state, "hmac_keyring_missing");
  assert.equal(result.writerAvailable, false);
  assert.equal(mocks.poolsCreated, 0);
});

test("explicit opt-in wires the existing writer with mocked dependencies only", () => {
  const mocks = fakeDependencies();
  const result = initialize(environment(), { dependencies: mocks.dependencies });
  assert.equal(result.state, "ready");
  assert.equal(result.writerAvailable, true);
  assert.equal(result.poolWired, true);
  assert.equal(result.writer, mocks.writer);
  assert.equal(mocks.poolsCreated, 1);
  assert.equal(mocks.writerCreations, 1);
  assert.equal(mocks.connectionsOpened, 0);
});

test("runtime role must be separately verified and match the approved login", () => {
  const mocks = fakeDependencies();
  const unverified = initialize(environment(), {
    rolePreflightPassed: false,
    dependencies: mocks.dependencies,
  });
  assert.equal(unverified.state, "runtime_role_unverified");
  assert.equal(mocks.poolsCreated, 0);
  assert.throws(
    () => buildAvniRuntimeWriterPoolConfig(environment(), "aichm_other_login"),
    /AVNI_RUNTIME_DATABASE_CONFIGURATION_INVALID/,
  );
});

test("runtime writer remains unavailable until the runtime schema preflight is complete", () => {
  const mocks = fakeDependencies();
  const result = initialize(environment(), {
    schemaPreflightPassed: false,
    dependencies: mocks.dependencies,
  });
  assert.equal(result.state, "runtime_schema_unverified");
  assert.equal(result.writerAvailable, false);
  assert.equal(mocks.poolsCreated, 0);
});

test("runtime URL builder enforces project, host, login, path, port, and TLS without connecting", () => {
  const good = environment({ SUPABASE_DB_SSL_CA: testCa });
  const config = buildAvniRuntimeWriterPoolConfig(good, loginRole);
  assert.equal((config.ssl as { rejectUnauthorized?: boolean }).rejectUnauthorized, true);
  assert.equal((config.ssl as { minVersion?: string }).minVersion, "TLSv1.2");
  assert.equal(config.application_name, "aichm-avni-runtime-writer");
  assert.equal((config.connectionString as string).includes("sslmode"), false);
  const invalidUris = [
    runtimeUrl.replace("sslmode=require", "sslmode=disable"),
    runtimeUrl.replace("aws-0-ap-northeast-1.pooler.supabase.com", "evil.example"),
    runtimeUrl.replace(`${loginRole}.xylqezjvqqqjozenuygh`, "service_role.xylqezjvqqqjozenuygh"),
    runtimeUrl.replace("xylqezjvqqqjozenuygh", "otherprojectrefxx"),
    runtimeUrl.replace(":5432/postgres", ":5433/postgres"),
    runtimeUrl.replace("/postgres?", "/otherdb?"),
    `${runtimeUrl}&sslrootcert=attacker`,
  ];
  for (const uri of invalidUris) {
    assert.throws(
      () => buildAvniRuntimeWriterPoolConfig(
        { ...good, [SUPABASE_AVNI_RUNTIME_DATABASE_URL_ENV]: uri },
        loginRole,
      ),
      /AVNI_RUNTIME_DATABASE_CONFIGURATION_INVALID/,
    );
  }
});

test("runtime initialization states and serialized output never contain URL or key material", () => {
  const mocks = fakeDependencies();
  const result = initialize(environment(), { dependencies: mocks.dependencies });
  const serialized = JSON.stringify(avniRuntimeWriterSafeStatus(result));
  assert.equal(serialized.includes(runtimeUrl), false);
  assert.equal(serialized.includes(syntheticKey), false);
  assert.equal(serialized.includes("synthetic-only"), false);
});

test("missing CA and unapproved role preflight fail closed", () => {
  const mocks = fakeDependencies();
  const noCa = initialize(environment({ SUPABASE_DB_SSL_CA: undefined }), {
    dependencies: mocks.dependencies,
  });
  assert.equal(noCa.state, "runtime_ca_missing");
  const noRoleApproval = initialize(environment(), {
    role: null,
    dependencies: mocks.dependencies,
  });
  assert.equal(noRoleApproval.state, "runtime_role_unverified");
  assert.equal(mocks.poolsCreated, 0);

  const invalidCa = initialize(environment({ SUPABASE_DB_SSL_CA: "not-a-certificate" }), {
    dependencies: {
      ...mocks.dependencies,
      buildPoolConfig: buildAvniRuntimeWriterPoolConfig,
    },
  });
  assert.equal(invalidCa.state, "runtime_configuration_invalid");
  assert.equal(invalidCa.writerAvailable, false);
  assert.equal(mocks.poolsCreated, 0);
});
