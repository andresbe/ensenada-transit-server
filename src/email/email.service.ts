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
  auth: {
    user: emailConfig.user,
    pass: emailConfig.password,
  },
});

// ── Markdown renderer ─────────────────────────────────────────

const md = new MarkdownIt();

// ── Template loader ───────────────────────────────────────────

const loadTemplate = (templatePath: string, replacements: Record<string, string>): string => {
  const raw = fs.readFileSync(templatePath, "utf8");
  return Object.entries(replacements).reduce(
    (content, [key, value]) => content.replaceAll(`{{${key}}}`, value),
    raw,
  );
};

// ── sendWelcomeEmail ──────────────────────────────────────────

export const sendWelcomeEmail = async (email: string, displayName: string): Promise<void> => {
  const templatePath = path.resolve(process.cwd(), "email/welcome-email.md");

  const markdownContent = loadTemplate(templatePath, {
    display_name: displayName || email,
  });

  const htmlContent = md.render(markdownContent);

  try {
    const info = await transporter.sendMail({
      from: `"${emailConfig.fromName}" <${emailConfig.fromEmail}>`,
      to: email,
      subject: "¡Bienvenido a Ensenada Transit!",
      text: markdownContent,
      html: htmlContent,
    });

    console.log(`[email] Welcome email sent to ${email} (messageId: ${info.messageId})`);
  } catch (err) {
    console.error(`[email] Failed to send welcome email to ${email}:`, err);
    throw err;
  }
};
