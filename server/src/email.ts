import nodemailer from "nodemailer";
import { env } from "./env.ts";
import { logger } from "./logger.ts";

export interface PasswordResetMail {
  to: string;
  url: string;
}

/**
 * Sends the better-auth password-reset email via SMTP. When SMTP is not
 * configured (SMTP_HOST unset — the default), the reset link is logged
 * instead: a development fallback that keeps the forgot-password flow usable
 * without a mail server. The log line is a deliberate, loud pointer; nobody
 * should be able to miss that no mail was actually sent.
 */
export async function sendPasswordResetMail({ to, url }: PasswordResetMail): Promise<void> {
  if (!env.SMTP_HOST || !env.SMTP_FROM) {
    logger.warn(
      `email: SMTP not configured; password reset for <${to}> — open this link directly: ${url}`,
    );
    return;
  }
  const transporter = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_PORT === 465,
    ...(env.SMTP_USER ? { auth: { user: env.SMTP_USER, pass: env.SMTP_PASS } } : {}),
  });
  await transporter.sendMail({
    from: env.SMTP_FROM,
    to,
    subject: "Reset your AI Assistant password",
    text:
      "Use this link to reset your AI Assistant password (valid for one hour):\n\n" +
      `${url}\n\n` +
      "If you didn't request this, you can safely ignore this email.",
  });
}