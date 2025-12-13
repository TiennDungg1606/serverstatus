import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

type EnvShape = z.infer<typeof envSchema>;

const envSchema = z.object({
  PORT: z.coerce.number().default(4444),
  PRESENCE_SECRET: z.string().min(12).optional(),
  PRESENCE_TTL_MS: z.coerce.number().default(60_000),
  CLEANUP_INTERVAL_MS: z.coerce.number().default(5_000),
  ALLOW_ORIGINS: z.string().optional(),
  LOG_HEARTBEATS: z.coerce.boolean().default(false),
  FRIEND_SYNC_URL: z.string().url().optional(),
  ENABLE_USER_WATCHER: z.coerce.boolean().default(false),
  MONGODB_URI: z.string().optional(),
  MONGODB_DB: z.string().optional(),
  WS_PORT: z.coerce.number().optional()
});

const parsed = envSchema.parse(process.env);

const allowedOrigins = parsed.ALLOW_ORIGINS
  ? parsed.ALLOW_ORIGINS.split(",")
      .map((origin) => origin.trim())
      .filter(Boolean)
  : [];

  export const config: EnvShape & { allowedOrigins: string[] } = {
    ...parsed,
    WS_PORT: process.env.WS_PORT ? Number(process.env.WS_PORT) : 8081,
    allowedOrigins
  };
