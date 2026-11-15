// Tests for the Proof Gatekeeper decision checklist + HMAC + preflight.
// Run: npm test   (node --test test/)

import { test } from "node:test";
import assert from "node:assert/strict";
import { decide } from "../src/decide.js";
import { verifySignature, signBody, parseSignatureHeader } from "../src/hmac.js";
import { isPreflight, preflightResponse } from "../src/preflight.js";

const enc = new TextEncoder();

// Canned valid task (from the official event page sample).
function validInput(overrides = {}) {
  return {
    registered_vk: "0x7d3a1111",
    proof_vk: "0x7d3a1111",
    minimum: "1000",
    public_balance: "1460",
    expiry_block: 19842201,
    current_block: 19832000,
    recipient: "0xDe420001",
    condition_recipient: "0xDe420001",
    amount: "500",
    max_transfer: "1000",
    proof_tx: "0xa4c1aaaa",
    ...overrides,
  };
}

// --- Decision checklist ---

test("valid condition -> APPROVE", () => {
  assert.deepEqual(decide(validInput(), null), {
    decision: "APPROVE",
    reason_code: "VALID_CONDITION",
  });
});

test("trap 1: proof_vk != registered_vk -> VK_SUBSTITUTION", () => {
  assert.deepEqual(decide(validInput({ proof_vk: "0xa4c1bbbb" }), null), {
    decision: "REJECT",
    reason_code: "VK_SUBSTITUTION",
  });
});

test("trap 2: proof_tx seen under a different task_id -> PROOF_REUSED", () => {
  assert.deepEqual(decide(validInput(), "gk_24_other"), {
    decision: "REJECT",
    reason_code: "PROOF_REUSED",
  });
});

test("trap 3: public_balance < minimum -> THRESHOLD_MISMATCH", () => {
  assert.deepEqual(decide(validInput({ public_balance: "999" }), null), {
    decision: "REJECT",
    reason_code: "THRESHOLD_MISMATCH",
  });
});

test("trap 4: current_block > expiry_block -> EXPIRED_CONDITION", () => {
  assert.deepEqual(decide(validInput({ current_block: 19842202 }), null), {
    decision: "REJECT",
    reason_code: "EXPIRED_CONDITION",
  });
});

test("trap 5: recipient != condition_recipient -> RECIPIENT_MISMATCH", () => {
  assert.deepEqual(decide(validInput({ recipient: "0xDe420002" }), null), {
    decision: "REJECT",
    reason_code: "RECIPIENT_MISMATCH",
  });
});

test("trap 6: amount > max_transfer -> AMOUNT_OVERFLOW", () => {
  assert.deepEqual(decide(validInput({ amount: "1001" }), null), {
    decision: "REJECT",
    reason_code: "AMOUNT_OVERFLOW",
  });
});

test("first failing trap wins (VK beats threshold)", () => {
  assert.deepEqual(
    decide(validInput({ proof_vk: "0xa4c1bbbb", public_balance: "1" }), null),
    { decision: "REJECT", reason_code: "VK_SUBSTITUTION" },
  );
});

// --- Boundary cases ---

test("boundary: balance == minimum is VALID", () => {
  const r = decide(validInput({ public_balance: "1000" }), null);
  assert.equal(r.decision, "APPROVE");
});

test("boundary: amount == max_transfer is VALID", () => {
  const r = decide(validInput({ amount: "1000" }), null);
  assert.equal(r.decision, "APPROVE");
});

test("boundary: current_block == expiry_block is EXPIRED", () => {
  assert.deepEqual(decide(validInput({ current_block: 19842201 }), null), {
    decision: "REJECT",
    reason_code: "EXPIRED_CONDITION",
  });
});

test("boundary: current_block one below expiry is VALID", () => {
  const r = decide(validInput({ current_block: 19842200 }), null);
  assert.equal(r.decision, "APPROVE");
});

test("large values use BigInt (no float precision loss)", () => {
  const r = decide(
    validInput({
      minimum: "9007199254740993",
      public_balance: "9007199254740993",
      amount: "9007199254740993",
      max_transfer: "9007199254740993",
    }),
    null,
  );
  assert.equal(r.decision, "APPROVE");
});

// --- Fail closed ---

test("fail closed: missing field -> INVALID_INPUT", () => {
  const input = validInput();
  delete input.proof_tx;
  assert.deepEqual(decide(input, null), { decision: "REJECT", reason_code: "INVALID_INPUT" });
});

test("fail closed: non-numeric balance -> INVALID_INPUT", () => {
  assert.deepEqual(decide(validInput({ public_balance: "abc" }), null), {
    decision: "REJECT",
    reason_code: "INVALID_INPUT",
  });
});

test("fail closed: null input -> INVALID_INPUT", () => {
  assert.deepEqual(decide(null, null), { decision: "REJECT", reason_code: "INVALID_INPUT" });
});

// --- HMAC ---

const SECRET = "a".repeat(64); // 32-byte hex secret (test value only, never a real secret)

test("hmac: sign then verify passes", async () => {
  const body = enc.encode('{"type":"agent-games.preflight.v1"}');
  const sig = await signBody(SECRET, body);
  assert.equal(await verifySignature(SECRET, body, sig), true);
});

test("hmac: tampered body fails", async () => {
  const body = enc.encode('{"type":"agent-games.preflight.v1"}');
  const sig = await signBody(SECRET, body);
  assert.equal(await verifySignature(SECRET, enc.encode('{"type":"tampered"}'), sig), false);
});

test("hmac: wrong secret fails", async () => {
  const body = enc.encode("{}");
  const sig = await signBody(SECRET, body);
  assert.equal(await verifySignature("b".repeat(64), body, sig), false);
});

test("hmac: sha256= prefixed header accepted", async () => {
  const body = enc.encode("{}");
  const sig = await signBody(SECRET, body);
  assert.equal(await verifySignature(SECRET, body, `sha256=${sig}`), true);
});

test("hmac: missing header fails", async () => {
  assert.equal(await verifySignature(SECRET, enc.encode("{}"), null), false);
});

test("hmac: parseSignatureHeader strips sha256= prefix", () => {
  assert.equal(parseSignatureHeader("sha256=ABCDEF"), "abcdef");
  assert.equal(parseSignatureHeader("ABCDEF"), "abcdef");
});

// --- Preflight ---

test("preflight: envelope detected, response shape correct", () => {
  assert.equal(isPreflight({ type: "agent-games.preflight.v1" }), true);
  assert.equal(isPreflight({ type: "agent-games.proof-gatekeeper.v1" }), false);
  assert.deepEqual(preflightResponse(), { ok: true, protocolVersion: "v1" });
});
