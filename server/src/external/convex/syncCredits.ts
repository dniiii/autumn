import { DrizzleCli } from "@/db/initDrizzle.js";
import { AppEnv, Organization, APIVersion } from "@autumn/shared";
import { CusService } from "@/internal/customers/CusService.js";
import { FeatureService } from "@/internal/features/FeatureService.js";
import { getCustomerDetails } from "@/internal/customers/cusUtils/getCustomerDetails.js";
import { publishCreditsProjection, CreditsPayload } from "./creditsPublisher.js";

export async function buildCreditsProjection({
  db,
  org,
  env,
  customerId,
  entityId,
  logger,
}: {
  db: DrizzleCli;
  org: Organization;
  env: AppEnv;
  customerId: string;
  entityId?: string;
  logger?: any;
}): Promise<CreditsPayload & { userId: string }> {
  const customer = await CusService.getFull({
    db,
    idOrInternalId: customerId,
    orgId: org.id,
    env,
    entityId,
  });
  const features = await FeatureService.list({ db, orgId: org.id, env });
  const cusDetails: any = await getCustomerDetails({
    db,
    customer,
    features,
    org,
    env,
    logger,
    cusProducts: customer.customer_products,
    expand: [],
    reqApiVersion: APIVersion.v1_2,
  });
  const balancesObj = cusDetails.customer?.features || cusDetails.features || {};
  const entries = Object.values(balancesObj as any);
  const total = entries.reduce((acc: number, e: any) => acc + (e.balance ?? 0), 0);

  // Best-effort subscription info (optional fields)
  let subscriptionTier: string | undefined;
  let subscriptionStatus: string | undefined;
  let subscriptionExpiry: string | undefined;
  try {
    const products = Array.isArray(customer.customer_products)
      ? customer.customer_products
      : [];
    // Prefer Active, then PastDue, else most recent
    const byPriority = (p: any) =>
      p.status === "Active" ? 0 : p.status === "PastDue" ? 1 : 2;
    const activeOrRecent = [...products].sort((a, b) => byPriority(a) - byPriority(b))[0];
    if (activeOrRecent) {
      subscriptionTier = activeOrRecent.product?.id || activeOrRecent.product_id || activeOrRecent.product?.name;
      subscriptionStatus = activeOrRecent.status;
      subscriptionExpiry = activeOrRecent.ended_at ? new Date(activeOrRecent.ended_at).toISOString() : undefined;
    }
  } catch {}

  // Intervals and rollovers (best-effort from feature responses)
  let intervals: any[] | undefined;
  let rolloverExpiries: string[] | undefined;
  let rolloverGroups: Array<{ iso: string; count: number }> | undefined;
  // Breakdown and resets (best-effort)
  let dailyAvailable = 0;
  let subscriptionAvailable = 0; // monthly + yearly
  let purchasedAvailable = 0; // permanent/no-interval
  let nextDailyResetIso: string | undefined;
  let nextMonthlyResetIso: string | undefined;
  try {
    const mapped = entries
      .filter((e: any) => e && typeof e === "object")
      .map((e: any) => ({
        interval: e.interval || "unknown",
        balance: typeof e.balance === "number" ? e.balance : 0,
        nextResetAt: e.next_reset_at ? new Date(e.next_reset_at).toISOString() : undefined,
        rollovers: Array.isArray(e.rollovers) ? e.rollovers : [],
        breakdown: Array.isArray(e.breakdown) ? e.breakdown : undefined,
      }));
    if (mapped.length > 0) {
      // Build flattened intervals using per-entitlement breakdown when present
      const flattened: Array<{ interval: string; balance: number; nextResetAt?: string }> = [];
      for (const m of mapped) {
        if (Array.isArray(m.breakdown) && m.breakdown.length > 0) {
          for (const b of m.breakdown) {
            flattened.push({
              interval: (b.interval || "unknown").toString(),
              balance: typeof b.balance === "number" ? b.balance : 0,
              nextResetAt: b.next_reset_at ? new Date(b.next_reset_at).toISOString() : undefined,
            });
          }
        } else {
          flattened.push({ interval: m.interval, balance: m.balance, nextResetAt: m.nextResetAt });
        }
      }
      // Filter noise: drop unknown with zero balance
      intervals = flattened.filter((f) => !(f.interval === "unknown" && (!f.balance || f.balance === 0)));

      const allExp = mapped.flatMap((m) => m.rollovers.map((r: any) => r.expires_at)).filter(Boolean);
      if (allExp.length > 0) {
        rolloverExpiries = allExp.map((ts: number | string) => new Date(ts as any).toISOString());
        const grouped = (rolloverExpiries as string[]).reduce((acc: Record<string, number>, iso: string) => {
          acc[iso] = (acc[iso] || 0) + 1;
          return acc;
        }, {});
        rolloverGroups = Object.entries(grouped).map(([iso, count]) => ({ iso, count }));

        // Compute amounts per expiry for UI (embed inside intervals since schema allows any there)
        const amountsByIso: Record<string, number> = {};
        for (const m of mapped) {
          for (const r of m.rollovers) {
            const iso = new Date(r.expires_at as any).toISOString();
            const amt = typeof r.balance === "number" ? r.balance : 0;
            amountsByIso[iso] = (amountsByIso[iso] || 0) + amt;
          }
        }
        const detailed = Object.entries(amountsByIso)
          .map(([iso, amount]) => ({ iso, amount }))
          .sort((a, b) => new Date(a.iso).getTime() - new Date(b.iso).getTime());
        if (detailed.length > 0) {
          (intervals as any[]).push({ type: "rollovers", rollovers: detailed });
        }
      }

      const consider = (interval: any, balance: any, nextResetAt?: any) => {
        if (typeof balance === "number") {
          const intStr = (interval || "").toString().toLowerCase();
          if (intStr === "day" || intStr === "daily") {
            dailyAvailable += balance;
            if (nextResetAt) {
              if (!nextDailyResetIso || new Date(nextResetAt).getTime() < new Date(nextDailyResetIso).getTime()) {
                nextDailyResetIso = nextResetAt;
              }
            }
          } else if (
            intStr === "week" ||
            intStr === "weekly" ||
            intStr === "month" ||
            intStr === "monthly" ||
            intStr === "year" ||
            intStr === "yearly"
          ) {
            subscriptionAvailable += balance;
            if (nextResetAt) {
              if (!nextMonthlyResetIso || new Date(nextResetAt).getTime() < new Date(nextMonthlyResetIso).getTime()) {
                nextMonthlyResetIso = nextResetAt;
              }
            }
          } else {
            purchasedAvailable += balance;
          }
        }
      };

      // Track if any monthly/yearly was found explicitly from breakdowns
      let foundExplicitSubscription = false;

      for (const f of intervals as Array<{ interval: string; balance: number; nextResetAt?: string }>) {
        const beforeSub = subscriptionAvailable;
        consider(f.interval, f.balance, f.nextResetAt);
        if (subscriptionAvailable > beforeSub) foundExplicitSubscription = true;
      }

      // If no explicit monthly/yearly found but there is a combined nextResetAt at the feature level,
      // allocate unknown balances with nextResetAt to subscription and undo their addition to purchased.
      if (!foundExplicitSubscription) {
        for (const f of intervals as Array<{ interval: string; balance: number; nextResetAt?: string }>) {
          if ((f.interval === "unknown" || f.interval === "multiple") && f.nextResetAt && f.balance > 0) {
            purchasedAvailable = Math.max(0, purchasedAvailable - f.balance);
            subscriptionAvailable += f.balance;
            if (!nextMonthlyResetIso || new Date(f.nextResetAt).getTime() < new Date(nextMonthlyResetIso).getTime()) {
              nextMonthlyResetIso = f.nextResetAt;
            }
          }
        }
      }
    }
  } catch {}
  return {
    userId: customer.id!,
    balance: total,
    subscriptionTier,
    subscriptionStatus,
    subscriptionExpiry,
    intervals,
    rolloverExpiries,
    rolloverGroups,
    breakdown: {
      dailyFree: dailyAvailable ? { available: dailyAvailable } : undefined,
      subscription: subscriptionAvailable ? { available: subscriptionAvailable } : undefined,
      purchased: purchasedAvailable ? { available: purchasedAvailable } : undefined,
    },
    resets: {
      nextDailyReset: nextDailyResetIso,
      nextMonthlyReset: nextMonthlyResetIso,
      nextRolloverExpiry: rolloverExpiries && rolloverExpiries.length > 0 ? rolloverExpiries[0] : undefined,
    },
    updatedAt: Date.now(),
  };
}

export async function syncCreditsToConvex(args: {
  db: DrizzleCli;
  org: Organization;
  env: AppEnv;
  customerId: string;
  entityId?: string;
  logger?: any;
}) {
  try {
    const { userId, ...payload } = await buildCreditsProjection(args);
    await publishCreditsProjection({ userId, payload, logger: args.logger });
  } catch (e) {
    // eslint-disable-next-line no-console
    if (args.logger?.warn) {
      args.logger.warn("Convex mirror failed", { error: e });
    } else {
      console.warn("Convex mirror failed", e);
    }
  }
}


