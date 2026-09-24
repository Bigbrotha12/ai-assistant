import { createHash } from "node:crypto";

const TEST_PASSWORD_HASH_PREFIX = "$test$sha256$";

function hashTestPassword(password: string): string {
  return `${TEST_PASSWORD_HASH_PREFIX}${createHash("sha256")
    .update(password.normalize("NFKC"))
    .digest("hex")}`;
}

// Test-only: keep password-auth fixtures fast and deterministic under parallel CI load.
export const testPasswordHasher = {
  hash: async (password: string) => hashTestPassword(password),
  verify: async ({ hash, password }: { hash: string; password: string }) =>
    hash === hashTestPassword(password),
};
