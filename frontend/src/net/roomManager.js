import peerjsPkg from "peerjs";

const Peer = peerjsPkg?.Peer || peerjsPkg?.default || peerjsPkg;
import {
  GuestBundleReceiver,
  checkLocalMissingFiles,
  fetchLocalBundleDeps,
  streamBundleToGuest,
} from "./bundleTransfer.js";

export const MAX_ROOM_PLAYERS = 4;
export const PEER_PREFIX = "softwarelego-room-";

export const PLAYER_PALETTE = [
  { id: "blue", label: "Azul", hex: "#38bdf8" },
  { id: "green", label: "Verde", hex: "#22c55e" },
  { id: "amber", label: "Ámbar", hex: "#f59e0b" },
  { id: "violet", label: "Violeta", hex: "#a855f7" },
];

export const ADMIN_ONLY_CONTROLS = Object.freeze([
  "sticker",
  "multiplayer",
  "undo",
  "clear",
  "export",
  "import",
  "save",
]);

export function generateRoomCode(rng = Math.random) {
  const num = 1000000 + Math.floor(rng() * 9000000);
  return String(num);
}

export function normalizeRoomCode(raw) {
  return String(raw || "").replace(/\D/g, "").slice(0, 7);
}

export function isValidRoomCode(raw) {
  return /^\d{7}$/.test(normalizeRoomCode(raw));
}

export function sanitizePlayerName(raw, fallback = "Jugador") {
  const clean = String(raw || "").replace(/\s+/g, " ").trim().slice(0, 22);
  return clean || fallback;
}

/**
 * Estado puro de la sala + reservas por pieza (reutilizable en tests unitarios sin WebRTC).
 */
export class RoomDirectory {
  constructor(hostPeerId = "host", hostName = "Anfitrión") {
    this.hostPeerId = hostPeerId;
    this.players = new Map();
    this.locks = new Map(); // instanceId -> { peerId, color, name }
    this.players.set(hostPeerId, {
      peerId: hostPeerId,
      name: sanitizePlayerName(hostName, "Anfitrión"),
      color: PLAYER_PALETTE[0].hex,
      isHost: true,
    });
  }

  _pickFreeColor() {
    const used = new Set([...this.players.values()].map((p) => p.color));
    const free = PLAYER_PALETTE.find((c) => !used.has(c.hex));
    return free ? free.hex : PLAYER_PALETTE[this.players.size % PLAYER_PALETTE.length].hex;
  }

  canAcceptPeer() {
    return this.players.size < MAX_ROOM_PLAYERS;
  }

  addGuest(peerId, requestedName = "") {
    if (!this.canAcceptPeer()) return null;
    if (this.players.has(peerId)) return this.players.get(peerId);
    const num = this.players.size + 1;
    const player = {
      peerId,
      name: sanitizePlayerName(requestedName, `Amigo ${num - 1}`),
      color: this._pickFreeColor(),
      isHost: false,
    };
    this.players.set(peerId, player);
    return player;
  }

  removePlayer(peerId) {
    if (peerId === this.hostPeerId) return false;
    const existed = this.players.delete(peerId);
    if (existed) this.releaseLocksByPeer(peerId);
    return existed;
  }

  renamePlayer(peerId, name) {
    const player = this.players.get(peerId);
    if (!player) return null;
    player.name = sanitizePlayerName(name, player.name);
    for (const lock of this.locks.values()) {
      if (lock.peerId === peerId) lock.name = player.name;
    }
    return player;
  }

  acquireLocks(peerId, instanceIds) {
    const player = this.players.get(peerId);
    if (!player) return { ok: false, blockedBy: null };
    const ids = Array.isArray(instanceIds) ? instanceIds.filter(Boolean) : [];
    for (const id of ids) {
      const existing = this.locks.get(id);
      if (existing && existing.peerId !== peerId) {
        return { ok: false, blockedBy: existing, instanceId: id };
      }
    }
    for (const id of ids) {
      this.locks.set(id, { peerId, color: player.color, name: player.name });
    }
    return { ok: true, blockedBy: null };
  }

