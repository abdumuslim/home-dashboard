declare module "xmihome" {
  interface Credentials {
    country?: string;
    username?: string;
    password?: string;
    userId?: string | number;
    ssecurity?: string;
    serviceToken?: string;
  }

  interface Config {
    credentials?: Credentials;
    credentialsFile?: string;
    connectionType?: "miio" | "bluetooth" | "cloud";
    devices?: unknown[];
    logLevel?: "none" | "error" | "warn" | "info" | "debug";
  }

  interface LoginHandlers {
    on2fa?: (url: string) => Promise<string>;
    onCaptcha?: (imageB64: string) => Promise<string>;
  }

  interface Miot {
    login(handlers?: LoginHandlers): Promise<Omit<Credentials, "username" | "password">>;
    request(path: string, data: unknown): Promise<{ result: unknown }>;
  }

  class XiaomiMiHome {
    config: Config;
    miot: Miot;
    constructor(config?: Config);
    getDevices(options?: { connectionType?: string; timeout?: number }): Promise<unknown[]>;
    destroy(): Promise<void>;
  }

  export default XiaomiMiHome;
}
