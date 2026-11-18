import { z } from "zod";

export const AVNI_PILOT_MESSAGE = "Hi Jigar Welcome to Aroma Institute";
export const AVNI_PILOT_TIMEOUT_MS = 8_000;

const e164Schema = z.string().regex(/^\+[1-9][0-9]{7,14}$/);
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
