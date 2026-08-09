// The hand-written Kotlin wire DTOs must agree with the frozen OpenAPI.
//
// core-network/.../dto/MobileDtos.kt is NOT generated: it is maintained by hand
// against contracts/openapi-mobile-v1.json. Nothing compared the two, and the
// drift that accumulated was not cosmetic -- it silently broke every shared
// endpoint:
//
//   * SharedResourceSummary declared `ownerLabel`; the server sends
//     `ownerDisplayName`. kotlinx fills a missing String field from its default,
//     so every shared row rendered with a blank owner and the residency UI could
//     not tell the user whose resource it was.
//   * The list DTO read `resources`; the frozen 200 body is `{ items,
//     nextPageToken }`. The shared directory therefore parsed as permanently
//     empty while the server was returning rows.
//   * The session request sent `{ purpose, clientNonce, requestDirect }` against
//     a schema that is `additionalProperties: false` and requires
//     `{ mode, clientSessionNonce, requestedChannels, deviceKeyVersion }`, so the
//     request was rejected outright rather than merely misread.
//   * The file-bridge body sent `connectionId`/`rootLabel`/`ttlSeconds` where the
//     schema requires `shareProfileIds`.
//
// A compiler cannot catch any of this: the Kotlin compiles, and kotlinx ignores
// unknown keys by configuration. Only a comparison against the contract can, so
// this test is that comparison.
//
// Scope: request bodies are checked strictly in both directions, because a
// schema with `additionalProperties: false` rejects a body carrying an unknown
// key. Response DTOs are checked for the required properties plus the absence of
// keys the server never sends; extra *nullable* fields are allowed, because
// several 200 schemas are deliberately free-form and the server enriches them.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const mobileRoot = path.resolve(here, "..");
const dtoPath = path.join(
  mobileRoot,
  "android/core-network/src/main/kotlin/one/zephyr/mobile/network/dto/MobileDtos.kt",
);

const api = JSON.parse(
  fs.readFileSync(path.join(mobileRoot, "contracts/openapi-mobile-v1.json"), "utf8"),
);
const kotlin = fs.readFileSync(dtoPath, "utf8");

/** Kotlin source with comments removed, so doc prose cannot be read as a field. */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/** Parses `data class Name(...)` bodies into field descriptors. */
function parseDtos(source) {
  const clean = stripComments(source);
  const out = new Map();
  const classRe = /data class (\w+)\s*\(([\s\S]*?)\n\)/g;
  let match;
  while ((match = classRe.exec(clean)) !== null) {
    const fields = new Map();
    const fieldRe = /\bval\s+(\w+)\s*:\s*([^=,\n]+?)\s*(=\s*[^,\n]+)?\s*(?:,|$)/gm;
    let f;
    while ((f = fieldRe.exec(match[2])) !== null) {
      const type = f[2].trim();
      fields.set(f[1], {
        type,
        nullable: type.endsWith("?"),
        hasDefault: Boolean(f[3]),
      });
    }
    out.set(match[1], fields);
  }
  return out;
}

const dtos = parseDtos(kotlin);

function dto(name) {
  const found = dtos.get(name);
  assert.ok(found, name + " must be declared in MobileDtos.kt");
  return found;
}

function schemaOf(ref) {
  const key = ref.replace("#/components/schemas/", "");
  const found = api.components.schemas[key];
  assert.ok(found, "schema " + key + " must exist in the frozen OpenAPI");
  return found;
}

function requestSchema(pathKey, method) {
  const op = api.paths[pathKey] && api.paths[pathKey][method];
  assert.ok(op, method.toUpperCase() + " " + pathKey + " must exist");
  const body = op.requestBody.content["application/json"].schema;
  return body.$ref ? schemaOf(body.$ref) : body;
}

function responseSchema(pathKey, method) {
  const op = api.paths[pathKey] && api.paths[pathKey][method];
  assert.ok(op, method.toUpperCase() + " " + pathKey + " must exist");
  const body = op.responses["200"].content["application/json"].schema;
  return body.$ref ? schemaOf(body.$ref) : body;
}

/**
 * True when a property schema permits a null value, either by being unconstrained
 * or by naming null in its type union.
 */
function allowsNull(property) {
  if (!property || typeof property !== "object") return true;
  if (Object.keys(property).length === 0) return true;
  const type = property.type;
  if (type === undefined) return true;
  return Array.isArray(type) ? type.includes("null") : type === "null";
}

