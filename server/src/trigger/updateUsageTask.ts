import {
  AllowanceType,
  AppEnv,
  CusProductStatus,
  Customer,
  Feature,
  FeatureType,
  FullCustomerEntitlement,
  Organization,
  EntInterval,
} from "@autumn/shared";
import { getCusEntsInFeatures } from "@/internal/customers/cusUtils/cusUtils.js";

import { featureToCreditSystem } from "@/internal/features/creditSystemUtils.js";
import { getFeatureBalance } from "@/internal/customers/cusProducts/cusEnts/cusEntUtils.js";
import { Decimal } from "decimal.js";

import {
  deductAllowanceFromCusEnt,
  deductFromUsageBasedCusEnt,
} from "./updateBalanceTask.js";
import { getSortedRollovers } from "@/internal/customers/cusProducts/cusEnts/cusRollovers/rolloverDeductionUtils.js";
import { calculateNextExpiry } from "@/internal/customers/cusProducts/cusEnts/cusRollovers/rolloverUtils.js";
import { CusService } from "@/internal/customers/CusService.js";
import { DrizzleCli } from "@/db/initDrizzle.js";
import { deductFromCusRollovers } from "@/internal/customers/cusProducts/cusEnts/cusRollovers/rolloverDeductionUtils.js";
import { refreshCusCache, deleteCusCache } from "@/internal/customers/cusCache/updateCachedCus.js";
import { syncCreditsToConvex } from "@/external/convex/syncCredits.js";

// 2. Get deductions for each feature
const getFeatureDeductions = ({
  cusEnts,
  value,
  features,
  shouldSet,
}: {
  cusEnts: FullCustomerEntitlement[];
  value: number;
  features: Feature[];
  shouldSet: boolean;
}) => {
  let meteredFeature =
    features.find((f) => f.type === FeatureType.Metered) || features[0];

  const featureDeductions = [];
  for (const feature of features) {
    let newValue = value;
    let unlimitedExists = cusEnts.some(
      (cusEnt) =>
        cusEnt.entitlement.allowance_type === AllowanceType.Unlimited &&
        cusEnt.entitlement.internal_feature_id == feature.internal_id
    );

    if (unlimitedExists) {
      continue;
    }

    if (feature.type === FeatureType.CreditSystem) {
      newValue = featureToCreditSystem({
        featureId: meteredFeature.id,
        creditSystem: feature,
        amount: value,
      });
    }

    // If it's set
    let deduction = newValue;

    if (shouldSet) {
      let totalAllowance = cusEnts.reduce((acc, curr) => {
        return acc + (curr.entitlement.allowance || 0);
      }, 0);

      let targetBalance = new Decimal(totalAllowance).sub(value).toNumber();

      let totalBalance = getFeatureBalance({
        cusEnts,
        internalFeatureId: feature.internal_id!,
      })!;

      deduction = new Decimal(totalBalance).sub(targetBalance).toNumber();
    }

    if (deduction == 0) {
      console.log(`   - Skipping feature ${feature.id} -- deduction is 0`);
      continue;
    }

    featureDeductions.push({
      feature,
      deduction,
    });
  }

  featureDeductions.sort((a, b) => {
    if (
      a.feature.type === FeatureType.CreditSystem &&
      b.feature.type !== FeatureType.CreditSystem
    ) {
      return 1;
    }

    if (
      a.feature.type !== FeatureType.CreditSystem &&
      b.feature.type === FeatureType.CreditSystem
    ) {
      return -1;
    }

    return a.feature.id.localeCompare(b.feature.id);
  });

  return featureDeductions;
};

const logUsageUpdate = ({
  customer,
  features,
  cusEnts,
  featureDeductions,
  org,
  setUsage,
  entityId,
}: {
  customer: Customer;
  features: Feature[];
  cusEnts: FullCustomerEntitlement[];
  featureDeductions: any;
  org: Organization;
  setUsage: boolean;
  entityId?: string;
}) => {
  console.log(
    `   - Customer: ${customer.id} (${customer.env}) | Org: ${
      org.slug
    } | Features: ${features.map((f) => f.id).join(", ")} | Set Usage: ${
      setUsage ? "true" : "false"
    }`
  );

  console.log(
    "   - CusEnts:",
    cusEnts.map((cusEnt: any) => {
      let balanceStr = cusEnt.balance;
      try {
        if (cusEnt.entitlement.allowance_type === AllowanceType.Unlimited) {
          balanceStr = "Unlimited";
        }
      } catch (error) {
        balanceStr = "failed_to_get_balance";
      }

      if (entityId && cusEnt.entities) {
        balanceStr = `${cusEnt.entities?.[entityId!]?.balance} [${entityId}]`;
      }

      return `${cusEnt.feature_id} - ${balanceStr} (${
        cusEnt.customer_product ? cusEnt.customer_product.product_id : ""
      })`;
    }),
    "| Deductions:",
    featureDeductions.map((f: any) => `${f.feature.id}: ${f.deduction}`)
  );
};

