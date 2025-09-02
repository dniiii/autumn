import dotenv from "dotenv";
import {
  CustomerEntitlement,
  FullCusEntWithProduct,
  ResetCusEnt,
} from "@autumn/shared";
import { CusEntService } from "./internal/customers/cusProducts/cusEnts/CusEntitlementService.js";
import { CronJob } from "cron";
import { initDrizzle } from "./db/initDrizzle.js";
import { resetCustomerEntitlement } from "./cron/cronUtils.js";
import { OrgService } from "./internal/orgs/OrgService.js";
import { notNullish } from "./utils/genUtils.js";
import { syncCreditsToConvex } from "@/external/convex/syncCredits.js";

dotenv.config();

const { db, client } = initDrizzle();

export const cronTask = async () => {
  const startTime = Date.now();
  let totalProcessed = 0;
  let totalSynced = 0;

  try {
    const cusEnts: ResetCusEnt[] = await CusEntService.getActiveResetPassed({
      db,
      batchSize: 500,
    });
    
    if (cusEnts.length === 0) return; // Skip logging if nothing to process

    const cacheEnabledOrgs = await OrgService.getCacheEnabledOrgs({ db });

    const batchSize = 100;
    for (let i = 0; i < cusEnts.length; i += batchSize) {
      const batch = cusEnts.slice(i, i + batchSize);
      const batchResets = [];
      for (const cusEnt of batch) {
        batchResets.push(
          resetCustomerEntitlement({
            db,
            cusEnt: cusEnt,
            cacheEnabledOrgs,
          })
        );
      }

      let results = await Promise.all(batchResets);

      let toUpsert = results.filter(notNullish);
      await CusEntService.upsert({
        db,
        data: toUpsert as CustomerEntitlement[],
      });
      totalProcessed += toUpsert.length;

      // Non-blocking: publish updated projections for affected customers
      const publishSet = new Set<string>();
      for (const cusEnt of batch) {
        if (cusEnt.customer_id) publishSet.add(cusEnt.customer_id);
      }
      const syncResults = await Promise.allSettled(
        Array.from(publishSet).map(async (customerId) => {
          const cusEnt = batch.find((b) => b.customer_id === customerId);
          if (!cusEnt) return;
          
          const org = await OrgService.get({ db, orgId: cusEnt.customer.org_id });
          
          await syncCreditsToConvex({
            db,
            org,
            env: cusEnt.customer.env,
            customerId,
            logger: { log: () => {}, error: () => {} }, // Silent logger
          });
        })
      );
      
      totalSynced += syncResults.filter(r => r.status === 'fulfilled').length;
    }

    const duration = Date.now() - startTime;
    console.log(
      `[CRON] Reset ${totalProcessed}/${cusEnts.length} entitlements, synced ${totalSynced} customers in ${duration}ms`
    );
  } catch (error) {
    console.error("[CRON ERROR]:", error);
    return;
  }

  // await client.end();
};

const job = new CronJob(
  "* * * * *", // Run every minute
  function () {
    cronTask();
  },
  null, // onComplete
  true, // start immediately
  "UTC" // timezone (adjust as needed)
);

cronTask();

process.on("SIGTERM", async () => {
  console.log("Received SIGTERM signal, closing database connection...");
  await client.end();
  process.exit(0);
});

process.on("SIGINT", async () => {
  console.log("Received SIGINT signal, closing database connection...");
  await client.end();
  process.exit(0);
});
