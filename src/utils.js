import nodemailer from "nodemailer";

export const esc = (s = "") => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const DAY = 86400000;

export function rentalUnits(start, end, rentalType) {
  const days = Math.max(1, Math.round((new Date(end) - new Date(start)) / DAY) + 1);
  if (rentalType === "weekly") return Math.ceil(days / 7);
  if (rentalType === "monthly") return Math.ceil(days / 30);
  return days;
}
export const calcTotal = (eq, start, end, qty) =>
  +(Number(eq.price) * rentalUnits(start, end, eq.rentalType) * Number(qty)).toFixed(2);

let transporter;
export async function sendMail(to, subject, html) {
  if (!process.env.SMTP_HOST) return;
  transporter ??= nodemailer.createTransport({
    host: process.env.SMTP_HOST, port: +process.env.SMTP_PORT || 587,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  try { await transporter.sendMail({ from: process.env.MAIL_FROM, to, subject, html }); }
  catch (e) { console.error("Mail error:", e.message); }
}
