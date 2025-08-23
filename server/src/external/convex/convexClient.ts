import { ConvexHttpClient } from "convex/browser";

export function createConvexClient(): ConvexHttpClient {
  const url = process.env.CONVEX_URL || process.env.CONVEX_CLOUD_URL;
  if (!url) {
    throw new Error("Missing CONVEX_URL or CONVEX_CLOUD_URL env var");
  }
  return new ConvexHttpClient(url);
}


