import "dotenv/config";

export interface Config {
  qpAppKey: string;
  qpAppSecret: string;
  awApiKey: string;
  awAppKey: string;
  databaseUrl: string;
  vapidPublicKey: string;
  vapidPrivateKey: string;
  vapidSubject: string;
}

export const config: Config = {
  qpAppKey: process.env.QP_APP_KEY ?? "",
  qpAppSecret: process.env.QP_APP_SECRET ?? "",
  awApiKey: process.env.AW_API_KEY ?? "",
  awAppKey: process.env.AW_APP_KEY ?? "",
  databaseUrl: process.env.DATABASE_URL ?? "postgresql://postgres@localhost:5432/home",
  vapidPublicKey: process.env.VAPID_PUBLIC_KEY ?? "",
  vapidPrivateKey: process.env.VAPID_PRIVATE_KEY ?? "",
  vapidSubject: process.env.VAPID_SUBJECT ?? "mailto:admin@altijwal.com",
};
