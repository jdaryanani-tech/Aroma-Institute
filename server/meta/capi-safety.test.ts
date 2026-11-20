import test from "node:test";
import assert from "node:assert/strict";
import { META_CONSENT_POLICY_VERSION } from "./config";
import { enqueueMetaEvent } from "./events";
import { startMetaCapiWorker } from "./routes";
import { pool } from "../db";

type MockConsent = {
  consentStatus: string;
  policyVersion: string;
} | null;

function createOutboxTransaction(
  consent: MockConsent,
  returnedRows: Array<Array<{ eventId: string }>>,
) {
  const insertedValues: Array<Record<string, unknown>> = [];
  let conflictSafeInsertCount = 0;
  let returningCall = 0;
  const selection = {
    from() {
      return this;
    },
    where() {
      return this;
    },
    orderBy() {
      return this;
    },
    async limit() {
      return consent ? [consent] : [];
    },
  };

  const transaction = {
    select() {
      return selection;
    },
    insert() {
      return {
        values(value: Record<string, unknown>) {
          insertedValues.push(value);
          return {
            onConflictDoNothing() {
              conflictSafeInsertCount += 1;
              const rows = returnedRows[returningCall] ?? [];
              returningCall += 1;
              return { returning: async () => rows };
            },
          };
        },
      };
    },
  };

  return {
    transaction,
    insertedValues,
    get conflictSafeInsertCount() {
      return conflictSafeInsertCount;
    },
  };
}

test("CAPI worker does not schedule or dispatch when its production flag is off", () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousCapiFlag = process.env.META_CAPI_ENABLED;
  const fetchDescriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  const intervalDescriptor = Object.getOwnPropertyDescriptor(globalThis, "setInterval");
  const poolConnectDescriptor = Object.getOwnPropertyDescriptor(pool, "connect");
  let externalRequestCount = 0;
  let scheduledWorkerCount = 0;
  let databaseConnectCount = 0;

  try {
    process.env.NODE_ENV = "production";
    globalThis.fetch = (async () => {
      externalRequestCount += 1;
      throw new Error("Unexpected external request in disabled-path test");
    }) as typeof fetch;
    globalThis.setInterval = ((() => {
      scheduledWorkerCount += 1;
      return 1 as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval);
    Object.defineProperty(pool, "connect", {
      configurable: true,
      value: async () => {
        databaseConnectCount += 1;
        throw new Error("Unexpected database connection in disabled-path test");
      },
    });

    for (const flag of [undefined, "false"]) {
      if (flag === undefined) delete process.env.META_CAPI_ENABLED;
      else process.env.META_CAPI_ENABLED = flag;

      assert.equal(startMetaCapiWorker(), false);
    }

    assert.equal(scheduledWorkerCount, 0);
    assert.equal(externalRequestCount, 0);
    assert.equal(databaseConnectCount, 0);
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousCapiFlag === undefined) delete process.env.META_CAPI_ENABLED;
    else process.env.META_CAPI_ENABLED = previousCapiFlag;
    if (fetchDescriptor) Object.defineProperty(globalThis, "fetch", fetchDescriptor);
    if (intervalDescriptor) Object.defineProperty(globalThis, "setInterval", intervalDescriptor);
    if (poolConnectDescriptor) Object.defineProperty(pool, "connect", poolConnectDescriptor);
    else delete (pool as unknown as { connect?: unknown }).connect;
  }
});

test("CAPI enqueue remains blocked without current granted consent", async () => {
  const cases: MockConsent[] = [
    null,
    { consentStatus: "denied", policyVersion: META_CONSENT_POLICY_VERSION },
    { consentStatus: "granted", policyVersion: "older-policy" },
  ];

  for (const consent of cases) {
    const mock = createOutboxTransaction(consent, []);
    const eventId = await enqueueMetaEvent(mock.transaction as never, {
      visitorKeyHash: "synthetic-visitor-hash",
      eventName: "PageView",
      eventSourceUrl: "https://aromacafeinstitute.in/",
      eventId: "synthetic-event-id",
    });

    assert.equal(eventId, null);
    assert.equal(mock.insertedValues.length, 0);
  }
});

test("CAPI enqueue retains stable event idempotency on conflict", async () => {
  const mock = createOutboxTransaction(
    { consentStatus: "granted", policyVersion: META_CONSENT_POLICY_VERSION },
    [[{ eventId: "synthetic-stable-event-id" }], []],
  );
  const input = {
    visitorKeyHash: "synthetic-visitor-hash",
    eventName: "PageView" as const,
    eventSourceUrl: "https://aromacafeinstitute.in/",
    eventId: "synthetic-stable-event-id",
  };

  const first = await enqueueMetaEvent(mock.transaction as never, input);
  const replay = await enqueueMetaEvent(mock.transaction as never, input);

  assert.equal(first, "synthetic-stable-event-id");
  assert.equal(replay, "synthetic-stable-event-id");
  assert.deepEqual(
    mock.insertedValues.map((row) => row.eventId),
    ["synthetic-stable-event-id", "synthetic-stable-event-id"],
  );
  assert.equal(mock.conflictSafeInsertCount, 2);
});