  releaseLocks(peerId, instanceIds) {
    for (const id of Array.isArray(instanceIds) ? instanceIds : []) {
      const existing = this.locks.get(id);
      if (existing && existing.peerId === peerId) {
        this.locks.delete(id);
      }
    }
  }

  releaseLocksByPeer(peerId) {
    for (const [id, lock] of this.locks.entries()) {
      if (lock.peerId === peerId) this.locks.delete(id);
    }
  }

  getRosterArray() {
    return [...this.players.values()];
  }

  getLocksObject() {
    return Object.fromEntries(this.locks.entries());
  }
}

const DEFAULT_ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

/**
 * Orquestador WebRTC P2P (`PeerJS`) para Host autoritativo e Invitados.
 */
export class RoomManager {
  constructor(callbacks = {}) {
    this.callbacks = callbacks;
    this.mode = "closed"; // "closed" | "opening" | "open" | "joining" | "joined"
    this.role = null; // "host" | "guest" | null
    this.roomCode = null;
    this.peer = null;
    this.localPeerId = null;
    this.directory = null;
    this.guestConns = new Map(); // peerId -> DataConnection (en Host)
    this.hostConn = null; // DataConnection (en Guest)
    this.remotePlayers = []; // Roster sincronizado en Guest
    this.remoteLocks = new Map(); // instanceId -> { peerId, color, name }
    this._openCanceled = false;
  }

  isOpen() {
    return this.mode === "open" || this.mode === "joined";
  }

  isHost() {
    return this.role === "host" && this.mode === "open";
  }

  isGuest() {
    return this.role === "guest" && this.mode === "joined";
  }

  getLocalColor() {
    if (this.isHost()) {
      return this.directory?.players.get(this.localPeerId)?.color || PLAYER_PALETTE[0].hex;
    }
    const me = this.remotePlayers.find((p) => p.peerId === this.localPeerId);
    return me?.color || PLAYER_PALETTE[1].hex;
  }

  getPlayers() {
    if (this.isHost() && this.directory) return this.directory.getRosterArray();
    return this.remotePlayers;
  }

  getLockOwner(instanceId) {
    if (!instanceId) return null;
    if (this.isHost() && this.directory) return this.directory.locks.get(instanceId) || null;
    return this.remoteLocks.get(instanceId) || null;
  }

  isLockedByOther(instanceId) {
    const owner = this.getLockOwner(instanceId);
    return owner && owner.peerId !== this.localPeerId ? owner : null;
  }

  _emitState() {
    this.callbacks.onStateChanged?.({
      mode: this.mode,
      role: this.role,
      roomCode: this.roomCode,
      localPeerId: this.localPeerId,
      players: this.getPlayers(),
    });
  }

  async openRoom({ setNumber, hostName = "Admin" } = {}) {
    if (this.mode === "open" || this.mode === "opening") return this.roomCode;
    this.closeRoom();

    this._openCanceled = false;
    this.mode = "opening";
    this.role = "host";
    this._emitState();

    const bundleMeta = await fetchLocalBundleDeps(setNumber);
    this._hostBundleMeta = bundleMeta;

    let attempts = 0;
    while (attempts < 5 && !this._openCanceled) {
      attempts += 1;
      const code = generateRoomCode();
      const peerId = `${PEER_PREFIX}${code}`;
      try {
        const peer = await this._createOpenPeer(peerId);
        if (this._openCanceled) {
          peer.destroy();
          return null;
        }
        this.peer = peer;
        this.localPeerId = peerId;
        this.roomCode = code;
        this.directory = new RoomDirectory(peerId, hostName);
        this.mode = "open";
        this._bindHostPeer(peer);
        this._emitState();
        return code;
      } catch (err) {
        if (err?.type === "unavailable-id" && attempts < 5) continue;
        this.closeRoom();
        throw err;
      }
    }
    this.closeRoom();
    throw new Error("No se pudo reservar un código de sala libre.");
  }

