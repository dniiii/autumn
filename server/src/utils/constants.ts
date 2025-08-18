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

const parseEmails = (emails?: string) =>
  (emails || "")
    .split(/[\s,]+/)
    .map((s) => s.trim().toLowerCase())
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

// Admin emails used for invite-only mode and bootstrap
const isProd = isProductionEnv;
const configuredAdminEmails = parseEmails(
  isProd
    ? process.env.ADMIN_EMAILS_PROD || process.env.ADMIN_EMAILS
    : process.env.ADMIN_EMAILS_DEV || process.env.ADMIN_EMAILS
);

export const ADMIN_EMAILS = configuredAdminEmails;

export const INVITE_ONLY =
  (process.env.AUTH_INVITE_ONLY || "false").toLowerCase() === "true";
