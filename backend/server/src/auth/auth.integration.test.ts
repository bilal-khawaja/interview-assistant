import { eq, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createDb, type DbClient } from "../db/client";
import { account, session, user } from "../db/schema";
import { env } from "../env";
import { createApp } from "../server/app";
import { createAuth } from "./auth";
import { mountAuthRoutes } from "./routes";

async function probe(): Promise<DbClient | null> {
  if (!env.DATABASE_URL) return null;
  try {
    const client = createDb(env.DATABASE_URL);
    await client.db.select().from(user).limit(0);
    return client;
  } catch {
    return null;
  }
}

const client = await probe();
const run = client ? describe : describe.skip;

const APP_ORIGIN = "interview-assistant://app";
const BASE = "http://localhost:3999";
const PASSWORD = "correct horse battery";
const EMAIL_PREFIX = "authtest-";
const email = (tag: string) => `${EMAIL_PREFIX}${tag}-${crypto.randomUUID().slice(0, 8)}@example.com`;

run("auth (postgres)", () => {
  const { db } = client ?? ({} as DbClient);
  const options = { db, secret: "x".repeat(40), baseUrl: BASE, trustedOrigins: [APP_ORIGIN] };
  // Throttling is off here so the many sign-ins below are not counted against each other.
  const auth = createAuth({ ...options, rateLimit: false });
  const app = new Hono();
  mountAuthRoutes(app as never, auth);

  type Result = { status: number; token: string | null; body: any };
  const send = async (path: string, init: RequestInit = {}, instance: { request: typeof app.request } = app): Promise<Result> => {
    const res = await instance.request(`${BASE}${path}`, init);
    let body: any = null;
    try {
      body = await res.json();
    } catch {}
    return { status: res.status, token: res.headers.get("set-auth-token"), body };
  };
  const post = (path: string, body: unknown, headers: Record<string, string> = {}, instance?: { request: typeof app.request }) =>
    send(
      path,
      { method: "POST", headers: { "content-type": "application/json", origin: APP_ORIGIN, ...headers }, body: JSON.stringify(body) },
      instance,
    );
  const signUp = (address: string, name = "Test User", password = PASSWORD) =>
    post("/api/auth/sign-up/email", { email: address, password, name });
  const signIn = (address: string, password = PASSWORD) => post("/api/auth/sign-in/email", { email: address, password });
  const me = (token?: string, headers: Record<string, string> = {}) =>
    send("/me", { headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } });

  afterAll(async () => {
    await db.delete(user).where(like(user.email, `${EMAIL_PREFIX}%`));
    await client?.close();
  });

  describe("sign up", () => {
    test("creates an account, signs the new user in and returns a token", async () => {
      const address = email("up");
      const result = await signUp(address, "Ada");
      expect(result.status).toBe(200);
      expect(result.token).toBeTruthy();
      expect(result.body.user).toMatchObject({ email: address, name: "Ada" });
      expect((await me(result.token!)).body).toMatchObject({ email: address, name: "Ada" });
    });

    test("the password is stored hashed, never as typed", async () => {
      const address = email("hash");
      await signUp(address);
      const [row] = await db
        .select({ password: account.password })
        .from(account)
        .innerJoin(user, eq(user.id, account.userId))
        .where(eq(user.email, address));
      expect(row?.password).toBeTruthy();
      expect(row?.password).not.toContain(PASSWORD);
    });

    test("an address that is already taken is refused", async () => {
      const address = email("dup");
      expect((await signUp(address)).status).toBe(200);
      const again = await signUp(address);
      expect(again.status).toBeGreaterThanOrEqual(400);
      expect(again.token).toBeNull();
      expect(await db.select().from(user).where(eq(user.email, address))).toHaveLength(1);
    });

    test("the same address in another case is the same account", async () => {
      const address = email("case");
      await signUp(address);
      const again = await signUp(address.toUpperCase());
      expect(again.status).toBeGreaterThanOrEqual(400);
    });

    test("a short password and a malformed address are refused", async () => {
      const short = await signUp(email("short"), "Test", "short");
      expect(short.status).toBeGreaterThanOrEqual(400);
      expect(short.token).toBeNull();
      const bad = await signUp("not-an-email");
      expect(bad.status).toBeGreaterThanOrEqual(400);
    });
  });

  describe("sign in", () => {
    const address = email("in");
    beforeAll(async () => void (await signUp(address)));

    test("the right password returns a working token", async () => {
      const result = await signIn(address);
      expect(result.status).toBe(200);
      expect((await me(result.token!)).status).toBe(200);
    });

    test("a wrong password and an unknown address look the same, so accounts cannot be guessed", async () => {
      const wrong = await signIn(address, "wrong password!!");
      const unknown = await signIn(email("nobody"), "wrong password!!");
      expect(wrong.status).toBe(401);
      expect(unknown.status).toBe(wrong.status);
      expect(unknown.body.message).toBe(wrong.body.message);
      expect(wrong.token).toBeNull();
    });

    test("each sign-in is its own session; ending one leaves the other working", async () => {
      const a = await signIn(address);
      const b = await signIn(address);
      expect(a.token).not.toBe(b.token);
      const out = await send("/api/auth/sign-out", { method: "POST", headers: { authorization: `Bearer ${a.token}`, origin: APP_ORIGIN } });
      expect(out.status).toBe(200);
      expect((await me(a.token!)).status).toBe(401);
      expect((await me(b.token!)).status).toBe(200);
    });
  });

  describe("requests that carry a token", () => {
    let token: string;
    beforeAll(async () => {
      const address = email("tok");
      token = (await signUp(address)).token!;
    });

    test("no token, an empty one and a made-up one are all the same 401", async () => {
      const none = await me();
      const empty = await send("/me", { headers: { authorization: "Bearer " } });
      const junk = await me("not-a-real-token");
      const wrongScheme = await send("/me", { headers: { authorization: `Basic ${token}` } });
      for (const r of [none, empty, junk, wrongScheme]) expect(r.status).toBe(401);
      expect(new Set([none, empty, junk].map((r) => JSON.stringify(r.body))).size).toBe(1);
    });

    test("a token with any character changed is refused", async () => {
      const flipped = token.slice(0, -2) + (token.endsWith("aa") ? "bb" : "aa");
      expect((await me(flipped)).status).toBe(401);
      const [raw] = token.split(".");
      expect((await me(`${raw!.slice(0, -2)}${raw!.endsWith("aa") ? "bb" : "aa"}`)).status).toBe(401);
    });

    test("the session token itself is the secret: the bearer plugin signs a bare one, so it must never be logged or sent anywhere", async () => {
      const [raw] = token.split(".");
      expect((await me(raw)).status).toBe(200);
    });

    test("an expired session is refused", async () => {
      const address = email("exp");
      const result = await signUp(address);
      expect((await me(result.token!)).status).toBe(200);
      const [owner] = await db.select({ id: user.id }).from(user).where(eq(user.email, address));
      await db.update(session).set({ expiresAt: new Date(Date.now() - 60_000) }).where(eq(session.userId, owner!.id));
      expect((await me(result.token!)).status).toBe(401);
    });

    test("a deleted account's token stops working", async () => {
      const address = email("del");
      const result = await signUp(address);
      await db.delete(user).where(eq(user.email, address));
      expect((await me(result.token!)).status).toBe(401);
    });

    test("an Origin header on a bearer request makes no difference", async () => {
      expect((await me(token, { origin: "http://evil.example" })).status).toBe(200);
    });
  });

  describe("two accounts", () => {
    test("each token identifies only its own user", async () => {
      const first = email("one");
      const second = email("two");
      const a = (await signUp(first, "One")).token!;
      const b = (await signUp(second, "Two")).token!;
      const [meA, meB] = await Promise.all([me(a), me(b)]);
      expect(meA.body.email).toBe(first);
      expect(meB.body.email).toBe(second);
      expect(meA.body.id).not.toBe(meB.body.id);
    });

    test("signing out one account does not touch the other", async () => {
      const a = (await signUp(email("so1"))).token!;
      const b = (await signUp(email("so2"))).token!;
      await send("/api/auth/sign-out", { method: "POST", headers: { authorization: `Bearer ${a}`, origin: APP_ORIGIN } });
      expect((await me(a)).status).toBe(401);
      expect((await me(b)).status).toBe(200);
    });
  });

  describe("origin checks on sign-in and sign-up", () => {
    test("the desktop app's origin is accepted", async () => {
      expect((await signUp(email("o1"))).status).toBe(200);
    });

    test("an Origin of null is refused: this is what Electron's fetch sends unless the app sets its own", async () => {
      const result = await post("/api/auth/sign-up/email", { email: email("o2"), password: PASSWORD, name: "T" }, { origin: "null" });
      expect(result.status).toBe(403);
      expect(result.token).toBeNull();
    });

    test("a client that sends no Origin header at all is let through: only browsers send one, and only browsers can be tricked into a cross-site request", async () => {
      const result = await send("/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: email("o5"), password: PASSWORD, name: "T" }),
      });
      expect(result.status).toBe(200);
    });

    test("a web page on another origin cannot sign up or sign in", async () => {
      const address = email("o3");
      await signUp(address);
      const evil = { origin: "http://evil.example" };
      const up = await post("/api/auth/sign-up/email", { email: email("o4"), password: PASSWORD, name: "T" }, evil);
      const inn = await post("/api/auth/sign-in/email", { email: address, password: PASSWORD }, evil);
      expect(up.status).toBe(403);
      expect(inn.status).toBe(403);
      expect(inn.token).toBeNull();
    });
  });

  describe("throttling", () => {
    test("repeated sign-in attempts are slowed down", async () => {
      const throttled = createAuth({ ...options, rateLimit: true });
      const limited = new Hono();
      mountAuthRoutes(limited as never, throttled);
      const address = email("rate");
      await signUp(address);
      const statuses: number[] = [];
      for (let i = 0; i < 8; i++) {
        statuses.push((await post("/api/auth/sign-in/email", { email: address, password: "wrong password!!" }, {}, limited)).status);
      }
      expect(statuses).toContain(429);
      expect(statuses[0]).toBe(401);
    });
  });

  describe("the server", () => {
    const real = () => {
      const stub = {} as never;
      return createApp({
        auth,
        meetings: stub,
        segments: stub,
        participants: stub,
        hub: stub,
        heartbeatMs: 1000,
        maxBufferedBytes: 1000,
      });
    };

    test("serves sign-up and /me, and /healthz stays open", async () => {
      const server = real();
      expect((await server.request(`${BASE}/healthz`)).status).toBe(200);
      expect((await server.request(`${BASE}/me`)).status).toBe(401);
      const up = await post("/api/auth/sign-up/email", { email: email("srv"), password: PASSWORD, name: "S" }, {}, server);
      expect(up.status).toBe(200);
      expect((await send("/me", { headers: { authorization: `Bearer ${up.token}` } }, server)).status).toBe(200);
    });

    test("every route but /healthz and /api/auth refuses a caller with no token", async () => {
      const server = real();
      for (const path of ["/meetings", "/meetings/00000000-0000-4000-8000-000000000000", "/anything"]) {
        expect((await server.request(`${BASE}${path}`)).status).toBe(401);
      }
    });
  });
});
