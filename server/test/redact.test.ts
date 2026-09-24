import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { CREDENTIAL_REDACTION } from "../src/plugins/credential.ts";
import { redactForOutbound } from "../src/redact.ts";

const RANDOM_PART = "AbCdEfGhIjKlMnOpQrStUvWxYz012345";
const PRODUCTION_KEY = `sk${RANDOM_PART}`;
const MASKED_KEY = `sk-${CREDENTIAL_REDACTION}`;

describe("redactForOutbound", () => {
  test("redacts the production no-separator key shape", () => {
    assert.equal(redactForOutbound(PRODUCTION_KEY), MASKED_KEY);
  });

  test("redacts the configured hyphen and underscore key shapes", () => {
    assert.equal(redactForOutbound(`sk-${RANDOM_PART}`), MASKED_KEY);
    assert.equal(redactForOutbound(`sk_${RANDOM_PART}`), MASKED_KEY);
  });

  test("does not redact short sk strings or ordinary words", () => {
    const shortPart = "AbCdEfGhIjKlMnOpQr";
    const input = `sk${shortPart} sk-${shortPart} sk_${shortPart} skate sketch skill`;
    assert.equal(redactForOutbound(input), input);
  });

  test("requires a token boundary around the key shape", () => {
    const input = `prefix=${PRODUCTION_KEY}; suffix=x${PRODUCTION_KEY}`;
    assert.equal(redactForOutbound(input), `prefix=${MASKED_KEY}; suffix=x${PRODUCTION_KEY}`);
  });

  test("is idempotent", () => {
    const input = `before ${PRODUCTION_KEY} after`;
    const once = redactForOutbound(input);
    assert.equal(redactForOutbound(once), once);
  });

  test("continues to redact Bearer authorization values", () => {
    assert.equal(
      redactForOutbound(`Authorization: Bearer ${PRODUCTION_KEY}`),
      "Authorization: Bearer ***",
    );
  });
});
