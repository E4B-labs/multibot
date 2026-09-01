import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { IdentityStore, identityCookie } from "./identity.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("protocol v2 identity", () => {
  it("configures server, creates owner, rotates recovery and revokes access", async () => {
    const dir = mkdtempSync(join(tmpdir(), "multibot-identity-"));
    dirs.push(dir);
    const store = new IdentityStore(join(dir, "identity.db"));
    const before = store.publicInfo();
    expect(before.configured).toBe(false);
    expect(before.protocol).toBe(2);

    const setup = await store.configureServer("Home server", "server-password-123");
    expect(setup.server.configured).toBe(true);
    expect(await store.verifyJoinPassword("server-password-123")).toBe(true);
    expect(await store.verifyJoinPassword("wrong-server-password")).toBe(false);
    const registered = await store.register({
      username: "test-user",
      password: "profile-password-123",
      displayName: "Example User",
      serverPassword: "server-password-123",
      deviceName: "test",
    });
    expect(registered.actor.role).toBe("owner");
    expect(registered.recoveryCode).toHaveLength(32);

    const cookie = identityCookie(registered.sessionToken, false);
    const actor = store.actorForRequest({ headers: { cookie } });
    expect(actor?.userId).toBe(registered.actor.userId);
    expect(store.actorForSessionToken(registered.sessionToken)?.userId).toBe(registered.actor.userId);
    expect(store.createSessionForActor(registered.actor, "mobile").accessToken).toBeTruthy();
    expect(store.actorForRequest({ headers: { authorization: `Bearer ${registered.accessToken}` } })?.username).toBe("test-user");

    const recovered = await store.recover("test-user", registered.recoveryCode, "new-profile-password-123", "recovery");
    expect(recovered.recoveryCode).not.toBe(registered.recoveryCode);
    expect(store.actorForRequest({ headers: { authorization: `Bearer ${registered.accessToken}` } })).toBeNull();
    expect((await store.login("test-user", "new-profile-password-123", "new device")).actor.userId).toBe(registered.actor.userId);
    store.close();
  });

  it("generates server join credentials when setup receives no values", async () => {
    const dir = mkdtempSync(join(tmpdir(), "multibot-identity-generated-"));
    dirs.push(dir);
    const store = new IdentityStore(join(dir, "identity.db"));

    const setup = await store.configureServer();
    expect(setup.server.name).toBe("MultiBot server");
    expect(setup.serverPassword.length).toBeGreaterThanOrEqual(12);
    expect(await store.verifyJoinPassword(setup.serverPassword)).toBe(true);
    store.close();
  });
});
