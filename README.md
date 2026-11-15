# widongoo — Proof Gatekeeper agent for Agent Games (zkVerify)

Decision-only Phase 1 agent for the **Proof Gatekeeper** track of
[Agent Games](https://agentgames.zkverify.io/dashboard) (zkVerify, Season 01).
Runs as a Cloudflare Worker. It judges proof-backed payment requests
(APPROVE / REJECT) using the published 7-trap checklist. **No proof
generation in Phase 1** — a correct decision without a proof still scores
+10/task (correct +12, missing proof −2); proof generation is an optional
Phase 2 (see below).

- **Agent name:** `widongoo`
- **Track:** Proof Gatekeeper
- **Owner:** Farhan Kurnia (X [@widongoo](https://x.com/widongoo))
- **Prize wallet (VFY distribution):** `0x8919e0Af16604E60417c6B7415208d975DD01105` (main wallet)
- **Competition closes:** 21 Nov 2026. Scored rounds 04–08: 16–20 Nov, 17:30–03:30 WIB.
- **Rewards pool:** 400K $VFY (whole competition).

## How it works

The platform POSTs a signed task envelope to `POST /gatekeeper`. The Worker:

1. Verifies `x-agent-games-signature` (HMAC-SHA256 over the **raw** body)
   **before parsing anything**. Bad signature → 401, no further work.
2. Answers preflight `{"type":"agent-games.preflight.v1"}` with
   `{ok:true, protocolVersion:"v1"}`, signed.
3. Returns the **identical cached response** for a repeated `task_id`
   (idempotency — the platform retries after network failures).
4. Runs the 7-trap checklist (first failing trap wins):

| # | Trap | Check | Result |
|---|------|-------|--------|
| 1 | `VK_SUBSTITUTION` | `proof_vk != registered_vk` | REJECT |
| 2 | `PROOF_REUSED` | `proof_tx` seen under a *different* `task_id` (same-task retry is NOT reuse) | REJECT |
| 3 | `THRESHOLD_MISMATCH` | `public_balance < minimum` | REJECT |
| 4 | `EXPIRED_CONDITION` | `current_block > expiry_block` | REJECT |
| 5 | `RECIPIENT_MISMATCH` | `recipient != condition_recipient` | REJECT |
| 6 | `AMOUNT_OVERFLOW` | `amount > max_transfer` | REJECT |
| 7 | `VALID_CONDITION` | everything checks out | APPROVE |

Boundary rules: `balance == minimum` is VALID, `amount == max_transfer` is
VALID, but `current_block == expiry_block` is EXPIRED (valid only while
`current_block < expiry_block`). Any parse error, missing field, or
uncertainty → REJECT (fail closed).

5. Responds with signed JSON: `{"decision":"APPROVE"|"REJECT","reason_code":"...","proof_tx":"0x..."}`.

Scoring (per task): correct decision +12 · incorrect APPROVE −6 · incorrect
REJECT −3 · timeout −2 · missing/invalid proof −2 · reliability bonus +0 to +5
(pro-rated by verified proofs; PROOF_REUSED tasks excluded).

## Architecture

```
src/index.js      Worker entry: GET /health, GET /, POST /gatekeeper
src/hmac.js       HMAC-SHA256 verify (incoming) + sign (outgoing), WebCrypto
src/decide.js     7-trap checklist (pure, fully unit-tested)
src/store.js      Workers KV: seen proof_tx set + task_id -> response cache
src/preflight.js  preflight handshake
test/decide.test.js  all 7 traps + boundary cases + HMAC + preflight
```

The HMAC secret is **never in this repo**. It is issued once at agent
registration and set as a Worker secret (see below). Until it is set,
`POST /gatekeeper` returns 401 `hmac_secret_not_configured` — that is
expected; `GET /health` reports `hmacConfigured: false`.

`GET /health` returns readiness:
`{ok, agent, track, protocolVersion, hmacConfigured, kvConfigured, selfTest}`.
The self-test runs the checklist against a canned valid task.

## Deploy

```bash
npm install
npm test            # 23 tests: traps, boundaries, HMAC, preflight
npx wrangler deploy # -> https://agent-games-gatekeeper.<subdomain>.workers.dev
```

Then create the KV namespace (needed for reliable PROOF_REUSED detection +
idempotency across isolates):

```bash
npx wrangler kv namespace create GATEKEEPER_KV
# paste the returned id into wrangler.toml (uncomment the [[kv_namespaces]] block)
npx wrangler deploy
```

## Register the agent (dashboard — after deploy)

1. Sign in at https://agentgames.zkverify.io/dashboard as @widongoo.
2. Link GitHub (this repo, in the owner's own account) + the prize wallet
   `0x8919e0Af16604E60417c6B7415208d975DD01105` (prize eligibility).
3. Register the agent: name `widongoo`, track **Proof Gatekeeper**, repo URL
   (this repo), endpoint URL `https://agent-games-gatekeeper.<subdomain>.workers.dev/gatekeeper`.
4. **Copy the 32-byte HMAC secret shown exactly once**, then set it and redeploy:
   ```bash
   npx wrangler secret put AGENT_GAMES_HMAC_SECRET
   npx wrangler deploy
   ```
   Verify: `GET /health` should show `hmacConfigured: true`, `selfTest: "pass"`.
5. Run the dashboard **preflight** — it must return healthy (signed
   `protocol-v1` JSON). If it fails with "The endpoint must return signed
   protocol-v1 JSON", the secret is not set or the signature format is wrong.
6. Run at least **one practice task** (cap 10/hour) and confirm the decision +
   reason code in the debugging history.
7. Register **outside round hours** — entries lock while a round is open
   (rounds run 17:30–03:30 WIB; register 03:30–17:30 WIB).

## Phase 2 (optional): proof generation

To recover the +2/task and the reliability bonus, the agent must generate a
Groth16 proof per decision with snarkjs + the official circuit
(`gatekeeper.wasm` / `gatekeeper_final.zkey` from
https://agentgames.zkverify.io/api/circuit-info). snarkjs `fullProve` does
**not** fit in a free-tier Worker's CPU limits, so Phase 2 means deploying the
same logic to a Node host (Vercel Hobby or Railway free tier — both proven by
the example repos) and pointing the dashboard at that URL instead. The
Worker stays as the fallback.

## References

- Builder Field Guide: https://agentgames.zkverify.io/build
- Rules: https://agentgames.zkverify.io/rules
- Guide: https://agentgames.zkverify.io/guide
- Proof Gatekeeper event: https://agentgames.zkverify.io/events/proof-gatekeeper
- Circuit info: https://agentgames.zkverify.io/api/circuit-info
- Working example repo: https://github.com/subastian1998/agent-games-season-01
