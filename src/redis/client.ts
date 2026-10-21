import { createClient, RedisClientType } from "redis";

const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";

const client: RedisClientType = createClient({
  url: redisUrl,
  // Fail requests promptly during outages instead of retaining an unbounded queue.
  disableOfflineQueue: true,
  socket: {
    reconnectStrategy: (retries) => {
      // Keep recovering after prolonged outages; cap the delay, not the attempts.
      return Math.min((retries + 1) * 100, 3_000);
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
