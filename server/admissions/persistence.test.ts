import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import express from "express";
import session from "express-session";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import * as siteSchema from "../../shared/schema";
import * as lmsSchema from "../../shared/lms-schema";

const approved = process.env.NODE_ENV === "test" &&
  process.env.ADMISSIONS_TEST_DB_WRITE_APPROVED === "TEMPORARY_DEVELOPMENT_SCHEMA_ONLY";

test("isolated PostgreSQL: identity, legacy safety, questionnaire linkage, event API ownership/idempotency and rate limits", {
  skip: approved ? false : "Opt in to a disposable development-only schema; no normal tables are written.",
}, async () => {
  const [{ pool }, { registerVslLead, saveLinkedCounsellingInquiry }, { registerAdmissionsRoutes }] = await Promise.all([
    import("../db"), import("./identity"), import("./routes"),
  ]);
  const client = await pool.connect();
  const namespace = `admissions_test_${randomUUID().replaceAll("-", "")}`;
  assert.match(namespace, /^admissions_test_[a-f0-9]+$/);
  let server: ReturnType<typeof createServer> | undefined;
  try {
    await client.query(`CREATE SCHEMA "${namespace}"`);
    await client.query(`SET search_path TO "${namespace}"`);
    // Clone schema only, never copy or read real applicant rows.
    await client.query(`CREATE TABLE inquiries (LIKE public.inquiries INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES)`);
    // Avoid advancing the real inquiry serial sequence through its copied default.
    await client.query(`CREATE SEQUENCE isolated_inquiry_id`);
    await client.query(`ALTER TABLE inquiries ALTER COLUMN id SET DEFAULT nextval('isolated_inquiry_id')`);
    const migration = await readFile("migrations/0006_admissions_stage_one.sql", "utf8");
    await client.query(migration);
    await client.query(migration); // migration itself is safely repeatable
    const database = drizzle(client, { schema: { ...siteSchema, ...lmsSchema } });
    const { inquiries, admissionsLeads, admissionsPlaybacks, admissionsVideoEvents } = siteSchema;
    const register = (phone: string) => registerVslLead({
      name: "Synthetic Test", phone, entryPath: "/vsl", entryHost: "test.invalid",
    }, new Date(), database);
    const legacy = (phone: string) => database.insert(inquiries).values({
      name: "Synthetic Legacy", phone, email: "", programInterest: "test",
    }).returning();
    const [old] = await legacy("9000000002");
    const uniqueLead = await register("+91 90000 00002");
    assert.equal((await database.select().from(inquiries).where(eq(inquiries.id, old.id)))[0].leadId, uniqueLead.id);
    await legacy("9000000003");
    await legacy("+91 90000 00003");
    const ambiguous = await register("9000000003");
    assert.equal(ambiguous.legacyMatchStatus, "ambiguous");
    assert.equal((await database.select().from(inquiries).where(eq(inquiries.phone, "9000000003")))[0].leadId, null);
    const first = await register("9000000001");
    const again = await register("+919000000001");
    assert.equal(first.id, again.id);
    assert.equal((await database.select().from(inquiries).where(eq(inquiries.leadId, first.id))).length, 1);
    const choices = Object.fromEntries(Object.entries(siteSchema.counsellingAnswerValues).map(([key, values]) => [
      key, ["careerReasons", "stepsTaken"].includes(key) ? [values[0]] : values[0],
    ]));
    const answers = siteSchema.counsellingAnswersSchema.parse({
      ...choices, fullName: "Synthetic Test", city: "Test City", situationImpact: "test impact",
      topQuestions: "test questions", counsellorNote: "test note", visitFocus: "test focus",
      preferredDate: "2099-01-10", mobileWhatsapp: "+91 90000 00001", email: "", consentToContact: true,
    });
    const submission = await saveLinkedCounsellingInquiry({
      name: answers.fullName, phone: answers.mobileWhatsapp, email: "", programInterest: "test",
      message: "synthetic only", counsellingAnswers: answers,
    }, new Date(), database);
    assert.equal(submission.leadId, first.id);
    assert.deepEqual(submission.counsellingAnswers, answers);
    assert.equal(Object.keys(submission.counsellingAnswers!).length, 29);
    assert.equal((await database.select().from(admissionsLeads).where(eq(admissionsLeads.id, first.id)))[0].questionnaireStatus, "completed");
    const secondAnswers = { ...answers, topQuestions: "a later synthetic question" };
    const secondSubmission = await saveLinkedCounsellingInquiry({
      name: answers.fullName, phone: "919000000001", email: "", programInterest: "test",
      counsellingAnswers: secondAnswers,
    }, new Date(), database);
    assert.equal(secondSubmission.leadId, first.id);
    assert.notEqual(secondSubmission.id, submission.id);
    assert.deepEqual((await database.select().from(inquiries).where(eq(inquiries.id, submission.id)))[0].counsellingAnswers, answers);
    assert.equal((await database.select().from(inquiries).where(eq(inquiries.id, old.id)))[0].name, "Synthetic Legacy");

    const app = express();
    app.use(express.json());
    app.use(session({ secret: "isolated-test-session-only-not-a-real-secret", resave: false, saveUninitialized: false }));
    registerAdmissionsRoutes(app, database, async () => 100); // no real media/webhook requests
    server = createServer(app);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    const post = (path: string, body: unknown, cookie = "", requestOrigin = origin) => fetch(`${origin}${path}`, {
      method: "POST", headers: { "Content-Type": "application/json", Origin: requestOrigin, Cookie: cookie },
      body: JSON.stringify(body),
    });
    assert.equal((await post("/api/vsl/playbacks", {})).status, 401);
    assert.equal((await post("/api/vsl/registrations", { name: "Test", phone: "9000000001" }, "", "https://evil.invalid")).status, 403);
    const registration = await post("/api/vsl/registrations", { name: "Synthetic Test", phone: "9000000001", entryPath: "/vsl" });
    assert.equal(registration.status, 201);
    assert.deepEqual(await registration.json(), { registered: true });
    const cookie = registration.headers.get("set-cookie")!.split(";")[0];
    const playbackResponse = await post("/api/vsl/playbacks", {}, cookie);
    const { playbackId } = await playbackResponse.json();
    assert.equal(playbackResponse.status, 201);
    const payload = { playbackId, sequence: 1, type: "play", position: 0, duration: 100 };
    assert.equal((await post("/api/vsl/events", { ...payload, leadId: first.id }, cookie)).status, 400);
    assert.equal((await post("/api/vsl/events", payload)).status, 401);
    // Another valid visitor cannot use the first visitor's playback token.
    const other = await post("/api/vsl/registrations", { name: "Other Synthetic", phone: "9000000004" });
    const otherCookie = other.headers.get("set-cookie")!.split(";")[0];
    assert.equal((await post("/api/vsl/events", payload, otherCookie)).status, 403);
    assert.equal((await post("/api/vsl/events", payload, cookie)).status, 200);
    assert.equal((await post("/api/vsl/events", payload, cookie)).status, 200);
    for (let pos = 4; pos <= 100; pos += 4) {
      // Advance the test's server observation clock, never touch normal data.
      await database.update(admissionsPlaybacks).set({ lastObservedAt: new Date(Date.now() - 4000) }).where(eq(admissionsPlaybacks.id, playbackId));
      assert.equal((await post("/api/vsl/events", { ...payload, sequence: pos / 4 + 1, type: "sample", position: pos }, cookie)).status, 200);
    }
    const ended = { ...payload, sequence: 27, type: "ended", position: 100 };
    assert.equal((await post("/api/vsl/events", ended, cookie)).status, 200);
    assert.equal((await post("/api/vsl/events", ended, cookie)).status, 200);
    const events = await database.select().from(admissionsVideoEvents).where(eq(admissionsVideoEvents.leadId, first.id));
    assert.deepEqual(events.map(event => event.event).sort(), ["25", "50", "75", "90", "completed", "started"]);
    assert.ok(events.every(event => event.occurredAt instanceof Date && event.durationSeconds === 100));
    let response: Response;
    do { response = await post("/api/vsl/registrations", { name: "Synthetic Test", phone: "9000000001" }); } while (response.status === 201);
    assert.equal(response.status, 429);
  } finally {
    if (server) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
    await client.query("SET search_path TO public");
    await client.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
    client.release();
    await pool.end();
  }
});
