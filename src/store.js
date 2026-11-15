// Seen proof_tx set + task_id -> response cache.
// Uses Workers KV when the GATEKEEPER_KV binding exists; otherwise falls back to
// an in-memory Map. The in-memory fallback works for local testing and for a
// first deploy, but it does NOT survive isolate restarts — KV is required for
// reliable PROOF_REUSED detection and idempotency in production.
// See wrangler.toml for how to create and bind the namespace.

const memory = new Map();

export function hasKv(env) {
  return Boolean(env && env.GATEKEEPER_KV);
}

export async function getCachedResponse(env, taskId) {
  if (hasKv(env)) {
    const raw = await env.GATEKEEPER_KV.get(`task:${taskId}`);
    return raw ? JSON.parse(raw) : null;
  }
  return memory.get(`task:${taskId}`) || null;
}

export async function putCachedResponse(env, taskId, response) {
  if (hasKv(env)) {
    await env.GATEKEEPER_KV.put(`task:${taskId}`, JSON.stringify(response));
    return;
  }
  memory.set(`task:${taskId}`, response);
}

// Returns the task_id that first used this proof_tx, or null if never seen.
export async function getSeenTaskId(env, proofTx) {
  const key = `seen:${proofTx.toLowerCase()}`;
  if (hasKv(env)) return await env.GATEKEEPER_KV.get(key);
  return memory.get(key) || null;
}

export async function markSeen(env, proofTx, taskId) {
  const key = `seen:${proofTx.toLowerCase()}`;
  if (hasKv(env)) {
    await env.GATEKEEPER_KV.put(key, taskId);
    return;
  }
  memory.set(key, taskId);
}
