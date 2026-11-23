import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import request from "supertest";

/**
 * A fake Google for Admin portal tests: an OpenID server on a local port, and a sign-in that walks the portal's real
 * Google flow (PKCE, nonce, sealed cookie). Tests only.
 */
export async function fakeGoogle() {
  const keys = await generateKeyPair("RS256", { extractable: true });
  const jwk = { ...(await exportJWK(keys.publicKey)), kid: "test", alg: "RS256", use: "sig" };
  const codes = new Map<string, { challenge: string; nonce: string; email: string; sub: string }>();
  let issuer = "";
  const server = createServer((req, res) => void handle(req, res).catch(() => json(res, 500, {})));

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", issuer);
    if (url.pathname === "/.well-known/openid-configuration") {
      return json(res, 200, {
        issuer,
        authorization_endpoint: `${issuer}authorize`,
        token_endpoint: `${issuer}token`,
        jwks_uri: `${issuer}jwks`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        token_endpoint_auth_methods_supported: ["client_secret_post"],
        code_challenge_methods_supported: ["S256"],
      });
    }
    if (url.pathname === "/jwks") return json(res, 200, { keys: [jwk] });
    if (url.pathname === "/authorize") {
      const code = randomBytes(16).toString("hex");
      codes.set(code, {
        challenge: url.searchParams.get("code_challenge") ?? "",
        nonce: url.searchParams.get("nonce") ?? "",
        email: url.searchParams.get("email") ?? "",
        sub: url.searchParams.get("sub") ?? "",
      });
      const redirect = new URL(url.searchParams.get("redirect_uri") ?? "");
      redirect.searchParams.set("code", code);
      redirect.searchParams.set("state", url.searchParams.get("state") ?? "");
      res.writeHead(302, { location: redirect.href });
      return res.end();
    }
    if (url.pathname === "/token") {
      const body = new URLSearchParams(await readBody(req));
      const pending = codes.get(body.get("code") ?? "");
      if (!pending || createHash("sha256").update(body.get("code_verifier") ?? "").digest("base64url") !== pending.challenge) return json(res, 400, { error: "invalid_grant" });
      codes.delete(body.get("code") ?? "");
      const now = Math.floor(Date.now() / 1000);
      const idToken = await new SignJWT({ email: pending.email, email_verified: true, name: pending.email.split("@")[0], nonce: pending.nonce })
        .setProtectedHeader({ alg: "RS256", kid: "test" })
        .setIssuer(issuer)
        .setSubject(pending.sub)
        .setAudience(body.get("client_id") ?? "")
        .setIssuedAt(now)
        .setExpirationTime(now + 600)
        .sign(keys.privateKey);
      return json(res, 200, { access_token: "x", token_type: "Bearer", expires_in: 600, id_token: idToken });
    }
    res.writeHead(404);
    res.end();
  }

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;

  return {
    issuer,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    /** Signs in to the portal; returns the portal's session cookie. */
    async signIn(http: Parameters<typeof request>[0], email: string, sub: string) {
      const started = await request(http).get("/api/admin/v1/auth/google/start").expect(302);
      const authorize = new URL(started.headers.location as string);
      authorize.searchParams.set("email", email);
      authorize.searchParams.set("sub", sub);
      const sealed = cookieNamed(started.headers["set-cookie"], "bizora_admin_oauth") ?? "";
      const redirected = await fetch(authorize, { redirect: "manual" });
      const callback = new URL(redirected.headers.get("location") ?? "");
      const finished = await request(http).get(`${callback.pathname}${callback.search}`).set("cookie", sealed);
      return cookieNamed(finished.headers["set-cookie"], "bizora_admin") ?? "";
    },
  };
}

export function cookieNamed(header: unknown, name: string) {
  const list = Array.isArray(header) ? (header as string[]) : typeof header === "string" ? [header] : [];
  const found = list.find((cookie) => cookie.startsWith(`${name}=`));
  return found ? found.split(";")[0]! : null;
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage) {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
