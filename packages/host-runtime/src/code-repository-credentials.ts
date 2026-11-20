import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename, rm, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export class RepositoryCredentials {
  readonly file: string;
  constructor(environment: NodeJS.ProcessEnv = process.env) {
    this.file = path.join(environment.HOME || os.homedir(), ".config", "codexhost", "gitlab-token");
  }
  async token(): Promise<string | null> {
    try {
      const value = (await readFile(this.file, "utf8")).trim();
      return value.length >= 8 && value.length <= 512 && !/\s/u.test(value) ? value : null;
    } catch {
      return null;
    }
  }
  async state() {
    const token = await this.token();
    return { configured: token !== null, lastFour: token?.slice(-4) ?? null };
  }
  async update(token: string | null) {
    if (token === null) await rm(this.file, { force: true });
    else {
      await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, `${token}\n`, { mode: 0o600 });
        await chmod(temporary, 0o600);
        await rename(temporary, this.file);
      } finally {
        await rm(temporary, { force: true });
      }
    }
    return this.state();
  }
}
