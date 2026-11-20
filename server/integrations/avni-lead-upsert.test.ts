import assert from "node:assert/strict";
import { once } from "node:events";
import express, { type RequestHandler } from "express";
import { createServer } from "node:http";
import test, { mock } from "node:test";
import {
  avniIntegrationAuth,
  N8N_VSL_SECRET_ENV,
  registerAvniLeadUpsertRoute,
  verifyAvniIntegrationSecret,
} from "./avni";
import { N8N_INTEGRATION_SECRET_HEADER } from "./n8n-auth";
import { saveMetaInstantLead, type AdmissionsDatabase } from "../admissions/identity";
import { db } from "../db";

const ROUTE = "/api/integrations/n8n/leads/upsert";
const SYNTHETIC_CREDENTIAL = "test-only-avni-integration-credential";
const LEAD_ID = "20000000-0000-4000-8000-000000000001";

type RouteOptions = {
  authenticate?: RequestHandler;
  schemaReady?: () => Promise<boolean>;
  upsertLead?: (input: {
    phone: string;
    name: string;
    source?: string;
    programInterest?: string;
  }) => Promise<{
    lead: { id: string; [key: string]: unknown };
    inquiryId: number | null;
    inquiryCreated: boolean;
    canonicalPhone: string;
  }>;
};

async function postLeadUpsert(
  options: RouteOptions,
  body: unknown,
  credential?: string,
) {
  const app = express();
  app.use(express.json());
  const calls = { schema: 0, upsert: 0, journey: 0, crm: 0 };
  const authenticatedTestMiddleware: RequestHandler = (req, res, next) => {
    if (!verifyAvniIntegrationSecret(req.get(N8N_INTEGRATION_SECRET_HEADER) ?? "", SYNTHETIC_CREDENTIAL)) {
      return void res.status(401).json({ message: "Integration authentication required." });
    }
    return next();
  };
  const lead = { id: LEAD_ID, canonicalPhone: "919000000001", name: "Synthetic lead" };
  registerAvniLeadUpsertRoute(app, {
    authenticate: options.authenticate ?? authenticatedTestMiddleware,
    schemaReady: options.schemaReady ?? (async () => {
      calls.schema++;
      return true;
    }),
    upsertLead: (async input => {
      calls.upsert++;
      if (options.upsertLead) return options.upsertLead(input);
      return {
        lead,
        inquiryId: 81,
        inquiryCreated: true,
        canonicalPhone: "919000000001",
      };
    }) as never,
    readLeadJourney: async () => {
      calls.journey++;
      return null;
    },
    readCrmFollowUpState: async () => {
      calls.crm++;
      return {
        stage: "new",
        expectedVersion: 1,
        followUpAt: null,
        followUpDue: false,
      };
    },
  });

  const server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}${ROUTE}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(credential === undefined ? {} : { [N8N_INTEGRATION_SECRET_HEADER]: credential }),
      },
      body: JSON.stringify(body),
    });
    return { response, calls };
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((resolve, reject) =>
      server.close(error => error ? reject(error) : resolve()));
  }
}

const validRequest = {
  phone: "+91 90000 00001",
  name: "Synthetic lead",
};

test("lead-upsert route rejects a missing or invalid integration credential before CRM work", async () => {
  const previousCredential = process.env[N8N_VSL_SECRET_ENV];
  process.env[N8N_VSL_SECRET_ENV] = SYNTHETIC_CREDENTIAL;
  const rateLimitDbGuard = mock.method(db, "insert", () => {
    throw new Error("Database access is disabled in this route test.");
  });
  try {
    for (const credential of [undefined, "wrong-test-credential"]) {
      const { response, calls } = await postLeadUpsert({
        authenticate: avniIntegrationAuth,
      }, validRequest, credential);
      assert.equal(response.status, 401);
      assert.equal((await response.json()).message, "Integration authentication required.");
      assert.deepEqual(calls, { schema: 0, upsert: 0, journey: 0, crm: 0 });
    }
  } finally {
    rateLimitDbGuard.mock.restore();
    if (previousCredential === undefined) delete process.env[N8N_VSL_SECRET_ENV];
    else process.env[N8N_VSL_SECRET_ENV] = previousCredential;
  }
});

test("lead-upsert route rejects malformed input before schema checks or persistence", async () => {
  const invalidRequests = [
    { phone: "not-a-mobile", name: "Synthetic lead" },
    { phone: "+919000000001", name: "x" },
    { phone: "+919000000001", name: "Synthetic lead", unexpected: "field" },
  ];
  for (const body of invalidRequests) {
    const { response, calls } = await postLeadUpsert({}, body, SYNTHETIC_CREDENTIAL);
    assert.equal(response.status, 400);
    assert.deepEqual(calls, { schema: 0, upsert: 0, journey: 0, crm: 0 });
  }
});

test("lead-upsert route returns 200 when the canonical upsert reuses its existing inquiry", async () => {
  const upsertCalls: Array<Record<string, unknown>> = [];
  const { response, calls } = await postLeadUpsert({
    upsertLead: async input => {
      upsertCalls.push(input);
      return {
        lead: { id: LEAD_ID, canonicalPhone: "919000000001", name: "Synthetic lead" },
        inquiryId: 81,
        inquiryCreated: false,
        canonicalPhone: "919000000001",
      };
    },
  }, validRequest, SYNTHETIC_CREDENTIAL);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    leadId: LEAD_ID,
    inquiryId: 81,
    inquiryCreated: false,
    crm: { stage: "new", expectedVersion: 1, followUpAt: null, followUpDue: false },
    registeredAt: null,
    video: null,
    questionnaire: null,
  });
  assert.equal(upsertCalls.length, 1);
  assert.equal(upsertCalls[0].source, "avni_whatsapp");
  assert.equal(upsertCalls[0].programInterest, "Professional Barista Executive Program");
  assert.deepEqual(calls, { schema: 1, upsert: 1, journey: 1, crm: 1 });
});

test("existing Meta lead ID returns the prior link without inserting a second inquiry or link", async () => {
  let insertCalls = 0;
  const existingLink = { inquiryId: 82, leadId: LEAD_ID };
  const transaction = {
    execute: async () => undefined,
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [existingLink],
        }),
      }),
    }),
    insert: () => {
      insertCalls++;
      throw new Error("duplicate Meta submission attempted an insert");
    },
  };
  const mockedDatabase = {
    transaction: async (callback: (tx: typeof transaction) => unknown) => callback(transaction),
  } as unknown as AdmissionsDatabase;

  const result = await saveMetaInstantLead({
    metaLeadId: "synthetic-meta-lead-id",
    pageId: "synthetic-page-id",
    formId: null,
    campaignId: null,
    adId: null,
    adsetId: null,
    leadCreatedAt: null,
    fieldData: [],
  }, new Date("2026-11-20T00:00:00Z"), mockedDatabase);

  assert.deepEqual(result, { duplicate: true, inquiryId: 82, leadId: LEAD_ID });
  assert.equal(insertCalls, 0);
});

test("lead-upsert persistence failure returns a generic response without error details", async () => {
  const sentinel = "SYNTHETIC_DATABASE_FAILURE_DETAIL";
  const { response, calls } = await postLeadUpsert({
    upsertLead: async () => {
      throw new Error(sentinel);
    },
  }, validRequest, SYNTHETIC_CREDENTIAL);

  const body = await response.text();
  assert.equal(response.status, 503);
  assert.equal(body, JSON.stringify({ message: "Lead could not be saved." }));
  assert.equal(body.includes(sentinel), false);
  assert.deepEqual(calls, { schema: 1, upsert: 1, journey: 0, crm: 0 });
});
