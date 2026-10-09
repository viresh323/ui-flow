import { registerSecretValue } from "../obs/logger.js";

/**
 * Secret resolution (§3.4).
 *
 * An artifact carries `{from: "secret", secret: "tenant.parabank.operator_user"}`
 * — a *reference*. The value is fetched here, at the moment of use, and never
 * travels with the flow. In production this is a vault client; the interface is
 * the part that matters.
 *
 * Every resolved value is registered with the logger, so even an accidental
 * interpolation into a log line or an error message comes out as `[secret]`.
 */

export interface SecretStore {
  get(ref: string): string;
}

/** `tenant.parabank.operator_user` -> `TENANT_PARABANK_OPERATOR_USER` */
export function envVarFor(ref: string): string {
  return ref.replace(/[.\-]/g, "_").toUpperCase();
}

export function createEnvSecretStore(): SecretStore {
  const cache = new Map<string, string>();

  return {
    get(ref: string): string {
      const cached = cache.get(ref);
      if (cached !== undefined) return cached;

      const name = envVarFor(ref);
      const value = process.env[name];
      if (!value) {
        throw new Error(
          `secret "${ref}" is not available (expected environment variable ${name})`,
        );
      }

      registerSecretValue(value);
      cache.set(ref, value);
      return value;
    },
  };
}

/**
 * A capability may only resolve secrets it declared. Stops a tampered or
 * over-broad artifact from reaching credentials outside its stated contract.
 */
export function restrictTo(store: SecretStore, allowed: string[]): SecretStore {
  const permitted = new Set(allowed);
  return {
    get(ref: string): string {
      if (!permitted.has(ref)) {
        throw new Error(`secret "${ref}" is not declared in the capability's policy.requires.secrets`);
      }
      return store.get(ref);
    },
  };
}
