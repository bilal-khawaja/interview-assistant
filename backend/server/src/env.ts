import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
  server: {
    DATABASE_URL: z.url(),
    OPENAI_API_KEY: z.string().min(1),
    DEEPGRAM_API_KEY: z.string().min(1).optional(),
    YOUTUBE_URL: z.url().default("https://www.youtube.com/watch?v=7ARBJQn6QkM"),
    PORT: z.coerce.number().int().min(0).max(65535).default(3000),
    STREAM_ANSWER: z
      .enum(["true", "false"])
      .default("true")
      .transform((value) => value === "true"),
  },
  runtimeEnv: {
    DATABASE_URL: process.env.DATABASE_URL,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    DEEPGRAM_API_KEY: process.env.DEEPGRAM_API_KEY,
    YOUTUBE_URL: process.env.YOUTUBE_URL,
    PORT: process.env.PORT,
    STREAM_ANSWER: process.env.STREAM_ANSWER,
  },
  emptyStringAsUndefined: true,
});
