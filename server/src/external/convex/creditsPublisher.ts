import { createConvexClient } from "./convexClient.js";

export type CreditsPayload = {
  balance: number;
  subscriptionTier?: string;
  subscriptionStatus?: string;
  subscriptionExpiry?: string;
  breakdown?: {
    dailyFree?: { available?: number };
    subscription?: { available?: number };
    purchased?: { available?: number };
  };
  resets?: {
    resetsAt?: string;
    nextDailyReset?: string;
    nextMonthlyReset?: string;
    nextRolloverExpiry?: string;
  };
  intervals?: Array<{
    interval: string;
    balance: number;
    nextResetAt?: string;
  }>;
  rolloverExpiries?: string[];
  rolloverGroups?: Array<{ iso: string; count: number }>;
  updatedAt: number;
};

export async function publishCreditsProjection({
  userId,
  payload,
}: {
  userId: string;
  payload: CreditsPayload;
}) {
  const convex = createConvexClient();
  const serviceSecret = process.env.CONVEX_SERVICE_SECRET;
  if (!serviceSecret) {
    throw new Error("Missing CONVEX_SERVICE_SECRET env var");
  }
  try {
    // Call by name so we can target main app Convex without local codegen
    await convex.mutation("credits:setProjection" as any, {
      userId,
      payload,
      serviceSecret,
    } as any);
  } catch (error) {
    // Swallow errors to avoid blocking the primary transaction
    // eslint-disable-next-line no-console
    console.warn("Failed to publish credits to Convex", error);
  }
}


