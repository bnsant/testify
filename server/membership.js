import { getActivityInstance } from "./discordAuth.js";

// Short-lived cache coalesces checks for viewers in the same Activity.
// The cache never authorizes an identity supplied by the browser.
export function createMembershipVerifier(config, fetchImpl = fetch) {
  const cache = new Map();
  return async function verify({ instanceId, user }) {
    let entry = cache.get(instanceId);
    if (!entry || entry.expiresAt <= Date.now()) {
      const promise = getActivityInstance({ clientId: config.clientId, botToken: config.botToken, instanceId, fetchImpl });
      entry = { promise, expiresAt: Date.now() + 10_000 };
      cache.set(instanceId, entry);
      if (cache.size > 256) cache.delete(cache.keys().next().value);
      promise.catch(() => { if (cache.get(instanceId) === entry) cache.delete(instanceId); });
    }
    const instance = await entry.promise;
    if (instance.application_id !== config.clientId || instance.instance_id !== instanceId || !instance.users?.includes(user.id)) {
      const error = new Error("Você não está nesta instância do Testify.");
      error.code = "NOT_ACTIVITY_MEMBER";
      throw error;
    }
  };
}
