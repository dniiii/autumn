import { createConvexClient } from "./convexClient.js";

// Serialize and coalesce concurrent publishes per user to avoid Convex write conflicts
const userIdToQueue: Map<string, Promise<void>> = new Map();
const latestPayloadByUser: Map<string, CreditsPayloadV2> = new Map();
// No additional backoff or debounce; Convex handles retries for conflicts

// Full v2 payload we will upsert via Convex mutation `credits:upsertV2`
export type CreditsPayloadV2 = {
  version: 2;
  userId: string;
  entityId?: string | null;
  updatedAt: number;

  hasActiveSubscription: boolean;
  isDowngradeScheduled: boolean;
  subscriptionTierId: string;
  subscriptionInterval?: "month" | "year";
  subscriptionProductId?: string;
  subscriptionCurrency?: string;
  subscriptionPriceCents?: number;

  subscription: {
    activeMain?: {
      productId: string;
      name?: string;
      status: string;
      group?: string;
      currentPeriodStart?: string;
      currentPeriodEnd?: string;
      billingCycleAnchor?: string;
      collectionMethod?: string;
    };
    scheduledChange: {
      exists: boolean;
      action?: "downgrade" | "upgrade" | "switch" | "cancel";
      group?: string;
      productId?: string;
      scheduledProductName?: string;
      scheduledAt?: string;
      effectiveAt?: string;
    };
  };

  entitlements: Array<{
    featureId: string;
    label?: string;
    type: "metered" | "boolean";
    interval: "day" | "month" | "year" | "lifetime";
    allowance?: number;
    used?: number;
    available: number;
    nextResetAt?: string;
    unit?: string;
    rolloverPolicy?: { enabled: boolean; expiryMonths?: number; capPerMonth?: number };
    pockets: Array<{
      pocketId: string;
      category: "rollover" | "topup";
      amount: number;
      expiresAt?: string;
      source?: {
        fromProductId?: string;
        fromProductName?: string;
        invoiceId?: string;
        checkoutSessionId?: string;
        capturedAt?: string;
      };
    }>;
    pocketTotals?: { rollover: number; topup: number };
  }>;

  totals: { daily: number; subscription: number; lifetime: number; rollover?: number };
  resets: { nextDailyReset?: string; nextSubscriptionReset?: string; nextRolloverExpiry?: string };
  upcoming: { rolloverExpiries: Array<{ iso: string; amount: number; pocketCount: number }> };
  rollover?: { enabled: boolean; expiryMonths?: number; capPerMonth?: number };
  uiHints?: { unit: string; precision: number };
  billing?: { billingCycleAnchor?: string; collectionMethod?: string };
  requiresPaymentMethod?: boolean;
  audit?: { lastWebhookAt?: string; lastSourceEventId?: string; lastSyncAt?: string };
};

export async function publishCreditsProjectionV2({
  userId,
  entityId,
  payload,
  logger,
}: {
  userId: string;
  entityId?: string | null;
  payload: CreditsPayloadV2;
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
    let toPublish: CreditsPayloadV2 | undefined = latestPayloadByUser.get(userId);

    if (logger?.info) {
      logger.info("Publishing credits v2 to Convex (queued)", {
        userId,
        version: toPublish?.version,
      });
    } else {
      // eslint-disable-next-line no-console
      console.info("Publishing credits v2 to Convex (queued)", {
        userId,
        version: toPublish?.version,
      });
    }

    try {
      // Refresh to latest right before sending, to coalesce multiple updates
      toPublish = latestPayloadByUser.get(userId) || toPublish!;
      if (!toPublish) {
        return;
      }

      await convex.mutation("credits:upsertV2" as any, {
        userId,
        entityId,
        doc: toPublish,
        serviceSecret,
      } as any);

      if (logger?.info) {
        logger.info("Credits v2 projection published", { userId });
      } else {
        // eslint-disable-next-line no-console
        console.info("Credits v2 projection published", { userId });
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


