import { db } from "@/db/initDrizzle.js";
import { auth } from "@/utils/auth.js";
import { Session } from "better-auth";
import { eq } from "drizzle-orm";
import { invitation, user as userTable } from "@autumn/shared";
import { slugify } from "@/utils/genUtils.js";
import { Organization } from "better-auth/plugins/organization";
import { and } from "drizzle-orm";
import { ADMIN_EMAILS, INVITE_ONLY } from "@/utils/constants.js";

export const createDefaultOrg = async ({
  session,
}: {
  session: Session;
}): Promise<Organization | undefined> => {
  try {
    const user = await db.query.user.findFirst({
      where: eq(userTable.id, session.userId),
    });

    const invites = await db
      .select()
      .from(invitation)
      .where(
        and(
          eq(invitation.email, user?.email || ""),
          eq(invitation.status, "pending"),
        ),
      );

    if (invites.length > 0) {
      await auth.api.addMember({
        body: {
          userId: session.userId,
          role: invites[0].role as any,
          organizationId: invites[0].organizationId,
        },
      });

      await db.update(invitation).set({
        status: "accepted",
      });

      return invites[0].organizationId as any;
    }

    // If invite-only is enabled, block default org creation for non-admins without invite
    const isAdminEmail = (user?.email || "").toLowerCase() &&
      ADMIN_EMAILS.includes((user?.email || "").toLowerCase());

    if (INVITE_ONLY && !isAdminEmail) {
      // No pending invite (handled above) and not admin: don't create a default org
      return undefined;
    }

    let userName = user?.name;
    if (!userName) {
      userName = user?.email?.split("@")[0] || "org";
    }

    const res = await auth.api.createOrganization({
      body: {
        name: `${userName}'s Org`,
        slug: `${slugify(userName)}_${Math.floor(10000000 + Math.random() * 90000000)}`,
        userId: session.userId,
      },
    });

    return res?.id as any;
  } catch (error) {
    console.error("Error creating org", error);
    return undefined;
  }
};
