// Pure deterministic 7-trap checklist for Proof Gatekeeper tasks.
// No I/O, no network — safe to unit test exhaustively.
//
// Traps are evaluated in order; the FIRST failing trap wins.
//   1. VK_SUBSTITUTION     proof_vk != registered_vk            -> REJECT
//   2. PROOF_REUSED        proof_tx seen under a DIFFERENT task -> REJECT
//   3. THRESHOLD_MISMATCH  public_balance < minimum             -> REJECT
//   4. EXPIRED_CONDITION   current_block > expiry_block         -> REJECT
//   5. RECIPIENT_MISMATCH  recipient != condition_recipient     -> REJECT
//   6. AMOUNT_OVERFLOW     amount > max_transfer                -> REJECT
//   7. VALID_CONDITION     everything checks out                -> APPROVE
//
// Boundary rules (verified against the circuit by the example repo):
//   - balance == minimum is VALID (threshold is inclusive)
//   - amount == max_transfer is VALID (cap is inclusive)
//   - current_block == expiry_block is EXPIRED (valid only while current < expiry)
//
// Any parse error, missing field, or uncertainty -> REJECT (fail closed).

export const REASONS = {
  VALID_CONDITION: "VALID_CONDITION",
  VK_SUBSTITUTION: "VK_SUBSTITUTION",
  PROOF_REUSED: "PROOF_REUSED",
  THRESHOLD_MISMATCH: "THRESHOLD_MISMATCH",
  EXPIRED_CONDITION: "EXPIRED_CONDITION",
  RECIPIENT_MISMATCH: "RECIPIENT_MISMATCH",
  AMOUNT_OVERFLOW: "AMOUNT_OVERFLOW",
  INVALID_INPUT: "INVALID_INPUT",
};

function toBigInt(value) {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return Number.isInteger(value) ? BigInt(value) : null;
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
    try {
      return BigInt(value.trim());
    } catch {
      return null;
    }
  }
  return null;
}

function toBlockNumber(value) {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

function normAddr(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim().toLowerCase() : null;
}

// input: the task `input` object.
// seenTaskIdForProofTx: the task_id that previously used this proof_tx, or
// null/undefined if the proof_tx was never seen. The CALLER must pass null when
// the seen task_id equals the current task_id (a retry of the same task is NOT
// reuse — retries are handled by the response cache before decide() is called).
export function decide(input, seenTaskIdForProofTx) {
  if (!input || typeof input !== "object") {
    return { decision: "REJECT", reason_code: "INVALID_INPUT" };
  }
  const {
    registered_vk,
    proof_vk,
    minimum,
    public_balance,
    expiry_block,
    current_block,
    recipient,
    condition_recipient,
    amount,
    max_transfer,
    proof_tx,
  } = input;

  if (!registered_vk || !proof_vk || !proof_tx || !recipient || !condition_recipient) {
    return { decision: "REJECT", reason_code: "INVALID_INPUT" };
  }

  const min = toBigInt(minimum);
  const bal = toBigInt(public_balance);
  const amt = toBigInt(amount);
  const max = toBigInt(max_transfer);
  const expiry = toBlockNumber(expiry_block);
  const current = toBlockNumber(current_block);
  if (min === null || bal === null || amt === null || max === null || expiry === null || current === null) {
    return { decision: "REJECT", reason_code: "INVALID_INPUT" };
  }

  const rvk = normAddr(registered_vk);
  const pvk = normAddr(proof_vk);
  const rcpt = normAddr(recipient);
  const crcpt = normAddr(condition_recipient);
  const ptx = normAddr(proof_tx);
  if (!rvk || !pvk || !rcpt || !crcpt || !ptx) {
    return { decision: "REJECT", reason_code: "INVALID_INPUT" };
  }

  // Trap 1: VK substitution (a valid proof for the wrong condition is still a reject).
  if (pvk !== rvk) return { decision: "REJECT", reason_code: "VK_SUBSTITUTION" };
  // Trap 2: proof reused under a different task_id.
  if (seenTaskIdForProofTx) return { decision: "REJECT", reason_code: "PROOF_REUSED" };
  // Trap 3: threshold (balance == minimum is VALID).
  if (bal < min) return { decision: "REJECT", reason_code: "THRESHOLD_MISMATCH" };
  // Trap 4: expiry — strict (current_block == expiry_block is EXPIRED).
  if (current >= expiry) return { decision: "REJECT", reason_code: "EXPIRED_CONDITION" };
  // Trap 5: recipient mismatch.
  if (rcpt !== crcpt) return { decision: "REJECT", reason_code: "RECIPIENT_MISMATCH" };
  // Trap 6: amount overflow (amount == max_transfer is VALID).
  if (amt > max) return { decision: "REJECT", reason_code: "AMOUNT_OVERFLOW" };
  // Trap 7: valid condition.
  return { decision: "APPROVE", reason_code: "VALID_CONDITION" };
}
