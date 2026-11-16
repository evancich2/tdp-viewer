import { execFileSync } from "node:child_process";
import { join } from "node:path";
// Git for Windows ships OpenSSL without normally adding usr/bin to PATH.
export const OPENSSL = (() => {
  const windows = process.platform === "win32" ? [join(process.env.ProgramFiles ?? "C:/Program Files", "Git", "usr", "bin", "openssl.exe"), join(process.env.LOCALAPPDATA ?? "", "Programs", "Git", "usr", "bin", "openssl.exe")] : [];
  for (const bin of ["openssl", ...windows, "/opt/local/bin/openssl", "/usr/bin/openssl"]) {
    try { execFileSync(bin, ["version"], { stdio: "ignore" }); return bin; } catch { /* next */ }
  }
  return null;
})();
