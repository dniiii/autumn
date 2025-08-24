import { DrizzleCli } from "@/db/initDrizzle.js";
import { AppEnv, Organization } from "@autumn/shared";
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
  });
  const balancesObj = cusDetails.customer?.features || cusDetails.features || {};
  const entries = Object.values(balancesObj as any);
  const total = entries.reduce((acc: number, e: any) => acc + (e.balance ?? 0), 0);
  return {
    userId: customer.id!,
    balance: total,
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


