import type { Database } from "../db/client";
import { user } from "../db/schema";
import type { AuthApi } from "./routes";

export const TEST_OWNER_ID = "test-owner";
export const OWNER_EMAIL = "test-owner@example.test";

/** A fixed account that owns the meetings of tests that are not about accounts. Safe to call again. */
export async function testOwner(db: Database): Promise<string> {
  await db
    .insert(user)
    .values({ id: TEST_OWNER_ID, name: "Test owner", email: OWNER_EMAIL })
    .onConflictDoNothing();
  return TEST_OWNER_ID;
}

export type FakeUser = { id: string; email: string; name: string };

/**
 * Stands in for Better Auth so route tests need no sign-up. With a token map, a request is
 * the user whose token it carries as `Authorization: Bearer <token>`, and anyone else is
 * signed out. With a single user, every request is that user, for tests that are not about
 * who is calling.
 */
export function fakeAuth(users: Record<string, FakeUser> | FakeUser): AuthApi {
  const lookup = (headers: Headers): FakeUser | null => {
    if ("id" in users && typeof users.id === "string") return users as FakeUser;
    const match = /^Bearer (.+)$/.exec(headers.get("authorization") ?? "");
    return (match && (users as Record<string, FakeUser>)[match[1]!]) || null;
  };
  return {
    handler: async () => new Response("not found", { status: 404 }),
    api: {
      getSession: (async ({ headers }: { headers: Headers }) => {
        const found = lookup(headers);
        return found ? { user: found, session: { id: "fake" } } : null;
      }) as never,
    },
  };
}

export const testOwnerAuth = (): AuthApi => fakeAuth({ id: TEST_OWNER_ID, email: OWNER_EMAIL, name: "Test owner" });
