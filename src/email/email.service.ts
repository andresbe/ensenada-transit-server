import fs from "fs";
import path from "path";
import nodemailer from "nodemailer";
import MarkdownIt from "markdown-it";
import { emailConfig } from "./email.config";

// ── Nodemailer transporter ────────────────────────────────────

const transporter = nodemailer.createTransport({
  host: emailConfig.host,
  port: emailConfig.port,
  secure: emailConfig.port === 465, // true for port 465 (SSL), false for 587 (STARTTLS)
  auth:
    emailConfig.user && emailConfig.password
      ? {
          user: emailConfig.user,
          pass: emailConfig.password,
        }
      : undefined,
  connectionTimeout: 5000,
  greetingTimeout: 5000,
  socketTimeout: 10000,
});

// ── Markdown renderer ─────────────────────────────────────────

const md = new MarkdownIt();

// ── Template loader ───────────────────────────────────────────

const loadTemplate = (templatePath: string, replacements: Record<string, string>): string => {
  const raw = fs.readFileSync(templatePath, "utf8");
  return Object.entries(replacements).reduce(
    (content, [key, value]) => content.split(`{{${key}}}`).join(value),
    raw,
  );
};

// ── sendWelcomeEmail ──────────────────────────────────────────

export const sendWelcomeEmail = async (
  email: string,
  displayName: string,
): Promise<boolean> => {
  if (!emailConfig.host || !emailConfig.user || !emailConfig.password) {
    console.log("[email] SMTP not configured, skipping welcome email.");
    return false;
  }

  const templatePath = path.resolve(process.cwd(), "email/welcome-email.md");

  const markdownContent = loadTemplate(templatePath, {
    display_name: displayName || email,
  });

  const htmlContent = md.render(markdownContent);

  await transporter.sendMail({
    from: `"${emailConfig.fromName}" <${emailConfig.fromEmail}>`,
    to: email,
    subject: "¡Bienvenido a Ensenada Transit!",
    text: markdownContent,
    html: htmlContent,
  });

  return true;
};
