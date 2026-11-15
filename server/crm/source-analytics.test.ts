import test from "node:test";
import assert from "node:assert/strict";
import express, { type RequestHandler } from "express";
import { createServer } from "node:http";
import { once } from "node:events";
import {
  buildCrmSourceAnalyticsQuery,
  classifyCrmEnquirySource,
  readCrmSourceAnalytics,
  summarizeCrmSourceAnalyticsFixture,
} from "./source-analytics";
import { registerCrmRoutes } from "./routes";

test("source attribution uses one deterministic direct-source bucket per enquiry", () => {
  assert.equal(classifyCrmEnquirySource({
    hasMetaLeadLink: true,
    submissionSource: "public_form",
  }), "meta_lead_ads");
  assert.equal(classifyCrmEnquirySource({ submissionSource: "meta_instant_form" }), "meta_lead_ads");
  assert.equal(classifyCrmEnquirySource({ submissionSource: "avni_whatsapp" }), "whatsapp");
  assert.equal(classifyCrmEnquirySource({ submissionSource: "public_form" }), "website");
  assert.equal(classifyCrmEnquirySource({ submissionSource: "website_counselling" }), "website");
  assert.equal(classifyCrmEnquirySource({ submissionSource: "manual" }), "manual");
  assert.equal(classifyCrmEnquirySource({ submissionSource: "partner_referral" }), "other");
  assert.equal(classifyCrmEnquirySource({ submissionSource: "unknown" }), "unknown");
  assert.equal(classifyCrmEnquirySource({
    inquiryTouchpointChannels: ["website_enquiry", "website_vsl"],
  }), "website");
  assert.equal(classifyCrmEnquirySource({
    inquiryTouchpointChannels: ["website_enquiry", "meta_instant_form"],
  }), "unknown");
  assert.equal(classifyCrmEnquirySource({}), "unknown");
});

test("aggregate fixture reconciles submissions, distinct people and unresolved records", () => {
  const result = summarizeCrmSourceAnalyticsFixture([
    { personKey: "person-1", identityStatus: "linked", source: "meta_lead_ads" },
    { personKey: "person-1", identityStatus: "linked", source: "website" },
    { personKey: "person-2", identityStatus: "unique_phone", source: "whatsapp" },
    { personKey: "unresolved-1", identityStatus: "ambiguous", source: "unknown" },
    { personKey: "unresolved-2", identityStatus: "unmatchable", source: "unknown" },
  ]);

  assert.equal(result.totalEnquiries, 5);
  assert.equal(result.sources.reduce((sum, row) => sum + row.enquiries, 0), result.totalEnquiries);
  assert.equal(result.identifiedPeople, 2);
  assert.equal(result.unresolvedRecords, 2);
  assert.equal(result.sources.find(row => row.source === "meta_lead_ads")?.identifiedPeople, 1);
  assert.equal(result.sources.find(row => row.source === "website")?.identifiedPeople, 1);
  assert.equal(result.sources.find(row => row.source === "whatsapp")?.identifiedPeople, 1);
  assert.equal(result.sources.find(row => row.source === "unknown")?.identifiedPeople, 0);
  assert.equal(result.duplicateSubmissions, null);
  assert.equal(result.duplicateTracking, "not_tracked");
});

test("duplicate attempts remain not tracked rather than being inferred from idempotency", async () => {
  const sourceSql = buildCrmSourceAnalyticsQuery({
    hasSubmissionSource: true,
    hasMetaLeadLinks: true,
    hasTouchpoints: true,
    crmModel: "WITH model AS (SELECT 1)",
  });
  assert.match(sourceSql, /submission_source/);
  assert.match(sourceSql, /admissions_meta_lead_links/);
  assert.match(sourceSql, /admissions_lead_touchpoints/);
  assert.match(sourceSql, /count\(DISTINCT person_key\)/);
  assert.match(sourceSql, /count\(\*\)::integer FROM attributed_enquiries/);

  const result = await readCrmSourceAnalytics({
    query: async (query: string) => {
      if (query.includes("AS identity")) {
        return { rows: [{
          identity: true, video: true, crm: true, assignments: true,
          attempts: true, marketing: true, calendar: true,
        }] };
      }
      if (query.includes("AS submission_source")) {
        return { rows: [{ submission_source: true, meta_lead_links: true }] };
      }
      return { rows: [{
        total_enquiries: 0,
        identified_people: 0,
        unresolved_records: 0,
        classified_enquiries: 0,
        sources: [
          { source: "meta_lead_ads", enquiries: 0, identifiedPeople: 0 },
          { source: "whatsapp", enquiries: 0, identifiedPeople: 0 },
          { source: "website", enquiries: 0, identifiedPeople: 0 },
          { source: "manual", enquiries: 0, identifiedPeople: 0 },
          { source: "other", enquiries: 0, identifiedPeople: 0 },
          { source: "unknown", enquiries: 0, identifiedPeople: 0 },
        ],
      }] };
    },
  }, () => new Date("2026-11-15T12:00:00.000Z"));
  assert.equal(result.duplicateSubmissions, null);
  assert.equal(result.duplicateTracking, "not_tracked");
  assert.match(result.duplicateExplanation, /attempts are not retained/);
});

