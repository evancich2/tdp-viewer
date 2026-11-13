// TLS to a Bambu Lab printer with the certificate pinned by fingerprint.
//
// The printer's certificate is issued by Bambu's own CA, not a public one, so ordinary chain
// validation can't succeed. Instead of switching verification off, we pin: `printer pin` records the
// SHA-256 fingerprint the printer presents (trust on first use, checked by the person against the
// printer they're standing at), and every later connection must present exactly that certificate
// before any credential is sent.
import tls from "node:tls";

export class PinMismatch extends Error {}

export const normalizeFingerprint = (fp: string) => {
  const hex = fp.replace(/[^0-9a-f]/gi, "").toUpperCase();
  if (hex.length !== 64) throw new Error(`not a SHA-256 fingerprint: ${fp}`);
  return hex.match(/../g)!.join(":");
};

export interface PeerCert {
  fingerprint256: string;
  subjectCN?: string;
  issuerCN?: string;
  validTo?: string;
  /** True when no certificate was shown because a pinned TLS session was resumed. */
  resumed?: boolean;
}

export interface PinnedOptions {
  host: string;
  port: number;
  /** Required unless `allowUnpinned` (only the `pin` command sets that). */
  fingerprint?: string;
  allowUnpinned?: boolean;
  /** TLS session to resume (FTPS data connections must reuse the control session). */
  session?: Buffer;
  timeoutMs?: number;
}

function peer(sock: tls.TLSSocket): PeerCert {
  const c = sock.getPeerCertificate();
  const cn = (v: unknown) => (Array.isArray(v) ? String(v[0]) : v === undefined ? undefined : String(v));
  return { fingerprint256: normalizeFingerprint(c.fingerprint256), subjectCN: cn(c.subject?.CN), issuerCN: cn(c.issuer?.CN), validTo: c.valid_to };
}

/**
 * Opens a TLS connection and resolves once the peer's certificate matches the pin.
 * `onSocket` sees the socket before the handshake (FTPS needs to send a command meanwhile).
 */
export function connectPinned(o: PinnedOptions, onSocket?: (s: tls.TLSSocket) => void): Promise<{ socket: tls.TLSSocket; cert: PeerCert }> {
  if (!o.fingerprint && !o.allowUnpinned) return Promise.reject(new Error(`no certificate pin for ${o.host}; run "printer pin" first`));
  const want = o.fingerprint ? normalizeFingerprint(o.fingerprint) : undefined;
  return new Promise((resolve, reject) => {
    // Chain validation is replaced by the exact-certificate pin checked below, before any bytes are sent.
    const socket = tls.connect({ host: o.host, port: o.port, rejectUnauthorized: false, session: o.session, minVersion: "TLSv1.2" });
    const timer = setTimeout(() => { socket.destroy(); reject(new Error(`${o.host}:${o.port}: TLS connection timed out`)); }, o.timeoutMs ?? 10_000);
    socket.once("error", (e) => { clearTimeout(timer); reject(new Error(`${o.host}:${o.port}: ${e.message}`)); });
    socket.once("secureConnect", () => {
      clearTimeout(timer);
      let cert: PeerCert;
      const raw = socket.getPeerCertificate();
      if ((!raw || !raw.fingerprint256) && o.session && socket.isSessionReused() && want) {
        // A resumed session presents no certificate. Its keys come from the earlier handshake,
        // which was checked against this same pin, so the identity carries over.
        return resolve({ socket, cert: { fingerprint256: want, resumed: true } });
      }
      try { cert = peer(socket); } catch { socket.destroy(); return reject(new Error(`${o.host}:${o.port}: the server presented no certificate`)); }
      if (want && cert.fingerprint256 !== want) {
        socket.destroy();
        return reject(new PinMismatch(`${o.host}:${o.port}: certificate ${cert.fingerprint256} does not match the pinned ${want}. Not connecting. If the printer was replaced or reset, pin it again after checking it's the right machine.`));
      }
      resolve({ socket, cert });
    });
    onSocket?.(socket);
  });
}
