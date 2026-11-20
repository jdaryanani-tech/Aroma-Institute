import { randomUUID } from "node:crypto";

export type StartupFailureStage = "module-load" | "server-start";

export type StartupFailureRecord = {
  event: "application_startup_failed";
  correlationId: string;
  stage: StartupFailureStage;
  errorClass: string;
  safeErrorCode?: string;
  stackFrames: string[];
};

type ApplicationModule = {
  startApplication: () => Promise<void>;
};

type StartupDiagnosticsOptions = {
  correlationId?: string;
  logger?: (line: string) => void;
  setExitCode?: (code: number) => void;
};

const SAFE_ERROR_CODES = new Set([
  "DATABASE_URL_REQUIRED",
  "APP_DATABASE_URL_REQUIRED",
  "APP_DATABASE_URL_INVALID",
  "APP_DATABASE_PLATFORM_REFERENCE_REQUIRED",
  "APP_DATABASE_PLATFORM_REFERENCE_INVALID",
  "APP_DATABASE_ENDPOINT_NOT_INTERNAL",
  "APP_DATABASE_HOST_POLICY_REJECTED",
  "APP_DATABASE_NEON_SSLMODE_REQUIRED",
  "APP_DATABASE_ENDPOINT_MISMATCH",
  "APP_DATABASE_LOGIN_NOT_DISTINCT",
  "APP_DATABASE_RUNTIME_IDENTITY_UNAVAILABLE",
  "APP_DATABASE_RUNTIME_IDENTITY_REJECTED",
  "APP_DATABASE_RUNTIME_PRIVILEGES_NOT_READY",
  "APP_DATABASE_PREMIGRATION_IDENTITY_UNAVAILABLE",
  "APP_DATABASE_PREMIGRATION_IDENTITY_MISMATCH",
  "APP_DATABASE_PREMIGRATION_LOGIN_REJECTED",
  "APP_DATABASE_PREMIGRATION_GROUP_REJECTED",
  "APP_DATABASE_PREMIGRATION_MEMBERSHIP_REJECTED",
  "EADDRINUSE",
  "EACCES",
  "EADDRNOTAVAIL",
  "ECONNREFUSED",
  "ECONNRESET",
  "ECONNABORTED",
  "EPIPE",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ERR_INVALID_ARG_TYPE",
  "ERR_INVALID_URL",
  "ERR_MODULE_NOT_FOUND",
  "ERR_REQUIRE_ESM",
  "ERR_PACKAGE_PATH_NOT_EXPORTED",
  "ERR_SOCKET_BAD_PORT",
  "ERR_SERVER_ALREADY_LISTEN",
]);

const SAFE_ERROR_CLASS_NAMES = new Set([
  "AbortError",
  "AggregateError",
  "DatabaseError",
  "Error",
  "EvalError",
  "FetchError",
  "PostgresError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TimeoutError",
  "TypeError",
  "URIError",
]);

function errorClass(error: unknown): string {
  if (!error || typeof error !== "object") return "UnknownError";

  let name: unknown;
  try {
    name = (error as { name?: unknown }).name;
  } catch {
    return "Error";
  }

  return typeof name === "string" && SAFE_ERROR_CLASS_NAMES.has(name)
    ? name
    : "Error";
}

function safeErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;

  let code: unknown;
  try {
    code = (error as { code?: unknown }).code;
  } catch {
    return undefined;
  }

  return typeof code === "string" && SAFE_ERROR_CODES.has(code)
    ? code
    : undefined;
}

function safeFrameName(value: string): string {
  const normalized = value.replace(/^async\s+/, "");
  if (
    normalized.length <= 80 &&
    /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*|\.<anonymous>)*$/.test(
      normalized,
    ) &&
    !/[A-Za-z0-9_-]{32,}/.test(normalized) &&
    !/[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/.test(
      normalized,
    )
  ) {
    return normalized;
  }
  return "frame";
}

function safeStackFrame(line: string): string | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("at ")) return undefined;

  const body = trimmed.slice(3);
  const openParen = body.lastIndexOf(" (");
  const hasLocationParens = openParen >= 0 && body.endsWith(")");
  const functionName = hasLocationParens ? body.slice(0, openParen) : "";
  const location = hasLocationParens
    ? body.slice(openParen + 2, -1)
    : body;
  const match = location.match(/^(.*):(\d+):(\d+)$/);
  if (!match) return undefined;

  if (/^(?:postgres(?:ql)?|https?):\/\//i.test(match[1]) || /[?&=]/.test(match[1])) {
    return undefined;
  }
  const path = match[1].replace(/^file:\/\//i, "");
  const normalizedPath = path.replace(/\\/g, "/");
  const rawFileName = normalizedPath.split("/").pop() ?? "";
  const isNodeFrame = normalizedPath.startsWith("node:");
  const isSourceFile = /\.(?:[cm]?js|tsx?|json|node)$/i.test(rawFileName);
  if (
    !/^[A-Za-z0-9_.-]{1,120}$/.test(rawFileName) ||
    /[A-Za-z0-9_-]{32,}/.test(rawFileName) ||
    (!isNodeFrame && !isSourceFile)
  ) {
    return undefined;
  }
  const fileName = isNodeFrame ? `node:${rawFileName}` : rawFileName;
  const lineNumber = match[2];
  const columnNumber = match[3];
  if (!hasLocationParens) {
    return `at ${fileName}:${lineNumber}:${columnNumber}`;
  }
  return `at ${safeFrameName(functionName)} (${fileName}:${lineNumber}:${columnNumber})`;
}

function safeStackFrames(error: unknown): string[] {
  if (!error || typeof error !== "object") return [];

  let stack: unknown;
  try {
    stack = (error as { stack?: unknown }).stack;
  } catch {
    return [];
  }
  if (typeof stack !== "string") return [];

  return stack
    .split(/\r?\n/)
    .slice(1)
    .filter((line) => /^\s*at\s/.test(line))
    .slice(0, 8)
    .map(safeStackFrame)
    .filter((frame): frame is string => Boolean(frame));
}

export function createStartupFailureRecord(
  stage: StartupFailureStage,
  error: unknown,
  correlationId: string = randomUUID(),
): StartupFailureRecord {
  const safeCode = safeErrorCode(error);
  return {
    event: "application_startup_failed",
    correlationId,
    stage,
    errorClass: errorClass(error),
    ...(safeCode ? { safeErrorCode: safeCode } : {}),
    stackFrames: safeStackFrames(error),
  };
}

export async function runStartupWithDiagnostics(
  loadApplication: () => Promise<ApplicationModule>,
  options: StartupDiagnosticsOptions = {},
): Promise<void> {
  let stage: StartupFailureStage = "module-load";

  try {
    const application = await loadApplication();
    stage = "server-start";
    await application.startApplication();
  } catch (error) {
    const record = createStartupFailureRecord(
      stage,
      error,
      options.correlationId,
    );
    try {
      (options.logger ?? console.error)(JSON.stringify(record));
    } finally {
      (options.setExitCode ?? ((code: number) => {
        process.exitCode = code;
      }))(1);
    }
  }
}
