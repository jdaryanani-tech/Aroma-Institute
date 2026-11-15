import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyMetaGraphError,
  createMetaGraphHttpError,
} from "./graph-error";

const forbiddenValues = [
  "SENTINEL_RAW_MESSAGE",
  "SENTINEL_TOKEN",
  "SENTINEL_PAGE_TOKEN",
  "SENTINEL_URL",
  "SENTINEL_LEAD_ID",
  "SENTINEL_FORM_ID",
  "SENTINEL_PAGE_ID",
  "SENTINEL_FIELD_DATA",
  "SENTINEL_PERSON",
  "SENTINEL_TRACE",
];

test("extracts only allowlisted Graph error primitives and maps a known auth code", () => {
  const body = {
    error: {
      type: "OAuthException",
      code: 190,
      error_subcode: 463,
      is_transient: false,
      message: "SENTINEL_RAW_MESSAGE SENTINEL_TOKEN",
      fbtrace_id: "SENTINEL_TRACE",
      url: "SENTINEL_URL",
      access_token: "SENTINEL_PAGE_TOKEN",
      lead_id: "SENTINEL_LEAD_ID",
      form_id: "SENTINEL_FORM_ID",
      page_id: "SENTINEL_PAGE_ID",
      field_data: { email: "SENTINEL_PERSON" },
    },
    payload: "SENTINEL_FIELD_DATA",
  };
  const diagnostic = classifyMetaGraphError(400, body);

  assert.deepEqual(diagnostic, {
    upstreamHttpStatus: 400,
    errorCategory: "graph_authentication_rejected",
    upstreamErrorType: "OAuthException",
    upstreamErrorCode: 190,
    upstreamErrorSubcode: 463,
    upstreamIsTransient: false,
  });
  const serialized = JSON.stringify(diagnostic);
  for (const value of forbiddenValues) assert.equal(serialized.includes(value), false);
});

test("maps the known permission code and leaves unknown codes generic", () => {
  assert.equal(
    classifyMetaGraphError(400, { error: { type: "OAuthException", code: 200 } }).errorCategory,
    "graph_permission_rejected",
  );
  assert.deepEqual(
    classifyMetaGraphError(400, { error: { type: "GraphMethodException", code: 987654, error_subcode: 42 } }),
    {
      upstreamHttpStatus: 400,
      errorCategory: "graph_http_4xx",
      upstreamErrorType: "GraphMethodException",
      upstreamErrorCode: 987654,
      upstreamErrorSubcode: 42,
    },
  );
  assert.equal(
    classifyMetaGraphError(503, { error: { type: "ServerException", code: 1, is_transient: true } }).errorCategory,
    "graph_http_5xx",
  );
});

test("malformed or non-JSON Graph errors retain only status and a fixed fallback", async () => {
  const error = await createMetaGraphHttpError(400, async () => {
    throw new SyntaxError("SENTINEL_RAW_MESSAGE SENTINEL_TOKEN");
  });

  assert.equal(error.message, "meta_graph_http_400");
  assert.deepEqual(error.diagnostic, {
    upstreamHttpStatus: 400,
    errorCategory: "graph_http_4xx",
    classificationFallbackCode: "graph_error_response_invalid_json",
  });
  const serialized = JSON.stringify({ message: error.message, diagnostic: error.diagnostic });
  for (const value of forbiddenValues) assert.equal(serialized.includes(value), false);
});

test("missing metadata and invalid/unexpected allowlisted values use fixed fallbacks", () => {
  assert.deepEqual(
    classifyMetaGraphError(400, { error: { message: "SENTINEL_RAW_MESSAGE", fbtrace_id: "SENTINEL_TRACE" } }),
    {
      upstreamHttpStatus: 400,
      errorCategory: "graph_http_4xx",
      classificationFallbackCode: "graph_error_metadata_missing",
    },
  );
  assert.deepEqual(
    classifyMetaGraphError(400, { error: { type: "UnknownType", code: 190 } }),
    {
      upstreamHttpStatus: 400,
      errorCategory: "graph_http_4xx",
      classificationFallbackCode: "graph_error_metadata_unexpected_fields",
    },
  );
  assert.deepEqual(
    classifyMetaGraphError(400, { error: { type: "OAuthException", code: "190", is_transient: "false" } }),
    {
      upstreamHttpStatus: 400,
      errorCategory: "graph_http_4xx",
      classificationFallbackCode: "graph_error_metadata_unexpected_fields",
    },
  );
  assert.deepEqual(
    classifyMetaGraphError(400, { error: "SENTINEL_RAW_MESSAGE" }),
    {
      upstreamHttpStatus: 400,
      errorCategory: "graph_http_4xx",
      classificationFallbackCode: "graph_error_response_invalid_shape",
    },
  );
});
