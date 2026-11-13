export const CRM_MIGRATION_WRAPPER_ERROR = "CRM_FORWARD_MIGRATION_TRANSACTION_WRAPPER_INVALID";

type SqlStatement = {
  tokens: Array<string | null>;
  start: number;
  semicolon: number | null;
};

const TRANSACTION_CONTROL_STATEMENTS = new Set([
  "BEGIN",
  "START",
  "COMMIT",
  "END",
  "ROLLBACK",
  "ABORT",
  "SAVEPOINT",
  "RELEASE",
]);

function invalidWrapper(): never {
  const error = new Error(CRM_MIGRATION_WRAPPER_ERROR) as Error & { code: string };
  error.code = CRM_MIGRATION_WRAPPER_ERROR;
  throw error;
}

function isWordStart(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z_\u0080-\uFFFF]/.test(char);
}

function isWordCharacter(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z0-9_$\u0080-\uFFFF]/.test(char);
}

function isWhitespace(char: string | undefined): boolean {
  return char !== undefined && (/\s/.test(char) || char === "\uFEFF");
}

function skipBlockComment(sql: string, start: number): number {
  let depth = 1;
  let index = start + 2;
  while (index < sql.length) {
    if (sql.startsWith("/*", index)) {
      depth += 1;
      index += 2;
    } else if (sql.startsWith("*/", index)) {
      depth -= 1;
      index += 2;
      if (depth === 0) return index;
    } else {
      index += 1;
    }
  }
  return invalidWrapper();
}

function skipSingleQuotedString(sql: string, start: number): number {
  const escapeString = (sql[start - 1] === "e" || sql[start - 1] === "E") &&
    !isWordCharacter(sql[start - 2]);
  let index = start + 1;
  while (index < sql.length) {
    const char = sql[index];
    if (escapeString && char === "\\") {
      index += 2;
      continue;
    }
    if (char === "'") {
      if (sql[index + 1] === "'") {
        index += 2;
        continue;
      }
      return index + 1;
    }
    index += 1;
  }
  return invalidWrapper();
}

function skipQuotedIdentifier(sql: string, start: number): number {
  let index = start + 1;
  while (index < sql.length) {
    if (sql[index] === '"') {
      if (sql[index + 1] === '"') {
        index += 2;
        continue;
      }
      return index + 1;
    }
    index += 1;
  }
  return invalidWrapper();
}

function dollarDelimiterAt(sql: string, start: number): string | undefined {
  return /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(start))?.[0];
}

function scanStatements(sql: string): SqlStatement[] {
  const statements: SqlStatement[] = [];
  let tokens: Array<string | null> = [];
  let statementStart = -1;
  let index = 0;

  const addToken = (token: string | null, start: number) => {
    if (tokens.length === 0) statementStart = start;
    tokens.push(token);
  };
  const finishStatement = (semicolon: number) => {
    if (tokens.length === 0) return invalidWrapper();
    statements.push({ tokens, start: statementStart, semicolon });
    tokens = [];
    statementStart = -1;
  };

  while (index < sql.length) {
    const char = sql[index];
    if (isWhitespace(char)) {
      index += 1;
      continue;
    }
    if (sql.startsWith("--", index)) {
      const newline = sql.indexOf("\n", index + 2);
      index = newline === -1 ? sql.length : newline + 1;
      continue;
    }
    if (sql.startsWith("/*", index)) {
      index = skipBlockComment(sql, index);
      continue;
    }
    if (sql.startsWith("*/", index)) return invalidWrapper();
    if (char === "'") {
      const start = index;
      index = skipSingleQuotedString(sql, index);
      addToken(null, start);
      continue;
    }
    if (char === '"') {
      const start = index;
      index = skipQuotedIdentifier(sql, index);
      addToken(null, start);
      continue;
    }
    if (char === "$") {
      const delimiter = dollarDelimiterAt(sql, index);
      if (delimiter) {
        const start = index;
        const contentStart = index + delimiter.length;
        const closing = sql.indexOf(delimiter, contentStart);
        if (closing === -1) return invalidWrapper();
        index = closing + delimiter.length;
        addToken(null, start);
      } else {
        addToken(null, index);
        index += 1;
      }
      continue;
    }
    if (char === ";") {
      finishStatement(index);
      index += 1;
      continue;
    }
    if (isWordStart(char)) {
      const start = index;
      index += 1;
      while (isWordCharacter(sql[index])) index += 1;
      addToken(sql.slice(start, index).toUpperCase(), start);
      continue;
    }
    addToken(null, index);
    index += 1;
  }

  if (tokens.length > 0) statements.push({ tokens, start: statementStart, semicolon: null });
  return statements;
}

/**
 * Validates the dedicated migration-file transaction envelope and returns only
 * its body. Comments and whitespace may precede BEGIN; comments are otherwise
 * lexed so keywords inside strings/comments cannot masquerade as wrappers.
 */
export function unwrapCrmMigration(sql: string): string {
  const statements = scanStatements(sql);
  if (statements.length < 3) return invalidWrapper();

  const begin = statements[0];
  const commit = statements.at(-1)!;
  if (
    begin.tokens.length !== 1 ||
    begin.tokens[0] !== "BEGIN" ||
    begin.semicolon === null ||
    commit.tokens.length !== 1 ||
    commit.tokens[0] !== "COMMIT" ||
    commit.semicolon === null
  ) {
    return invalidWrapper();
  }

  for (const statement of statements.slice(1, -1)) {
    if (typeof statement.tokens[0] === "string" &&
      TRANSACTION_CONTROL_STATEMENTS.has(statement.tokens[0])) {
      return invalidWrapper();
    }
  }

  const body = sql.slice(begin.semicolon + 1, commit.start).trim();
  if (!body) return invalidWrapper();
  return body;
}
