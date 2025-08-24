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
  logger,
}: {
  userId: string;
  payload: CreditsPayload;
  logger?: any;
}) {
  const convex = createConvexClient();
  const serviceSecret = process.env.CONVEX_SERVICE_SECRET;
  if (!serviceSecret) {
    const msg = "Missing CONVEX_SERVICE_SECRET env var";
    logger?.warn?.(msg);
    throw new Error(msg);
  }
  try {
    logger?.info?.("Publishing credits to Convex", { userId, balance: payload.balance });
    // Call by name so we can target main app Convex without local codegen
    await convex.mutation("credits:setProjection" as any, {
      userId,
      payload,
      serviceSecret,
    } as any);
    logger?.info?.("Credits projection published", { userId });
  } catch (error) {
    const msg = "Failed to publish credits to Convex";
    if (logger?.error) {
      logger.error(msg, { error });
    } else {
      // eslint-disable-next-line no-console
      console.warn(msg, error);
    }
  }
}


