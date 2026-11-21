export const CHUNK_BYTE_SIZE = 48 * 1024;
const MAX_BUFFERED_AMOUNT = 512 * 1024;
const PDF_READ_SLICE = 256 * 1024;

function arrayBufferToBase64(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

async function waitForBufferDrain(conn) {
  const dc = conn?.dataChannel;
  if (!dc || dc.bufferedAmount <= MAX_BUFFERED_AMOUNT) return;
  await new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      resolve();
    };
    const timer = setInterval(() => {
      if (!conn.open || !dc || dc.bufferedAmount <= MAX_BUFFERED_AMOUNT / 2) {
        done();
      }
    }, 15);
    setTimeout(done, 4000);
  });
}

async function sendChunkedBytes(conn, transferId, kind, extraMeta, bytes, onChunkSent) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const totalBytes = view.byteLength;
  const totalChunks = Math.max(1, Math.ceil(totalBytes / CHUNK_BYTE_SIZE));

  for (let i = 0; i < totalChunks; i += 1) {
    if (!conn.open) throw new Error("Conexión cerrada durante la transferencia.");
    const start = i * CHUNK_BYTE_SIZE;
    const end = Math.min(totalBytes, start + CHUNK_BYTE_SIZE);
    const slice = view.slice(start, end);
    await waitForBufferDrain(conn);
    conn.send({
      type: "bundle:chunk",
      transferId,
      kind,
      ...extraMeta,
      chunkIndex: i,
      totalChunks,
      isLast: i === totalChunks - 1,
      data: slice.buffer,
    });
    onChunkSent?.(end - start);
  }
}

export async function fetchLocalBundleDeps(setNumber) {
  const resp = await fetch(`/api/bundle/deps?set=${encodeURIComponent(setNumber)}`);
  const data = await resp.json();
  if (!resp.ok || !data.ok) {
    throw new Error(data.error || "No se pudieron obtener las dependencias del set.");
  }
  return data;
}

export async function checkLocalMissingFiles(meta) {
  const resp = await fetch("/api/bundle/check-missing", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      set_number: meta.set_number,
      manifest_size: meta.manifest_size,
      has_cover: meta.has_cover,
      source_pdf: meta.pdf_filename,
      pdf_size: meta.pdf_size,
      ldraw_files: meta.ldraw_files || [],
    }),
  });
  const data = await resp.json();
  if (!resp.ok || !data.ok) {
    throw new Error(data.error || "No se pudo verificar los archivos locales.");
  }
  return data;
}

/**
 * Envía los archivos solicitados por un invitado desde la PC del Host en bloques pequeños.
 */
