import { DrizzleCli } from "@/db/initDrizzle.js";
import { AppEnv, Organization, APIVersion } from "@autumn/shared";
import { CusService } from "@/internal/customers/CusService.js";
import { FeatureService } from "@/internal/features/FeatureService.js";
import { getCustomerDetails } from "@/internal/customers/cusUtils/getCustomerDetails.js";
import { publishCreditsProjectionV2, CreditsPayloadV2 } from "./creditsPublisher.js";
import { createHash } from "crypto";

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
      // Choose only from Active/PastDue/Trialing for active main
      const isActiveLike = (s: any) => ["active", "pastdue", "past_due", "trialing"].includes(String(s).toLowerCase());
      const activePool = mains.filter((p: any) => isActiveLike(p.status));
      const byPriority = (p: any) => (String(p.status).toLowerCase() === "active" ? 0 : 1);
      const current = activePool.length > 0 ? [...activePool].sort((a, b) => byPriority(a) - byPriority(b))[0] : undefined;
      if (current) {
        subscriptionTierId = (current.id || "free").replace(/_(monthly|yearly|year)$/i, "");
        subscriptionProductId = current.id;
        const periodStart = current.current_period_start ? new Date(current.current_period_start).toISOString() : undefined;
        const periodEnd = current.current_period_end ? new Date(current.current_period_end).toISOString() : undefined;
        activeMain = {
          productId: current.id,
          name: typeof current.name === "string" ? current.name : undefined,
          status: current.status,
          group: typeof current.group === "string" ? current.group : undefined,
          currentPeriodStart: periodStart,
          currentPeriodEnd: periodEnd,
          billingCycleAnchor: periodStart,
          collectionMethod: typeof current.collection_method === "string" ? current.collection_method : undefined,
        };
        if (/year|yearly/i.test(current.id)) subscriptionInterval = "year";
        else if (/month|monthly/i.test(current.id)) subscriptionInterval = "month";
      }
      const scheduled = productsResp.find((p: any) => p && p.is_add_on === false && String(p.status).toLowerCase() === "scheduled");
      if (scheduled) {
        scheduledChange = {
          exists: true,
          productId: scheduled.id,
          scheduledProductName: typeof scheduled.name === "string" ? scheduled.name : undefined,
          group: typeof scheduled.group === "string" ? scheduled.group : undefined,
          scheduledAt: scheduled.created_at ? new Date(scheduled.created_at).toISOString() : undefined,
          effectiveAt: scheduled.starts_at ? new Date(scheduled.starts_at).toISOString() : undefined,
        };
      }
    }
  } catch {}

  // Fallback: if no scheduled found via processed products, scan raw customer_products
  if (!scheduledChange?.exists) {
    try {
      const schedCp = (customer.customer_products || []).find(
        (cp: any) => cp && cp.product && cp.product.is_add_on === false && String(cp.status).toLowerCase() === "scheduled"
      );
      if (schedCp) {
        scheduledChange = {
          exists: true,
          productId: schedCp.product.id,
          scheduledProductName: schedCp.product.name,
          group: schedCp.product.group,
          scheduledAt: schedCp.created_at ? new Date(schedCp.created_at).toISOString() : undefined,
          effectiveAt: schedCp.starts_at ? new Date(schedCp.starts_at).toISOString() : undefined,
        };
      }
    } catch {}
  }

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

    hasActiveSubscription: Boolean(
      activeMain && ["active", "pastdue", "past_due", "trialing"].includes(String(activeMain.status).toLowerCase())
    ),
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
    const makeHash = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 16);
    const makePocketId = (fields: Record<string, any>) => {
      const key = Object.entries(fields)
        .filter(([, v]) => v !== undefined && v !== null && v !== "")
        .map(([k, v]) => `${k}=${String(v)}`)
        .sort()
        .join("|");
      return makeHash(key);
    };
    for (const [featureId, row] of Object.entries(featsObj)) {
      const e: any = row as any;
      const intervalStr = (e.interval || "unknown").toString().toLowerCase();
      const hasRollovers = Array.isArray(e.rollovers) && e.rollovers.length > 0;
      const hasTopups = Array.isArray(e.topups) && e.topups.length > 0;
      // Normalize interval to schema: day | month | year | lifetime
      let interval: "day" | "month" | "year" | "lifetime";
      if (intervalStr === "daily" || intervalStr === "day") interval = "day";
      else if (intervalStr === "yearly" || intervalStr === "year") interval = "year";
      else if (intervalStr === "monthly" || intervalStr === "month") interval = "month";
      else if (!hasRollovers && hasTopups && !e.next_reset_at) interval = "lifetime";
      else interval = "month"; // default normalization
      const type = e.unlimited === true || e.type === "boolean" ? "boolean" : "metered";
      // Build pockets once (only relevant for month/year)
      const pocketsAll: any[] = [];
      const seen = new Set<string>();
      let topupTotal = 0;
      if (interval !== "day") {
        const rollArr = Array.isArray(e.rollovers) ? e.rollovers : [];
        for (let idx = 0; idx < rollArr.length; idx++) {
          const r = rollArr[idx];
          const amount = Number(r.balance || r.amount || 0);
          const expiresAtIso = r.expires_at ? new Date(r.expires_at).toISOString() : undefined;
          const src = r.source || {};
          const fromProductId = src.fromProductId || src.from_product_id || undefined;
          const capturedAtIso = src.capturedAt
            ? new Date(src.capturedAt).toISOString()
            : r.captured_at
              ? new Date(r.captured_at).toISOString()
              : undefined;
          const pid = r.id || makePocketId({ featureId, category: "rollover", amount, expiresAt: expiresAtIso, fromProductId, capturedAt: capturedAtIso });
          if (seen.has(pid)) continue;
          seen.add(pid);
          pocketsAll.push({
            pocketId: pid,
            category: "rollover" as const,
            amount,
            expiresAt: expiresAtIso,
            source: { fromProductId, capturedAt: capturedAtIso },
          });
        }
        const topArr = Array.isArray(e.topups) ? e.topups : [];
        for (let i = 0; i < topArr.length; i++) {
          const t = topArr[i];
          const amount = Number(t.balance || t.amount || 0);
          topupTotal += amount;
          const expiresAtIso = t.expires_at ? new Date(t.expires_at).toISOString() : undefined;
          const invoiceId = t.invoiceId || t.invoice_id || undefined;
          const checkoutSessionId = t.checkoutSessionId || t.checkout_session_id || undefined;
          const capturedAtIso = t.capturedAt ? new Date(t.capturedAt).toISOString() : undefined;
          const pid = t.id || invoiceId || checkoutSessionId || makePocketId({ featureId, category: "topup", amount, capturedAt: capturedAtIso });
          if (seen.has(pid)) continue;
          seen.add(pid);
          pocketsAll.push({
            pocketId: pid,
            category: "topup" as const,
            amount,
            expiresAt: expiresAtIso,
            source: { invoiceId, checkoutSessionId, capturedAt: capturedAtIso },
          });
        }
      }
      // Build sub-entries per-interval if breakdown exists; otherwise single entry
      const breakdownArr = Array.isArray(e.breakdown) ? e.breakdown : null;
      let parts = breakdownArr
        ? breakdownArr.map((b: any) => ({
            interval: (b.interval || "unknown").toString().toLowerCase(),
            available: Number(b.balance || 0),
            nextResetAt: b.next_reset_at ? new Date(b.next_reset_at).toISOString() : undefined,
          }))
        : undefined;

      if (!parts) {
        const totalAvail = Number(e.balance || 0);
        // If daily exists but breakdown missing, split into day + month/year parts
        if ((interval === "month" || interval === "year") && dailyAvailable > 0 && totalAvail >= dailyAvailable) {
          parts = [
            { interval: "day", available: dailyAvailable, nextResetAt: nextDailyResetIso },
            {
              interval: interval,
              available: totalAvail - dailyAvailable,
              nextResetAt: e.next_reset_at ? new Date(e.next_reset_at).toISOString() : nextMonthlyResetIso,
            },
          ];
        } else {
          parts = [{ interval: intervalStr, available: totalAvail, nextResetAt: e.next_reset_at ? new Date(e.next_reset_at).toISOString() : undefined }];
        }
      }

      // Drop zero/negative parts to avoid duplicate empty rows
      parts = parts.filter((p: any) => (p.available || 0) > 0);

      let monthYearPocketsAssigned = false;
      for (const part of parts) {
        let partInterval: "day" | "month" | "year" | "lifetime";
        if (part.interval === "daily" || part.interval === "day") partInterval = "day";
        else if (part.interval === "yearly" || part.interval === "year") partInterval = "year";
        else if (part.interval === "monthly" || part.interval === "month") partInterval = "month";
        else if (!part.nextResetAt) partInterval = "lifetime"; // unknown with no reset -> lifetime
        else if (!hasRollovers && hasTopups && !e.next_reset_at) partInterval = "lifetime";
        else partInterval = interval; // fallback to overall normalization

        // If this part looks like pure top-ups (no reset and equals total topups), mark as lifetime
        if ((partInterval === "month" || partInterval === "year") && !part.nextResetAt && topupTotal > 0 && Math.abs(part.available - topupTotal) < 1e-6) {
          partInterval = "lifetime";
        }

        // Only attach pockets to the first month/year part to prevent duplicates
        const canHavePockets = partInterval === "month" || partInterval === "year";
        const pocketsForPart = canHavePockets && !monthYearPocketsAssigned ? pocketsAll : [];
        if (canHavePockets && pocketsForPart.length > 0) monthYearPocketsAssigned = true;
        const pocketTotals = pocketsForPart.length
          ? pocketsForPart.reduce(
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
          label: typeof e.label === "string" ? e.label : undefined,
          type,
          interval: partInterval,
          allowance: typeof e.allowance === "number" ? e.allowance : undefined,
          used: typeof e.used === "number" ? e.used : undefined,
          available: part.available,
          nextResetAt: part.nextResetAt,
          unit: typeof e.unit === "string" ? e.unit : undefined,
          rolloverPolicy: e.rollover ? { enabled: true, expiryMonths: e.rollover?.months || undefined, capPerMonth: e.rollover?.cap || undefined } : undefined,
          pockets: pocketsForPart,
          pocketTotals,
        });
      }
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


