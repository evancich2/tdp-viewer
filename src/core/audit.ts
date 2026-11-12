import { sha256Hex, utf8 } from "./bytes";

export type AuditAction = "trust" | "load" | "verify" | "deny" | "open" | "export";

export interface AuditEntry {
  seq: number;
  time: string;
  action: AuditAction;
  subject: string;
  detail: string;
  prevHash: string;
  hash: string;
}

const GENESIS = "0".repeat(64);

/**
 * Append-only, hash-chained log of everything the viewer does with a package.
 * Each entry commits to the one before it, so editing or dropping an entry breaks the chain.
 */
export class AuditLog {
  private entries: AuditEntry[] = [];
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly now: () => Date = () => new Date()) {}

  append(action: AuditAction, subject: string, detail = ""): Promise<void> {
    // Serialize appends so the chain order matches call order.
    this.tail = this.tail.then(async () => {
      const prevHash = this.entries.at(-1)?.hash ?? GENESIS;
      const body = { seq: this.entries.length, time: this.now().toISOString(), action, subject, detail, prevHash };
      const hash = await sha256Hex(utf8.encode(JSON.stringify(body)));
      this.entries.push({ ...body, hash });
    });
    return this.tail;
  }

  async list(): Promise<readonly AuditEntry[]> {
    await this.tail;
    return [...this.entries];
  }

  static async verifyChain(entries: readonly AuditEntry[]): Promise<boolean> {
    let prev = GENESIS;
    for (const [i, e] of entries.entries()) {
      if (e.seq !== i || e.prevHash !== prev) return false;
      const { hash, ...body } = e;
      if ((await sha256Hex(utf8.encode(JSON.stringify(body)))) !== hash) return false;
      prev = hash;
    }
    return true;
  }
}
