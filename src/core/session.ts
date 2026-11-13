import { AuditLog } from "./audit";
import { digestEquals, sha256Hex } from "./bytes";
import type { Policy } from "./policy";
import type { Manifest, ManifestFile, TrustStore } from "./schema";
import { verifyPackage, type VerifyResult } from "./verify";

export class AccessDenied extends Error {}

/**
 * The only way UI code gets package bytes. A file is handed out only if the package was trusted,
 * and its digest is checked again on every open: trust is never cached.
 */
export class PackageSession {
  private constructor(
    readonly name: string,
    readonly result: VerifyResult,
    readonly audit: AuditLog,
    readonly policy: Policy,
  ) {}

  static async open(
    name: string,
    data: Uint8Array,
    trustStore: TrustStore,
    policy: Policy,
    audit = new AuditLog(),
    now: Date = new Date(),
  ): Promise<PackageSession> {
    await audit.append("load", name, `${data.length} bytes`);
    const result = await verifyPackage(data, trustStore, policy, now);
    const failed = result.checks.filter((c) => c.status === "fail").map((c) => c.message);
    if (result.verdict === "trusted") await audit.append("verify", name, `trusted, manifest ${result.manifestSha256}`);
    else await audit.append("deny", name, failed.join("; "));
    return new PackageSession(name, result, audit, policy);
  }

  get trusted(): boolean {
    return this.result.verdict === "trusted";
  }

  get manifest(): Manifest | undefined {
    return this.result.manifest;
  }

  /** The verified engineering model of a trusted 0.2 package; undefined otherwise. */
  get engineering() {
    return this.trusted ? this.result.engineering : undefined;
  }

  async openFile(path: string, purpose: string): Promise<{ file: ManifestFile; bytes: Uint8Array }> {
    const deny = async (why: string): Promise<never> => {
      await this.audit.append("deny", path, `${purpose}: ${why}`);
      throw new AccessDenied(`${path}: ${why}`);
    };
    if (!this.trusted) return deny("package is not trusted");
    const file = this.result.manifest?.files.find((f) => f.path === path);
    const entry = this.result.entries.find((e) => e.path === path);
    if (!file || !entry) return deny("not in package");
    if (!digestEquals(await sha256Hex(entry.bytes), file.sha256)) return deny("digest changed since verification");
    await this.audit.append("open", path, purpose);
    // Hand out a copy so callers can't alter the verified bytes.
    return { file, bytes: entry.bytes.slice() };
  }
}
