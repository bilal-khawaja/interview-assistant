import type { Context, Hono, MiddlewareHandler } from "hono";
import type { StreamVariables } from "../server/app";
import type { Auth } from "./auth";

export type AuthVariables = {
  userId: string;
  user: { id: string; email: string; name: string };
};

/** The part of Better Auth the routes need, so tests can stand in for it. */
export type AuthApi = {
  handler: Auth["handler"];
  api: { getSession: Auth["api"]["getSession"] };
};

/** The signed-in user for the request's bearer token (or session cookie), or null. */
export async function sessionUser(auth: Pick<AuthApi, "api">, headers: Headers) {
  const session = await auth.api.getSession({ headers });
  return session ? { id: session.user.id, email: session.user.email, name: session.user.name } : null;
}

/**
 * Lets only signed-in requests through and puts the caller on the context as `userId`.
 * Unknown, expired and tampered tokens all get the same 401, so a caller learns nothing.
 */
export function requireAuth(auth: Pick<AuthApi, "api">): MiddlewareHandler {
  return async (c, next) => {
    const user = await sessionUser(auth, c.req.raw.headers);
    if (!user) return c.json({ error: "unauthorized" }, 401);
    c.set("userId", user.id);
    c.set("user", user);
    await next();
  };
}

export function currentUserId(c: Context): string {
  return c.get("userId") as string;
}

/**
 * Mounts Better Auth's endpoints (sign-up, sign-in, sign-out, ...) under /api/auth and a
 * /me that says who the caller is. Mount before any catch-all route.
 */
export function mountAuthRoutes(
  app: Hono<{ Variables: StreamVariables & Record<string, unknown> }>,
  auth: AuthApi,
): void {
  app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));
  app.get("/me", requireAuth(auth), (c) => c.json(c.get("user")));
}
