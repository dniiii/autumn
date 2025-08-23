import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  credits: defineTable({
    userId: v.string(),
    balance: v.optional(v.number()),
    subscriptionTier: v.optional(v.string()),
    subscriptionStatus: v.optional(v.string()),
    subscriptionExpiry: v.optional(v.string()),
    breakdown: v.optional(
      v.object({
        dailyFree: v.optional(v.object({ available: v.optional(v.number()) })),
        purchased: v.optional(v.object({ available: v.optional(v.number()) })),
        subscription: v.optional(v.object({ available: v.optional(v.number()) })),
      })
    ),
    resets: v.optional(v.any()),
    intervals: v.optional(v.array(v.any())),
    rolloverExpiries: v.optional(v.array(v.string())),
    rolloverGroups: v.optional(
      v.array(v.object({ iso: v.string(), count: v.number() }))
    ),
    updatedAt: v.optional(v.number()),
  }).index("by_user", ["userId"]),
});


