// Finds Bambu Lab printers on the local network by listening for the SSDP announcements they
// broadcast (UDP 2021, and 1990 on some firmware). Listen-only: nothing is sent.
import dgram from "node:dgram";

export interface Announcement {
  host: string;
  /** Set when the announcement's Location differs from where it came from. */
  claimedHost?: string;
  serial?: string;
  model?: string;
  name?: string;
  connect?: string;
  bind?: string;
  version?: string;
  signal?: string;
  headers: Record<string, string>;
}

export function parseAnnouncement(text: string, from: string): Announcement | undefined {
  const lines = text.split(/\r?\n/);
  if (!/^(NOTIFY|HTTP\/1\.1 200|M-SEARCH)/i.test(lines[0] ?? "")) return undefined;
  const headers: Record<string, string> = {};
  for (const l of lines.slice(1)) {
    const i = l.indexOf(":");
    if (i > 0) headers[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim();
  }
  if (!/bambulab|bambu/i.test(headers.nt ?? headers.st ?? "") && !Object.keys(headers).some((k) => k.endsWith(".bambu.com"))) return undefined;
  // Use the packet's source address, not the address the packet claims (Location).
  return {
    host: from,
    claimedHost: headers.location && headers.location !== from ? headers.location : undefined,
    serial: headers.usn,
    model: headers["devmodel.bambu.com"],
    name: headers["devname.bambu.com"],
    connect: headers["devconnect.bambu.com"],
    bind: headers["devbind.bambu.com"],
    version: headers["devversion.bambu.com"],
    signal: headers["devsignal.bambu.com"],
    headers,
  };
}

export async function discover(seconds: number, onFound?: (a: Announcement) => void): Promise<Announcement[]> {
  const found = new Map<string, Announcement>();
  const sockets = [2021, 1990].map((port) => {
    const s = dgram.createSocket({ type: "udp4", reuseAddr: true });
    s.on("message", (m, r) => {
      const a = parseAnnouncement(m.toString("utf8").slice(0, 4096), r.address);
      if (!a) return;
      const key = a.serial ?? a.host;
      if (!found.has(key)) { found.set(key, a); onFound?.(a); }
    });
    s.on("error", () => s.close());
    s.bind(port, () => { try { s.addMembership("239.255.255.250"); } catch { /* broadcast still arrives */ } });
    return s;
  });
  await new Promise((r) => setTimeout(r, seconds * 1000));
  for (const s of sockets) { try { s.close(); } catch { /* closed */ } }
  return [...found.values()];
}