export async function streamBundleToGuest(conn, meta, req) {
  const setNum = meta.set_number;
  const transferId = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

  if (req.need_manifest) {
    const resp = await fetch(`/sets/${encodeURIComponent(meta.manifest_file)}`);
    if (!resp.ok) throw new Error("No se pudo leer el manifiesto local del set.");
    const buf = await resp.arrayBuffer();
    await sendChunkedBytes(conn, `${transferId}_m`, "manifest", { set_number: setNum }, buf);
  }

  if (req.need_cover && meta.has_cover) {
    const resp = await fetch(`/covers/${encodeURIComponent(setNum)}.png`);
    if (resp.ok) {
      const buf = await resp.arrayBuffer();
      await sendChunkedBytes(conn, `${transferId}_c`, "cover", { set_number: setNum }, buf);
    }
  }

  const missingLdraw = Array.isArray(req.missing_ldraw) ? req.missing_ldraw : [];
  for (let i = 0; i < missingLdraw.length; i += 1) {
    if (!conn.open) return;
    const relPath = missingLdraw[i];
    const encodedPath = relPath.split("/").map(encodeURIComponent).join("/");
    const resp = await fetch(`/ldraw/${encodedPath}`);
    if (!resp.ok) continue;
    const buf = await resp.arrayBuffer();
    await sendChunkedBytes(
      conn,
      `${transferId}_d_${i}`,
      "ldraw",
      { path: relPath, totalFiles: missingLdraw.length, fileIndex: i },
      buf
    );
  }

  if (req.need_pdf && meta.pdf_filename && meta.pdf_size > 0) {
    let offset = 0;
    let chunkSeq = 0;
    while (offset < meta.pdf_size) {
      if (!conn.open) return;
      const len = Math.min(PDF_READ_SLICE, meta.pdf_size - offset);
      const q = new URLSearchParams({
        set: setNum,
        source: meta.pdf_filename,
        offset: String(offset),
        length: String(len),
      });
      const resp = await fetch(`/api/bundle/read-pdf?${q.toString()}`);
      if (!resp.ok) throw new Error("Error leyendo el manual PDF local para enviarlo.");
      const sliceBuf = new Uint8Array(await resp.arrayBuffer());
      if (!sliceBuf.byteLength) break;

      // Dividimos cada lectura de 256 KB en sub-chunks de 48 KB para el DataChannel
      for (let sub = 0; sub < sliceBuf.byteLength; sub += CHUNK_BYTE_SIZE) {
        if (!conn.open) return;
        const end = Math.min(sliceBuf.byteLength, sub + CHUNK_BYTE_SIZE);
        const subSlice = sliceBuf.slice(sub, end);
        const globalEnd = offset + end;
        await waitForBufferDrain(conn);
        conn.send({
          type: "bundle:pdf-chunk",
          filename: meta.pdf_filename,
          seq: chunkSeq++,
          isFirst: offset === 0 && sub === 0,
          isLast: globalEnd >= meta.pdf_size,
          totalSize: meta.pdf_size,
          receivedEnd: globalEnd,
          data: subSlice.buffer,
        });
      }
      offset += sliceBuf.byteLength;
    }
  }

  if (conn.open) {
    conn.send({ type: "bundle:transfer-complete", set_number: setNum });
  }
}

/**
 * Reensambla chunks pequeños en memoria para manifest, cover o .dat individuales.
 */
export class ChunkAccumulator {
  constructor() {
    this._buffers = new Map();
  }

  push(msg) {
    const id = msg.transferId;
    let entry = this._buffers.get(id);
    if (!entry) {
      entry = {
        chunks: new Array(msg.totalChunks || 1),
        received: 0,
        total: msg.totalChunks || 1,
        meta: msg,
      };
      this._buffers.set(id, entry);
    }
    if (!entry.chunks[msg.chunkIndex]) {
      entry.chunks[msg.chunkIndex] = new Uint8Array(msg.data);
      entry.received += 1;
    }
    if (entry.received < entry.total) return null;

    this._buffers.delete(id);
    const totalLen = entry.chunks.reduce((acc, c) => acc + (c?.byteLength || 0), 0);
    const out = new Uint8Array(totalLen);
    let pos = 0;
    for (const c of entry.chunks) {
      if (!c) continue;
      out.set(c, pos);
      pos += c.byteLength;
    }
    return { meta: entry.meta, bytes: out };
  }
}

/**
 * Recibe archivos del Host y los persiste en el disco local del invitado vía Vite API.
 */
export class GuestBundleReceiver {
  constructor(meta, missingReq, onProgress) {
    this.meta = meta;
    this.missingReq = missingReq;
    this.onProgress = onProgress || (() => {});
    this.acc = new ChunkAccumulator();
    this._ldrawBatch = [];
    this._queue = Promise.resolve();

    const sizeMap = new Map((meta.ldraw_files || []).map((f) => [f.path, f.size || 0]));
    const missingLdrawBytes = (missingReq.missing_ldraw || []).reduce(
      (s, p) => s + (sizeMap.get(p) || 1024),
      0
    );
    this.totalExpectedBytes =
      (missingReq.need_manifest ? meta.manifest_size || 0 : 0) +
      (missingReq.need_cover ? meta.cover_size || 0 : 0) +
      missingLdrawBytes +
      (missingReq.need_pdf ? meta.pdf_size || 0 : 0);
    this.doneBytes = 0;
    this._pdfFlushBuf = [];
    this._pdfFlushSize = 0;
  }

  _enqueue(fn) {
    this._queue = this._queue.then(fn);
    return this._queue;
  }

