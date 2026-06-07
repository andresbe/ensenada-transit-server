import { createClient, RedisClientType } from "redis";

const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";

const client: RedisClientType = createClient({
  url: redisUrl,
  socket: {
    reconnectStrategy: (retries) => {
      if (retries > 10) {
        console.error("[redis] Too many reconnect attempts – giving up.");
        return new Error("Redis reconnect limit reached");
      }
      return Math.min(retries * 100, 3_000);
    },
  },
}) as RedisClientType;

client.on("connect", () => console.log("[redis] Connected to Redis"));
client.on("ready", () => console.log("[redis] Redis client ready"));
client.on("error", (err) => console.error("[redis] Client error:", err));
client.on("reconnecting", () => console.warn("[redis] Reconnecting to Redis…"));
client.on("end", () => console.warn("[redis] Redis connection closed"));

export const connectRedis = async (): Promise<void> => {
  if (!client.isOpen) {
    await client.connect();
  }
};

export default client;
