import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { safeCatalogIdentifierArray } from "./crm-forward-migration-postconditions";

test("catalog name[] values use pg's raw text shape and normalize to identifiers", () => {
  const parseNameArray = pg.types.getTypeParser(1003, "text");
  const driverValue = parseNameArray("{lead_id,assigned_by}");

  assert.equal(typeof driverValue, "string");
  assert.deepEqual(
    safeCatalogIdentifierArray(driverValue),
    ["lead_id", "assigned_by"],
  );
});

test("catalog identifier normalization fails closed for malformed result shapes", () => {
  assert.equal(safeCatalogIdentifierArray({ rows: ["lead_id"] }), null);
  assert.equal(safeCatalogIdentifierArray(42), null);
  assert.equal(safeCatalogIdentifierArray("{lead_id,not an identifier}"), null);
  assert.equal(safeCatalogIdentifierArray("{lead_id,\"assigned_by\"}"), null);
});

test("catalog text[] arrays and null reference arrays retain their expected forms", () => {
  const parseTextArray = pg.types.getTypeParser(1009, "text");
  const driverValue = parseTextArray("{lead_id,assigned_by}");

  assert.deepEqual(safeCatalogIdentifierArray(driverValue), ["lead_id", "assigned_by"]);
  assert.equal(safeCatalogIdentifierArray(null), null);
});