  async _flushLdrawBatch() {
    if (!this._ldrawBatch.length) return;
    const files = this._ldrawBatch.splice(0, this._ldrawBatch.length);
    const resp = await fetch("/api/bundle/save-ldraw-batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ files }),
    });
    if (!resp.ok) throw new Error("Error guardando piezas LDraw recibidas.");
  }

  async _flushPdfBuffer(filename, isFirst, isLast) {
    if (!this._pdfFlushBuf.length && !isLast) return;
    const totalLen = this._pdfFlushBuf.reduce((a, b) => a + b.byteLength, 0);
    const merged = new Uint8Array(totalLen);
    let pos = 0;
    for (const part of this._pdfFlushBuf) {
      merged.set(part, pos);
      pos += part.byteLength;
    }
    this._pdfFlushBuf = [];
    this._pdfFlushSize = 0;

    const mode = isFirst && isLast ? "start" : isFirst ? "start" : isLast ? "finish" : "append";
    const doneFlag = isLast ? "1" : "0";
    const q = new URLSearchParams({
      filename,
      mode,
      done: doneFlag,
    });
    const resp = await fetch(`/api/bundle/save-pdf-chunk?${q.toString()}`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: merged,
    });
    if (!resp.ok) throw new Error("Error guardando el manual PDF en Sets/.");
  }

  handleChunk(msg) {
    const completed = this.acc.push(msg);
    if (!completed) return;
    const { meta, bytes } = completed;
    this._enqueue(async () => {
      if (meta.kind === "manifest") {
        await fetch(`/api/bundle/save-manifest?set=${encodeURIComponent(this.meta.set_number)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: bytes,
        });
        this.doneBytes += bytes.byteLength;
        this.onProgress(this.doneBytes, this.totalExpectedBytes, "Descargando catálogo del set...");
      } else if (meta.kind === "cover") {
        await fetch(`/api/bundle/save-cover?set=${encodeURIComponent(this.meta.set_number)}`, {
          method: "POST",
          headers: { "Content-Type": "image/png" },
          body: bytes,
        });
        this.doneBytes += bytes.byteLength;
        this.onProgress(this.doneBytes, this.totalExpectedBytes, "Descargando portada del set...");
      } else if (meta.kind === "ldraw") {
        this._ldrawBatch.push({
          path: meta.path,
          data: arrayBufferToBase64(bytes),
        });
        if (this._ldrawBatch.length >= 25) {
          await this._flushLdrawBatch();
        }
        this.doneBytes += bytes.byteLength;
        this.onProgress(
          this.doneBytes,
          this.totalExpectedBytes,
          `Descargando piezas 3D (${(meta.fileIndex || 0) + 1}/${meta.totalFiles || 1})...`
        );
      }
    });
  }

  handlePdfChunk(msg) {
    const chunk = new Uint8Array(msg.data);
    this._enqueue(async () => {
      await this._flushLdrawBatch();
      const wasEmptyAndFirst = msg.isFirst;
      this._pdfFlushBuf.push(chunk);
      this._pdfFlushSize += chunk.byteLength;
      this.doneBytes += chunk.byteLength;

      // Acumula ~1 MB por POST HTTP para no saturar Vite con miles de requests chicos
      if (this._pdfFlushSize >= 1024 * 1024 || msg.isLast) {
        const mbDone = (this.doneBytes / (1024 * 1024)).toFixed(1);
        const mbTot = Math.max(0.1, this.totalExpectedBytes / (1024 * 1024)).toFixed(1);
        this.onProgress(
          this.doneBytes,
          this.totalExpectedBytes,
          `Descargando set y manual PDF (${mbDone} / ${mbTot} MB)...`
        );
        await this._flushPdfBuffer(
          msg.filename,
          wasEmptyAndFirst || this._firstPdfPostPending !== false,
          Boolean(msg.isLast)
        );
        this._firstPdfPostPending = false;
      }
    });
  }

  async finalize() {
    await this._enqueue(async () => {
      await this._flushLdrawBatch();
      if (this._pdfFlushBuf.length > 0) {
        await this._flushPdfBuffer(this.meta.pdf_filename, false, true);
      }
    });
  }
}
