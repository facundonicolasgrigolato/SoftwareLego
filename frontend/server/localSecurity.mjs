import fs from "node:fs";
import path from "node:path";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const MUTATING_METHODS = new Set(["POST", "PUT", "DELETE", "PATCH"]);

export function isPdfBuffer(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 5 && buf.subarray(0, 5).toString("ascii") === "%PDF-";
}

export function isPngBuffer(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIGNATURE);
}

export function isSafeLDrawRelPath(relPath) {
  const clean = String(relPath || "").trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (!clean || clean.includes("\0")) return false;
  const lower = clean.toLowerCase();
  if (lower === "ldconfig.ldr") return true;
  if (!lower.endsWith(".dat")) return false;
  return lower.startsWith("parts/") || lower.startsWith("p/");
}

export function isValidLDrawContent(rawText) {
  if (typeof rawText !== "string") return false;
  const cleaned = rawText.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const head = cleaned.slice(0, 256).toLowerCase();
  if (head.includes("<html") || head.includes("<!doctype")) return false;

  let hasLine = false;
  for (const rawLine of cleaned.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const first = line[0];
    if (first < "0" || first > "5") return false;
    if (line.length > 1 && !/\s/.test(line[1])) return false;
    hasLine = true;
  }
  return hasLine;
}

export function isValidManifestPayload(parsed) {
  return Boolean(
    parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      Array.isArray(parsed.parts)
  );
}

export function writeFileAtomicSync(targetPath, data, encoding) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const tmpPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    if (encoding !== undefined) {
      fs.writeFileSync(tmpPath, data, encoding);
    } else {
      fs.writeFileSync(tmpPath, data);
    }
    fs.renameSync(tmpPath, targetPath);
  } finally {
    if (fs.existsSync(tmpPath)) {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        // ignorar limpieza si el rename tuvo éxito
      }
    }
  }
}

function isLoopbackHostHeader(hostHeader) {
  if (!hostHeader) return true;
  try {
    const u = new URL(`http://${hostHeader}`);
    return LOOPBACK_HOSTS.has(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function matchesLocalOrigin(rawUrl, hostHeader) {
  if (!rawUrl || rawUrl === "null") return false;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    if (!LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())) return false;
    if (hostHeader && parsed.host.toLowerCase() !== String(hostHeader).toLowerCase()) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function isAllowedLocalRequest(req) {
  const headers = req?.headers || {};
  const hostHeader = headers.host;
  if (hostHeader && !isLoopbackHostHeader(hostHeader)) {
    return false;
  }

  const method = String(req?.method || "GET").toUpperCase();
  if (!MUTATING_METHODS.has(method)) {
    return true;
  }

  const fetchSite = String(headers["sec-fetch-site"] || "").toLowerCase();
  if (fetchSite === "cross-site") {
    return false;
  }

  if (headers.origin !== undefined && !matchesLocalOrigin(headers.origin, hostHeader)) {
    return false;
  }

  if (
    headers.origin === undefined &&
    headers.referer !== undefined &&
    !matchesLocalOrigin(headers.referer, hostHeader)
  ) {
    return false;
  }

  return true;
}

export function safeDecodeUriComponent(raw) {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}
