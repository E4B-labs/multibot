// Provider instance registry — port of upstream's ProviderInstanceRegistryLive
// behavior, minus Effect: config map → live instances; unknown driver or
// config-decode failure becomes an UNAVAILABLE SHADOW SNAPSHOT instead of a
// startup failure (that behavior is what makes settings forward/backward
// compatible — do not remove it); dispose tears an instance down without
// touching its siblings.
import type {
  AnyProviderDriver,
  InstanceConfigMap,
  InstanceId,
  ProviderInstance,
  ProviderSnapshot,
} from "../contracts.ts";

export interface ShadowInstance {
  instanceId: InstanceId;
  driverKind: string;
  displayName: string | undefined;
  enabled: boolean;
  shadow: true;
  reason: string;
}

export type RegistryEntry =
  | { instanceId: InstanceId; live: ProviderInstance; shadow?: undefined }
  | { instanceId: InstanceId; live?: undefined; shadow: ShadowInstance };

export class ProviderRegistry {
  private byId = new Map<InstanceId, RegistryEntry>();
  private driversByKind: Map<string, AnyProviderDriver>;

  constructor(drivers: readonly AnyProviderDriver[]) {
    this.driversByKind = new Map(drivers.map((d) => [d.driverKind, d]));
  }

  async load(configs: InstanceConfigMap) {
    for (const [instanceId, entry] of Object.entries(configs)) {
      const driver = this.driversByKind.get(entry.driver);
      if (!driver) {
        this.byId.set(instanceId, {
          instanceId,
          shadow: {
            instanceId,
            driverKind: entry.driver,
            displayName: entry.displayName,
            enabled: entry.enabled ?? true,
            shadow: true,
            reason: `unknown driver "${entry.driver}" — kept as configured, unavailable here`,
          },
        });
        continue;
      }
      // multibot (G1): `enabled` is the persistent CLI allow switch. Disabled
      // tools must not be spawned or remain routable through registry.get().
      if (entry.enabled === false) {
        this.byId.set(instanceId, {
          instanceId,
          shadow: {
            instanceId,
            driverKind: entry.driver,
            displayName: entry.displayName ?? driver.metadata.displayName,
            enabled: false,
            shadow: true,
            reason: "disabled in settings",
          },
        });
        continue;
      }
      try {
        const config = entry.config === undefined ? driver.defaultConfig() : driver.decodeConfig(entry.config);
        const live = await driver.create({
          instanceId,
          displayName: entry.displayName ?? driver.metadata.displayName,
          environment: entry.environment ?? {},
          enabled: entry.enabled ?? true,
          config,
        });
        this.byId.set(instanceId, { instanceId, live });
      } catch (e) {
        this.byId.set(instanceId, {
          instanceId,
          shadow: {
            instanceId,
            driverKind: entry.driver,
            displayName: entry.displayName ?? driver.metadata.displayName,
            enabled: entry.enabled ?? true,
            shadow: true,
            reason: e instanceof Error ? e.message : String(e),
          },
        });
      }
    }
  }

  get(instanceId: InstanceId): ProviderInstance | null {
    return this.byId.get(instanceId)?.live ?? null;
  }

  entries(): RegistryEntry[] {
    return [...this.byId.values()];
  }

  instances(): ProviderInstance[] {
    return [...this.byId.values()].flatMap((e) => (e.live ? [e.live] : []));
  }

  /** instance snapshots for the model picker: id, driver, models, health */
  async describe() {
    return Promise.all(
      this.entries().map(async (entry) => {
        if (entry.shadow) {
          return {
            instanceId: entry.instanceId,
            driverKind: entry.shadow.driverKind,
            displayName: entry.shadow.displayName ?? entry.shadow.driverKind,
            enabled: entry.shadow.enabled,
            snapshot: { state: "unavailable", reason: entry.shadow.reason } satisfies ProviderSnapshot,
            models: { default: "", options: [] },
            capabilities: { peerMessaging: "mentions-only" as const },
          };
        }
        const inst = entry.live;
        let snapshot: ProviderSnapshot;
        try {
          snapshot = await inst.snapshot();
        } catch (e) {
          snapshot = { state: "unavailable", reason: e instanceof Error ? e.message : String(e) };
        }
        return {
          instanceId: inst.instanceId,
          driverKind: inst.driverKind,
          displayName: inst.displayName ?? inst.driverKind,
          enabled: inst.enabled,
          snapshot,
          models: inst.models,
          capabilities: {
            peerMessaging: inst.adapter.capabilities.agentsMcp === true ? ("tools" as const) : ("mentions-only" as const),
          },
        };
      }),
    );
  }

  async disposeAll() {
    await Promise.allSettled(this.instances().map((i) => i.dispose()));
    this.byId.clear();
  }
}
