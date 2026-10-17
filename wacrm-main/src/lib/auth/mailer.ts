// Optional SMTP delivery for password-reset mails. Without SMTP_HOST the link is
// written to the server log so a self-hosted install still works.
import nodemailer from "nodemailer";

export async function sendMail(to: string, subject: string, text: string): Promise<void> {
  const host = process.env.SMTP_HOST;
  if (!host) {
    console.log(`[mail] SMTP not configured. To: ${to} | ${subject}\n${text}`);
    return;
  }
  const transport = nodemailer.createTransport({
    host,
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: process.env.SMTP_SECURE === "true",
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS ?? "" } : undefined,
  });
  await transport.sendMail({ from: process.env.SMTP_FROM ?? process.env.SMTP_USER, to, subject, text });
}
