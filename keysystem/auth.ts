import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { installLicensing } from "./licensing";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { emailOTP, twoFactor } from "better-auth/plugins";
import { Resend } from "resend";

export const origin = process.env.APP_ORIGIN ?? "http://127.0.0.1:4318";
export const testMode = process.env.NODE_ENV === "test";
const dir = process.env.DATA_DIR ?? "./data";
mkdirSync(dir, { recursive: true });
export const db = new Database(`${dir}/revolution.sqlite`, { create: true });
db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
const secret = process.env.BETTER_AUTH_SECRET;
if (!secret || secret.length < 32) throw new Error("Set a private BETTER_AUTH_SECRET of at least 32 characters.");
export const testMailbox = new Map<string, string>();
export const mailReady = testMode || Boolean(process.env.RESEND_API_KEY && process.env.MAIL_FROM);
async function sendCode(email: string, otp: string) {
  if (testMode) { testMailbox.set(email, otp); return; }
  if (!mailReady) throw new Error("Email provider is not configured. Registration is unavailable.");
  const resend = new Resend(process.env.RESEND_API_KEY);
  const { error } = await resend.emails.send({
    from: process.env.MAIL_FROM!, to: email,
    subject: "Dein Revolution Client Sicherheitscode",
    text: `Dein Code: ${otp}\nGültig für 5 Minuten. Teile ihn mit niemandem.\nPrüfe auch deinen Spam-Ordner, falls du weitere Sicherheits-E-Mails erwartest.`,
  });
  if (error) throw new Error("Email delivery failed; please try again later.");
}
export const auth = betterAuth({
  appName: "Revolution Client", baseURL: origin, secret, database: db,
  trustedOrigins: [origin],
  emailAndPassword: { enabled: true, requireEmailVerification: true, minPasswordLength: 12, autoSignIn: false },
  emailVerification: { autoSignInAfterVerification: false },
  databaseHooks: {
    user: { create: { before: async (user) => ({ data: { ...user, twoFactorEnabled: true } }) } },
  },
  session: { expiresIn: 60 * 60 * 24 * 7, cookieCache: { enabled: false } },
  rateLimit: { enabled: !testMode, storage: "database", window: 60, max: 30 },
  plugins: [
    emailOTP({ otpLength: 6, expiresIn: 300, allowedAttempts: 5, disableSignUp: true,
      async sendVerificationOTP({ email, otp }) { await sendCode(email, otp); } }),
    twoFactor({ issuer: "Revolution Client", totpOptions: { disable: true },
      otpOptions: { period: 5, allowedAttempts: 5, storeOTP: "hashed", async sendOTP({ user, otp }) { await sendCode(user.email, otp); } },
    }),
  ],
});
export async function migrate() {
  const migration = await getMigrations(auth.options);
  await migration.runMigrations();
  db.exec(`
    CREATE TABLE IF NOT EXISTS configs (user_id TEXT PRIMARY KEY, body TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS news (id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS releases (id TEXT PRIMARY KEY, version TEXT NOT NULL UNIQUE, notes TEXT NOT NULL, path TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS devices (poll_hash TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, user_id TEXT, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS device_tokens (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires INTEGER NOT NULL);
  `);
  // The key system's own tables and its three shipped tiers. Installed from here so that the API, the bot
  // and the tests all get exactly one migration path - the bot runs against the same file.
  installLicensing(db);
}
