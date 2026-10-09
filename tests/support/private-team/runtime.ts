import type {ReplicaClient} from "./application-client.js";

export type PrivateTeamTarget = "compact-compose" | "external-compose" | "helm";

/** One packaged private-team deployment the shared acceptance suite can drive. */
export interface PrivateTeamRuntime {
  readonly bootstrapAdministrator: {readonly email: string; readonly password: string};
  readonly deployment: "single_server" | "kubernetes";
  /** One client per application process, so a check can name the replica it reaches. */
  readonly replicas: readonly ReplicaClient[];
  /** The installation's managed `as_key_` machine credential. */
  readonly serviceKey: string;
  readonly target: PrivateTeamTarget;
  /**
   * Start with environment overrides (null removes a variable) and resolve with
   * the refusal text once it is clear no replica will ever report ready.
   */
  expectStartupRefused(overrides: Readonly<Record<string, string | null>>): Promise<string>;
  /** Provider bindings recorded for an email, read from the runtime's own store. */
  externalIdentityCount(email: string): Promise<number>;
  /** Start, or restart, with the valid private-team configuration. */
  start(): Promise<void>;
  /** Startup output of the running replicas. */
  startupLogs(): Promise<string>;
  stop(): Promise<void>;
  /** Credentials present on disk for this runtime that must never authenticate. */
  strayCredentials(): Promise<readonly {readonly name: string; readonly token: string}[]>;
}
