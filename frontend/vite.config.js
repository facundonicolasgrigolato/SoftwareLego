import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const SETS_DIR = path.join(ROOT_DIR, "Sets");
const OUTPUT_SETS_DIR = path.join(ROOT_DIR, "output", "sets");
const OUTPUT_COVERS_DIR = path.join(ROOT_DIR, "output", "covers");
const SAVES_DIR = path.join(ROOT_DIR, "Saves");
const PROCESS_SET_SCRIPT = path.join(ROOT_DIR, "backend", "scripts", "process_set.py");
const RENDER_MANUAL_SCRIPT = path.join(ROOT_DIR, "backend", "scripts", "render_manual_page.py");
function resolveSafeChild(baseDir, relPath) {
  const clean = String(relPath || "").replace(/\\/g, "/").replace(/^\/+/, "");
  const resolvedBase = path.resolve(baseDir);
  const target = path.resolve(resolvedBase, clean);
  if (target !== resolvedBase && !target.startsWith(resolvedBase + path.sep)) {
    return null;
  }
  return { clean, target };
}

function findLDrawFileOnDisk(rawRef) {
  const ref = String(rawRef || "").trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (!ref) return null;
  const candidates = [
    ref,
    `parts/${ref}`,
    `p/${ref}`,
  ];
  for (const cand of candidates) {
    const res = resolveSafeChild(LDRAW_ROOT, cand);
    if (res && fs.existsSync(res.target) && fs.statSync(res.target).isFile()) {
      return res;
    }
  }
  return null;
}

function collectLDrawDependencies(manifestParts) {
  const visited = new Set();
  const queue = [];

  const enqueue = (ref) => {
    const found = findLDrawFileOnDisk(ref);
    if (!found) return;
    const key = found.clean.toLowerCase();
    if (visited.has(key)) return;
    visited.add(key);
    queue.push(found);
  };

  if (fs.existsSync(path.join(LDRAW_ROOT, "LDConfig.ldr"))) {
    enqueue("LDConfig.ldr");
  }
  for (const part of manifestParts || []) {
    if (part?.ldraw_file) enqueue(part.ldraw_file);
    else if (part?.ldraw_part_id) enqueue(`parts/${part.ldraw_part_id}.dat`);
  }

  const results = [];
  while (queue.length > 0) {
    const cur = queue.shift();
    try {
      const stat = fs.statSync(cur.target);
      results.push({ path: cur.clean, size: stat.size });
      const text = fs.readFileSync(cur.target, "utf-8");
      const lines = text.split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("1 ")) continue;
        // Formato LDraw línea tipo 1: 1 <color> <x> <y> <z> <a>..<i> <file>
        const tokens = trimmed.split(/\s+/);
        if (tokens.length >= 15) {
          const subRef = tokens.slice(14).join(" ");
          enqueue(subRef);
        }
      }
    } catch {
      // ignorar archivos ilegibles
    }
  }
  return results;
}

const SAVE_SLOT_COUNT = 3;
const MANUAL_PAGE_CACHE_LIMIT = 48;

const manualInfoCache = new Map();
const manualPageCache = new Map();

function rememberManualPage(cacheKey, pngBuf) {
  if (manualPageCache.has(cacheKey)) {
    manualPageCache.delete(cacheKey);
  } else if (manualPageCache.size >= MANUAL_PAGE_CACHE_LIMIT) {
    const oldestKey = manualPageCache.keys().next().value;
    if (oldestKey !== undefined) manualPageCache.delete(oldestKey);
  }
  manualPageCache.set(cacheKey, pngBuf);
}

function clearManualCaches() {
  manualInfoCache.clear();
  manualPageCache.clear();
}

