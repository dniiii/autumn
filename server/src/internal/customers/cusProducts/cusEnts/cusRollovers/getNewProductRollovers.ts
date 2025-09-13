import { generateId, nullish } from "@/utils/genUtils.js";
import {
  CustomerEntitlement,
  EntitlementWithFeature,
  FullCusProduct,
  FullCustomerEntitlement,
  Rollover,
  RolloverConfig,
} from "@autumn/shared";
import { RolloverService } from "./RolloverService.js";
import { DrizzleCli } from "@/db/initDrizzle.js";
import { calculateNextExpiry } from "./rolloverUtils.js";
import { EntInterval } from "@autumn/shared";

export const getNewProductRollovers = async ({
  curCusProduct,
  cusEnts: newCusEnts,
  entitlements,
  db,
  logger,
}: {
  curCusProduct: FullCusProduct;
  cusEnts: CustomerEntitlement[];
  entitlements: EntitlementWithFeature[];
  db: DrizzleCli;
  logger: any;
}) => {
  if (!curCusProduct) return [];
  if (!curCusProduct.id) return [];
  try {
    let rolloverOperations: {
      // rolloverConfig: RolloverConfig;
      toInsert: Rollover[];
      cusEnt: FullCustomerEntitlement;
      // cusEntId: string;
      // toUpdate: Rollover[];
      // entityMode: boolean;
    }[] = [];

    // let newRollovers: Rollover[] = [];

    let oldCusEnts = curCusProduct.customer_entitlements;

    for (const newCusEnt of newCusEnts) {
      let newRollovers: Rollover[] = [];
      let newEnt = entitlements.find((e) => e.id === newCusEnt.entitlement_id);
      if (!newEnt) {
        // No matching entitlement definition for this new customer entitlement
        // Skip rollover operations for safety
        continue;
      }
      // Prefer matching by internal_feature_id + interval (month/year) to avoid
      // accidentally picking the daily entitlement. Fallback to same feature_id
      // across monthly/yearly if exact interval match is missing.
      const monthlyOrYearly = [EntInterval.Month, EntInterval.Year];
      const candidates = oldCusEnts.filter(
        (e) =>
          e.entitlement.internal_feature_id === newEnt.internal_feature_id &&
          (monthlyOrYearly as any).includes(e.entitlement.interval as any)
      );

      let oldCusEnt = candidates.find(
        (e) => e.entitlement.interval === newEnt.interval
      );
      if (!oldCusEnt) {
        // pick the candidate with the largest remaining base as a sensible fallback
        oldCusEnt = candidates.sort(
          (a, b) => (Number(b.balance || 0) - Number(a.balance || 0))
        )[0];
      }
      let oldEnt = oldCusEnt?.entitlement;

      // Must have a corresponding old entitlement to carry forward from
      if (!oldCusEnt) continue;

      // Do not handle case where user is upgrading from non-entity to entity or vice versa
      if (newEnt?.entity_feature_id && !oldEnt?.entity_feature_id) {
        continue;
      }
      if (!newEnt?.entity_feature_id && oldEnt?.entity_feature_id) {
        continue;
      }

      // Bring over current balance (if greater > 0), and any existing rollover
      // if (
      //   oldCusEnt.balance &&
      //   oldCusEnt.balance > 0 &&
      //   !oldCusEnt.entitlement.entity_feature_id &&
      //   rollover
      // ) {
      //   newRollovers.push({
      //     id: generateId("roll"),
      //     cus_ent_id: newCusEnt.id,
      //     balance: oldCusEnt.balance,
      //     entities: {},
      //     usage: 0,
      //     expires_at: calculateNextExpiry(Date.now(), rollover),
      //   });
      // } else if (
      //   oldCusEnt.entitlement.entity_feature_id &&
      //   oldCusEnt.entities
      // ) {
      //   const entityRollovers = Object.keys(oldCusEnt.entities || {}).reduce(
      //     (acc, entityId) => {
      //       const entityBalance = oldCusEnt.entities?.[entityId];
      //       if (entityBalance && entityBalance.balance > 0) {
      //         acc[entityId] = {
      //           id: entityId,
      //           balance: entityBalance.balance || 0,
      //           usage: 0,
      //         };
      //       }
      //       return acc;
      //     },
      //     {} as Record<string, { id: string; balance: number; usage: number }>
      //   );

      //   if (Object.keys(entityRollovers).length > 0) {
      //     newRollovers.push({
      //       id: generateId("roll"),
      //       cus_ent_id: newCusEnt.id,
      //       balance: 0,
      //       entities: entityRollovers,
      //       usage: 0,
      //       expires_at: calculateNextExpiry(Date.now(), rollover),
      //     });
      //   }
      // }

      // 1) Always preserve existing rollover pockets from the old entitlement,
      // even if the new entitlement doesn't define a rollover policy.
      let curRollovers = oldCusEnt.rollovers || [];

      for (const curRollover of curRollovers) {
        newRollovers.push({
          ...curRollover,
          id: generateId("roll"),
          cus_ent_id: newCusEnt.id,
        });
      }

      // 2) If there is leftover base balance on the old entitlement for
      // monthly/yearly credits, convert that remainder into a rollover pocket
      // on the new entitlement. Daily is explicitly excluded.
      try {
        const oldInterval = oldEnt?.interval;
        const isMonthlyOrYearly =
          oldInterval === EntInterval.Month || oldInterval === EntInterval.Year;

        const leftoverBase = Math.max(0, Number(oldCusEnt.balance || 0));

        if (isMonthlyOrYearly && leftoverBase > 0 && !oldEnt?.entity_feature_id) {
          // Determine expiry: preserve the remainder of the old cycle when possible.
          // If the old entitlement had a next_reset_at, use that exact timestamp so
          // leftover credits keep their original remaining validity window.
          // If not available, fall back to the new entitlement's next reset; and as
          // a last resort, if the new entitlement defines a rollover policy, compute
          // based on that policy.
          const oldNextResetAt = (oldCusEnt as any).next_reset_at as number | null | undefined;
          const newNextResetAt = (newCusEnt as any).next_reset_at as number | null | undefined;
          // Prefer the new plan's rollover policy if enabled: align to the new
          // plan's next reset and add its configured duration. Otherwise, fall
          // back to preserving the remainder of the old cycle; lastly the new
          // entitlement's next reset.
          const expiresAt = newEnt?.rollover
            ? calculateNextExpiry(newNextResetAt || Date.now(), newEnt.rollover)
            : oldNextResetAt || newNextResetAt || null;

          newRollovers.push({
            id: generateId("roll"),
            cus_ent_id: newCusEnt.id,
            balance: leftoverBase,
            usage: 0,
            expires_at: expiresAt || null,
            entities: {},
          });
        }
      } catch (err) {
        // best-effort; don't block attach on carryover computation issues
        logger?.error?.("carryover_leftover_error", { err });
      }

      console.log(`Feature ${newEnt?.feature_id} rollovers:`, newRollovers);

      // // Add this entitlement's rollover operations
      rolloverOperations.push({
        toInsert: newRollovers,
        cusEnt: {
          ...newCusEnt,
          entitlement: newEnt,
          rollovers: [],
          replaceables: [],
        },
      });
    }

    return rolloverOperations;
  } catch (error) {
    logger.error(`Failed to handle new product rollovers:`, {
      error,
    });
    return [];
  }
};
