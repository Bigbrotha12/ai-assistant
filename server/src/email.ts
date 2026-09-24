import nodemailer from "nodemailer";
import { env } from "./env.ts";
import { logger } from "./logger.ts";

export interface PasswordResetMail {
  to: string;
  url: string;
}

export interface EmailVerificationMail {
  to: string;
  url: string;
}

type EmailEnvironment = Pick<typeof env, "NODE_ENV" | "SMTP_HOST" | "SMTP_FROM">;
type Warn = (...args: unknown[]) => void;

async function sendMail({ to, subject, text }: { to: string; subject: string; text: string }): Promise<void> {
  const transporter = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_PORT === 465,
    ...(env.SMTP_USER ? { auth: { user: env.SMTP_USER, pass: env.SMTP_PASS } } : {}),
  });
  await transporter.sendMail({ from: env.SMTP_FROM, to, subject, text });
}

function redactEmailUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname}`;
  } catch {
    return "<unparseable email URL>";
  }
}

export function smtpUnconfigured(
  kind: string,
  to: string,
  url: string,
  environment: EmailEnvironment = env,
  warn: Warn = logger.warn,
): boolean {
  if (environment.SMTP_HOST && environment.SMTP_FROM) return false;
  if (environment.NODE_ENV === "development") {
    warn(
      `email: SMTP not configured; ${kind} for <${to}> — open this link directly: ${url}`,
    );
  } else {
    warn(
      `email: SMTP not configured; ${kind} for <${to}> — delivery skipped; request path: ${redactEmailUrl(url)}`,
    );
  }
  return true;
}

/**
 * Sends the better-auth password-reset email via SMTP. In development, when
 * SMTP is not configured (SMTP_HOST unset — the default), the reset link is
 * logged instead: a development fallback that keeps the forgot-password flow
 * usable without a mail server. Outside development, the same condition logs
 * only a redacted host/path so reset tokens never reach production logs.
 */
export async function sendPasswordResetMail({ to, url }: PasswordResetMail): Promise<void> {
  if (smtpUnconfigured("password reset", to, url)) return;
  await sendMail({
    to,
    subject: "Reset your AI Assistant password",
    text:
      "Use this link to reset your AI Assistant password (valid for one hour):\n\n" +
      `${url}\n\n` +
      "If you didn't request this, you can safely ignore this email.",
  });
}

/**
 * Sends the better-auth email-verification mail (C2) via the same SMTP
 * transport as the reset mail — used by the `sendVerificationEmail` callback
 * in auth.ts. In development, with SMTP unset the verification link is logged
 * instead of sent (valid for one hour, better-auth's default token lifetime).
 * Other environments log only a redacted host/path.
 */
export async function sendEmailVerificationMail({ to, url }: EmailVerificationMail): Promise<void> {
  if (smtpUnconfigured("email verification", to, url)) return;
  await sendMail({
    to,
    subject: "Verify your email for AI Assistant",
    text:
      "Use this link to verify your email address (valid for one hour):\n\n" +
      `${url}\n\n` +
      "If you didn't create an AI Assistant account, you can safely ignore this email.",
  });
}
