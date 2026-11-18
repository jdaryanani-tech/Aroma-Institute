import { z } from "zod";

export const AVNI_PILOT_MESSAGE = "Hi Jigar Welcome to Aroma Institute";
export const AVNI_PILOT_TIMEOUT_MS = 8_000;
export const EVOLUTION_API_BASE_URL = "https://evo.aromacafeinstitute.in";
export const EVOLUTION_API_KEY_ENV = "EVOLUTION_API_KEY";
export const EVOLUTION_API_INSTANCE_ENV = "EVOLUTION_API_INSTANCE";

const e164Schema = z.string().regex(/^\+[1-9][0-9]{7,14}$/);
const instanceNameSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
const idempotencyKeySchema = z.string().regex(/^[A-Za-z0-9._:-]{1,200}$/);
const apiKeySchema = z.string().min(1).max(4096).refine(
  value => value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value),
);
const providerMessageIdSchema = z.string().min(1).max(200).refine(
  value => !/[\u0000-\u001f\u007f]/.test(value),
);

export type EvolutionPilotResult =
  | { state: "accepted"; providerMessageId: string }
  | { state: "failed"; code: "definite_rejection" }
  | { state: "unknown"; code: "timeout" | "transport_error" | "invalid_response" }
  | { state: "unavailable"; code: "transport_not_configured" };

/**
 * The repository has no Evolution endpoint, API version, auth-header, or
 * response contract. A deployment-specific client must be supplied after that
 * contract is reviewed; this module deliberately does not guess an HTTP URL or
 * credential header.
 */
export type EvolutionPilotClient = {
  sendText(input: {
    recipientE164: string;
    text: string;
    idempotencyKey: string;
    signal: AbortSignal;
  }): Promise<
    | { state: "accepted"; providerMessageId: string }
    | { state: "failed"; code: "definite_rejection" }
    | { state: "unknown" }
  >;
};

export type EvolutionPilotTransport = {
  configured: boolean;
  sendText(input: {
    recipientE164: string;
    text: typeof AVNI_PILOT_MESSAGE;
    idempotencyKey: string;
  }): Promise<EvolutionPilotResult>;
};

const MAX_RESPONSE_BYTES = 16 * 1024;

async function readBoundedResponse(response: Response): Promise<string | null> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/**
 * Creates the server-only Evolution v2 HTTP client for the configured
 * instance. The base host is fixed; only a validated instance path segment is
 * accepted. The n8n Header Auth credential is not read or reused here.
 *
 * Evolution's current upstream contract uses POST /message/sendText/:instanceName,
 * the `apikey` header, and `{ number, text }`, returning a message with `key.id`.
 * The deployed server version still must be confirmed before enabling dispatch.
 */
export function createEvolutionPilotHttpClient(
  configuration: {
    apiKey?: string | null;
    instanceName?: string | null;
  },
  fetchImpl: typeof fetch = fetch,
): EvolutionPilotClient | null {
  const apiKey = configuration.apiKey;
  const instanceName = configuration.instanceName;
  if (
    typeof apiKey !== "string" ||
    !apiKeySchema.safeParse(apiKey).success ||
    typeof instanceName !== "string" ||
    !instanceNameSchema.safeParse(instanceName).success
  ) {
    return null;
  }

  const endpoint =
    `${EVOLUTION_API_BASE_URL}/message/sendText/${encodeURIComponent(instanceName)}`;
  return {
    async sendText(input) {
      if (
        !e164Schema.safeParse(input.recipientE164).success ||
        input.text !== AVNI_PILOT_MESSAGE ||
        !idempotencyKeySchema.safeParse(input.idempotencyKey).success
      ) {
        return { state: "failed", code: "definite_rejection" };
      }

      let response: Response;
      try {
        response = await fetchImpl(endpoint, {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            apikey: apiKey,
          },
          // Evolution expects the country code and digits without a leading +.
          body: JSON.stringify({
            number: input.recipientE164.slice(1),
            text: AVNI_PILOT_MESSAGE,
          }),
          signal: input.signal,
          redirect: "manual",
          cache: "no-store",
        });
      } catch {
        return { state: "unknown" };
      }

      // The upstream apikey guard rejects before entering the message route.
      // Other non-2xx responses are conservatively ambiguous: never retry them.
      if (response.status === 401 || response.status === 403) {
        return { state: "failed", code: "definite_rejection" };
      }
      if (!response.ok) return { state: "unknown" };

      const responseText = await readBoundedResponse(response);
      if (responseText === null) return { state: "unknown" };
      try {
        const parsed: unknown = JSON.parse(responseText);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          return { state: "unknown" };
        }
        const key = (parsed as { key?: unknown }).key;
        if (!key || typeof key !== "object" || Array.isArray(key)) {
          return { state: "unknown" };
        }
        const providerMessageId = providerMessageIdSchema.safeParse(
          (key as { id?: unknown }).id,
        );
        return providerMessageId.success
          ? { state: "accepted", providerMessageId: providerMessageId.data }
          : { state: "unknown" };
      } catch {
        return { state: "unknown" };
      }
    },
  };
}

/**
 * Wraps a server-only Evolution client with strict recipient validation and a
 * hard timeout. The client must classify `failed` only for a documented,
 * definite pre-acceptance rejection. Timeouts and ambiguous responses are
 * `unknown` and must not be retried under a new attempt.
 */
export function createEvolutionPilotTransport(
  client: EvolutionPilotClient | null,
  options: { timeoutMs?: number } = {},
): EvolutionPilotTransport {
  const timeoutMs = options.timeoutMs ?? AVNI_PILOT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 15_000) {
    throw new Error("AVNI_PILOT_TIMEOUT_INVALID");
  }

  return {
    configured: client !== null,
    async sendText(input) {
      if (!client) return { state: "unavailable", code: "transport_not_configured" };
      if (!e164Schema.safeParse(input.recipientE164).success
        || input.text !== AVNI_PILOT_MESSAGE
        || !/^[A-Za-z0-9._:-]{1,200}$/.test(input.idempotencyKey)) {
        return { state: "failed", code: "definite_rejection" };
      }

      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const timeout = new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error("pilot_transport_timeout"));
          }, timeoutMs);
        });
        const result = await Promise.race([
          client.sendText({
            recipientE164: input.recipientE164,
            text: input.text,
            idempotencyKey: input.idempotencyKey,
            signal: controller.signal,
          }),
          timeout,
        ]);
        if (result.state === "failed") return result;
        if (result.state === "unknown") return { state: "unknown", code: "transport_error" };
        const providerMessageId = providerMessageIdSchema.safeParse(result.providerMessageId);
        return providerMessageId.success
          ? { state: "accepted", providerMessageId: providerMessageId.data }
          : { state: "unknown", code: "invalid_response" };
      } catch (error) {
        return {
          state: "unknown",
          code: error instanceof Error && error.message === "pilot_transport_timeout"
            ? "timeout"
            : "transport_error",
        };
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  };
}
