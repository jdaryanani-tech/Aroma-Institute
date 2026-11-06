import assert from "node:assert/strict";
import test from "node:test";
import {
  AICHM_APP_SCHEMA_MIGRATION_VERSION,
  AICHM_STAGE1_ENUM_TYPES,
  AICHM_STAGE1_TABLES,
  buildAichmStage1ApplicationSql,
  normalizeAichmColumnDefault,
  type EnumDefinition,
} from "./aichm-schema-stage1";

const enums: EnumDefinition[] = AICHM_STAGE1_ENUM_TYPES.map((name) => ({
  name,
  labels: ["draft", "published"],
}));

function sourceDump() {
  return [
    ...AICHM_STAGE1_TABLES.map((table) => `CREATE TABLE public.${table} (id integer NOT NULL);`),
    "CREATE SEQUENCE public.sample_id_seq START WITH 1;",
    "ALTER TABLE ONLY public.lms_users ADD CONSTRAINT lms_users_pkey PRIMARY KEY (id);",
    "CREATE INDEX sample_idx ON public.lms_users USING btree (id);",
    "ALTER TABLE ONLY public.lms_user_roles ADD CONSTRAINT lms_user_roles_user_fk FOREIGN KEY (user_id) REFERENCES public.lms_users(id);",
  ].join("\n");
}

test("Stage 1 schema builder rewrites exactly the application allowlist and enables RLS", () => {
  const sql = buildAichmStage1ApplicationSql(sourceDump(), enums);
  assert.equal((sql.match(/^CREATE TABLE aichm\./gm) ?? []).length, 34);
  assert.equal((sql.match(/^ALTER TABLE aichm\..* ENABLE ROW LEVEL SECURITY;$/gm) ?? []).length, 34);
  assert.match(sql, /CREATE TYPE aichm\.lms_role AS ENUM/);
  assert.match(sql, /REFERENCES aichm\.lms_users/);
  assert.match(sql, /REVOKE ALL ON ALL TABLES IN SCHEMA aichm FROM PUBLIC, anon, authenticated, service_role/);
  assert.match(sql, new RegExp(`VALUES \\('${AICHM_APP_SCHEMA_MIGRATION_VERSION}'`));
  assert.doesNotMatch(sql, /^COPY |^INSERT INTO aichm\.(?!schema_migrations)/m);
  assert.doesNotMatch(sql, /\bpublic\./);
});

test("Stage 1 schema builder rejects missing/extra tables and row-data statements", () => {
  const missingTableDump = sourceDump().replace(
    `CREATE TABLE public.${AICHM_STAGE1_TABLES[0]} (id integer NOT NULL);`,
    "",
  );
  assert.throws(() => buildAichmStage1ApplicationSql(missingTableDump, enums), /complete Stage 1 table allowlist/);
  assert.throws(() => buildAichmStage1ApplicationSql(`${sourceDump()}\nCOPY public.lms_users FROM stdin;`, enums));
  assert.throws(
    () => buildAichmStage1ApplicationSql(sourceDump(), enums.slice(1)),
    /source enum definitions do not match/,
  );
});

test("column default comparison normalizes equivalent sequence and enum schema qualification", () => {
  assert.equal(
    normalizeAichmColumnDefault("nextval('public.inquiries_id_seq'::regclass)"),
    normalizeAichmColumnDefault("nextval('inquiries_id_seq'::regclass)"),
  );
  assert.equal(
    normalizeAichmColumnDefault("nextval('\"public\".\"inquiries_id_seq\"'::regclass)"),
    normalizeAichmColumnDefault("nextval('aichm.inquiries_id_seq'::regclass)"),
  );
  assert.equal(
    normalizeAichmColumnDefault("'draft'::public.lms_content_status"),
    normalizeAichmColumnDefault("'draft'::aichm.lms_content_status"),
  );
  assert.equal(normalizeAichmColumnDefault("gen_random_uuid()"), "gen_random_uuid()");
  assert.equal(normalizeAichmColumnDefault(null), null);
});
