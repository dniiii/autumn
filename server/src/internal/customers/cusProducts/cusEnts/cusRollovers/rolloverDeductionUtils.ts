import { RolloverDeductParams } from "@/trigger/updateBalanceTask.js";
import { FullCusEntWithFullCusProduct, Rollover } from "@autumn/shared";
import { RolloverService } from "./RolloverService.js";

export const deductFromCusRollovers = async ({
  toDeduct,
  deductParams,
  cusEnt,
}: {
  toDeduct: number;
  deductParams: RolloverDeductParams;
  cusEnt: FullCusEntWithFullCusProduct;
}) => {
  if (toDeduct == 0) {
    return toDeduct;
  }

  let updates = {
    toInsert: [] as Rollover[],
    toUpdate: [] as Rollover[],
  };
  let rollovers = getSortedRollovers({
    cusEnts: [cusEnt],
    featureId: deductParams.feature.id,
    entityId: deductParams.entity?.id,
  });

  if (deductParams.entity) {
    for (let rollover of rollovers) {
      let entityRollover = rollover.entities[deductParams.entity.id];
      if (entityRollover) {
        if (entityRollover.balance >= toDeduct) {
          entityRollover.balance -= toDeduct;
          entityRollover.usage += toDeduct;

          updates.toUpdate.push(rollover);
          toDeduct = 0;
          break;
        } else {
          if (entityRollover.balance > 0) {
            let deductedAmount = entityRollover.balance;
            toDeduct -= entityRollover.balance;
            entityRollover.balance = 0;
            entityRollover.usage += deductedAmount;
            updates.toUpdate.push(rollover);
          }
        }
      }
    }
  } else {
    for (let rollover of rollovers) {
      if (rollover.balance >= toDeduct) {
        rollover = {
          ...rollover,
          balance: rollover.balance - toDeduct,
          usage: rollover.usage + toDeduct,
        };

        updates.toUpdate.push(rollover);
        toDeduct = 0;

        break;
      } else {
        if (rollover.balance > 0) {
          toDeduct -= rollover.balance;
          rollover = {
            ...rollover,
            usage: rollover.usage + rollover.balance,
            balance: 0,
          };

          updates.toUpdate.push(rollover);
        }
      }
    }
  }

  await RolloverService.upsert({
    db: deductParams.db,
    rows: updates.toUpdate,
  });

  return toDeduct;
};

export const getSortedRollovers = ({
  cusEnts,
  featureId,
  entityId,
}: {
  cusEnts: FullCusEntWithFullCusProduct[];
  featureId: string;
  entityId?: string;
}) => {
  if (!entityId)
    return cusEnts
      .filter((cusEnt) => {
        return cusEnt.feature_id === featureId;
      })
      .flatMap((cusEnt) => {
        return cusEnt.rollovers;
      })
      .sort((a, b) => {
        if (a.expires_at && b.expires_at) return a.expires_at - b.expires_at;
        if (a.expires_at && !b.expires_at) return -1;
        if (!a.expires_at && b.expires_at) return 1;
        return 0;
      });
  else {
    return cusEnts
      .filter((cusEnt) => {
        return (
          cusEnt.feature_id === featureId &&
          cusEnt.entities &&
          cusEnt.entities[entityId]
        );
      })
      .flatMap((cusEnt) => {
        return cusEnt.rollovers.filter((x) => {
          return x.entities[entityId];
        });
      })
      .sort((a, b) => {
        if (a.expires_at && b.expires_at) return a.expires_at - b.expires_at;
        if (a.expires_at && !b.expires_at) return -1;
        if (!a.expires_at && b.expires_at) return 1;
        return 0;
      });
  }
};

// Deduct across all rollover rows globally by expiry (entity-aware)
export const deductAcrossRollovers = async ({
  toDeduct,
  deductParams,
  cusEnts,
}: {
  toDeduct: number;
  deductParams: RolloverDeductParams;
  cusEnts: FullCusEntWithFullCusProduct[];
}) => {
  if (toDeduct == 0) return 0;

  const { db, feature, entity } = deductParams;
  const rows = getSortedRollovers({
    cusEnts: cusEnts as any,
    featureId: feature.id,
    entityId: entity?.id,
  });

  const toUpdate: Rollover[] = [];

  if (entity) {
    for (const row of rows) {
      const e = row.entities[entity.id];
      if (!e) continue;
      if (toDeduct === 0) break;
      if (e.balance >= toDeduct) {
        e.balance -= toDeduct;
        e.usage += toDeduct;
        toUpdate.push(row);
        toDeduct = 0;
        break;
      }
      if (e.balance > 0) {
        const used = e.balance;
        e.balance = 0;
        e.usage += used;
        toUpdate.push(row);
        toDeduct -= used;
      }
    }
  } else {
    for (let row of rows) {
      if (toDeduct === 0) break;
      if (row.balance >= toDeduct) {
        row = { ...row, balance: row.balance - toDeduct, usage: row.usage + toDeduct };
        toUpdate.push(row);
        toDeduct = 0;
        break;
      }
      if (row.balance > 0) {
        const used = row.balance;
        row = { ...row, balance: 0, usage: row.usage + used };
        toUpdate.push(row);
        toDeduct -= used;
      }
    }
  }

  if (toUpdate.length) {
    await RolloverService.upsert({ db, rows: toUpdate });
  }

  return toDeduct;
};
