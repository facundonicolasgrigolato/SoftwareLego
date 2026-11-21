/**
 * Modal de gestión de Sala Multijugador (exclusivo del Administrador del slot):
 * - Abrir / Cerrar sala (genera código único de 7 dígitos al abrir)
 * - Copiar código para pasarlo a amigos
 * - Lista de hasta 4 jugadores con color, edición de nombre y botón X para expulsar
 */
export class RoomModal {
  constructor(elements, handlers = {}) {
    this.backdropEl = elements.backdropEl;
    this.closeBtnEl = elements.closeBtnEl;
    this.statusBadgeEl = elements.statusBadgeEl;
    this.toggleBtnEl = elements.toggleBtnEl;
    this.codeSectionEl = elements.codeSectionEl;
    this.codeTextEl = elements.codeTextEl;
    this.copyBtnEl = elements.copyBtnEl;
    this.playersCountEl = elements.playersCountEl;
    this.playersListEl = elements.playersListEl;
    this.hintEl = elements.hintEl;

    this.handlers = handlers;
    this.state = {
      mode: "closed",
      role: null,
      roomCode: null,
      localPeerId: null,
      players: [],
    };
    this._busy = false;
    this._bindEvents();
  }

  _bindEvents() {
    this.closeBtnEl?.addEventListener("click", () => this.hide());
    this.backdropEl?.addEventListener("click", (ev) => {
      if (ev.target === this.backdropEl) this.hide();
    });

    this.toggleBtnEl?.addEventListener("click", async () => {
      if (this._busy) return;
      this._busy = true;
      this.toggleBtnEl.disabled = true;
      try {
        if (this.state.mode === "open") {
          await this.handlers.onCloseRoom?.();
        } else {
          await this.handlers.onOpenRoom?.();
        }
      } finally {
        this._busy = false;
        this.toggleBtnEl.disabled = false;
        this.render();
      }
    });

    this.copyBtnEl?.addEventListener("click", async () => {
      if (!this.state.roomCode) return;
      try {
        await navigator.clipboard.writeText(this.state.roomCode);
        this.handlers.onToast?.(`Código ${this.state.roomCode} copiado.`);
      } catch {
        this.handlers.onToast?.(`Código de sala: ${this.state.roomCode}`);
      }
    });
  }

  isOpen() {
    return Boolean(this.backdropEl && !this.backdropEl.classList.contains("hidden"));
  }

  show() {
    this.backdropEl?.classList.remove("hidden");
    this.render();
  }

  hide() {
    this.backdropEl?.classList.add("hidden");
  }

  setState(nextState) {
    this.state = { ...this.state, ...nextState };
    this.render();
  }

  render() {
    if (!this.backdropEl) return;
    const isRoomOpen = this.state.mode === "open";
    const isOpening = this.state.mode === "opening";

    if (this.statusBadgeEl) {
      this.statusBadgeEl.textContent = isOpening
        ? "Abriendo sala..."
        : isRoomOpen
          ? "Sala abierta"
          : "Sala cerrada";
      this.statusBadgeEl.className = `room-status-pill${isRoomOpen ? " is-open" : ""}`;
    }

    if (this.toggleBtnEl) {
      this.toggleBtnEl.textContent = isOpening
        ? "Conectando..."
        : isRoomOpen
          ? "Cerrar sala"
          : "Abrir sala";
      this.toggleBtnEl.className = `btn ${isRoomOpen ? "btn-danger" : "btn-primary"}`;
    }

    this.codeSectionEl?.classList.toggle("hidden", !isRoomOpen || !this.state.roomCode);
    if (this.codeTextEl && this.state.roomCode) {
      this.codeTextEl.textContent = this.state.roomCode;
    }

    const players = Array.isArray(this.state.players) ? this.state.players : [];
    if (this.playersCountEl) {
      this.playersCountEl.textContent = `${isRoomOpen ? players.length : 1} / 4`;
    }

    if (this.hintEl) {
      this.hintEl.textContent = isRoomOpen
        ? "Pasá el código de 7 dígitos a tus amigos. Si cerrás la sala se desconectan todos y la próxima vez se genera un código nuevo."
        : "En sala cerrada jugás solo como siempre. Al abrirla se genera un código de 7 dígitos para hasta 4 personas.";
    }

    if (!this.playersListEl) return;
    this.playersListEl.innerHTML = "";
    if (!isRoomOpen) {
      const empty = document.createElement("div");
      empty.className = "room-empty-note";
      empty.textContent = "Abrí la sala para ver y administrar a los jugadores conectados.";
      this.playersListEl.appendChild(empty);
      return;
    }

    for (const player of players) {
      const row = document.createElement("div");
      row.className = "room-player-row";

      const dot = document.createElement("span");
      dot.className = "room-player-dot";
      dot.style.backgroundColor = player.color || "#38bdf8";

      const nameInput = document.createElement("input");
      nameInput.type = "text";
      nameInput.className = "room-player-name-input";
      nameInput.value = player.name || "Jugador";
      nameInput.maxLength = 22;
      nameInput.title = "Editar nombre visible";
      nameInput.addEventListener("change", () => {
        this.handlers.onRenamePlayer?.(player.peerId, nameInput.value);
      });
      nameInput.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") {
          ev.preventDefault();
          nameInput.blur();
        }
      });

      const roleTag = document.createElement("span");
      roleTag.className = `room-player-role${player.isHost ? " is-host" : ""}`;
      roleTag.textContent = player.isHost ? "Admin" : "Amigo";

      row.append(dot, nameInput, roleTag);

      if (!player.isHost) {
        const kickBtn = document.createElement("button");
        kickBtn.type = "button";
        kickBtn.className = "room-kick-btn";
        kickBtn.textContent = "✕";
        kickBtn.title = `Expulsar a ${player.name || "jugador"}`;
        kickBtn.addEventListener("click", () => {
          this.handlers.onKickPlayer?.(player.peerId);
        });
        row.appendChild(kickBtn);
      }

      this.playersListEl.appendChild(row);
    }
  }
}
