import { logger } from "@/external/logtail/logtailUtils.js";
import { ADMIN_EMAILS, INVITE_ONLY } from "@/utils/constants.js";
import { db } from "@/db/initDrizzle.js";
import { invitation, user as userTable } from "@autumn/shared";
import { and, eq } from "drizzle-orm";
import { createResendCli } from "@/external/resend/resendUtils.js";
import OTPEmail from "@emails/OTPEmail.js";

const sendOTPEmail = async ({ email, otp }: { email: string; otp: string }) => {
  // Enforce invite-only gating if enabled
  if (INVITE_ONLY) {
    const lower = email.toLowerCase();
    let allowed = ADMIN_EMAILS.includes(lower);
    if (!allowed) {
      // Check if user already exists (allow returning users)
      const existing = await db.query.user.findFirst({
        where: eq(userTable.email, lower),
      });
      if (existing) allowed = true;
    }
    if (!allowed) {
      // Check pending invites
      const inv = await db
        .select()
        .from(invitation)
        .where(and(eq(invitation.email, lower), eq(invitation.status, "pending")));
      if (inv.length > 0) allowed = true;
    }
    if (!allowed) {
      logger.warn(`OTP blocked (invite-only): ${email}`);
      console.warn(`OTP blocked (invite-only): ${email}`);
      return; // silently block sending OTP
    }
  }
  if (!process.env.RESEND_API_KEY || !process.env.RESEND_DOMAIN) {
    logger.warn(`RESEND NOT SET UP, SIGN IN OTP: ${otp}`);
    return;
  }

  const resend = createResendCli();
  await resend.emails.send({
    from: `Autumn <hey@${process.env.RESEND_DOMAIN}>`,
    to: email,
    subject: "Your verification code for Autumn",
    react: OTPEmail({ otpCode: otp }),
  });
};

export default sendOTPEmail;
