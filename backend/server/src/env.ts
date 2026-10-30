import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
  server: {
    DATABASE_URL: z.url(),
    OPENAI_API_KEY: z.string().min(1),
    DEEPGRAM_API_KEY: z.string().min(1).optional(),
    /** Signs session tokens. Generate one with `openssl rand -hex 32`. */
    BETTER_AUTH_SECRET: z.string().min(32),
    /** The server's public address. Defaults to http://localhost:<PORT>. */
    BETTER_AUTH_URL: z.url().optional(),
    /** Comma-separated origins that may sign in besides the server itself: the desktop app's scheme. */
    AUTH_TRUSTED_ORIGINS: z
      .string()
      .default("interview-assistant://app")
      .transform((value) => value.split(",").map((origin) => origin.trim()).filter(Boolean)),
    /** What an invite token is appended to in the link the owner copies. The desktop app registers this scheme. */
    INVITE_LINK_PREFIX: z.string().min(1).default("interview-assistant://join/"),
    YOUTUBE_URL: z.url().default("https://www.youtube.com/watch?v=7ARBJQn6QkM"),
    PORT: z.coerce.number().int().min(0).max(65535).default(3000),
    STREAM_ANSWER: z
      .enum(["true", "false"])
      .default("true")
      .transform((value) => value === "true"),
    /** Unprompted chat suggestions on new transcript lines. Off: chats only answer questions. */
    CHAT_SUGGESTIONS: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
  },
  runtimeEnv: {
    DATABASE_URL: process.env.DATABASE_URL,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    DEEPGRAM_API_KEY: process.env.DEEPGRAM_API_KEY,
    BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET,
    BETTER_AUTH_URL: process.env.BETTER_AUTH_URL,
    AUTH_TRUSTED_ORIGINS: process.env.AUTH_TRUSTED_ORIGINS,
    INVITE_LINK_PREFIX: process.env.INVITE_LINK_PREFIX,
    YOUTUBE_URL: process.env.YOUTUBE_URL,
    PORT: process.env.PORT,
    STREAM_ANSWER: process.env.STREAM_ANSWER,
    CHAT_SUGGESTIONS: process.env.CHAT_SUGGESTIONS,
  },
  emptyStringAsUndefined: true,
});
