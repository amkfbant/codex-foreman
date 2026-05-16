import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";

export async function tempRepo(prefix = "codex-foreman-"): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  await execa("git", ["init"], { cwd: dir });
  await execa("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  await execa("git", ["config", "user.name", "Test User"], { cwd: dir });
  await writeFile(path.join(dir, "README.md"), "# Fixture\n", "utf8");
  await execa("git", ["add", "README.md"], { cwd: dir });
  await execa("git", ["commit", "-m", "initial"], { cwd: dir });
  return dir;
}