test("admin source-analytics endpoint is protected and returns aggregates only", async (t) => {
  const aggregate = {
    total_enquiries: 4,
    identified_people: 2,
    unresolved_records: 1,
    classified_enquiries: 4,
    sources: [
      { source: "meta_lead_ads", enquiries: 1, identifiedPeople: 1 },
      { source: "whatsapp", enquiries: 1, identifiedPeople: 1 },
      { source: "website", enquiries: 1, identifiedPeople: 0 },
      { source: "manual", enquiries: 0, identifiedPeople: 0 },
      { source: "other", enquiries: 0, identifiedPeople: 0 },
      { source: "unknown", enquiries: 1, identifiedPeople: 0 },
    ],
  };
  const db = {
    query: async (query: string) => {
      if (query.includes("AS identity")) {
        return { rows: [{
          identity: true, video: true, crm: true, assignments: true,
          attempts: true, marketing: true, calendar: true,
        }] };
      }
      if (query.includes("AS submission_source")) {
        return { rows: [{ submission_source: true, meta_lead_links: true }] };
      }
      if (query.startsWith("INSERT INTO lms_audit_logs")) return { rows: [] };
      if (query.includes("classified_enquiries")) return { rows: [aggregate] };
      throw new Error("Unexpected test query.");
    },
  };
  const authenticate: RequestHandler = (req, _res, next) => {
    const role = req.header("x-test-role");
    if (role) req.lmsUser = {
      id: role === "admin" ? 1 : 2,
      roles: [role],
    };
    next();
  };
  const app = express();
  registerCrmRoutes(app, { db, connectionPool: db, authenticate });
  const server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const endpoint = `http://127.0.0.1:${address.port}/api/admin/crm/source-analytics`;

  const anonymous = await fetch(endpoint);
  assert.equal(anonymous.status, 401);
  const admissions = await fetch(endpoint, { headers: { "x-test-role": "admissions" } });
  assert.equal(admissions.status, 403);
  const response = await fetch(endpoint, { headers: { "x-test-role": "admin" } });
  assert.equal(response.status, 200);
  const body = await response.json() as Record<string, unknown>;
  assert.equal(body.totalEnquiries, 4);
  assert.equal(body.identifiedPeople, 2);
  assert.equal(body.unresolvedRecords, 1);
  assert.equal(typeof body.lastUpdatedAt, "string");
  assert.ok(Number.isFinite(Date.parse(body.lastUpdatedAt as string)));
  assert.deepEqual(Object.keys(body).sort(), [
    "attributionMethod",
    "duplicateExplanation",
    "duplicateSubmissions",
    "duplicateTracking",
    "identifiedPeople",
    "lastUpdatedAt",
    "sources",
    "totalEnquiries",
    "unresolvedRecords",
  ].sort());
  assert.doesNotMatch(JSON.stringify(body), /name|phone|email|message|payload|leadId|metaLeadId|token/i);
});

test("aggregate SQL returns a bounded bucket projection and handles absent optional attribution tables", () => {
  const query = buildCrmSourceAnalyticsQuery({
    hasSubmissionSource: false,
    hasMetaLeadLinks: false,
    hasTouchpoints: false,
    crmModel: "WITH model AS (SELECT 1)",
  });
  assert.match(query, /SELECT count\(\*\)::integer FROM inquiries/);
  assert.match(query, /count\(DISTINCT person_key\)/);
  assert.match(query, /ARRAY\[\]::text\[\]/);
  assert.match(query, /FROM source_buckets b/);
  assert.doesNotMatch(query.slice(query.lastIndexOf("SELECT\n")), /SELECT \*|i\.name|i\.email|i\.phone/i);
});
