import { DrizzleCli } from "@/db/initDrizzle.js";
import { AppEnv, Organization, APIVersion } from "@autumn/shared";
import { CusService } from "@/internal/customers/CusService.js";
import { FeatureService } from "@/internal/features/FeatureService.js";
import { getCustomerDetails } from "@/internal/customers/cusUtils/getCustomerDetails.js";
import { publishCreditsProjectionV2, CreditsPayloadV2 } from "./creditsPublisher.js";

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
}): Promise<CreditsPayloadV2 & { userId: string }> {
  const customer = await CusService.getFull({
    db,
    idOrInternalId: customerId,
    orgId: org.id,
    env,
    entityId,
    withSubs: true,
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

  // v2 fields: active main & scheduled change
  let activeMain: any | undefined;
  let scheduledChange: any = { exists: false };
  let subscriptionTierId = "free";
  let subscriptionInterval: "month" | "year" | undefined;
  let subscriptionProductId: string | undefined;
  let subscriptionCurrency: string | undefined;
  let subscriptionPriceCents: number | undefined;
  try {
    // Prefer using processed customer details which already separate add-ons
    const productsResp = Array.isArray((cusDetails as any).products)
      ? (cusDetails as any).products
      : [];
    const mains = productsResp.filter((p: any) => p && p.is_add_on === false);
    if (mains.length > 0) {
      const byPriority = (p: any) =>
        p.status === "Active" ? 0 : p.status === "PastDue" ? 1 : 2;
      const current = [...mains].sort((a, b) => byPriority(a) - byPriority(b))[0];
      if (current) {
        subscriptionTierId = (current.id || "free").replace(/_(monthly|yearly|year)$/i, "");
        subscriptionProductId = current.id;
        const periodStart = current.current_period_start ? new Date(current.current_period_start).toISOString() : undefined;
        const periodEnd = current.current_period_end ? new Date(current.current_period_end).toISOString() : undefined;
        activeMain = {
          productId: current.id,
          name: current.name,
          status: current.status,
          group: current.group,
          currentPeriodStart: periodStart,
          currentPeriodEnd: periodEnd,
          billingCycleAnchor: periodStart,
          collectionMethod: current.collection_method,
        };
        if (/year|yearly/i.test(current.id)) subscriptionInterval = "year";
        else if (/month|monthly/i.test(current.id)) subscriptionInterval = "month";
      }
      const scheduled = productsResp.find((p: any) => p && p.is_add_on === false && p.status === "Scheduled");
      if (scheduled) {
        scheduledChange = {
          exists: true,
          productId: scheduled.id,
          scheduledProductName: scheduled.name,
          group: scheduled.group,
          scheduledAt: scheduled.created_at ? new Date(scheduled.created_at).toISOString() : undefined,
          effectiveAt: scheduled.starts_at ? new Date(scheduled.starts_at).toISOString() : undefined,
        };
      }
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
  // Build v2 doc
  const v2: any = {
    version: 2,
    userId: customer.id!,
    entityId: customer.entity?.id || undefined,
    updatedAt: Date.now(),

    hasActiveSubscription: Boolean(activeMain && ["Active", "PastDue", "Trialing"].includes(activeMain.status)),
    isDowngradeScheduled: false,
    subscriptionTierId,
    subscriptionInterval,
    subscriptionProductId,
    subscriptionCurrency,
    subscriptionPriceCents,

    subscription: {
      activeMain,
      scheduledChange,
    },

    // Entitlements/pockets are derived below; if not available, keep empty
    entitlements: [],

    totals: {
      daily: dailyAvailable,
      subscription: subscriptionAvailable,
      lifetime: purchasedAvailable,
    },
    resets: {
      nextDailyReset: nextDailyResetIso,
      nextSubscriptionReset: nextMonthlyResetIso,
      nextRolloverExpiry: rolloverExpiries && rolloverExpiries.length > 0 ? rolloverExpiries[0] : undefined,
    },
    upcoming: {
      rolloverExpiries: Array.isArray(intervals?.find((x: any) => x?.type === "rollovers")?.rollovers)
        ? (intervals!.find((x: any) => x?.type === "rollovers")!.rollovers as any[])
            .map((r: any) => ({ iso: r.iso || r.date || r, amount: r.amount || 0, pocketCount: r.pocketCount || 1 }))
        : [],
    },
  } as CreditsPayloadV2;

  // Map entitlements and pockets best-effort from balances object
  try {
    const featsObj = balancesObj as any;
    const ents: any[] = [];
    for (const [featureId, row] of Object.entries(featsObj)) {
      const e: any = row as any;
      const intervalStr = (e.interval || "unknown").toString().toLowerCase();
      const interval = intervalStr === "daily" ? "day" : intervalStr === "yearly" ? "year" : intervalStr === "monthly" ? "month" : intervalStr;
      const type = e.unlimited === true || e.type === "boolean" ? "boolean" : "metered";
      const pockets: any[] = Array.isArray(e.rollovers)
        ? e.rollovers.map((r: any, idx: number) => ({
            pocketId: r.id || `${featureId}-roll-${idx}`,
            category: "rollover",
            amount: Number(r.balance || r.amount || 0),
            expiresAt: r.expires_at ? new Date(r.expires_at).toISOString() : undefined,
            source: r.source || undefined,
          }))
        : [];
      if (Array.isArray(e.topups)) {
        for (let i = 0; i < e.topups.length; i++) {
          const t = e.topups[i];
          pockets.push({
            pocketId: t.id || `${featureId}-top-${i}`,
            category: "topup",
            amount: Number(t.balance || t.amount || 0),
            expiresAt: t.expires_at ? new Date(t.expires_at).toISOString() : undefined,
            source: t.source || undefined,
          });
        }
      }
      const pocketTotals = pockets.length
        ? pockets.reduce(
            (acc, p) => {
              if (p.category === "rollover") acc.rollover += p.amount || 0;
              else if (p.category === "topup") acc.topup += p.amount || 0;
              return acc;
            },
            { rollover: 0, topup: 0 }
          )
        : undefined;
      ents.push({
        featureId,
        label: e.label,
        type,
        interval,
        allowance: typeof e.allowance === "number" ? e.allowance : undefined,
        used: typeof e.used === "number" ? e.used : undefined,
        available: Number(e.balance || 0),
        nextResetAt: e.next_reset_at ? new Date(e.next_reset_at).toISOString() : undefined,
        unit: e.unit,
        rolloverPolicy: e.rollover ? { enabled: true, expiryMonths: e.rollover?.months || undefined, capPerMonth: e.rollover?.cap || undefined } : undefined,
        pockets,
        pocketTotals,
      });
    }
    v2.entitlements = ents;
  } catch {}

  return v2 as CreditsPayloadV2 & { userId: string };
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
    const v2 = await buildCreditsProjection(args);
    await publishCreditsProjectionV2({
      userId: v2.userId,
      entityId: v2.entityId,
      payload: v2,
      logger: args.logger,
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    if (args.logger?.warn) {
      args.logger.warn("Convex mirror failed", { error: e });
    } else {
      console.warn("Convex mirror failed", e);
    }
  }
}


