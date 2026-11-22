/**
 * Whether `candidate` is a per-version content address under the lease's
 * content domain: the same scheme and port, one extra host label, plain
 * HTTP(S), and never the application's own origin.
 */
export function isVersionContentUrl(
  candidate: string,
  leaseBase: string,
  applicationOrigin: string,
): boolean {
  let target: URL;
  let lease: URL;
  try {
    target = new URL(candidate);
    lease = new URL(leaseBase);
  } catch {
    return false;
  }
  const suffix = lease.hostname.slice(lease.hostname.indexOf("."));
  const label = target.hostname.slice(0, -suffix.length);
  return suffix.startsWith(".")
    && label.length > 0
    && !label.includes(".")
    && target.hostname.endsWith(suffix)
    && target.protocol === lease.protocol
    && target.port === lease.port
    && ["http:", "https:"].includes(target.protocol)
    && target.origin !== applicationOrigin;
}
