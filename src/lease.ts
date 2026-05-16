import { open, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { locksDir } from "./paths.js";
import { ensureDir } from "./utils/fs.js";

export type Lease = {
  acquired: boolean;
  path: string;
  token: string;
  ttlSeconds: number;
};

type LeaseRecord = {
  token: string;
  holder: string;
  acquiredAt: number;
  expiresAt: number;
};

export async function tryAcquireLease(
  projectPath: string,
  workItemId: string,
  ttlSeconds = 120
): Promise<Lease> {
  const dir = locksDir(projectPath);
  await ensureDir(dir);
  const lockPath = path.join(dir, `${workItemId}.lock`);
  const token = `${process.pid}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
  const record: LeaseRecord = {
    token,
    holder: `${process.env.USER ?? "unknown"}:${process.pid}`,
    acquiredAt: Date.now(),
    expiresAt: Date.now() + ttlSeconds * 1000
  };
  try {
    const handle = await open(lockPath, "wx");
    await handle.writeFile(JSON.stringify(record, null, 2), "utf8");
    await handle.close();
    return { acquired: true, path: lockPath, token, ttlSeconds };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await readLease(lockPath);
    if (existing && existing.expiresAt < Date.now()) {
      await rm(lockPath, { force: true });
      return tryAcquireLease(projectPath, workItemId, ttlSeconds);
    }
    return { acquired: false, path: lockPath, token, ttlSeconds };
  }
}

export async function renewLease(lease: Lease): Promise<boolean> {
  if (!lease.acquired) return false;
  const existing = await readLease(lease.path);
  if (!existing || existing.token !== lease.token) return false;
  existing.expiresAt = Date.now() + lease.ttlSeconds * 1000;
  await writeFile(lease.path, JSON.stringify(existing, null, 2), "utf8");
  return true;
}

export async function releaseLease(lease: Lease): Promise<void> {
  if (!lease.acquired) return;
  const existing = await readLease(lease.path);
  if (!existing || existing.token !== lease.token) return;
  await rm(lease.path, { force: true });
}

async function readLease(lockPath: string): Promise<LeaseRecord | undefined> {
  try {
    return JSON.parse(await readFile(lockPath, "utf8")) as LeaseRecord;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return undefined;
  }
}