/**
 * A request body must be an exact match when the schema is closed: an unknown key
 * is rejected by the server, and a missing required key never reaches it.
 */
function assertClosedRequest(dtoName, schema, { allowOmitted = [] } = {}) {
  const fields = dto(dtoName);
  assert.equal(
    schema.additionalProperties,
    false,
    dtoName + " is checked strictly, so its schema must be closed",
  );

  for (const key of Object.keys(schema.properties || {})) {
    if (allowOmitted.includes(key)) continue;
    assert.ok(fields.has(key), dtoName + " must carry the schema property " + key);
  }
  for (const [name] of fields) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(schema.properties || {}, name),
      dtoName + " sends " + name + ", which the closed schema rejects",
    );
  }
  for (const key of schema.required || []) {
    const field = fields.get(key);
    assert.ok(field, dtoName + " must carry the required property " + key);
    assert.equal(
      field.nullable,
      false,
      dtoName + "." + key + " is required by the schema, so it must not be nullable",
    );
  }
}

/**
 * A response DTO must carry every required property as non-nullable, must not
 * invent keys the server does not send, and may add nullable enrichment fields.
 */
function assertResponse(dtoName, schema, { extras = [] } = {}) {
  const fields = dto(dtoName);
  const declared = new Set(Object.keys(schema.properties || {}));

  for (const key of schema.required || []) {
    const field = fields.get(key);
    assert.ok(field, dtoName + " must carry the required property " + key);
    /* `required` in JSON Schema means the key is present, not that its value is
     * non-null. Where the property schema is unconstrained (`{}`) or explicitly
     * admits null, a nullable Kotlin field is the accurate model -- forcing it
     * non-null would crash the parse on a legal response. Only a property with a
     * concrete, non-null type must be non-nullable on this side. */
    if (!allowsNull(schema.properties && schema.properties[key])) {
      assert.equal(
        field.nullable,
        false,
        dtoName + "." + key + " is required with a concrete type, so a nullable field would hide a malformed response",
      );
    }
  }
  for (const [name, field] of fields) {
    if (declared.has(name) || extras.includes(name)) continue;
    assert.ok(
      field.nullable || field.hasDefault,
      dtoName + " declares " + name + ", which is not in the schema, so it must be optional",
    );
  }
}

test("the shared summary DTO uses the schema field names, not invented ones", () => {
  const schema = schemaOf("#/components/schemas/SharedResourceSummary");
  assertResponse("SharedResourceSummaryDto", schema, {
    // Detail-only enrichment: GET /shared/{type}/{id} has a free-form 200 body
    // and the server adds non-secret connect metadata there.
    extras: ["protocol", "host", "port", "username", "directUseAllowed", "hasContent"],
  });

  const fields = dto("SharedResourceSummaryDto");
  assert.ok(
    fields.has("ownerDisplayName"),
    "the owner display name must use the schema key ownerDisplayName",
  );
  assert.ok(
    !fields.has("ownerLabel"),
    "ownerLabel is not a key the server sends; the row would render a blank owner",
  );
});

test("the shared list DTO reads items, which is what the server returns", () => {
  const schema = responseSchema("/api/mobile/v1/shared", "get");
  assert.deepEqual(
    schema.required,
    ["items"],
    "the frozen list body requires items",
  );

  const fields = dto("SharedListDto");
  assert.ok(fields.has("items"), "the list DTO must read items");
  assert.ok(
    !fields.has("resources"),
    "reading resources yields an always-empty directory",
  );
  assert.ok(fields.has("nextPageToken"), "the pagination key must be readable");
});

test("the session request body matches the closed schema exactly", () => {
  const schema = requestSchema(
    "/api/mobile/v1/shared/connections/{connectionId}/sessions",
    "post",
  );
  assertClosedRequest("SharedSessionRequestDto", schema);

  const fields = dto("SharedSessionRequestDto");
  // The exact keys that were wrong before, named so a regression is unambiguous.
  assert.ok(fields.has("mode"), "the server switches on mode");
  assert.ok(!fields.has("purpose"), "purpose is not a key in this body");
  assert.ok(!fields.has("requestDirect"), "requestDirect is not a key in this body");
  assert.ok(fields.has("clientSessionNonce"), "the nonce key is clientSessionNonce");
  assert.ok(!fields.has("clientNonce"), "clientNonce is the envelope field, not the request field");
});

