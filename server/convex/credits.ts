import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

const requireServiceSecret = async (
  _ctx: unknown,
  provided: string | undefined
) => {
  const expected = process.env.CONVEX_SERVICE_SECRET || "";
  if (!expected || provided !== expected) throw new Error("Unauthorized");
};

export const setCreditsProjection = mutation({
  args: {
    userId: v.string(),
    payload: v.object({
      balance: v.number(),
      subscriptionTier: v.optional(v.string()),
      subscriptionStatus: v.optional(v.string()),
      subscriptionExpiry: v.optional(v.string()),
      breakdown: v.optional(
        v.object({
          dailyFree: v.optional(v.object({ available: v.float64() })),
          subscription: v.optional(v.object({ available: v.float64() })),
          purchased: v.optional(v.object({ available: v.float64() })),
        })
      ),
      resets: v.optional(
        v.object({
          resetsAt: v.optional(v.string()),
          nextDailyReset: v.optional(v.string()),
          nextMonthlyReset: v.optional(v.string()),
          nextRolloverExpiry: v.optional(v.string()),
        })
      ),
      intervals: v.optional(
        v.array(
          v.object({
            interval: v.string(),
            balance: v.number(),
            nextResetAt: v.optional(v.string()),
          })
        )
      ),
      rolloverExpiries: v.optional(v.array(v.string())),
      rolloverGroups: v.optional(
        v.array(v.object({ iso: v.string(), count: v.number() }))
      ),
      updatedAt: v.number(),
    }),
    serviceSecret: v.optional(v.string()),
  },
  handler: async (ctx, { userId, payload, serviceSecret }) => {
    await requireServiceSecret(ctx, serviceSecret);
    const existing = await ctx.db
      .query("credits")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first();

    if (
      existing &&
      (existing as any).updatedAt !== undefined &&
      (existing as any).updatedAt >= payload.updatedAt
    ) {
      return { ignored: true } as const;
    }

    if (existing) {
      await ctx.db.patch(existing._id, {
        balance: payload.balance,
        subscriptionTier: payload.subscriptionTier,
        subscriptionStatus: payload.subscriptionStatus,
        subscriptionExpiry: payload.subscriptionExpiry,
        breakdown: payload.breakdown,
        resets: payload.resets,
        intervals: payload.intervals,
        rolloverExpiries: payload.rolloverExpiries,
        rolloverGroups: payload.rolloverGroups,
        updatedAt: payload.updatedAt,
      });
      return { updated: true } as const;
    }

    await ctx.db.insert("credits", {
      userId,
      balance: payload.balance,
      subscriptionTier: payload.subscriptionTier,
      subscriptionStatus: payload.subscriptionStatus,
      subscriptionExpiry: payload.subscriptionExpiry,
      breakdown: payload.breakdown,
      resets: payload.resets,
      intervals: payload.intervals,
      rolloverExpiries: payload.rolloverExpiries,
      rolloverGroups: payload.rolloverGroups,
      updatedAt: payload.updatedAt,
    });
    return { created: true } as const;
  },
});

export const getCreditsByUser = query({
  args: { userId: v.string() },
  handler: async (ctx, { userId }) => {
    return await ctx.db
      .query("credits")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first();
  },
});


