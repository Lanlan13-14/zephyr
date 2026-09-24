# AI Contract v2

Single source of truth for the Zephyr AI unification (master spec Phase 1).
Every structure, capability enum, stream frame and error code in this directory
is defined once as JSON Schema and regenerated into all four runtimes. Hand
maintaining a parallel field map is forbidden by the master spec section 1.1.

## Layout

- `*.schema.json` - the only contract source. `common.schema.json` owns the
  shared id, revision, URI, sha256 and tristate primitives.
- `error-taxonomy.json` - the only registry of retryable vs terminal AI errors.
- `testdata/golden-vectors.json` - accepted documents plus documents that must
  fail closed (numeric `-1` sentinels, missing stop reasons, scope violations).
- `testdata/canonical-bytes.json` - byte-stable canonical JSON for every golden
  vector; the cross-language replay gate.

## Generate

```sh
node scripts/generate-ai-contracts.mjs
node scripts/generate-ai-contracts.mjs --check
```

Outputs, all generated and checked in:

- `src/generated/ai-contract-v2.js` - Node control plane enums and error helpers.
- `zephyr-ai/contracts/v2/contract.go` - Go shared core enums and error helpers.
- `zephyr_one/mobile/android/core-contracts/.../aiv2/AIContractV2.kt` - Kotlin enums.
- `zephyr_one/mobile/ios/Sources/ZephyrContracts/Generated/AIV2/AIContractV2.swift` - Swift enums.
- `contracts/ai/v2/GENERATED_MANIFEST.json` - sha256 of every generated artifact.

## Test

```sh
node --test tests/ai-contract-v2.test.mjs
cd zephyr-ai && go test ./contracts/v2/
```

The Node suite asserts schema closure, golden validation, fail-closed
rejections, canonical byte stability, generator drift and identical error-code
order across all four languages. The Go suite asserts the generated package
answers the same taxonomy and replays the same golden documents.

## Rules for later phases

- Phase 2 (TransportTarget) and Phase 4 (Link sync envelopes) consume the
  schemas in this directory; they do not fork them.
- New fields arrive here first, then the generator, then the per-platform code.
  A platform file that disagrees with this directory is a bug in the platform.
- `temperature: -1` and hard-coded model defaults are legacy v1 behavior. The
  v2 contract uses `{ mode: inherit | omit | value }` and adapters must lock
  temperature to `omit` when the model descriptor sets `disallowsTemperature`.
