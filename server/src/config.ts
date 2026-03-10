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
  mqttBrokerUrl: string;
  mqttUsername: string;
  mqttPassword: string;
  mqttQingpingMac: string;
  miEmail: string;
  miPassword: string;
  miRegion: string;
  tclUsername: string;
  tclPassword: string;
  authSecret: string;
  adminUser: string;
  adminPassword: string;
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
  mqttBrokerUrl: process.env.MQTT_BROKER_URL ?? "mqtt://mosquitto:1883",
  mqttUsername: process.env.MQTT_USERNAME ?? "",
  mqttPassword: process.env.MQTT_PASSWORD ?? "",
  mqttQingpingMac: process.env.MQTT_QINGPING_MAC ?? "582D3470F981",
  miEmail: process.env.MI_EMAIL ?? "",
  miPassword: process.env.MI_PASSWORD ?? "",
  miRegion: process.env.MI_REGION ?? "sg",
  tclUsername: process.env.TCL_USERNAME ?? "",
  tclPassword: process.env.TCL_PASSWORD ?? "",
  authSecret: process.env.AUTH_SECRET ?? "",
  adminUser: process.env.ADMIN_USER ?? "",
  adminPassword: process.env.ADMIN_PASSWORD ?? "",
};