// Main function to update customer balance
export const updateUsage = async ({
  db,
  customerId,
  features,
  org,
  env,
  value,
  properties,
  setUsage,
  logger,
  entityId,
}: {
  db: DrizzleCli;
  customerId: string;
  features: Feature[];
  org: Organization;
  env: AppEnv;
  value: number;
  properties: any;
  setUsage: boolean;
  logger: any;
  entityId?: string;
}) => {
  const customer = await CusService.getFull({
    db,
    idOrInternalId: customerId,
    orgId: org.id,
    env,
    inStatuses: [CusProductStatus.Active, CusProductStatus.PastDue],
    entityId,
  });

  const { cusEnts, cusPrices } = await getCusEntsInFeatures({
    customer,
    internalFeatureIds: features.map((f) => f.internal_id!),
    logger,
    reverseOrder: org.config?.reverse_deduction_order,
  });

  // 1. Get deductions for each feature
  const featureDeductions = getFeatureDeductions({
    cusEnts,
    value,
    shouldSet: setUsage,
    features,
  });

  logUsageUpdate({
    customer,
    features,
    cusEnts,
    featureDeductions,
    org,
    setUsage,
    entityId,
  });

  // 3. Return if no customer entitlements or features found
  if (cusEnts.length === 0 || features.length === 0) {
    console.log("   - No customer entitlements or features found");
    return;
  }

  const isRefund = value < 0;

    for (const obj of featureDeductions) {
    let { feature, deduction: toDeduct } = obj;

    // Refunds: route negative amounts to the Lifetime (non-expiring) pocket if present
    if (isRefund) {
      const lifetimeEnt = cusEnts.find(
        (ce) =>
          ce.entitlement.internal_feature_id === feature.internal_id &&
          ce.entitlement.interval === EntInterval.Lifetime
      );

      if (lifetimeEnt) {
        await deductAllowanceFromCusEnt({
          toDeduct,
          cusEnt: lifetimeEnt,
          deductParams: {
            db,
            feature,
            env,
            org,
            cusPrices: cusPrices as any[],
            customer,
            properties,
            entity: customer.entity,
          },
          featureDeductions,
          willDeductCredits: true,
          setZeroAdjustment: true,
        });
        // Done with this feature; move to next featureDeductions item
        continue;
      }
      // No lifetime pocket found; fall through to default behavior
    }

    // Ordered deduction across all pocket types (unified by earliest effective expiry)
    const isSameFeature = (ce: any) => ce.entitlement.internal_feature_id === feature.internal_id;
    const intervalOf = (ce: any) => ce.entitlement.interval;

    const dailyLike = cusEnts.filter((ce) => isSameFeature(ce) && (
      intervalOf(ce) === EntInterval.Minute ||
      intervalOf(ce) === EntInterval.Hour ||
      intervalOf(ce) === EntInterval.Day
    ));
    const subLike = cusEnts.filter((ce) => isSameFeature(ce) && (
      intervalOf(ce) === EntInterval.Month ||
      intervalOf(ce) === EntInterval.Quarter ||
      intervalOf(ce) === EntInterval.SemiAnnual ||
      intervalOf(ce) === EntInterval.Year
    ));
    const lifetimeLike = cusEnts.filter((ce) => isSameFeature(ce) && intervalOf(ce) === EntInterval.Lifetime);
    const hasEntityFeature = cusEnts.some((ce) => isSameFeature(ce) && Boolean((ce as any)?.entitlement?.entity_feature_id));

    // Compute earliest effective expiry per category
    const dailyMin = (() => {
      const candidates = dailyLike.map((ce: any) => ce.next_reset_at).filter((t: any) => typeof t === "number" && t > 0);
      return candidates.length > 0 ? Math.min(...candidates) : undefined;
    })();

    const rollMin = (() => {
      try {
        const rolls = getSortedRollovers({
          cusEnts: cusEnts as any,
          featureId: feature.id,
          entityId: hasEntityFeature ? customer.entity?.id : undefined,
        });
        const withBal = rolls.filter((r: any) => (r.balance ?? 0) > 0 || (r.entities && Object.values(r.entities).some((e: any) => (e.balance ?? 0) > 0)));
        return withBal.length > 0 ? withBal[0].expires_at || undefined : undefined;
      } catch {
        return undefined;
      }
    })();

    const subMin = (() => {
      const effs: number[] = [];
      for (const ce of subLike) {
        const ent: any = ce.entitlement;
        const nextReset: number | undefined = typeof ce.next_reset_at === "number" ? ce.next_reset_at : undefined;
        if (!nextReset) continue;
        const eff = ent?.rollover ? calculateNextExpiry(nextReset, ent.rollover) : nextReset;
        if (typeof eff === "number") effs.push(eff);
      }
      return effs.length > 0 ? Math.min(...effs) : undefined;
    })();

    type CatKey = "daily" | "roll" | "sub";
    const categoryOrder = (
      [
        { key: "daily" as CatKey, ts: dailyMin },
        { key: "roll" as CatKey, ts: rollMin },
        { key: "sub" as CatKey, ts: subMin },
      ] as Array<{ key: CatKey; ts: number | undefined }>
    ).sort(
      (a, b) =>
        (a.ts ?? Number.POSITIVE_INFINITY) - (b.ts ?? Number.POSITIVE_INFINITY)
    );

    // If none have expiries, process lifetime then usage-based
    if (categoryOrder.length === 0 && toDeduct > 0 && lifetimeLike.length > 0) {
      for (const ce of lifetimeLike) {
        if (toDeduct === 0) break;
        toDeduct = await deductAllowanceFromCusEnt({
          toDeduct,
          cusEnt: ce as any,
          deductParams: {
            db,
            feature,
            env,
            org,
            cusPrices: cusPrices as any[],
            customer,
            properties,
            entity: customer.entity,
          },
          featureDeductions,
          willDeductCredits: true,
          setZeroAdjustment: true,
        });
      }
    }

    // Cascade by earliest effective expiry: daily vs rollovers vs subscription
    for (const entry of categoryOrder) {
      if (toDeduct === 0) break;
      if (entry.key === "daily") {
        // Deduct from earliest daily ce first, then remaining dailies
        const dSorted = [...dailyLike].sort((a: any, b: any) => (a.next_reset_at || 0) - (b.next_reset_at || 0));
        for (const ce of dSorted) {
          if (toDeduct === 0) break;
          toDeduct = await deductAllowanceFromCusEnt({
            toDeduct,
            cusEnt: ce as any,
            deductParams: {
              db,
              feature,
              env,
              org,
              cusPrices: cusPrices as any[],
              customer,
              properties,
              entity: customer.entity,
            },
            featureDeductions,
            willDeductCredits: true,
            setZeroAdjustment: true,
          });
        }
      } else if (entry.key === "roll") {
        // Deduct from rollovers per entitlement; pass entity only when that entitlement is entity-scoped
        const sameFeatureEnts = cusEnts.filter((ce) => isSameFeature(ce));
        for (const ce of sameFeatureEnts) {
          if (toDeduct === 0) break;
          const ceIsEntityScoped = Boolean((ce as any)?.entitlement?.entity_feature_id);
          toDeduct = await deductFromCusRollovers({
            toDeduct,
            cusEnt: ce as any,
            deductParams: {
              db,
              feature,
              env,
              entity: ceIsEntityScoped ? (customer.entity ? customer.entity : undefined) : undefined,
            },
          });
        }
      } else if (entry.key === "sub") {
        // Deduct from earliest subscription ce first
        const sSorted = [...subLike].sort((a: any, b: any) => {
          const entA: any = a.entitlement, entB: any = b.entitlement;
          const aNext = a.next_reset_at || 0, bNext = b.next_reset_at || 0;
          const aEff = entA?.rollover ? calculateNextExpiry(aNext, entA.rollover) : aNext;
          const bEff = entB?.rollover ? calculateNextExpiry(bNext, entB.rollover) : bNext;
          return (aEff || 0) - (bEff || 0);
        });
        for (const ce of sSorted) {
          if (toDeduct === 0) break;
          toDeduct = await deductAllowanceFromCusEnt({
            toDeduct,
            cusEnt: ce as any,
            deductParams: {
              db,
              feature,
              env,
              org,
              cusPrices: cusPrices as any[],
              customer,
              properties,
              entity: customer.entity,
            },
            featureDeductions,
            willDeductCredits: true,
            setZeroAdjustment: true,
          });
        }
      }
    }

    // Finally lifetime if still needed
    if (toDeduct > 0 && lifetimeLike.length > 0) {
      for (const ce of lifetimeLike) {
        if (toDeduct === 0) break;
        toDeduct = await deductAllowanceFromCusEnt({
          toDeduct,
          cusEnt: ce as any,
          deductParams: {
            db,
            feature,
            env,
            org,
            cusPrices: cusPrices as any[],
            customer,
            properties,
            entity: customer.entity,
          },
          featureDeductions,
          willDeductCredits: true,
          setZeroAdjustment: true,
        });
      }
    }

    // Sequential fallback: if expiry-ordered routing didn’t consume everything, walk pockets in fixed order.
    if (toDeduct > 0) {
      // Daily first
      for (const ce of dailyLike) {
        if (toDeduct === 0) break;
        toDeduct = await deductAllowanceFromCusEnt({
          toDeduct,
          cusEnt: ce as any,
          deductParams: { db, feature, env, org, cusPrices: cusPrices as any[], customer, properties, entity: customer.entity },
          featureDeductions,
          willDeductCredits: true,
          setZeroAdjustment: true,
        });
      }

      // Rollovers
      if (toDeduct > 0) {
        const sameFeatureEnts = cusEnts.filter((ce) => isSameFeature(ce));
        for (const ce of sameFeatureEnts) {
          if (toDeduct === 0) break;
          const ceIsEntityScoped = Boolean((ce as any)?.entitlement?.entity_feature_id);
          toDeduct = await deductFromCusRollovers({
            toDeduct,
            cusEnt: ce as any,
            deductParams: { db, feature, env, entity: ceIsEntityScoped ? (customer.entity ? customer.entity : undefined) : undefined },
          });
        }
      }

      // Subscription base
      for (const ce of subLike) {
        if (toDeduct === 0) break;
        toDeduct = await deductAllowanceFromCusEnt({
          toDeduct,
          cusEnt: ce as any,
          deductParams: { db, feature, env, org, cusPrices: cusPrices as any[], customer, properties, entity: customer.entity },
          featureDeductions,
          willDeductCredits: true,
          setZeroAdjustment: true,
        });
      }

      // Lifetime last
      for (const ce of lifetimeLike) {
        if (toDeduct === 0) break;
        toDeduct = await deductAllowanceFromCusEnt({
          toDeduct,
          cusEnt: ce as any,
          deductParams: { db, feature, env, org, cusPrices: cusPrices as any[], customer, properties, entity: customer.entity },
          featureDeductions,
          willDeductCredits: true,
          setZeroAdjustment: true,
        });
      }
    }

    if (toDeduct == 0) {
      continue;
    }

    await deductFromUsageBasedCusEnt({
      toDeduct,
      cusEnts,
      deductParams: {
        db,
        feature,
        env,
        org,
        cusPrices: cusPrices as any[],
        customer,
        properties,
        entity: customer.entity,
      },
      setZeroAdjustment: true,
    });
  }

  return cusEnts;
};

