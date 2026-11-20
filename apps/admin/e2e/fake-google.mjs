// A stand-in for Google's sign-in, for the Admin portal's end-to-end tests only. It shows an account chooser page,
// then answers the token request with a signed ID token for whichever email was typed.
import { createHash, generateKeyPairSync, randomBytes, createSign } from "node:crypto";
import { createServer } from "node:http";
import { Buffer } from "node:buffer";
import process from "node:process";
import { URL, URLSearchParams } from "node:url";

const port = Number(process.env.FAKE_GOOGLE_PORT ?? 3009);
const issuer = `http://127.0.0.1:${port}/`;
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "e2e", alg: "RS256", use: "sig" };
const codes = new Map();

const b64 = (value) => Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");
function sign(claims) {
  const head = b64({ alg: "RS256", kid: "e2e", typ: "JWT" });
  const body = b64(claims);
  const signer = createSign("RSA-SHA256");
  signer.update(`${head}.${body}`);
  return `${head}.${body}.${signer.sign(privateKey).toString("base64url")}`;
}
const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};
const read = (req) => new Promise((resolve) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
});
const escape = (value) => String(value).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

createServer(async (req, res) => {
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
  if (url.pathname === "/authorize" && req.method === "GET") {
    const hidden = ["redirect_uri", "state", "nonce", "code_challenge"]
      .map((name) => `<input type="hidden" name="${name}" value="${escape(url.searchParams.get(name) ?? "")}">`)
      .join("");
    res.writeHead(200, { "content-type": "text/html" });
    return res.end(`<!doctype html><title>Choose an account</title><form method="post" action="/authorize">${hidden}<label>Email <input name="email" type="email"></label><button>Continue</button></form>`);
  }
  if (url.pathname === "/authorize" && req.method === "POST") {
    const form = new URLSearchParams(await read(req));
    const code = randomBytes(16).toString("hex");
    const email = (form.get("email") ?? "").toLowerCase();
    codes.set(code, { email, nonce: form.get("nonce"), challenge: form.get("code_challenge") });
    const back = new URL(form.get("redirect_uri") ?? "");
    back.searchParams.set("code", code);
    back.searchParams.set("state", form.get("state") ?? "");
    res.writeHead(302, { location: back.href });
    return res.end();
  }
  if (url.pathname === "/token" && req.method === "POST") {
    const body = new URLSearchParams(await read(req));
    const pending = codes.get(body.get("code") ?? "");
    const verifier = createHash("sha256").update(body.get("code_verifier") ?? "").digest("base64url");
    if (!pending || verifier !== pending.challenge) return json(res, 400, { error: "invalid_grant" });
    codes.delete(body.get("code"));
    const now = Math.floor(Date.now() / 1000);
    const idToken = sign({ iss: issuer, aud: body.get("client_id"), sub: `sub-${pending.email}`, email: pending.email, email_verified: true, name: pending.email.split("@")[0], nonce: pending.nonce, iat: now, exp: now + 600 });
    return json(res, 200, { access_token: "e2e", token_type: "Bearer", expires_in: 600, id_token: idToken });
  }
  if (url.pathname === "/health") return json(res, 200, { ok: true });
  res.writeHead(404);
  res.end();
}).listen(port, "127.0.0.1");
