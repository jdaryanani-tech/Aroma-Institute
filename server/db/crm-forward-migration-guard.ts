export type CrmForwardDatabaseIdentity = {
  databaseName: string;
  databaseOid: string;
  databaseUser: string;
  systemIdentifier: string;
  inRecovery: boolean;
  defaultTransactionReadOnly: boolean;
};

export type CrmForwardEnvironment = Record<string, string | undefined>;

export const CRM_FORWARD_DEVELOPMENT_IDENTITY = Object.freeze({
  databaseName: "heliumdb",
  databaseOid: "16384",
  databaseUser: "postgres",
  systemIdentifier: "7609038573599248406",
});

const KNOWN_PRODUCTION_IDENTITY = Object.freeze({
  databaseName: "neondb",
  databaseOid: "16395",
  databaseUser: "neondb_owner",
});

function fail(code: string): never {
  throw new Error(code);
}

export function requireCrmForwardConnectionUrl(
  environment: CrmForwardEnvironment = process.env,
): string {
  // URL shape is not target authorization; the runner must still verify the
  // pinned server/database identity in a read-only transaction before writes.
  const raw = environment.AICHM_CRM_FORWARD_DATABASE_URL;
  if (!raw || raw.trim() !== raw || /[\r\n]/.test(raw)) {
    fail("CRM_FORWARD_EXPLICIT_DEVELOPMENT_URL_REQUIRED");
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return fail("CRM_FORWARD_CONNECTION_URL_INVALID");
  }

  let database: string;
  let user: string;
  try {
    database = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
    user = decodeURIComponent(url.username);
  } catch {
    return fail("CRM_FORWARD_CONNECTION_URL_INVALID");
  }

  const queryEntries = Array.from(url.searchParams.entries());
  const allowedQuery =
    queryEntries.filter(([key]) => key === "sslmode").length <= 1 &&
    queryEntries.every(
      ([key, value]) => key === "sslmode" && ["require", "verify-full"].includes(value),
    );
  if (
    url.protocol !== "postgresql:" ||
    !url.hostname ||
    !url.port ||
    !/^[1-9]\d{0,4}$/.test(url.port) ||
    Number(url.port) > 65535 ||
    user !== "postgres" ||
    database !== CRM_FORWARD_DEVELOPMENT_IDENTITY.databaseName ||
    url.hash ||
    !allowedQuery
  ) {
    fail("CRM_FORWARD_CONNECTION_URL_REJECTED");
  }

  return raw;
}

export function assertCrmForwardDevelopmentIdentity(
  identity: CrmForwardDatabaseIdentity,
): void {
  if (
    identity.databaseName === KNOWN_PRODUCTION_IDENTITY.databaseName &&
    identity.databaseOid === KNOWN_PRODUCTION_IDENTITY.databaseOid &&
    identity.databaseUser === KNOWN_PRODUCTION_IDENTITY.databaseUser
  ) {
    fail("CRM_FORWARD_PRODUCTION_IDENTITY_REJECTED");
  }

  const expected = CRM_FORWARD_DEVELOPMENT_IDENTITY;
  if (
    identity.databaseName !== expected.databaseName ||
    identity.databaseOid !== expected.databaseOid ||
    identity.databaseUser !== expected.databaseUser ||
    identity.systemIdentifier !== expected.systemIdentifier ||
    identity.inRecovery ||
    identity.defaultTransactionReadOnly
  ) {
    fail("CRM_FORWARD_DEVELOPMENT_IDENTITY_MISMATCH");
  }
}
