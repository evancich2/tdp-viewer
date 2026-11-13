// Read-only Onshape source adapter, for the CLI only. The browser app never makes network requests;
// this runs in Node, on an operator's machine, with credentials from the environment.
//
// What it does: reads a document, its versions and its revisions (release management), and compares
// them with the source references a baseline declares (publication check), or captures a source
// reference to put into an engineering model. It never writes to Onshape: `reconcile` answers every
// transaction "unsupported".
//
// Based on the public API documentation (onshape-public.github.io/docs: api-intro, auth/apikeys,
// api-adv/documents, api-adv/relmgmt), using only documented GET endpoints. The docs do not fully
// specify revision response fields, so they are read defensively: when a field this adapter needs
// is missing, the result is "unknown", never "current". NOT YET EXERCISED AGAINST A LIVE ONSHAPE
// ACCOUNT: confirm with real credentials before relying on it.
//
// Credentials: ONSHAPE_ACCESS_KEY and ONSHAPE_SECRET_KEY (API keys, request-signature method).
// Optional: ONSHAPE_BASE_URL (default https://cad.onshape.com), ONSHAPE_API_VERSION (default v10).
// Secrets are never written to any file, record, bundle or log line.
import { createHmac, randomBytes } from "node:crypto";
import { itemKey, type EngineeringModel, type SourceReference } from "../src/core/engineering";
import type { AckSet, AdapterDescriptor, ProposalSet, PublicationCheck, SourceAdapter } from "../src/core/exchange";
import { canonicalSha256 } from "../src/core/canonical";

export interface OnshapeCredentials {
  accessKey: string;
  secretKey: string;
  baseUrl: string;
  apiVersion: string;
}

/** Minimal fetch shape, so tests can substitute a transport. */
export type Transport = (url: string, init: { method: string; headers: Record<string, string> }) => Promise<{ status: number; json(): Promise<unknown>; headers: { get(name: string): string | null } }>;

