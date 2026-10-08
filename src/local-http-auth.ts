import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { PluginRequest, PluginResponse } from "./mcp-http-handler.js";

const COOKIE = "orgx_gateway_session";
const SESSION_MS = 8 * 60 * 60 * 1000;
const digest = (value: string) => createHash("sha256").update(value).digest();
const equal = (a: string, b: string) => timingSafeEqual(digest(a), digest(b));

export function createLocalHttpAuth(getToken: () => string | undefined) {
  const sessions = new Map<string, { expires: number; token: string }>();
  return (req: PluginRequest, res: PluginResponse): boolean => {
    const path = (req.url ?? "").split("?")[0];
    if (!/^\/orgx\/(?:api|mcp)(?:\/|$)/.test(path)) return true;
    const reject = (status: number, error: string) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ error }));
      return false;
    };
    const host = req.headers.host;
    if (typeof host !== "string") return reject(403, "Invalid local gateway host");
    let authority: URL;
    try { authority = new URL(`http://${host}`); }
    catch { return reject(403, "Invalid local gateway host"); }
    if (!["localhost", "127.0.0.1", "[::1]"].includes(authority.hostname)) {
      return reject(403, "Use the local gateway address");
    }
    const origin = req.headers.origin;
    if (origin !== undefined) {
      try {
        if (typeof origin !== "string" || new URL(origin).host !== authority.host ||
            !["http:", "https:"].includes(new URL(origin).protocol)) {
          return reject(403, "Cross-origin gateway requests are blocked");
        }
      } catch { return reject(403, "Cross-origin gateway requests are blocked"); }
    }
    if (req.headers["sec-fetch-site"] === "cross-site") {
      return reject(403, "Cross-origin gateway requests are blocked");
    }
    const token = getToken()?.trim();
    if (!token || token.startsWith("${")) return reject(503, "Configure an OpenClaw gateway token");
    const authorization = req.headers.authorization;
    const bearer = typeof authorization === "string" && authorization.startsWith("Bearer ")
      ? authorization.slice(7) : "";
    const cookie = typeof req.headers.cookie === "string"
      ? req.headers.cookie.split(";").map(value => value.trim()).find(value => value.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1)
      : undefined;
    const now = Date.now();
    for (const [key, session] of sessions) {
      if (session.expires <= now || !equal(session.token, token)) sessions.delete(key);
    }
    const session = cookie ? sessions.get(cookie) : undefined;
    if (!(bearer && equal(bearer, token)) && !session) return reject(401, "OpenClaw gateway sign-in required");
    if (path === "/orgx/api/gateway-session") {
      if (req.method !== "POST") return reject(405, "Use POST to sign in");
      const id = randomBytes(32).toString("base64url");
      if (sessions.size >= 64) sessions.delete(sessions.keys().next().value!);
      sessions.set(id, { expires: now + SESSION_MS, token });
      res.writeHead(204, {
        "cache-control": "no-store",
        "set-cookie": `${COOKIE}=${id}; Path=/orgx; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MS / 1000}`,
      });
      res.end();
      return false;
    }
    return true;
  };
}
