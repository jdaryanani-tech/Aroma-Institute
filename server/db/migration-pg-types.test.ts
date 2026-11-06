import assert from "node:assert/strict";
import { types as pgTypes } from "pg";
import test from "node:test";
import { migrationPgTypes } from "./migration-pg-types";

test("migration timestamp parsers preserve exact PostgreSQL text values", () => {
  const timestamp = "2026-11-06 01:02:03.123456+00";

  assert.equal(migrationPgTypes.getTypeParser(1184, "text")(timestamp), timestamp);
  assert.equal(migrationPgTypes.getTypeParser(1184)(timestamp), timestamp);
});

test("migration type parser delegates regular text and binary types to pg", () => {
  const integerText = "42";
  const binaryValue = Buffer.from([0, 0, 0, 42]);

  assert.equal(
    migrationPgTypes.getTypeParser(23, "text")(integerText),
    pgTypes.getTypeParser(23, "text")(integerText),
  );
  assert.equal(
    migrationPgTypes.getTypeParser(23, "binary")(binaryValue),
    pgTypes.getTypeParser(23, "binary")(binaryValue),
  );
});