test("the refresh body carries the nonce the schema requires", () => {
  const schema = requestSchema(
    "/api/mobile/v1/shared/sessions/{sessionId}/refresh",
    "post",
  );
  assertClosedRequest("SharedSessionRefreshDto", schema);
  assert.ok(
    dto("SharedSessionRefreshDto").has("clientSessionNonce"),
    "refresh re-seals against a fresh nonce, so it must be sent",
  );
});

test("the session response reads useEnvelope and relay, not relayUrl", () => {
  const schema = schemaOf("#/components/schemas/SharedSessionResponse");
  assertResponse("SharedSessionResponseDto", schema);

  const fields = dto("SharedSessionResponseDto");
  assert.ok(fields.has("useEnvelope"), "direct mode returns useEnvelope");
  assert.ok(fields.has("relay"), "relay mode returns a relay object");
  assert.ok(
    !fields.has("relayUrl"),
    "relayUrl is not a top-level key; the URL lives inside relay",
  );
  assert.ok(
    !fields.has("envelope"),
    "the envelope key is useEnvelope; a wrong name silently drops the credential",
  );
});

test("the relay descriptor is modelled, so the attach URL and credential survive parsing", () => {
  const schema = schemaOf("#/components/schemas/SharedSessionResponse");
  const relay = schema.properties.relay;
  assert.equal(relay.additionalProperties, false, "the relay object is closed");

  const fields = dto("SharedRelayDto");
  for (const key of Object.keys(relay.properties)) {
    assert.ok(fields.has(key), "SharedRelayDto must read " + key);
  }
});

test("the invoke request and response carry revision, which the server requires", () => {
  assertClosedRequest(
    "SharedInvokeRequestDto",
    schemaOf("#/components/schemas/SharedInvokeRequest"),
  );

  const responseSchemaBody = schemaOf("#/components/schemas/SharedInvokeResponse");
  assertResponse("SharedInvokeResponseDto", responseSchemaBody);
  assert.ok(
    dto("SharedInvokeRequestDto").has("expectedRevision"),
    "a note update without expectedRevision is refused with revision_required",
  );
  assert.ok(
    dto("SharedInvokeResponseDto").has("revision"),
    "the client needs the revision to send back on the next edit",
  );
});

test("the file-bridge lease body sends shareProfileIds", () => {
  const schema = requestSchema("/api/mobile/v1/file-bridge/lease", "post");
  const fields = dto("FileBridgeLeaseRequestDto");

  for (const key of schema.required || []) {
    assert.ok(fields.has(key), "the lease body must carry " + key);
  }
  for (const gone of ["connectionId", "rootLabel", "ttlSeconds"]) {
    assert.ok(
      !fields.has(gone),
      gone + " was never part of the frozen lease body",
    );
  }
});

test("every shared path the client calls is a path the contract declares", () => {
  const clientDir = path.join(mobileRoot, "android/core-network/src/main/kotlin/one/zephyr/mobile/network");
  const sources = fs.readdirSync(clientDir)
    .filter((name) => name.endsWith(".kt"))
    .map((name) => fs.readFileSync(path.join(clientDir, name), "utf8"))
    .join("\n");

  /* A literal path built by hand in the client is how a route drifts out of the
   * contract unnoticed, so any /api/mobile/v1 string literal must correspond to
   * a declared path once its interpolated segments are normalised. */
  const declared = new Set(Object.keys(api.paths));
  const literals = sources.match(/"\/api\/mobile\/v1[^"]*"/g) || [];
  for (const raw of literals) {
    const literal = raw.slice(1, -1);
    const normalised = literal.replace(/\/$/, "");
    const matches = [...declared].some((candidate) => {
      const pattern = "^" + candidate.replace(/\{[^}]+\}/g, "[^/]*") + "$";
      // A client literal may be a prefix that gets an id appended at runtime.
      return new RegExp(pattern).test(normalised)
        || candidate.startsWith(normalised)
        || new RegExp("^" + candidate.replace(/\{[^}]+\}/g, "[^/]*")).test(normalised);
    });
    assert.ok(matches, "client path literal " + literal + " is not declared in the OpenAPI");
  }
});
