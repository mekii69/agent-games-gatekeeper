// widongoo — Proof Gatekeeper agent for Agent Games (zkVerify).
// Decision-only Phase 1 Cloudflare Worker (NO proof generation).
// A correct decision without a proof scores +10/task (correct +12, missing proof -2);
// proof generation (Phase 2, optional) would recover the +2 and the reliability bonus.
//
// Routes:
//   GET  /health     readiness: HMAC configured? KV bound? decision self-test?
//   GET  /           agent info
//   POST /gatekeeper signed task requests (preflight + proof-gatekeeper tasks)
//
// Security: every POST is HMAC-SHA256 verified against the raw body BEFORE any
// parsing. Bad signature -> 401, no further work. Every decision response is
// signed the same way. The HMAC secret lives in the Worker as a secret
// (AGENT_GAMES_HMAC_SECRET) and is NEVER in this repo.

import { verifySignature, signBody } from "./hmac.js";
import { decide } from "./decide.js";
import { isPreflight, preflightResponse } from "./preflight.js";
import { getCachedResponse, putCachedResponse, getSeenTaskId, markSeen, hasKv } from "./store.js";

const AGENT_NAME = "widongoo";
const TRACK = "proof-gatekeeper";
const PROTOCOL_VERSION = "v1";

const enc = new TextEncoder();

// JSON response, HMAC-signed when the secret is configured.
async function signedJson(env, obj, status = 200) {
  const body = JSON.stringify(obj);
  const headers = { "Content-Type": "application/json" };
  const secret = env.AGENT_GAMES_HMAC_SECRET;
  if (secret) {
    headers["x-agent-games-signature"] = await signBody(secret, enc.encode(body));
  }
  return new Response(body, { status, headers });
}

function plainJson(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function handleHealth(env) {
  const secret = env.AGENT_GAMES_HMAC_SECRET;
  const selfTest = decide(
    {
      registered_vk: "0xabc",
      proof_vk: "0xabc",
      minimum: "1000",
      public_balance: "1460",
      expiry_block: 19842201,
      current_block: 19832000,
      recipient: "0xde42",
      condition_recipient: "0xde42",
      amount: "500",
      max_transfer: "1000",
      proof_tx: "0xhealth",
    },
    null,
  );
  const selfTestPass = selfTest.decision === "APPROVE" && selfTest.reason_code === "VALID_CONDITION";
  return plainJson({
    ok: true,
    agent: AGENT_NAME,
    track: TRACK,
    protocolVersion: PROTOCOL_VERSION,
    hmacConfigured: Boolean(secret),
    kvConfigured: hasKv(env),
    selfTest: selfTestPass ? "pass" : "fail",
  });
}

async function handleGatekeeper(request, env) {
  const secret = env.AGENT_GAMES_HMAC_SECRET;
  // Without the secret we cannot verify incoming requests or sign responses.
  // This is EXPECTED before registration: the secret is only issued when the
  // agent is registered in the dashboard. Set it, then redeploy.
  if (!secret) {
    return plainJson(
      {
        error: "hmac_secret_not_configured",
        detail: "Set the secret with: wrangler secret put AGENT_GAMES_HMAC_SECRET",
      },
      401,
    );
  }

  const raw = await request.arrayBuffer();
  const sig = request.headers.get("x-agent-games-signature");
  if (!(await verifySignature(secret, raw, sig))) {
    return plainJson({ error: "invalid_signature" }, 401);
  }

  let body;
  try {
    body = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return signedJson(env, { decision: "REJECT", reason_code: "INVALID_INPUT", proof_tx: null }, 200);
  }

  // Preflight handshake.
  if (isPreflight(body)) {
    return signedJson(env, preflightResponse(), 200);
  }

  const taskId = typeof body.task_id === "string" && body.task_id !== "" ? body.task_id : null;
  if (!taskId) {
    return signedJson(
      env,
      {
        decision: "REJECT",
        reason_code: "INVALID_INPUT",
        proof_tx: body && body.input && typeof body.input.proof_tx === "string" ? body.input.proof_tx : null,
      },
      200,
    );
  }

  // Idempotency: the platform retries after network failures — return the
  // IDENTICAL cached response for a repeated task_id.
  const cached = await getCachedResponse(env, taskId);
  if (cached) return signedJson(env, cached, 200);

  const input = body.input && typeof body.input === "object" ? body.input : null;
  const proofTx = input && typeof input.proof_tx === "string" ? input.proof_tx : null;

  // PROOF_REUSED only counts when the proof_tx was seen under a DIFFERENT task_id.
  let seen = null;
  if (proofTx) {
    const seenTaskId = await getSeenTaskId(env, proofTx);
    if (seenTaskId && seenTaskId !== taskId) seen = seenTaskId;
  }

  const { decision, reason_code } = decide(input, seen);
  const response = { decision, reason_code, proof_tx: proofTx };

  if (proofTx) await markSeen(env, proofTx, taskId);
  await putCachedResponse(env, taskId, response);
  return signedJson(env, response, 200);
}

export default {
  async fetch(request, env, _ctx) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") return handleHealth(env);
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "")) {
      return signedJson(env, {
        agent: AGENT_NAME,
        track: TRACK,
        protocolVersion: PROTOCOL_VERSION,
        endpoints: { health: "GET /health", gatekeeper: "POST /gatekeeper" },
      });
    }
    if (request.method === "POST" && url.pathname === "/gatekeeper") {
      return handleGatekeeper(request, env);
    }
    return signedJson(env, { error: "not_found" }, 404);
  },
};
