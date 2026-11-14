import { Inject, Injectable } from "@nestjs/common";
import type { AppEnv } from "@bizora/config/env";
import { publicWebOrigin } from "@bizora/config/env";
import { ApiError } from "../../common/errors.js";
import { APP_ENV } from "../../tokens.js";
import * as client from "openid-client";
import { InvitationService } from "../rbac/invitation.service.js";
import type { AuthMeta, AuthPayload } from "./identity.service.js";
import { IdentityService } from "./identity.service.js";
import { sealOauthTransaction, type OauthIntent, type OauthProviderName, type OauthTransaction } from "./oauth-cookie.js";
import { microsoftIssuer, safeReturnTo } from "./return-to.js";

export type OauthProfile = {
  provider: OauthProviderName;
  subject: string;
  email: string;
  emailVerified: boolean;
  displayName: string;
};

const providers = ["google", "microsoft"] as const;

export function isOauthProvider(value: string): value is OauthProviderName {
  return providers.includes(value as OauthProviderName);
}

@Injectable()
export class OauthService {
  private readonly configurations = new Map<OauthProviderName, client.Configuration>();

  constructor(
    @Inject(APP_ENV) private readonly env: AppEnv,
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(InvitationService) private readonly invitations: InvitationService,
  ) {}

  enabled() {
    return {
      google: Boolean(this.env.GOOGLE_OAUTH_CLIENT_ID && this.env.GOOGLE_OAUTH_CLIENT_SECRET),
      microsoft: Boolean(this.env.MICROSOFT_OAUTH_CLIENT_ID && this.env.MICROSOFT_OAUTH_CLIENT_SECRET),
    };
  }

  async begin(input: {
    provider: OauthProviderName;
    returnTo: unknown;
    intent: OauthIntent;
    inviteToken?: string;
    userId?: string;
  }): Promise<{ location: string; sealed: string }> {
    const config = await this.configuration(input.provider);
    const returnTo = safeReturnTo(input.returnTo);
    const codeVerifier = client.randomPKCECodeVerifier();
    const state = client.randomState();
    const nonce = client.randomNonce();
    const url = client.buildAuthorizationUrl(config, {
      redirect_uri: this.redirectUri(input.provider),
      scope: "openid email profile",
      code_challenge: await client.calculatePKCECodeChallenge(codeVerifier),
      code_challenge_method: "S256",
      state,
      nonce,
    });
    return {
      location: url.href,
      sealed: sealOauthTransaction(
        {
          provider: input.provider,
          state,
          nonce,
          codeVerifier,
          returnTo,
          intent: input.intent,
          ...(input.inviteToken ? { inviteToken: input.inviteToken } : {}),
          ...(input.userId ? { userId: input.userId } : {}),
        },
        this.env.JWT_SECRET,
      ),
    };
  }

  async finish(transaction: OauthTransaction, currentUrl: URL, meta: AuthMeta): Promise<{ session: AuthPayload | null; location: string }> {
    const profile = await this.profile(transaction, currentUrl);
    if (transaction.intent === "link") {
      if (!transaction.userId) throw new ApiError("OAUTH_REJECTED", "Sign-in could not be completed.", 400);
      await this.identity.linkIdentity(transaction.userId, profile, meta);
      const joiner = transaction.returnTo.includes("?") ? "&" : "?";
      return { session: null, location: `${transaction.returnTo}${joiner}linked=${profile.provider}` };
    }
    if (transaction.intent === "invite") {
      if (!transaction.inviteToken) throw new ApiError("OAUTH_REJECTED", "Sign-in could not be completed.", 400);
      const user = await this.invitations.acceptWithProvider(transaction.inviteToken, profile, meta.correlationId);
      const session = await this.identity.establishSession(user, meta, profile.provider, true);
      return { session, location: session.needsWorkspaceSelection ? "/select-workspace" : "/app" };
    }
    try {
      const user = await this.identity.resolveOauthUser(profile, meta);
      const session = await this.identity.establishSession(user, meta, profile.provider, true);
      if (session.needsOrganizationSetup) return { session, location: "/setup" };
      if (session.needsWorkspaceSelection) return { session, location: "/select-workspace" };
      return { session, location: transaction.returnTo };
    } catch (error) {
      if (error instanceof ApiError && error.code === "OAUTH_LINK_REQUIRED") throw error;
      throw error;
    }
  }

  private async profile(transaction: OauthTransaction, currentUrl: URL): Promise<OauthProfile> {
    const config = await this.configuration(transaction.provider);
    let tokens: client.TokenEndpointResponseHelpers;
    try {
      const granted = await client.authorizationCodeGrant(config, currentUrl, {
        pkceCodeVerifier: transaction.codeVerifier,
        expectedState: transaction.state,
        expectedNonce: transaction.nonce,
      });
      tokens = granted;
    } catch {
      throw new ApiError("OAUTH_REJECTED", "Sign-in could not be completed.", 400);
    }
    const claims = tokens.claims() as { sub?: string; iss?: string; [key: string]: unknown } | undefined;
    if (!claims?.sub || !claims.iss) throw new ApiError("OAUTH_REJECTED", "Sign-in could not be completed.", 400);
    if (transaction.provider === "microsoft") {
      const expected = microsoftIssuer(config.serverMetadata().issuer, claims.tid);
      if (claims.iss !== expected) throw new ApiError("OAUTH_REJECTED", "Sign-in could not be completed.", 400);
    }
    const email = emailFrom(claims);
    if (!email) throw new ApiError("OAUTH_REJECTED", "Sign-in could not be completed.", 400);
    const name = typeof claims.name === "string" ? claims.name.trim().slice(0, 120) : "";
    const preferred = typeof claims.preferred_username === "string" ? claims.preferred_username.trim().slice(0, 120) : "";
    return {
      provider: transaction.provider,
      subject: claims.sub,
      email,
      emailVerified: transaction.provider === "microsoft" ? claims.xms_edov === true : claims.email_verified === true,
      displayName: name || preferred || email.split("@")[0] || "Member",
    };
  }

  private redirectUri(provider: OauthProviderName): string {
    return `${publicWebOrigin(this.env)}/api/v1/auth/oauth/${provider}/callback`;
  }

  private async configuration(provider: OauthProviderName): Promise<client.Configuration> {
    const cached = this.configurations.get(provider);
    if (cached) return cached;
    const clientId = provider === "google" ? this.env.GOOGLE_OAUTH_CLIENT_ID : this.env.MICROSOFT_OAUTH_CLIENT_ID;
    const clientSecret = provider === "google" ? this.env.GOOGLE_OAUTH_CLIENT_SECRET : this.env.MICROSOFT_OAUTH_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      throw new ApiError("OAUTH_DISABLED", "That sign-in method is not available.", 404);
    }
    const issuer = new URL(
      provider === "google"
        ? (this.env.GOOGLE_OAUTH_ISSUER ?? "https://accounts.google.com")
        : (this.env.MICROSOFT_OAUTH_ISSUER ?? "https://login.microsoftonline.com/common/v2.0"),
    );
    const config = await client.discovery(issuer, clientId, undefined, client.ClientSecretPost(clientSecret), {
      ...(issuer.protocol === "http:" ? { execute: [client.allowInsecureRequests] } : {}),
    });
    this.configurations.set(provider, config);
    return config;
  }
}

function emailFrom(claims: { [key: string]: unknown }): string {
  if (typeof claims.email === "string" && claims.email.includes("@")) return claims.email.toLowerCase();
  return "";
}
