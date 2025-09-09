import { createConvexClient } from "./convexClient.js";

// Serialize and coalesce concurrent publishes per user to avoid Convex write conflicts
const userIdToQueue: Map<string, Promise<void>> = new Map();
const latestPayloadByUser: Map<string, CreditsPayload> = new Map();
// No additional backoff or debounce; Convex handles retries for conflicts

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
  // Always keep the latest payload; older queued calls will publish the newest state
  latestPayloadByUser.set(userId, payload);

  const run = async () => {
    const convex = createConvexClient();
    const serviceSecret = process.env.CONVEX_SERVICE_SECRET;
    if (!serviceSecret) {
      const msg = "Missing CONVEX_SERVICE_SECRET env var";
      logger?.warn?.(msg);
      throw new Error(msg);
    }

    // On entry, read the latest payload snapshot
    let toPublish: CreditsPayload | undefined = latestPayloadByUser.get(userId);

    if (logger?.info) {
      logger.info("Publishing credits to Convex (queued)", {
        userId,
        balance: toPublish?.balance,
      });
    } else {
      // eslint-disable-next-line no-console
      console.info("Publishing credits to Convex (queued)", {
        userId,
        balance: toPublish?.balance,
      });
    }

    try {
      // Refresh to latest right before sending, to coalesce multiple updates
      toPublish = latestPayloadByUser.get(userId) || toPublish!;
      if (!toPublish) {
        return;
      }

      await convex.mutation("credits:setProjection" as any, {
        userId,
        payload: toPublish,
        serviceSecret,
      } as any);

      if (logger?.info) {
        logger.info("Credits projection published", { userId });
      } else {
        // eslint-disable-next-line no-console
        console.info("Credits projection published", { userId });
      }

      // After successful publish, clear stale latest payload if it hasn't changed
      const latestAfter = latestPayloadByUser.get(userId);
      if (latestAfter === toPublish) {
        latestPayloadByUser.delete(userId);
      }
    } catch (error: any) {
      const msg = "Failed to publish credits to Convex";
      if (logger?.error) {
        logger.error(msg, { error, userId });
      } else {
        // eslint-disable-next-line no-console
        console.warn(msg, error);
      }
      // Cleanup: if no newer update arrived, drop the stale payload to avoid retention
      const latestAfterError = latestPayloadByUser.get(userId);
      if (latestAfterError === toPublish) {
        latestPayloadByUser.delete(userId);
      }
    }
  };

  const current = userIdToQueue.get(userId) || Promise.resolve();
  // Chain onto the existing promise to serialize per userId
  const next = current
    .catch(() => {})
    .then(run)
    .finally(() => {
      // If this promise is still the latest for this user, clear it
      if (userIdToQueue.get(userId) === next) {
        userIdToQueue.delete(userId);
      }
    });

  userIdToQueue.set(userId, next);
  return next;
}


