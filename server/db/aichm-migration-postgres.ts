import type { Pool, PoolClient } from "pg";
import type {
  DatabaseIdentity,
  DbRow,
  MigrationCheckpoint,
  MigrationStore,
  MigrationTransaction,
  TableMetadata,
} from "./aichm-migration-engine";
import { AICHM_REQUIRED_SCHEMA_VERSION, canonicalize } from "./aichm-migration-engine";

type QueryResult<Row = Record<string, unknown>> = {
  rows: Row[];
  rowCount: number | null;
};

type Queryable = {
  query<Row = Record<string, unknown>>(text: string, values?: unknown[]): Promise<QueryResult<Row>>;
};

function quoteIdentifier(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(identifier)) {
    throw new Error("Migration metadata contains an invalid identifier.");
  }
  return `"${identifier.replaceAll('"', '""')}"`;
}

function qualified(schema: string, table: string): string {
  return `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
}

function keyPredicate(key: Record<string, unknown>) {
  const columns = Object.keys(key);
  if (!columns.length) throw new Error("A migration key cannot be empty.");
  const values = columns.map((column) => key[column]);
  const expressions = columns.map((column) => quoteIdentifier(column)).join(", ");
  const placeholders = columns.map((_, index) => `$${index + 1}`).join(", ");
  return { columns, values, expressions, placeholders };
}

class PgMigrationTransaction implements MigrationTransaction {
  constructor(private readonly client: PoolClient) {}

  async findByKey(schema: string, table: string, key: Record<string, unknown>): Promise<DbRow | null> {
    const predicate = keyPredicate(key);
    const result = await this.client.query(
      `SELECT * FROM ${qualified(schema, table)} WHERE (${predicate.expressions}) = (${predicate.placeholders}) LIMIT 1`,
      predicate.values,
    );
    return result.rows[0] ?? null;
  }

  async findByUniqueKeys(
    schema: string,
    table: string,
    row: DbRow,
    uniqueKeys: string[][],
  ): Promise<{ row: DbRow; key: string[] } | null> {
    for (const key of uniqueKeys) {
      if (!key.length || key.some((column) => row[column] === null || row[column] === undefined)) continue;
      const predicates = key.map((column, index) => `${quoteIdentifier(column)} = $${index + 1}`);
      const values = key.map((column) => row[column]);
      const result = await this.client.query(
        `SELECT * FROM ${qualified(schema, table)} WHERE ${predicates.join(" AND ")} LIMIT 1`,
        values,
      );
      if (result.rows[0]) return { row: result.rows[0], key };
    }
    return null;
  }

  async insertIgnore(
    schema: string,
    table: string,
    row: DbRow,
    primaryKey: string[],
  ): Promise<boolean> {
    const columns = Object.keys(row);
    if (!columns.length) throw new Error("A migration row cannot be empty.");
    const values = columns.map((column) => row[column]);
    const returning = primaryKey.map(quoteIdentifier).join(", ");
    const result = await this.client.query(
      `INSERT INTO ${qualified(schema, table)} (${columns.map(quoteIdentifier).join(", ")}) ` +
        `VALUES (${columns.map((_, index) => `$${index + 1}`).join(", ")}) ` +
        `ON CONFLICT DO NOTHING RETURNING ${returning}`,
      values,
    );
    return result.rowCount === 1;
  }

  async saveCheckpoint(runId: string, table: string, checkpoint: MigrationCheckpoint): Promise<void> {
    await this.client.query(
      `INSERT INTO "aichm"."migration_checkpoints" ` +
        `("run_id","table_name","batch_number","last_key","row_count","source_checksum","target_checksum","updated_at") ` +
        `VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,now()) ` +
        `ON CONFLICT ("run_id","table_name") DO UPDATE SET ` +
        `"batch_number"=EXCLUDED."batch_number","last_key"=EXCLUDED."last_key",` +
        `"row_count"="aichm"."migration_checkpoints"."row_count"+EXCLUDED."row_count",` +
        `"source_checksum"=EXCLUDED."source_checksum","target_checksum"=EXCLUDED."target_checksum","updated_at"=now()`,
      [
        runId,
        table,
        checkpoint.batchNumber,
        JSON.stringify(checkpoint.lastKey),
        checkpoint.rowCount,
        checkpoint.sourceChecksum,
        checkpoint.targetChecksum,
      ],
    );
  }

  async saveCrosswalk(input: {
    sourceTable: string;
    sourceKey: Record<string, unknown>;
    targetTable: string;
    targetKey: Record<string, unknown>;
    decision: "create-distinct" | "link-existing-public-lead" | "preserve-custom-auth";
    targetPublicLeadId?: string;
    reviewer: string;
    reviewedAt: string;
  }): Promise<void> {
    const inserted = await this.client.query(
      `INSERT INTO "aichm"."migration_crosswalk" ` +
        `("source_schema","source_table","source_key","target_schema","target_table","target_key",` +
        `"decision","target_public_lead_id","reviewer","reviewed_at") ` +
        `VALUES ('public',$1,$2::jsonb,'aichm',$3,$4::jsonb,$5,$6,$7,$8::timestamptz) ` +
        `ON CONFLICT ("source_schema","source_table","source_key") DO NOTHING`,
      [
        input.sourceTable,
        JSON.stringify(input.sourceKey),
        input.targetTable,
        JSON.stringify(input.targetKey),
        input.decision,
        input.targetPublicLeadId ?? null,
        input.reviewer,
        input.reviewedAt,
      ],
    );
    if (inserted.rowCount === 1) return;

    const existing = await this.client.query(
      `SELECT target_schema,target_table,target_key,decision,target_public_lead_id,reviewer,reviewed_at ` +
        `FROM "aichm"."migration_crosswalk" ` +
        `WHERE source_schema='public' AND source_table=$1 AND source_key=$2::jsonb`,
      [input.sourceTable, JSON.stringify(input.sourceKey)],
    );
    const row = existing.rows[0];
    if (
      !row ||
      row.target_schema !== "aichm" ||
      row.target_table !== input.targetTable ||
      canonicalize(row.target_key) !== canonicalize(input.targetKey) ||
      row.decision !== input.decision ||
      row.target_public_lead_id !== (input.targetPublicLeadId ?? null)
    ) {
      throw new Error("Existing migration crosswalk conflicts with the approved manifest.");
    }
  }
}

export class PostgresMigrationStore implements MigrationStore {
  constructor(
    private readonly pool: Pool,
    private readonly configuredHost: string,
    private readonly configuredPort: number,
    private readonly projectRef?: string,
    private readonly readOnlySnapshot = false,
  ) {}

  async identity(): Promise<DatabaseIdentity> {
    const client = await this.pool.connect();
    try {
      const result = await client.query<{
        database: string;
        user: string;
        is_recovery: boolean;
        is_read_only: boolean;
      }>(
        "SELECT current_database() AS database, current_user AS user, " +
          "pg_is_in_recovery() AS is_recovery, " +
          "current_setting('default_transaction_read_only')::boolean AS is_read_only",
      );
      const clientWithSocket = client as unknown as { connection: { stream: {
        encrypted?: boolean;
        authorized?: boolean;
        authorizationError?: Error;
        servername?: string;
      } } };
      const socket = clientWithSocket.connection.stream;
      return {
        database: result.rows[0].database,
        user: result.rows[0].user,
        host: this.configuredHost,
        port: this.configuredPort,
        isRecovery: result.rows[0].is_recovery,
        isReadOnly: result.rows[0].is_read_only,
        projectRef: this.projectRef,
        tlsAuthorized: socket.encrypted === true && socket.authorized === true && !socket.authorizationError,
        tlsServername: socket.servername ?? null,
      };
    } finally {
      client.release();
    }
  }

  async schemaVersion(): Promise<string | null> {
    try {
      const result = await this.pool.query<{ version: string }>(
        `SELECT version FROM "aichm"."schema_migrations" WHERE version = $1 LIMIT 1`,
        [AICHM_REQUIRED_SCHEMA_VERSION],
      );
      return result.rows[0]?.version ?? null;
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        (error as { code?: string }).code === "42P01"
      ) {
        return null;
      }
      throw error;
    }
  }

  async alignSequences(schema: string, table: string): Promise<number> {
    const columns = await this.pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns ` +
        `WHERE table_schema=$1 AND table_name=$2 AND data_type IN ('smallint','integer','bigint') ` +
        `ORDER BY ordinal_position`,
      [schema, table],
    );
    let adjusted = 0;
    const qualifiedName = `${schema}.${table}`;
    for (const { column_name: column } of columns.rows) {
      const sequenceResult = await this.pool.query<{ sequence_name: string | null }>(
        "SELECT pg_get_serial_sequence($1,$2) AS sequence_name",
        [qualifiedName, column],
      );
      const sequenceName = sequenceResult.rows[0]?.sequence_name;
      if (!sequenceName) continue;
      const maxResult = await this.pool.query<{ max_value: string | null }>(
        `SELECT max(${quoteIdentifier(column)})::text AS max_value FROM ${qualified(schema, table)}`,
      );
      const maxValue = maxResult.rows[0]?.max_value;
      if (maxValue === null || maxValue === undefined) continue;
      await this.pool.query(
        `SELECT setval($1::regclass, GREATEST(COALESCE(pg_sequence_last_value($1::regclass),1),$2::bigint), true)`,
        [sequenceName, maxValue],
      );
      adjusted++;
    }
    return adjusted;
  }

  async inspectTable(schema: string, table: string): Promise<TableMetadata | null> {
    const columnsResult = await this.pool.query<{
      column_name: string;
      data_type: string;
      udt_name: string;
      is_nullable: string;
      column_default: string | null;
      character_maximum_length: number | null;
      numeric_precision: number | null;
      numeric_scale: number | null;
      ordinal_position: number;
    }>(
      `SELECT column_name,data_type,udt_name,is_nullable,column_default,character_maximum_length,` +
        `numeric_precision,numeric_scale,ordinal_position ` +
        `FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 ORDER BY ordinal_position`,
      [schema, table],
    );
    if (!columnsResult.rows.length) return null;

    const constraintsResult = await this.pool.query<{
      contype: "p" | "u";
      columns: string[];
    }>(
      `SELECT c.contype, array_agg(a.attname::text ORDER BY key_column.ordinality) AS columns ` +
        `FROM pg_constraint c ` +
        `JOIN pg_class t ON t.oid=c.conrelid ` +
        `JOIN pg_namespace n ON n.oid=t.relnamespace ` +
        `CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS key_column(attnum, ordinality) ` +
        `JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=key_column.attnum ` +
        `WHERE n.nspname=$1 AND t.relname=$2 AND c.contype IN ('p','u') ` +
        `GROUP BY c.oid,c.contype ORDER BY c.contype,c.oid`,
      [schema, table],
    );
    const primaryKey = constraintsResult.rows.find((constraint) => constraint.contype === "p")?.columns ?? [];
    const uniqueKeys = constraintsResult.rows.map((constraint) => constraint.columns);
    return {
      columns: columnsResult.rows.map((column) => ({
        name: column.column_name,
        dataType: column.data_type,
        typeName: column.udt_name,
        characterMaximumLength: column.character_maximum_length === null ? null : Number(column.character_maximum_length),
        numericPrecision: column.numeric_precision === null ? null : Number(column.numeric_precision),
        numericScale: column.numeric_scale === null ? null : Number(column.numeric_scale),
        defaultExpression: column.column_default,
        nullable: column.is_nullable === "YES",
        hasDefault: column.column_default !== null,
        ordinal: Number(column.ordinal_position),
      })),
      primaryKey,
      uniqueKeys,
    };
  }

  async scanRows(
    schema: string,
    table: string,
    afterKey: Record<string, unknown> | null,
    primaryKey: string[],
    limit: number,
  ): Promise<DbRow[]> {
    if (!primaryKey.length) throw new Error("Primary-key scan is required for migration.");
    const orderBy = primaryKey.map(quoteIdentifier).join(", ");
    let where = "";
    let values: unknown[] = [];
    if (afterKey) {
      const predicate = keyPredicate(afterKey);
      if (predicate.columns.join("\0") !== primaryKey.join("\0")) {
        throw new Error("Migration checkpoint key does not match the table primary key.");
      }
      where = `WHERE (${predicate.expressions}) > (${predicate.placeholders})`;
      values = predicate.values;
    }
    values.push(limit);
    const result = await this.pool.query(
      `SELECT * FROM ${qualified(schema, table)} ${where} ORDER BY ${orderBy} LIMIT $${values.length}`,
      values,
    );
    return result.rows;
  }

  async readCheckpoint(runId: string, table: string): Promise<MigrationCheckpoint | null> {
    const result = await this.pool.query<{
      last_key: Record<string, unknown> | null;
      batch_number: number;
      row_count: number;
      source_checksum: string;
      target_checksum: string;
    }>(
      `SELECT last_key,batch_number,row_count,source_checksum,target_checksum ` +
        `FROM "aichm"."migration_checkpoints" WHERE run_id=$1 AND table_name=$2`,
      [runId, table],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      lastKey: row.last_key,
      batchNumber: Number(row.batch_number),
      rowCount: Number(row.row_count),
      sourceChecksum: row.source_checksum,
      targetChecksum: row.target_checksum,
    };
  }

  async transaction<T>(callback: (transaction: MigrationTransaction) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    if (this.readOnlySnapshot) {
      try {
        return await callback(new PgMigrationTransaction(client));
      } finally {
        client.release();
      }
    }
    try {
      await client.query("BEGIN");
      const result = await callback(new PgMigrationTransaction(client));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the original transactional failure without logging DB details.
      }
      throw error;
    } finally {
      client.release();
    }
  }
}

export function migrationStoreFromPool(
  pool: Pool,
  config: { host: string; port: number; projectRef?: string },
): PostgresMigrationStore {
  return new PostgresMigrationStore(pool, config.host, config.port, config.projectRef);
}

export function migrationStoreFromReadOnlyClient(
  client: PoolClient,
  config: { host: string; port: number; projectRef?: string },
): PostgresMigrationStore {
  const pinnedClient = {
    query: client.query.bind(client),
    release: () => undefined,
    connection: (client as unknown as { connection: unknown }).connection,
  };
  const pinnedPool = {
    query: client.query.bind(client),
    connect: async () => pinnedClient,
  } as unknown as Pool;
  return new PostgresMigrationStore(
    pinnedPool,
    config.host,
    config.port,
    config.projectRef,
    true,
  );
}
