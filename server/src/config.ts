import "dotenv/config";

export interface Config {
  qpAppKey: string;
  qpAppSecret: string;
  awApiKey: string;
  awAppKey: string;
  databaseUrl: string;
}

export const config: Config = {
  qpAppKey: process.env.QP_APP_KEY ?? "",
  qpAppSecret: process.env.QP_APP_SECRET ?? "",
  awApiKey: process.env.AW_API_KEY ?? "",
  awAppKey: process.env.AW_APP_KEY ?? "",
  databaseUrl: process.env.DATABASE_URL ?? "postgresql://postgres@localhost:5432/home",
};
