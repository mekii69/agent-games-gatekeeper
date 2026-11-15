// Preflight handshake (Agent Games rules 1.7).
// The dashboard sends {"type":"agent-games.preflight.v1"} and the endpoint must
// answer {"ok":true,"protocolVersion":"v1"}, HMAC-signed, before any task is
// dispatched. A preflight that returns unsigned JSON fails with:
// "The endpoint must return signed protocol-v1 JSON".

export const PREFLIGHT_TYPE = "agent-games.preflight.v1";

export function isPreflight(body) {
  return Boolean(body && body.type === PREFLIGHT_TYPE);
}

export function preflightResponse() {
  return { ok: true, protocolVersion: "v1" };
}
