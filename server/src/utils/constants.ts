import "dotenv/config";
import { CusProductStatus } from "@autumn/shared";

export const BREAK_API_VERSION = 0.2;

export const getActiveCusProductStatuses = () => [
  CusProductStatus.Active,
  CusProductStatus.PastDue,
];

const isProductionEnv =
  process.env.ENV == "production" || process.env.NODE_ENV == "production";

const parseAdminIds = (ids?: string) =>
  (ids || "")
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);

const defaultProdAdminIds = [""
];

const defaultDevAdminIds = [""];

const configuredAdminIds = parseAdminIds(
  isProductionEnv
    ? process.env.ADMIN_USER_IDS_PROD || process.env.ADMIN_USER_IDS
    : process.env.ADMIN_USER_IDS_DEV || process.env.ADMIN_USER_IDS
);

export const ADMIN_USER_IDs =
  configuredAdminIds.length > 0
    ? configuredAdminIds
    : isProductionEnv
    ? defaultProdAdminIds
    : defaultDevAdminIds;

export const dashboardOrigins = [
  "http://localhost:3000",
  process.env.CLIENT_URL!,
];
