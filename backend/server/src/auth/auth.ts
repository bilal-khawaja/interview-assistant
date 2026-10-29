import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { bearer } from "better-auth/plugins";
import type { Database } from "../db/client";
import { account, session, user, verification } from "../db/schema";

export type AuthOptions = {
  db: Database;
  /** Signs session tokens. At least 32 characters; keep it out of version control. */
  secret: string;
  /** The server's own public address, e.g. http://localhost:3000. */
  baseUrl: string;
  /**
   * Origins allowed to call the sign-in and sign-up endpoints, besides the server itself.
   * The desktop app has no web origin, so it sends a custom scheme such as
   * interview-assistant://app. Any other origin is refused.
   */
  trustedOrigins?: string[];
  /** Throttle sign-in and sign-up attempts per client. On by default. */
  rateLimit?: boolean;
};

/**
 * Email and password accounts, with sessions carried as bearer tokens: the desktop app's
 * main process signs in, keeps the token and sends it as `Authorization: Bearer <token>`
 * (the sign-in response returns it in the `set-auth-token` header).
 */
export function createAuth(options: AuthOptions) {
  return betterAuth({
    baseURL: options.baseUrl,
    secret: options.secret,
    database: drizzleAdapter(options.db, {
      provider: "pg",
      schema: { user, session, account, verification },
    }),
    emailAndPassword: { enabled: true },
    plugins: [bearer()],
    trustedOrigins: options.trustedOrigins ?? [],
    rateLimit: { enabled: options.rateLimit ?? true },
    // Better Auth skips the origin check when it detects a test run. Always do it, so tests
    // exercise what production does.
    advanced: { disableOriginCheck: false },
  });
}

export type Auth = ReturnType<typeof createAuth>;