function sanitizeId(raw) {
  return String(raw || "").replace(/[^a-zA-Z0-9_-]/g, "");
}

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function readRequestBuffer(req, maxBytes = 200 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error("Archivo demasiado grande."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function resolveLDrawRoot() {
  const direct = path.join(ROOT_DIR, "data", "ldraw");
  if (fs.existsSync(path.join(direct, "parts"))) {
    return direct;
  }
  const nested = path.join(direct, "ldraw");
  if (fs.existsSync(path.join(nested, "parts"))) {
    return nested;
  }
  return direct;
}

const LDRAW_ROOT = resolveLDrawRoot();

function serveStaticDirectory(urlPrefix, baseDir) {
  return (req, res, next) => {
    const reqUrl = (req.url || "").split("?")[0];
    if (!reqUrl.startsWith(urlPrefix)) {
      return next();
    }

    const relPath = decodeURIComponent(reqUrl.slice(urlPrefix.length)).replace(/^\/+/, "");
    const resolvedBase = path.resolve(baseDir);
    const targetPath = path.resolve(resolvedBase, relPath);
    if (targetPath !== resolvedBase && !targetPath.startsWith(resolvedBase + path.sep)) {
      res.statusCode = 403;
      res.end("Forbidden");
      return;
    }

    if (!fs.existsSync(targetPath) || fs.statSync(targetPath).isDirectory()) {
      res.statusCode = 404;
      res.end("Not Found");
      return;
    }

    const ext = path.extname(targetPath).toLowerCase();
    const contentType =
      ext === ".json"
        ? "application/json; charset=utf-8"
        : ext === ".png"
          ? "image/png"
          : ext === ".jpg" || ext === ".jpeg"
            ? "image/jpeg"
            : "text/plain; charset=utf-8";
    res.setHeader("Content-Type", contentType);
    fs.createReadStream(targetPath).pipe(res);
  };
}

function getSlotFilePath(setNumber, slotNum) {
  const safeSet = sanitizeId(setNumber);
  const slot = Number(slotNum);
  if (!safeSet || !Number.isInteger(slot) || slot < 1 || slot > SAVE_SLOT_COUNT) {
    return null;
  }
  return path.join(SAVES_DIR, safeSet, `slot_${slot}.json`);
}

function listSetSlots(setNumber) {
  const slots = [];
  for (let slot = 1; slot <= SAVE_SLOT_COUNT; slot += 1) {
    const filePath = getSlotFilePath(setNumber, slot);
    if (!filePath || !fs.existsSync(filePath)) {
      slots.push({
        slot,
        exists: false,
        name: `Slot ${slot}`,
        updated_at: null,
        placed_count: 0,
      });
      continue;
    }
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      const stat = fs.statSync(filePath);
      slots.push({
        slot,
        exists: true,
        name: raw.name || `Slot ${slot}`,
        updated_at: raw.updated_at || stat.mtime.toISOString(),
        placed_count: Array.isArray(raw.pieces) ? raw.pieces.length : raw.placed_count || 0,
      });
    } catch {
      slots.push({
        slot,
        exists: false,
        name: `Slot ${slot}`,
        updated_at: null,
        placed_count: 0,
      });
    }
  }
  return slots;
}

function listAvailableSets() {
  if (!fs.existsSync(OUTPUT_SETS_DIR)) {
    return [];
  }
  return fs
    .readdirSync(OUTPUT_SETS_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((filename) => {
      try {
        const raw = JSON.parse(
          fs.readFileSync(path.join(OUTPUT_SETS_DIR, filename), "utf-8")
        );
        const setNumber = raw.set_number || filename.replace(/\.json$/, "");
        const coverPath = path.join(OUTPUT_COVERS_DIR, `${setNumber}.png`);
        const slots = listSetSlots(setNumber);
        return {
          filename,
          set_number: setNumber,
          set_name: raw.set_name || filename,
          source_pdf: raw.source_pdf || null,
          total_pieces: raw.stats?.total_pieces ?? 0,
          resolved_pieces: raw.stats?.resolved_pieces ?? 0,
          coverage_percent: raw.stats?.coverage_percent ?? 0,
          unresolved_summary: raw.stats?.unresolved_summary || null,
          cover_url: fs.existsSync(coverPath) ? `/covers/${encodeURIComponent(setNumber)}.png` : null,
          saves_count: slots.filter((s) => s.exists).length,
        };
      } catch {
        const setNumber = filename.replace(/\.json$/, "");
        return {
          filename,
          set_number: setNumber,
          set_name: filename,
          total_pieces: 0,
          resolved_pieces: 0,
          coverage_percent: 0,
          cover_url: null,
          saves_count: 0,
        };
      }
    });
}

function parseProcessFailures(stdout, stderr) {
  const match = /^FAILED_JSON:(.+)$/m.exec(stdout || "");
  if (match) {
    try {
      const parsed = JSON.parse(match[1]);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // fall through
    }
  }
  const lines = String(stderr || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length) {
    return [{ filename: "manual.pdf", reason: lines[lines.length - 1] }];
  }
  return [];
}

let cachedPythonCommand = null;

function resolvePythonCommand() {
  if (cachedPythonCommand) return cachedPythonCommand;

  const candidates = [];
  if (process.env.SOFTWARELEGO_PYTHON) {
    candidates.push({ bin: process.env.SOFTWARELEGO_PYTHON, prefixArgs: [] });
  }
  candidates.push(
    { bin: "py", prefixArgs: ["-3"] },
    { bin: "py", prefixArgs: [] },
    { bin: "python", prefixArgs: [] },
    { bin: "python3", prefixArgs: [] }
  );

  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA || "";
    const programFiles = process.env.ProgramFiles || "C:\\Program Files";
    for (const baseDir of [
      path.join(localAppData, "Programs", "Python"),
      programFiles,
      "C:\\",
    ]) {
      try {
        if (!baseDir || !fs.existsSync(baseDir)) continue;
        for (const entry of fs.readdirSync(baseDir)) {
          if (/^Python3\d+$/i.test(entry)) {
            const exe = path.join(baseDir, entry, "python.exe");
            if (fs.existsSync(exe)) {
              candidates.push({ bin: exe, prefixArgs: [] });
            }
          }
        }
      } catch {
        // ignorar errores de permisos
      }
    }
  }

  for (const cand of candidates) {
    try {
      const check = spawnSync(cand.bin, [...cand.prefixArgs, "-c", "import pymupdf"], {
        stdio: "ignore",
        timeout: 5000,
      });
      if (check.status === 0) {
        cachedPythonCommand = cand;
        return cand;
      }
    } catch {
      // probar siguiente candidato
    }
  }

  const fallback = { bin: process.env.SOFTWARELEGO_PYTHON || "py", prefixArgs: [] };
  return fallback;
}

function runProcessSet(args = []) {
  return new Promise((resolve) => {
    const pyCmd = resolvePythonCommand();
    const proc = spawn(pyCmd.bin, [...pyCmd.prefixArgs, PROCESS_SET_SCRIPT, ...args], { cwd: ROOT_DIR });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    proc.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    proc.on("error", (err) => {
      resolve({ ok: false, stdout, stderr: err.message, failed: [{ filename: "python", reason: err.message }] });
    });
    proc.on("close", (code) => {
      const failed = parseProcessFailures(stdout, stderr);
      resolve({ ok: code === 0, stdout, stderr, failed });
    });
  });
}

function runManualScript(args = [], binary = false) {
  return new Promise((resolve) => {
    const pyCmd = resolvePythonCommand();
    const proc = spawn(pyCmd.bin, [...pyCmd.prefixArgs, RENDER_MANUAL_SCRIPT, ...args], { cwd: ROOT_DIR });
    const chunks = [];
    let stderr = "";
    proc.stdout.on("data", (d) => chunks.push(d));
    proc.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    proc.on("error", (err) => {
      resolve({ ok: false, data: null, error: err.message });
    });
    proc.on("close", (code) => {
      const buf = Buffer.concat(chunks);
      resolve({
        ok: code === 0,
        data: binary ? buf : buf.toString("utf-8"),
        error: stderr.trim(),
      });
    });
  });
}

async function resolveManualInfo(setNum, sourcePdf = "") {
  const cacheKey = `${setNum}::${sourcePdf}`;
  if (manualInfoCache.has(cacheKey)) {
    return { ok: true, payload: manualInfoCache.get(cacheKey) };
  }
  const args = ["--set", setNum, "--info"];
  if (sourcePdf) args.push("--source", path.basename(sourcePdf));
  const result = await runManualScript(args, false);
  let payload = null;
  try {
    payload = JSON.parse(result.data || "{}");
  } catch {
    payload = { ok: false, error: result.error || "No se pudo leer el manual PDF." };
  }
  if (!result.ok || !payload.ok) {
    return {
      ok: false,
      error: payload.error || "No se encontró el manual PDF en Sets/.",
    };
  }
  manualInfoCache.set(cacheKey, payload);
  return { ok: true, payload };
}

function attachLocalMiddlewares(server) {
  server.middlewares.use(async (req, res, next) => {
        const parsedUrl = new URL(req.url || "/", "http://127.0.0.1");
        const reqUrl = parsedUrl.pathname;

        if (reqUrl === "/api/sets" && req.method === "GET") {
          sendJson(res, 200, listAvailableSets());
          return;
        }

        if (reqUrl === "/api/scan-sets" && req.method === "POST") {
          const result = await runProcessSet();
          clearManualCaches();
          const failSummary = (result.failed || [])
            .map((f) => `${f.filename}: ${f.reason}`)
            .join(" | ");
          sendJson(res, result.ok ? 200 : 422, {
            ok: result.ok,
            sets: listAvailableSets(),
            failed: result.failed || [],
            output: result.stdout,
            error: result.ok ? "" : failSummary || "No se pudo procesar la carpeta Sets/.",
          });
          return;
        }

        if (reqUrl === "/api/rescan-set" && req.method === "POST") {
          try {
            const bodyBuf = await readRequestBuffer(req, 64 * 1024);
            const body = JSON.parse(bodyBuf.toString("utf-8") || "{}");
            const setNum = sanitizeId(body.set_number);
            let pdfName = String(body.source_pdf || "").trim();
            if (!pdfName && setNum) {
              const jsonPath = path.join(OUTPUT_SETS_DIR, `${setNum}.json`);
              if (fs.existsSync(jsonPath)) {
                try {
                  const manifest = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
                  if (manifest?.source_pdf) pdfName = manifest.source_pdf;
                } catch {
                  // fallback más abajo
                }
              }
            }
            let pdfTarget = pdfName ? resolveSafeChild(SETS_DIR, path.basename(pdfName)) : null;
            if ((!pdfTarget || !fs.existsSync(pdfTarget.target)) && setNum) {
              const fallback = resolveSafeChild(SETS_DIR, `${setNum}.pdf`);
              if (fallback && fs.existsSync(fallback.target)) pdfTarget = fallback;
            }
            if (!pdfTarget || !fs.existsSync(pdfTarget.target)) {
              sendJson(res, 404, {
                ok: false,
                error: "No se encontró el archivo PDF original de este set en Sets/.",
              });
              return;
            }

            const result = await runProcessSet([pdfTarget.target]);
            clearManualCaches();
            const sets = listAvailableSets();
            const updatedSet = sets.find((s) => s.set_number === setNum) || null;
            const failSummary = (result.failed || [])
              .map((f) => `${f.filename}: ${f.reason}`)
              .join(" | ");
            sendJson(res, result.ok ? 200 : 422, {
              ok: result.ok,
              sets,
              set: updatedSet,
              failed: result.failed || [],
              error: result.ok ? "" : failSummary || "No se pudo re-escanear el PDF del set.",
            });
          } catch (err) {
            sendJson(res, 500, { ok: false, error: err.message });
          }
          return;
        }

        if (reqUrl === "/api/upload-pdf" && req.method === "POST") {
          let pdfDest = null;
          let previousPdfBackup = null;
          try {
            const rawName = parsedUrl.searchParams.get("filename") || "nuevo-set.pdf";
            const baseName = path.basename(rawName).replace(/[^a-zA-Z0-9._-]/g, "_");
            const safePdfName = baseName.toLowerCase().endsWith(".pdf")
              ? baseName
              : `${baseName}.pdf`;
            const buf = await readRequestBuffer(req, 200 * 1024 * 1024);
            if (!buf.length) {
              sendJson(res, 400, { ok: false, error: "El archivo PDF está vacío." });
              return;
            }
            if (buf.subarray(0, 5).toString("ascii") !== "%PDF-") {
              sendJson(res, 400, {
                ok: false,
                error: `No se pudo procesar '${safePdfName}': el archivo no es un PDF válido.`,
              });
              return;
            }
            fs.mkdirSync(SETS_DIR, { recursive: true });
            pdfDest = path.join(SETS_DIR, safePdfName);
            if (fs.existsSync(pdfDest)) {
              previousPdfBackup = fs.readFileSync(pdfDest);
            }
            fs.writeFileSync(pdfDest, buf);

            const result = await runProcessSet([pdfDest]);
            if (!result.ok) {
              if (previousPdfBackup !== null) {
                fs.writeFileSync(pdfDest, previousPdfBackup);
              } else if (fs.existsSync(pdfDest)) {
                fs.unlinkSync(pdfDest);
              }
              const reason =
                result.failed?.[0]?.reason ||
                "el PDF no contiene inventario de texto seleccionable o está dañado.";
              sendJson(res, 422, {
                ok: false,
                filename: safePdfName,
                sets: listAvailableSets(),
                error: `No se pudo procesar '${safePdfName}': ${reason}`,
              });
              return;
            }

            clearManualCaches();
            sendJson(res, 200, {
              ok: true,
              filename: safePdfName,
              sets: listAvailableSets(),
              output: result.stdout,
              error: "",
            });
          } catch (err) {
            if (pdfDest) {
              try {
                if (previousPdfBackup !== null) {
                  fs.writeFileSync(pdfDest, previousPdfBackup);
                } else if (fs.existsSync(pdfDest)) {
                  fs.unlinkSync(pdfDest);
                }
              } catch {
                // ignore
              }
            }
            const isTooBig = String(err?.message || "").includes("demasiado grande");
            sendJson(res, isTooBig ? 413 : 500, {
              ok: false,
              error: isTooBig
                ? "El archivo PDF supera el límite máximo permitido de 200 MB."
                : err.message,
            });
          }
          return;
        }

        if (reqUrl === "/api/manual/info" && req.method === "GET") {
          const setNum = sanitizeId(parsedUrl.searchParams.get("set") || "");
          const sourcePdf = parsedUrl.searchParams.get("source") || "";
          if (!setNum) {
            sendJson(res, 400, { ok: false, error: "Falta el número de set." });
            return;
          }
          const resolved = await resolveManualInfo(setNum, sourcePdf);
          if (!resolved.ok) {
            sendJson(res, 404, { ok: false, error: resolved.error });
            return;
          }
          sendJson(res, 200, resolved.payload);
          return;
        }

        if (reqUrl === "/api/manual/pdf" && req.method === "GET") {
          const setNum = sanitizeId(parsedUrl.searchParams.get("set") || "");
          const sourcePdf = parsedUrl.searchParams.get("source") || "";
          if (!setNum) {
            res.statusCode = 400;
            res.end("Missing set");
            return;
          }
          const resolved = await resolveManualInfo(setNum, sourcePdf);
          const safeFilename = resolved.ok ? path.basename(String(resolved.payload.filename || "")) : "";
          const resolvedSets = path.resolve(SETS_DIR);
          const pdfPath = safeFilename ? path.resolve(resolvedSets, safeFilename) : "";
          if (
            !safeFilename ||
            (pdfPath !== resolvedSets && !pdfPath.startsWith(resolvedSets + path.sep)) ||
            !fs.existsSync(pdfPath)
          ) {
            res.statusCode = 404;
            res.end("Manual PDF not found");
            return;
          }
          const headerName = safeFilename.replace(/["\r\n]/g, "_");
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/pdf");
          res.setHeader("Content-Disposition", `inline; filename="${headerName}"`);
          fs.createReadStream(pdfPath).pipe(res);
          return;
        }

        if (reqUrl === "/api/manual/page" && req.method === "GET") {
          const setNum = sanitizeId(parsedUrl.searchParams.get("set") || "");
          const sourcePdf = parsedUrl.searchParams.get("source") || "";
          const page = Math.max(1, Number(parsedUrl.searchParams.get("page") || 1) || 1);
          const scale = Math.max(1.0, Math.min(3.0, Number(parsedUrl.searchParams.get("scale") || 2.0) || 2.0));
          if (!setNum) {
            res.statusCode = 400;
            res.end("Missing set");
            return;
          }
          const cacheKey = `${setNum}::${sourcePdf}::${page}::${scale.toFixed(1)}`;
          const cached = manualPageCache.get(cacheKey);
          if (cached) {
            res.statusCode = 200;
            res.setHeader("Content-Type", "image/png");
            res.end(cached);
            return;
          }
          const args = ["--set", setNum, "--page", String(page), "--scale", scale.toFixed(1)];
          if (sourcePdf) args.push("--source", path.basename(sourcePdf));
          const result = await runManualScript(args, true);
          if (!result.ok || !result.data?.length) {
            res.statusCode = 404;
            res.end(result.error || "PDF page not found");
            return;
          }
          rememberManualPage(cacheKey, result.data);
          res.statusCode = 200;
          res.setHeader("Content-Type", "image/png");
          res.end(result.data);
          return;
        }

        if (reqUrl === "/api/bundle/deps" && req.method === "GET") {
          const setNum = sanitizeId(parsedUrl.searchParams.get("set") || "");
          if (!setNum) {
            sendJson(res, 400, { ok: false, error: "Falta el número de set." });
            return;
          }
          const manifestPath = path.join(OUTPUT_SETS_DIR, `${setNum}.json`);
          if (!fs.existsSync(manifestPath)) {
            sendJson(res, 404, { ok: false, error: "Manifiesto no encontrado." });
            return;
          }
          try {
            const manifestStat = fs.statSync(manifestPath);
            const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
            const coverPath = path.join(OUTPUT_COVERS_DIR, `${setNum}.png`);
            const hasCover = fs.existsSync(coverPath);
            let pdfFilename = manifest.source_pdf ? path.basename(String(manifest.source_pdf)) : "";
            let pdfSize = 0;
            if (pdfFilename) {
              const directPdf = path.join(SETS_DIR, pdfFilename);
              if (fs.existsSync(directPdf)) {
                pdfSize = fs.statSync(directPdf).size;
              } else {
                const resolved = await resolveManualInfo(setNum, pdfFilename);
                if (resolved.ok && resolved.payload?.filename) {
                  pdfFilename = path.basename(String(resolved.payload.filename));
                  const foundPdf = path.join(SETS_DIR, pdfFilename);
                  if (fs.existsSync(foundPdf)) pdfSize = fs.statSync(foundPdf).size;
                }
              }
            }
            const ldrawFiles = collectLDrawDependencies(manifest.parts || []);
            sendJson(res, 200, {
              ok: true,
              set_number: setNum,
              set_name: manifest.set_name || `Set #${setNum}`,
              manifest_file: `${setNum}.json`,
              manifest_size: manifestStat.size,
              has_cover: hasCover,
              cover_size: hasCover ? fs.statSync(coverPath).size : 0,
              pdf_filename: pdfFilename,
              pdf_size: pdfSize,
              ldraw_files: ldrawFiles,
            });
          } catch (err) {
            sendJson(res, 500, { ok: false, error: err.message });
          }
          return;
        }

        if (reqUrl === "/api/bundle/read-pdf" && req.method === "GET") {
          const setNum = sanitizeId(parsedUrl.searchParams.get("set") || "");
          const sourcePdf = parsedUrl.searchParams.get("source") || "";
          const offset = Math.max(0, Number(parsedUrl.searchParams.get("offset") || 0) || 0);
          const length = Math.max(1, Math.min(2 * 1024 * 1024, Number(parsedUrl.searchParams.get("length") || 65536) || 65536));
          const resolved = await resolveManualInfo(setNum, sourcePdf);
          const safeFilename = resolved.ok ? path.basename(String(resolved.payload.filename || "")) : "";
          const resolvedSets = path.resolve(SETS_DIR);
          const pdfPath = safeFilename ? path.resolve(resolvedSets, safeFilename) : "";
          if (!safeFilename || (pdfPath !== resolvedSets && !pdfPath.startsWith(resolvedSets + path.sep)) || !fs.existsSync(pdfPath)) {
            res.statusCode = 404;
            res.end("PDF not found");
            return;
          }
          try {
            const stat = fs.statSync(pdfPath);
            if (offset >= stat.size) {
              res.statusCode = 200;
              res.setHeader("Content-Type", "application/octet-stream");
              res.end(Buffer.alloc(0));
              return;
            }
            const toRead = Math.min(length, stat.size - offset);
            const buf = Buffer.allocUnsafe(toRead);
            const fd = fs.openSync(pdfPath, "r");
            try {
              fs.readSync(fd, buf, 0, toRead, offset);
            } finally {
              fs.closeSync(fd);
            }
            res.statusCode = 200;
            res.setHeader("Content-Type", "application/octet-stream");
            res.end(buf);
          } catch (err) {
            res.statusCode = 500;
            res.end(err.message);
          }
          return;
        }

        if (reqUrl === "/api/bundle/check-missing" && req.method === "POST") {
          try {
            const buf = await readRequestBuffer(req, 8 * 1024 * 1024);
            const body = JSON.parse(buf.toString("utf-8") || "{}");
            const setNum = sanitizeId(body.set_number || "");
            const manifestPath = setNum ? path.join(OUTPUT_SETS_DIR, `${setNum}.json`) : "";
            const needManifest = !manifestPath || !fs.existsSync(manifestPath) ||
              (Number(body.manifest_size) > 0 && fs.statSync(manifestPath).size !== Number(body.manifest_size));
            const coverPath = setNum ? path.join(OUTPUT_COVERS_DIR, `${setNum}.png`) : "";
            const needCover = Boolean(body.has_cover) && (!coverPath || !fs.existsSync(coverPath));

            const safePdf = body.source_pdf ? path.basename(String(body.source_pdf)) : "";
            const pdfPath = safePdf ? path.join(SETS_DIR, safePdf) : "";
            const needPdf = Boolean(safePdf && Number(body.pdf_size) > 0) &&
              (!fs.existsSync(pdfPath) || fs.statSync(pdfPath).size !== Number(body.pdf_size));

            const missingLdraw = [];
            for (const entry of Array.isArray(body.ldraw_files) ? body.ldraw_files : []) {
              const rel = typeof entry === "string" ? entry : entry?.path;
              if (!rel) continue;
              const safe = resolveSafeChild(LDRAW_ROOT, rel);
              if (safe && !fs.existsSync(safe.target)) {
                missingLdraw.push(safe.clean);
              }
            }

            sendJson(res, 200, {
              ok: true,
              need_manifest: needManifest,
              need_cover: needCover,
              need_pdf: needPdf,
              missing_ldraw: missingLdraw,
            });
          } catch (err) {
            sendJson(res, 500, { ok: false, error: err.message });
          }
          return;
        }

        if (reqUrl === "/api/bundle/save-manifest" && req.method === "POST") {
          try {
            const setNum = sanitizeId(parsedUrl.searchParams.get("set") || "");
            if (!setNum) {
              sendJson(res, 400, { ok: false, error: "Set inválido." });
              return;
            }
            const buf = await readRequestBuffer(req, 16 * 1024 * 1024);
            JSON.parse(buf.toString("utf-8"));
            fs.mkdirSync(OUTPUT_SETS_DIR, { recursive: true });
            fs.writeFileSync(path.join(OUTPUT_SETS_DIR, `${setNum}.json`), buf);
            sendJson(res, 200, { ok: true });
          } catch (err) {
            sendJson(res, 500, { ok: false, error: err.message });
          }
          return;
        }

        if (reqUrl === "/api/bundle/save-cover" && req.method === "POST") {
          try {
            const setNum = sanitizeId(parsedUrl.searchParams.get("set") || "");
            if (!setNum) {
              sendJson(res, 400, { ok: false, error: "Set inválido." });
              return;
            }
            const buf = await readRequestBuffer(req, 16 * 1024 * 1024);
            fs.mkdirSync(OUTPUT_COVERS_DIR, { recursive: true });
            fs.writeFileSync(path.join(OUTPUT_COVERS_DIR, `${setNum}.png`), buf);
            sendJson(res, 200, { ok: true });
          } catch (err) {
            sendJson(res, 500, { ok: false, error: err.message });
          }
          return;
        }

        if (reqUrl === "/api/bundle/save-ldraw-batch" && req.method === "POST") {
          try {
            const buf = await readRequestBuffer(req, 32 * 1024 * 1024);
            const body = JSON.parse(buf.toString("utf-8") || "{}");
            let saved = 0;
            for (const item of Array.isArray(body.files) ? body.files : []) {
              const safe = resolveSafeChild(LDRAW_ROOT, item?.path || "");
              if (!safe || typeof item?.data !== "string") continue;
              fs.mkdirSync(path.dirname(safe.target), { recursive: true });
              fs.writeFileSync(safe.target, Buffer.from(item.data, "base64"));
              saved += 1;
            }
            sendJson(res, 200, { ok: true, saved });
          } catch (err) {
            sendJson(res, 500, { ok: false, error: err.message });
          }
          return;
        }

        if (reqUrl === "/api/bundle/save-pdf-chunk" && req.method === "POST") {
          try {
            const rawName = parsedUrl.searchParams.get("filename") || "manual.pdf";
            const baseName = path.basename(rawName).replace(/[^a-zA-Z0-9._-]/g, "_");
            const safePdfName = baseName.toLowerCase().endsWith(".pdf") ? baseName : `${baseName}.pdf`;
            const mode = parsedUrl.searchParams.get("mode") || "append";
            fs.mkdirSync(SETS_DIR, { recursive: true });
            const finalPath = path.join(SETS_DIR, safePdfName);
            const tmpPath = path.join(SETS_DIR, `.${safePdfName}.downloading`);
            const buf = await readRequestBuffer(req, 16 * 1024 * 1024);
            if (mode === "start") {
              fs.writeFileSync(tmpPath, buf);
            } else if (buf.length) {
              fs.appendFileSync(tmpPath, buf);
            }
            if (mode === "finish" || parsedUrl.searchParams.get("done") === "1") {
              if (fs.existsSync(tmpPath)) {
                fs.renameSync(tmpPath, finalPath);
              }
              clearManualCaches();
            }
            sendJson(res, 200, { ok: true });
          } catch (err) {
            sendJson(res, 500, { ok: false, error: err.message });
          }
          return;
        }

        if (reqUrl === "/api/saves" && req.method === "GET") {
          const setNum = parsedUrl.searchParams.get("set") || "";
          sendJson(res, 200, { ok: true, slots: listSetSlots(setNum) });
          return;
        }

        const slotMatch = /^\/api\/saves\/([^/]+)\/(\d+)$/.exec(reqUrl);
        if (slotMatch) {
          const setNum = decodeURIComponent(slotMatch[1]);
          const slotNum = Number(slotMatch[2]);
          const filePath = getSlotFilePath(setNum, slotNum);
          if (!filePath) {
            sendJson(res, 400, { ok: false, error: "Slot o set inválido." });
            return;
          }

          if (req.method === "GET") {
            if (!fs.existsSync(filePath)) {
              sendJson(res, 404, { ok: false, error: "Slot vacío." });
              return;
            }
            try {
              const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
              sendJson(res, 200, { ok: true, save: raw });
            } catch (err) {
              sendJson(res, 500, { ok: false, error: err.message });
            }
            return;
          }

          if (req.method === "PUT") {
            try {
              const buf = await readRequestBuffer(req, 32 * 1024 * 1024);
              const body = JSON.parse(buf.toString("utf-8") || "{}");
              const nowIso = new Date().toISOString();
              fs.mkdirSync(path.dirname(filePath), { recursive: true });

              let existingJson = null;
              if (fs.existsSync(filePath)) {
                try {
                  existingJson = JSON.parse(fs.readFileSync(filePath, "utf-8"));
                } catch {
                  existingJson = null;
                }
              }

              let payload;
              if (body.renameOnly && existingJson) {
                payload = {
                  ...existingJson,
                  name: String(body.name || existingJson.name || `Slot ${slotNum}`).trim() || `Slot ${slotNum}`,
                  updated_at: nowIso,
                };
              } else {
                const existingName = existingJson?.name || null;
                const pieces = Array.isArray(body.pieces) ? body.pieces : [];
                const manualPage = Number(body.manual_page ?? existingJson?.manual_page);
                const rawBoxCount =
                  body.custom_box_count !== undefined
                    ? body.custom_box_count
                    : existingJson?.custom_box_count;
                const customBoxCount = rawBoxCount == null ? null : Number(rawBoxCount);
                payload = {
                  version: "1.0.0",
                  slot: slotNum,
                  set_number: sanitizeId(setNum),
                  name: String(body.name || existingName || `Slot ${slotNum}`).trim() || `Slot ${slotNum}`,
                  updated_at: nowIso,
                  placed_count: pieces.length,
                  ...(Number.isFinite(manualPage) && manualPage >= 1 ? { manual_page: Math.round(manualPage) } : {}),
                  ...(Number.isFinite(customBoxCount) && customBoxCount >= 1
                    ? { custom_box_count: Math.max(1, Math.min(24, Math.round(customBoxCount))) }
                    : {}),
                  pieces,
                  history: Array.isArray(body.history) ? body.history : [],
                };
              }

              fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf-8");
              sendJson(res, 200, {
                ok: true,
                slots: listSetSlots(setNum),
                save: {
                  slot: payload.slot,
                  name: payload.name,
                  updated_at: payload.updated_at,
                  placed_count: payload.placed_count,
                },
              });
            } catch (err) {
              sendJson(res, 500, { ok: false, error: err.message });
            }
            return;
          }

          if (req.method === "DELETE") {
            if (fs.existsSync(filePath)) {
              fs.unlinkSync(filePath);
            }
            sendJson(res, 200, { ok: true, slots: listSetSlots(setNum) });
            return;
          }
        }

        next();
      });

  server.middlewares.use(serveStaticDirectory("/sets/", OUTPUT_SETS_DIR));
  server.middlewares.use(serveStaticDirectory("/covers/", OUTPUT_COVERS_DIR));
  server.middlewares.use(serveStaticDirectory("/ldraw/", LDRAW_ROOT));
}

function localSetsAndLDrawPlugin() {
  return {
    name: "softwarelego-local-assets",
    configureServer(server) {
      attachLocalMiddlewares(server);
    },
    configurePreviewServer(server) {
      attachLocalMiddlewares(server);
    },
  };
}

export default defineConfig({
  plugins: [localSetsAndLDrawPlugin()],
  server: {
    host: "127.0.0.1",
    port: 5173,
  },
});
