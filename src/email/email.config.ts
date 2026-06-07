// ── Email / SMTP configuration ────────────────────────────────
//
// For local development you can use Ethereal Email (https://ethereal.email)
// which provides a free, disposable SMTP sandbox — no real emails are sent.
//
// For production use any SMTP provider (Gmail, SendGrid, Mailgun, etc.).

export const emailConfig = {
  host: process.env.SMTP_HOST ?? "smtp.ethereal.email",
  port: Number(process.env.SMTP_PORT ?? 587),
  user: process.env.SMTP_USER ?? "",
  password: process.env.SMTP_PASSWORD ?? "",
  fromEmail: process.env.SMTP_FROM_EMAIL ?? "noreply@ensenadatransit.com",
  fromName: process.env.SMTP_FROM_NAME ?? "Ensenada Transit",
};