// MAIN FUNCTION
export const runUpdateUsageTask = async ({
  payload,
  logger,
  db,
  throwError = false,
}: {
  payload: any;
  logger: any;
  db: DrizzleCli;
  throwError?: boolean;
}) => {
  try {
    // 1. Update customer balance
    const {
      internalCustomerId,
      customerId,
      eventId,
      features,
      value,
      set_usage,
      properties,
      org,
      env,
      entityId,
    } = payload;

    console.log("--------------------------------");
    console.log(
      `HANDLING USAGE TASK FOR CUSTOMER (${customerId}), ORG: ${org.slug}, EVENT ID: ${eventId}`
    );

    const cusEnts: any = await updateUsage({
      db,
      customerId,
      features,
      value,
      properties,
      org,
      env,
      setUsage: set_usage,
      logger,
      entityId,
    });

    // Ensure stale cache is dropped, then rebuild
    await deleteCusCache({ db, customerId, org, env });
    await refreshCusCache({ db, customerId, entityId, org, env });

    if (!cusEnts || cusEnts.length === 0) {
      return;
    }
    console.log("   ✅ Customer balance updated");

    // Mirror to Convex credits projection (Autumn is source of truth) - fire-and-forget
    syncCreditsToConvex({ db, org, env, customerId, entityId, logger }).catch(() => {});
  } catch (error) {
    logger.error(`ERROR UPDATING USAGE`);
    logger.error(error);

    if (throwError) {
      throw error;
    }
  }
};