export function credentialsFromEnv(env: NodeJS.ProcessEnv = process.env): OnshapeCredentials {
  const accessKey = env.ONSHAPE_ACCESS_KEY;
  const secretKey = env.ONSHAPE_SECRET_KEY;
  if (!accessKey || !secretKey) throw new Error("set ONSHAPE_ACCESS_KEY and ONSHAPE_SECRET_KEY (API keys); they are read from the environment only and never stored");
  const baseUrl = (env.ONSHAPE_BASE_URL ?? "https://cad.onshape.com").replace(/\/+$/, "");
  if (!/^https:\/\//.test(baseUrl)) throw new Error("ONSHAPE_BASE_URL must be https");
  return { accessKey, secretKey, baseUrl, apiVersion: env.ONSHAPE_API_VERSION ?? "v10" };
}

const CONTENT_TYPE = "application/json";

/**
 * Request-signature authentication, as documented: HMAC-SHA256 with the secret key over
 * method, nonce, date, content type, path and query, each followed by a newline, all lowercased.
 */
export function signRequest(c: Pick<OnshapeCredentials, "accessKey" | "secretKey">, method: string, path: string, query: string, date: string, nonce: string): string {
  const text = `${method}\n${nonce}\n${date}\n${CONTENT_TYPE}\n${path}\n${query}\n`.toLowerCase();
  const sig = createHmac("sha256", c.secretKey).update(text).digest("base64");
  return `On ${c.accessKey}:HmacSHA256:${sig}`;
}

const SAFE = /^[A-Za-z0-9]{1,64}$/;
const seg = (v: string, what: string) => {
  if (!SAFE.test(v)) throw new Error(`${what} must be alphanumeric (got ${JSON.stringify(v.slice(0, 40))})`);
  return v;
};

export class OnshapeClient {
  constructor(private creds: OnshapeCredentials, private transport: Transport = fetch as unknown as Transport) {}

  async get(path: string, query = ""): Promise<unknown> {
    const fullPath = `/api/${this.creds.apiVersion}${path}`;
    const date = new Date().toUTCString();
    const nonce = randomBytes(18).toString("hex").slice(0, 25);
    const res = await this.transport(`${this.creds.baseUrl}${fullPath}${query ? `?${query}` : ""}`, {
      method: "GET",
      headers: {
        Date: date,
        "On-Nonce": nonce,
        "Content-Type": CONTENT_TYPE,
        Accept: "application/json;charset=UTF-8; qs=0.09",
        Authorization: signRequest(this.creds, "GET", fullPath, query, date, nonce),
      },
    });
    if (res.status === 429) throw new Error(`Onshape rate limit reached on ${fullPath} (remaining: ${res.headers.get("X-Rate-Limit-Remaining") ?? "?"})`);
    if (res.status === 402) throw new Error("Onshape annual API call limit reached for this account");
    if (res.status === 401 || res.status === 403) throw new Error(`Onshape refused ${fullPath} (${res.status}): check the API keys and document permissions`);
    if (res.status < 200 || res.status >= 300) throw new Error(`Onshape ${fullPath}: HTTP ${res.status}`);
    if (res.headers.get("X-Deprecated")) console.error(`note: Onshape marks ${fullPath} deprecated`);
    return res.json();
  }

  async document(did: string): Promise<{ id?: string; name?: string }> {
    return (await this.get(`/documents/${seg(did, "documentId")}`)) as { id?: string; name?: string };
  }
  async versions(did: string): Promise<{ id?: string; name?: string; createdAt?: string }[]> {
    return (await this.get(`/documents/d/${seg(did, "documentId")}/versions`, "offset=0&limit=200")) as { id?: string; name?: string }[];
  }
  async revisions(did: string): Promise<unknown> {
    return this.get(`/revisions/d/${seg(did, "documentId")}`);
  }
}

/** A revision as far as this adapter can read one. Fields the docs don't guarantee are optional. */
export interface RevisionInfo {
  revision?: string;
  partNumber?: string;
  elementId?: string;
  versionId?: string;
  releaseName?: string;
  createdAt?: string;
}

/** Reads revision entries from a response whose exact shape the docs don't pin down: an array, or `{ items: [...] }`. */
export function readRevisions(body: unknown): RevisionInfo[] {
  const list = Array.isArray(body) ? body : body && typeof body === "object" && Array.isArray((body as { items?: unknown }).items) ? (body as { items: unknown[] }).items : [];
  const str = (o: Record<string, unknown>, ...keys: string[]) => { for (const k of keys) if (typeof o[k] === "string") return o[k] as string; return undefined; };
  return list.filter((x): x is Record<string, unknown> => !!x && typeof x === "object").map((o) => ({
    revision: str(o, "revision"),
    partNumber: str(o, "partNumber"),
    elementId: str(o, "elementId"),
    versionId: str(o, "versionId"),
    releaseName: str(o, "releaseName"),
    createdAt: str(o, "createdAt"),
  }));
}

export class OnshapeReadAdapter implements SourceAdapter {
  constructor(private client: OnshapeClient) {}

  describe(): AdapterDescriptor {
    return { system: "onshape", label: "Onshape (read-only)", fixture: false, objectTypes: [] };
  }

  async checkPublication(model: EngineeringModel): Promise<PublicationCheck[]> {
    const out: PublicationCheck[] = [];
    for (const it of model.items) {
      const src = model.sources.find((s) => s.id === it.source);
      const label = `${itemKey(it)} (${src?.id ?? "no source"})`;
      if (!src || src.system !== "onshape") { out.push({ source: label, status: "unknown", message: `${label}: not an Onshape source` }); continue; }
      out.push(await this.checkOne(label, it.revision, src));
    }
    return out;
  }

  private async checkOne(label: string, revision: string, src: SourceReference): Promise<PublicationCheck> {
    const { documentId, versionId, elementId, partNumber } = src.reference as Record<string, string | undefined>;
    if (!documentId || !versionId) return { source: label, status: "unknown", message: `${label}: reference needs documentId and versionId` };
    try {
      const versions = await this.client.versions(documentId);
      if (!Array.isArray(versions) || !versions.some((v) => v.id === versionId)) return { source: label, status: "mismatch", message: `${label}: version ${versionId} is not a version of document ${documentId}` };
      const revs = readRevisions(await this.client.revisions(documentId)).filter((r) => (partNumber ? r.partNumber === partNumber : elementId ? r.elementId === elementId : false));
      if (!revs.length) return { source: label, status: "not-released", message: `${label}: no Onshape revision found for ${partNumber ? `part number ${partNumber}` : `element ${elementId ?? "?"}`}` };
      if (revs.some((r) => r.revision === undefined)) return { source: label, status: "unknown", message: `${label}: Onshape's revision response lacked a revision field; can't decide` };
      const declared = revs.find((r) => r.revision === revision);
      if (!declared) return { source: label, status: "mismatch", message: `${label}: Onshape has revisions ${revs.map((r) => r.revision).join(", ")}, not ${revision}` };
      if (declared.versionId && declared.versionId !== versionId) return { source: label, status: "mismatch", message: `${label}: revision ${revision} was released from version ${declared.versionId}, not ${versionId}` };
      const dated = revs.filter((r) => r.createdAt);
      if (dated.length !== revs.length) return { source: label, status: "unknown", message: `${label}: revision ${revision} exists, but revision dates are missing, so it can't be shown to be the latest` };
      const newest = [...dated].sort((a, b) => Date.parse(b.createdAt!) - Date.parse(a.createdAt!))[0]!;
      if (newest.revision !== revision) return { source: label, status: "superseded", message: `${label}: Onshape's latest revision is ${newest.revision}` };
      return { source: label, status: "current", message: `${label}: revision ${revision} is Onshape's latest for this part (read ${new Date().toISOString()})` };
    } catch (e) {
      return { source: label, status: "unknown", message: `${label}: ${(e as Error).message}` };
    }
  }

  /** Read-only: proposes nothing to Onshape. */
  async reconcile(proposals: ProposalSet, now = new Date()): Promise<AckSet> {
    return {
      schema: "tdp-sync-acks/0.1",
      adapter: { system: "onshape", label: "Onshape (read-only)", fixture: false },
      proposalSetSha256: await canonicalSha256(proposals),
      acknowledgedAt: now.toISOString(),
      acks: proposals.transactions.map((t) => ({
        txId: t.txId, contentSha256: t.contentSha256, status: "unsupported" as const, objectType: t.target.objectType, objectId: t.target.objectId,
        sourceVersion: null, reason: "the Onshape adapter is read-only in this increment", requiresNewBaseline: false,
      })),
    };
  }

  /** Builds a source reference for an engineering model from what Onshape reports now. */
  async captureReference(opts: { id: string; documentId: string; versionId: string; elementId: string; partNumber?: string; revision: string }, now = new Date()): Promise<SourceReference> {
    const doc = await this.client.document(opts.documentId);
    const versions = await this.client.versions(opts.documentId);
    const v = Array.isArray(versions) ? versions.find((x) => x.id === opts.versionId) : undefined;
    if (!v) throw new Error(`version ${opts.versionId} is not a version of document ${opts.documentId}`);
    const revs = readRevisions(await this.client.revisions(opts.documentId)).filter((r) => (opts.partNumber ? r.partNumber === opts.partNumber : r.elementId === opts.elementId));
    const rev = revs.find((r) => r.revision === opts.revision);
    seg(opts.elementId, "elementId");
    return {
      id: opts.id,
      system: "onshape",
      reference: {
        documentId: opts.documentId, versionId: opts.versionId, elementId: opts.elementId,
        ...(opts.partNumber ? { partNumber: opts.partNumber } : {}),
        ...(doc.name ? { documentName: doc.name.slice(0, 200) } : {}),
        ...(v.name ? { versionName: v.name.slice(0, 200) } : {}),
      },
      declaredRevision: opts.revision,
      // Declared, not verified: release is established by a source-release record under the authority.
      declaredReleaseState: rev ? `Released${rev.releaseName ? ` (${rev.releaseName.slice(0, 40)})` : ""}` : "Not released",
      capture: "api-read",
      capturedAt: now.toISOString(),
    };
  }
}