  _createOpenPeer(id) {
    return new Promise((resolve, reject) => {
      const peer = id
        ? new Peer(id, { config: { iceServers: DEFAULT_ICE_SERVERS } })
        : new Peer({ config: { iceServers: DEFAULT_ICE_SERVERS } });
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        peer.destroy();
        reject(new Error("Tiempo de espera agotado conectando al servidor de salas."));
      }, 15000);

      peer.once("open", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(peer);
      });
      peer.once("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        peer.destroy();
        reject(err);
      });
    });
  }

  _bindHostPeer(peer) {
    peer.on("connection", (conn) => {
      this._handleIncomingGuest(conn);
    });
    peer.on("disconnected", () => {
      if (this.mode === "open" && !peer.destroyed) {
        try {
          peer.reconnect();
        } catch {
          // ignore
        }
      }
    });
    peer.on("error", (err) => {
      this.callbacks.onError?.(err?.message || "Error en la sala P2P.");
    });
  }

  _handleIncomingGuest(conn) {
    const guestId = conn.peer;
    conn.on("open", () => {
      if (!this.isHost() || !this.directory.canAcceptPeer()) {
        try {
          conn.send({
            type: "room:rejected",
            reason: !this.isHost()
              ? "La sala fue cerrada."
              : `La sala está llena (máximo ${MAX_ROOM_PLAYERS} jugadores).`,
          });
        } catch {
          // ignore
        }
        setTimeout(() => conn.close(), 120);
        return;
      }

      const metaName = conn.metadata?.name || "";
      const player = this.directory.addGuest(guestId, metaName);
      this.guestConns.set(guestId, conn);

      conn.send({
        type: "room:welcome",
        yourPeerId: guestId,
        roomCode: this.roomCode,
        setMeta: this._hostBundleMeta,
        players: this.directory.getRosterArray(),
        locks: this.directory.getLocksObject(),
      });

      this._broadcastRoster();
      this.callbacks.onPlayerJoined?.(player);
    });

    conn.on("data", (msg) => {
      this._onHostDataFromGuest(guestId, conn, msg);
    });

    const cleanup = () => {
      const existed = this.guestConns.delete(guestId);
      if (existed && this.directory) {
        const left = this.directory.players.get(guestId);
        this.directory.removePlayer(guestId);
        this.callbacks.onRemotePresenceRemoved?.(guestId);
        this._broadcastRoster();
        this._broadcastLocks();
        if (left) this.callbacks.onPlayerLeft?.(left);
      }
    };

    conn.on("close", cleanup);
    conn.on("error", cleanup);
  }

  async _onHostDataFromGuest(guestId, conn, msg) {
    if (!msg || typeof msg !== "object" || !this.isHost()) return;

    if (msg.type === "bundle:request") {
      try {
        await streamBundleToGuest(conn, this._hostBundleMeta, msg);
      } catch (err) {
        if (conn.open) {
          conn.send({ type: "bundle:error", error: err?.message || "Error enviando el set." });
        }
      }
      return;
    }

    if (msg.type === "bundle:ready") {
      const snapshot = this.callbacks.getWorldSnapshot?.();
      if (snapshot && conn.open) {
        conn.send({
          type: "world:snapshot",
          snapshot,
          locks: this.directory.getLocksObject(),
          players: this.directory.getRosterArray(),
        });
      }
      return;
    }

    if (msg.type === "cursor:update" || msg.type === "carry:preview") {
      // Reenviamos presencia a los demás invitados y mostramos en el Host
      const player = this.directory.players.get(guestId);
      const enriched = {
        ...msg,
        peerId: guestId,
        color: player?.color || PLAYER_PALETTE[1].hex,
        name: player?.name || "Amigo",
      };
      this.callbacks.onRemotePresence?.(enriched);
      this._broadcastExcept(guestId, enriched);
      return;
    }

    if (msg.type === "lock:acquire") {
      const res = this.directory.acquireLocks(guestId, msg.instanceIds);
      if (res.ok) {
        this._broadcastLocks();
      }
      if (conn.open && msg.requestId) {
        conn.send({ type: "lock:reply", requestId: msg.requestId, ...res });
      }
      return;
    }

    if (msg.type === "lock:release") {
      this.directory.releaseLocks(guestId, msg.instanceIds);
      this._broadcastLocks();
      return;
    }

    if (msg.type === "lock:release-all") {
      this.directory.releaseLocksByPeer(guestId);
      this._broadcastLocks();
      return;
    }

    // Acciones autorizadas del invitado sobre el mundo del Host
    this.callbacks.onHostActionFromGuest?.(guestId, msg);
  }

  _broadcast(msg) {
    for (const conn of this.guestConns.values()) {
      if (conn.open) {
        try {
          conn.send(msg);
        } catch {
          // ignore
        }
      }
    }
  }

  _broadcastExcept(skipPeerId, msg) {
    for (const [id, conn] of this.guestConns.entries()) {
      if (id === skipPeerId || !conn.open) continue;
      try {
        conn.send(msg);
      } catch {
        // ignore
      }
    }
  }

  _broadcastRoster() {
    if (!this.isHost() || !this.directory) return;
    this._broadcast({
      type: "room:players",
      players: this.directory.getRosterArray(),
    });
    this._emitState();
  }

  _broadcastLocks() {
    if (!this.isHost() || !this.directory) return;
    const locks = this.directory.getLocksObject();
    this._broadcast({ type: "lock:state", locks });
    this.callbacks.onLocksChanged?.(new Map(this.directory.locks));
  }

  renamePlayer(peerId, newName) {
    if (!this.isHost() || !this.directory) return;
    if (this.directory.renamePlayer(peerId, newName)) {
      this._broadcastRoster();
      this._broadcastLocks();
    }
  }

  kickPlayer(peerId) {
    if (!this.isHost() || peerId === this.localPeerId) return;
    const conn = this.guestConns.get(peerId);
    if (conn) {
      try {
        if (conn.open) {
          conn.send({ type: "room:kicked", reason: "El administrador te expulsó de la sala." });
        }
      } catch {
        // ignore
      }
      setTimeout(() => {
        try {
          conn.close();
        } catch {
          // ignore
        }
      }, 60);
      this.guestConns.delete(peerId);
    }
    const left = this.directory?.players.get(peerId);
    this.directory?.removePlayer(peerId);
    this.callbacks.onRemotePresenceRemoved?.(peerId);
    this._broadcastRoster();
    this._broadcastLocks();
    if (left) this.callbacks.onPlayerLeft?.(left);
  }

  closeRoom() {
    this._openCanceled = true;
    if (this.role === "host") {
      this._broadcast({ type: "room:closed", reason: "El administrador cerró la sala." });
      for (const conn of this.guestConns.values()) {
        try {
          conn.close();
        } catch {
          // ignore
        }
      }
      this.guestConns.clear();
    } else if (this.hostConn) {
      try {
        this.hostConn.close();
      } catch {
        // ignore
      }
      this.hostConn = null;
    }

    if (this.peer) {
      try {
        this.peer.destroy();
      } catch {
        // ignore
      }
      this.peer = null;
    }

    this.mode = "closed";
    this.role = null;
    this.roomCode = null;
    this.localPeerId = null;
    this.directory = null;
    this.remotePlayers = [];
    this.remoteLocks.clear();
    this._hostBundleMeta = null;
    this.callbacks.onLocksChanged?.(new Map());
    this.callbacks.onClearRemotePresence?.();
    this._emitState();
  }

  /* ---------------------------------------------------------------- */
  /* Flujo del Invitado                                                */
  /* ---------------------------------------------------------------- */

  async joinRoom({ code, playerName = "", onProgress } = {}) {
    const cleanCode = normalizeRoomCode(code);
    if (!isValidRoomCode(cleanCode)) {
      throw new Error("El código debe tener exactamente 7 dígitos.");
    }
    this.closeRoom();

    this.mode = "joining";
    this.role = "guest";
    this.roomCode = cleanCode;
    this._emitState();

    let peer;
    try {
      peer = await this._createOpenPeer(null);
    } catch (err) {
      this.closeRoom();
      throw new Error(err?.message || "No se pudo iniciar la conexión P2P.");
    }
    this.peer = peer;
    this.localPeerId = peer.id;

    return new Promise((resolve, reject) => {
      let settled = false;
      let receiver = null;
      let welcomeMeta = null;
      const pendingLockReplies = new Map();

      const fail = (message) => {
        if (settled) return;
        settled = true;
        this.closeRoom();
        reject(new Error(message));
      };

      const connectTimer = setTimeout(() => {
        fail("No se encontró ninguna sala abierta con ese código (revisá el código o la red).");
      }, 18000);

      const conn = peer.connect(`${PEER_PREFIX}${cleanCode}`, {
        reliable: true,
        metadata: { name: sanitizePlayerName(playerName, "") },
      });
      this.hostConn = conn;
      this._pendingGuestLockReplies = pendingLockReplies;

      peer.on("error", (err) => {
        const msg =
          err?.type === "peer-unavailable"
            ? "No existe ninguna sala abierta con ese código."
            : err?.message || "Error conectando a la sala.";
        if (!settled) {
          clearTimeout(connectTimer);
          fail(msg);
        } else if (this.isGuest()) {
          this.callbacks.onError?.(msg);
        }
      });

      conn.on("data", async (msg) => {
        if (!msg || typeof msg !== "object") return;

        if (msg.type === "room:rejected") {
          clearTimeout(connectTimer);
          fail(msg.reason || "No se pudo entrar a la sala.");
          return;
        }

        if (msg.type === "room:welcome") {
          clearTimeout(connectTimer);
          this.localPeerId = msg.yourPeerId;
          welcomeMeta = msg.setMeta;
          this.remotePlayers = msg.players || [];
          this.remoteLocks = new Map(Object.entries(msg.locks || {}));
          this._emitState();

          try {
            onProgress?.(0, 100, "Verificando archivos locales del set...");
            const missing = await checkLocalMissingFiles(welcomeMeta);
            const needsDownload =
              missing.need_manifest ||
              missing.need_cover ||
              missing.need_pdf ||
              (missing.missing_ldraw || []).length > 0;

            if (!needsDownload) {
              onProgress?.(100, 100, "Set ya disponible. Sincronizando mesa...");
              conn.send({ type: "bundle:ready" });
            } else {
              receiver = new GuestBundleReceiver(welcomeMeta, missing, onProgress);
              conn.send({ type: "bundle:request", ...missing });
            }
          } catch (err) {
            fail(err?.message || "Error preparando descarga del set.");
          }
          return;
        }

        if (msg.type === "bundle:chunk") {
          receiver?.handleChunk(msg);
          return;
        }

        if (msg.type === "bundle:pdf-chunk") {
          receiver?.handlePdfChunk(msg);
          return;
        }

        if (msg.type === "bundle:error") {
          fail(msg.error || "El anfitrión no pudo enviar los archivos del set.");
          return;
        }

        if (msg.type === "bundle:transfer-complete") {
          try {
            if (receiver) {
              onProgress?.(98, 100, "Guardando set en tu biblioteca local...");
              await receiver.finalize();
            }
            onProgress?.(100, 100, "Abriendo mesa compartida...");
            conn.send({ type: "bundle:ready" });
          } catch (err) {
            fail(err?.message || "Error guardando los archivos descargados.");
          }
          return;
        }

        if (msg.type === "world:snapshot") {
          this.mode = "joined";
          this.remotePlayers = msg.players || this.remotePlayers;
          this.remoteLocks = new Map(Object.entries(msg.locks || {}));
          this._emitState();
          if (!settled) {
            settled = true;
            resolve({
              setMeta: welcomeMeta,
              snapshot: msg.snapshot,
              roomCode: cleanCode,
            });
          } else {
            this.callbacks.onGuestWorldSnapshot?.(msg.snapshot);
          }
          return;
        }

        if (msg.type === "room:players") {
          this.remotePlayers = msg.players || [];
          this._emitState();
          return;
        }

        if (msg.type === "lock:state") {
          this.remoteLocks = new Map(Object.entries(msg.locks || {}));
          this.callbacks.onLocksChanged?.(new Map(this.remoteLocks));
          return;
        }

        if (msg.type === "lock:reply" && msg.requestId) {
          const resolver = pendingLockReplies.get(msg.requestId);
          if (resolver) {
            pendingLockReplies.delete(msg.requestId);
            resolver(msg);
          }
          return;
        }

        if (msg.type === "room:kicked" || msg.type === "room:closed") {
          const reason = msg.reason || "La sala se cerró.";
          this.closeRoom();
          this.callbacks.onKickedOrClosed?.(reason);
          return;
        }

        if (msg.type === "cursor:update" || msg.type === "carry:preview") {
          if (msg.peerId !== this.localPeerId) {
            this.callbacks.onRemotePresence?.(msg);
          }
          return;
        }

        this.callbacks.onGuestWorldEvent?.(msg);
      });

      const handleDrop = () => {
        if (!settled) {
          clearTimeout(connectTimer);
          fail("Se perdió la conexión con la sala.");
        } else if (this.isGuest()) {
          this.closeRoom();
          this.callbacks.onKickedOrClosed?.("Se perdió la conexión con el anfitrión.");
        }
      };
      conn.on("close", handleDrop);
      conn.on("error", handleDrop);
    });
  }

  /* ---------------------------------------------------------------- */
  /* Mensajes en tiempo real (Host y Guest)                            */
  /* ---------------------------------------------------------------- */

  sendPresence(msg) {
    if (this.isHost()) {
      const me = this.directory?.players.get(this.localPeerId);
      this._broadcast({
        ...msg,
        peerId: this.localPeerId,
        color: me?.color || PLAYER_PALETTE[0].hex,
        name: me?.name || "Anfitrión",
      });
    } else if (this.isGuest() && this.hostConn?.open) {
      this.hostConn.send(msg);
    }
  }

  broadcastWorldEvent(msg) {
    if (!this.isHost()) return;
    this._broadcast(msg);
  }

  sendGuestAction(msg) {
    if (!this.isGuest() || !this.hostConn?.open) return;
    this.hostConn.send(msg);
  }

  async requestLock(instanceIds) {
    const ids = Array.isArray(instanceIds) ? instanceIds.filter(Boolean) : [];
    if (!ids.length || !this.isOpen()) return { ok: true };
    if (this.isHost()) {
      const res = this.directory.acquireLocks(this.localPeerId, ids);
      if (res.ok) this._broadcastLocks();
      return res;
    }
    if (!this.hostConn?.open) return { ok: false };
    const requestId = `lk_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this._pendingGuestLockReplies?.delete(requestId);
        resolve({ ok: false, timeout: true });
      }, 2500);
      this._pendingGuestLockReplies?.set(requestId, (reply) => {
        clearTimeout(timer);
        resolve(reply);
      });
      this.hostConn.send({ type: "lock:acquire", requestId, instanceIds: ids });
    });
  }

  releaseLocks(instanceIds) {
    if (!this.isOpen()) return;
    if (this.isHost()) {
      this.directory.releaseLocks(this.localPeerId, instanceIds);
      this._broadcastLocks();
    } else if (this.hostConn?.open) {
      this.hostConn.send({ type: "lock:release", instanceIds });
    }
  }

  releaseAllMyLocks() {
    if (!this.isOpen()) return;
    if (this.isHost()) {
      this.directory.releaseLocksByPeer(this.localPeerId);
      this._broadcastLocks();
    } else if (this.hostConn?.open) {
      this.hostConn.send({ type: "lock:release-all" });
    }
  }
}
