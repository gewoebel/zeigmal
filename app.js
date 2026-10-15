import { firebaseConfig, firebaseIsConfigured } from "./firebase-config.js";

const FIREBASE_VERSION = "13.0.0";
const FIREBASE_BASE = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}`;

const MIN_PLAYERS = 3;
const MAX_PLAYERS = 8;
const PROMPT_MS = 5000;
const PHOTO_MS = 30000;
const RESULTS_MS = 5000;
const ROOM_TTL = 6 * 60 * 60 * 1000;
const MAX_IMAGE_CHARS = 180000;
const MAX_FILE_BYTES = 8 * 1024 * 1024;

const appRoot = document.querySelector("#app");
const modalRoot = document.querySelector("#modal-root");
const roomPill = document.querySelector("#room-pill");
const roomCodeSmall = document.querySelector("#room-code-small");
const connectionDot = document.querySelector("#connection-dot");
const offlineBanner = document.querySelector("#offline-banner");
const scoreButton = document.querySelector("#score-button");
const confettiCanvas = document.querySelector("#confetti");

const state = {
  uid: null,
  roomCode: null,
  room: null,
  db: null,
  auth: null,
  api: null,
  roomUnsub: null,
  connectionUnsub: null,
  timerId: null,
  pausedTimerId: null,
  serverOffset: 0,
  phaseTransitioning: false,
  online: navigator.onLine,
  draftPrompt: "",
  draftRound: null,
  imageData: "",
  imageType: "image/jpeg",
  imageUploading: false,
  confettiRound: null,
  galleryRound: null,
  galleryLoading: false,
  signals: false
};

const $ = (selector, parent = document) => parent.querySelector(selector);
const $$ = (selector, parent = document) => [...parent.querySelectorAll(selector)];
const clone = (id) => document.querySelector(id).content.cloneNode(true);
const serverNow = () => Date.now() + state.serverOffset;
const roomRef = (path = "") =>
  state.api.ref(state.db, `rooms/${state.roomCode}${path ? `/${path}` : ""}`);
const photosRef = (round = state.room?.round, path = "") =>
  state.api.ref(state.db, `photos/${state.roomCode}/${round}${path ? `/${path}` : ""}`);

const isHost = () => Boolean(state.room && state.uid === state.room.hostId);
const isDeputy = () => Boolean(state.room && state.uid === state.room.deputyId);
const isPromptGiver = () => Boolean(state.room && state.uid === state.room.promptGiverId);

const cleanName = (value) => value.trim().replace(/\s+/g, " ").slice(0, 24);
const cleanPrompt = (value) => value.trim().replace(/\s+/g, " ").slice(0, 80);

function setScreen(fragment) {
  clearTimers();
  appRoot.replaceChildren(fragment);
  appRoot.focus({ preventScroll: true });
  window.scrollTo({ top: 0, behavior: "instant" });
}

function clearTimers() {
  clearInterval(state.timerId);
  clearInterval(state.pausedTimerId);
  state.timerId = null;
  state.pausedTimerId = null;
}

function setConnection(online) {
  state.online = online;
  connectionDot.classList.toggle("online", online);
  connectionDot.classList.toggle("offline", !online);
  connectionDot.setAttribute("aria-label", online ? "Verbunden" : "Nicht verbunden");
  offlineBanner.hidden = online;
}

function showHome() {
  const view = clone("#home-template");
  const note = $("#setup-note", view);

  if (!firebaseIsConfigured) {
    note.hidden = false;
    note.textContent = "Vor dem ersten Mehrspieler-Test muss Firebase eingerichtet werden.";
  }

  setScreen(view);
  roomPill.hidden = true;
  scoreButton.hidden = true;
}

function showEntry(mode) {
  if (!firebaseIsConfigured) {
    showSetupModal();
    return;
  }

  const view = clone("#name-template");
  const joining = mode === "join";

  $("#form-eyebrow", view).textContent = joining ? "Mitspielen" : "Neues Spiel";
  $("#form-title", view).textContent = joining ? "Code und Name" : "Wie heißt du?";
  $("#code-field", view).hidden = !joining;
  $("#entry-form", view).dataset.mode = mode;

  setScreen(view);
  setTimeout(() => $(joining ? "#room-code" : "#player-name")?.focus(), 80);
}

function showSetupModal() {
  showModal(
    "Firebase fehlt noch",
    "<p>Trage zuerst die Werte deines Firebase-Projekts in <strong>firebase-config.js</strong> ein.</p>",
    [{ label: "Verstanden", className: "button-primary", action: closeModal }]
  );
}

async function initFirebase() {
  if (!firebaseIsConfigured) {
    connectionDot.classList.remove("online", "offline");
    connectionDot.setAttribute("aria-label", "Firebase noch nicht eingerichtet");
    offlineBanner.hidden = true;
    showHome();
    return;
  }

  try {
    const appApi = await import(`${FIREBASE_BASE}/firebase-app.js`);
    const authApi = await import(`${FIREBASE_BASE}/firebase-auth.js`);
    const dbApi = await import(`${FIREBASE_BASE}/firebase-database.js`);

    state.api = { ...appApi, ...authApi, ...dbApi };

    const firebaseApp = appApi.initializeApp(firebaseConfig);
    state.auth = authApi.getAuth(firebaseApp);
    state.db = dbApi.getDatabase(firebaseApp);

    try {
      await authApi.setPersistence(state.auth, authApi.browserLocalPersistence);
    } catch (_) {}

    dbApi.onValue(dbApi.ref(state.db, ".info/serverTimeOffset"), (snapshot) => {
      state.serverOffset = snapshot.val() || 0;
    });

    dbApi.onValue(dbApi.ref(state.db, ".info/connected"), (snapshot) => {
      setConnection(snapshot.val() === true);
    });

    authApi.onAuthStateChanged(state.auth, async (user) => {
      try {
        if (!user) {
          await authApi.signInAnonymously(state.auth);
          return;
        }
        state.uid = user.uid;
        await restoreSession();
      } catch (error) {
        console.error(error);
        showHome();
        showFatal("Verbindung nicht möglich", error);
      }
    });
  } catch (error) {
    console.error(error);
    showHome();
    showFatal("Firebase konnte nicht geladen werden", error);
  }
}

async function restoreSession() {
  const { get, ref, remove } = state.api;
  const sessionSnapshot = await get(ref(state.db, `sessions/${state.uid}`));
  const code = sessionSnapshot.val()?.roomCode;

  if (!code) {
    showHome();
    return;
  }

  const roomSnapshot = await get(ref(state.db, `rooms/${code}`));
  const room = roomSnapshot.val();
  const expired = room && serverNow() - (room.lastActivity || room.createdAt || 0) > ROOM_TTL;

  if (!room || !room.players?.[state.uid] || expired) {
    await remove(ref(state.db, `sessions/${state.uid}`));
    showHome();
    return;
  }

  connectToRoom(code);
}

async function createRoom(name) {
  const { ref, runTransaction, set } = state.api;
  const now = serverNow();
  let code = "";
  let committed = false;

  for (let attempt = 0; attempt < 30 && !committed; attempt += 1) {
    code = String(Math.floor(1000 + Math.random() * 9000));

    const newRoom = {
      hostId: state.uid,
      deputyId: "",
      status: "lobby",
      paused: false,
      createdAt: now,
      lastActivity: now,
      round: 0,
      maxPlayers: MAX_PLAYERS,
      turnIndex: null,
      promptGiverId: null,
      prompt: null,
      phaseEndsAt: null,
      winners: null,
      submissions: null,
      players: {
        [state.uid]: {
          name,
          score: 0,
          online: true,
          joinedAt: now,
          lastSeen: now
        }
      }
    };

    const result = await runTransaction(
      ref(state.db, `rooms/${code}`),
      (current) =>
        current === null || now - (current.lastActivity || current.createdAt || 0) > ROOM_TTL
          ? newRoom
          : undefined,
      { applyLocally: false }
    );

    committed = result.committed;
  }

  if (!committed) {
    throw new Error("Es konnte kein freier Spielcode erzeugt werden.");
  }

  await set(ref(state.db, `sessions/${state.uid}`), { roomCode: code });
  connectToRoom(code);
}

async function joinRoom(code, name) {
  const { get, ref, set } = state.api;
  const normalized = code.replace(/\D/g, "").slice(0, 4);

  if (normalized.length !== 4) {
    throw new Error("Der Spielcode muss aus vier Ziffern bestehen.");
  }

  const snapshot = await get(ref(state.db, `rooms/${normalized}`));
  const room = snapshot.val();

  if (!room) throw new Error("Unter diesem Code wurde kein Spiel gefunden.");
  if (serverNow() - (room.lastActivity || room.createdAt || 0) > ROOM_TTL) {
    throw new Error("Dieser Spielraum ist nicht mehr aktiv.");
  }
  if (room.status !== "lobby") throw new Error("Dieses Spiel läuft bereits.");

  const players = Object.values(room.players || {});
  if (players.length >= MAX_PLAYERS) throw new Error("Dieser Spielraum ist bereits voll.");
  if (
    players.some(
      (player) => player.name.toLocaleLowerCase("de") === name.toLocaleLowerCase("de")
    )
  ) {
    throw new Error("Dieser Name wird bereits verwendet.");
  }

  const now = serverNow();
  await set(ref(state.db, `rooms/${normalized}/players/${state.uid}`), {
    name,
    score: 0,
    online: true,
    joinedAt: now,
    lastSeen: now
  });

  await set(ref(state.db, `sessions/${state.uid}`), { roomCode: normalized });
  connectToRoom(normalized);
}

function connectToRoom(code) {
  disconnectRoomListener();
  state.roomCode = code;
  roomPill.hidden = false;
  roomCodeSmall.textContent = code;
  scoreButton.hidden = false;

  state.roomUnsub = state.api.onValue(
    roomRef(),
    (snapshot) => {
      const room = snapshot.val();
      if (!room || !room.players?.[state.uid]) {
        handleRemovedOrClosed();
        return;
      }

      const previousRound = state.room?.round;
      state.room = room;

      if (previousRound !== room.round) {
        resetRoundLocalState(room.round);
      }

      registerPresence();

      if (isHost() && room.deputyId && !room.players[room.deputyId]) {
        state.api.update(roomRef(), { deputyId: "", lastActivity: serverNow() });
        return;
      }

      if (isHost() && room.paused && room.players[state.uid]?.online) {
        resumeAfterHostReturn();
        return;
      }

      renderRoom();
    },
    (error) => {
      console.error(error);
      showFatal("Spiel nicht erreichbar", error);
    }
  );
}

function disconnectRoomListener() {
  state.roomUnsub?.();
  state.connectionUnsub?.();
  state.roomUnsub = null;
  state.connectionUnsub = null;
  clearTimers();
}

function resetRoundLocalState(round) {
  state.draftRound = round;
  state.draftPrompt = "";
  state.imageData = "";
  state.imageType = "image/jpeg";
  state.imageUploading = false;
  state.galleryRound = null;
  state.galleryLoading = false;
}

function registerPresence() {
  if (state.connectionUnsub) return;

  const { onValue, ref, update, onDisconnect, serverTimestamp } = state.api;
  const connectedRef = ref(state.db, ".info/connected");

  state.connectionUnsub = onValue(connectedRef, async (snapshot) => {
    if (snapshot.val() !== true || !state.roomCode) return;

    const playerRef = roomRef(`players/${state.uid}`);
    await onDisconnect(playerRef).update({ online: false, lastSeen: serverTimestamp() });

    if (isHost()) {
      await onDisconnect(roomRef("paused")).set(true);
    }

    await update(playerRef, { online: true, lastSeen: serverNow() });
  });
}

async function resumeAfterHostReturn() {
  if (state.phaseTransitioning) return;

  state.phaseTransitioning = true;
  const patch = { paused: false, lastActivity: serverNow() };

  if (state.room.status === "showing") patch.phaseEndsAt = serverNow() + PROMPT_MS;
  if (state.room.status === "photos") patch.phaseEndsAt = serverNow() + PHOTO_MS;
  if (state.room.status === "results") patch.phaseEndsAt = serverNow() + RESULTS_MS;

  try {
    await state.api.update(roomRef(), patch);
  } finally {
    state.phaseTransitioning = false;
  }
}

function renderRoom() {
  if (!state.room) return;

  if (state.room.paused && !isHost()) {
    renderPaused();
    return;
  }

  switch (state.room.status) {
    case "lobby":
      renderLobby();
      break;
    case "prompt":
      renderPrompt();
      break;
    case "showing":
    case "photos":
      renderPlay();
      break;
    case "scoring":
      renderScoring();
      break;
    case "results":
      renderResults();
      break;
    case "ended":
      renderEnded();
      break;
    default:
      renderLobby();
  }
}

function sortedPlayers(byScore = false) {
  const entries = Object.entries(state.room?.players || {});
  return entries.sort((a, b) => {
    if (byScore) {
      return (b[1].score || 0) - (a[1].score || 0) || (a[1].joinedAt || 0) - (b[1].joinedAt || 0);
    }
    return (a[1].joinedAt || 0) - (b[1].joinedAt || 0);
  });
}

function playerOrder() {
  return sortedPlayers(false).map(([uid]) => uid);
}

function playerName(uid) {
  return state.room?.players?.[uid]?.name || "Unbekannt";
}

function renderLobby() {
  const view = clone("#lobby-template");
  $("#copy-code", view).textContent = state.roomCode;

  const players = sortedPlayers(false);
  $("#player-count", view).textContent = `${players.length} / ${MAX_PLAYERS}`;

  const list = $("#lobby-list", view);
  players.forEach(([uid, player]) => list.append(createPlayerRow(uid, player)));

  const actions = $("#lobby-actions", view);

  if (isHost()) {
    const start = button("Spiel starten", "button-primary", startGame);
    start.disabled = players.length < MIN_PLAYERS || !state.room.deputyId;
    actions.append(start);

    if (players.length < MIN_PLAYERS) {
      actions.prepend(helper(`Mindestens ${MIN_PLAYERS} Personen müssen im Warteraum sein.`));
    } else if (!state.room.deputyId) {
      actions.prepend(helper("Bestimme eine Stellvertretung, bevor das Spiel startet."));
    }
  } else {
    actions.append(helper("Die Spielleitung startet, sobald alle da sind."));
  }

  setScreen(view);

  const codeButton = $("#copy-code");
  codeButton?.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(state.roomCode);
      codeButton.textContent = "Kopiert!";
      setTimeout(() => {
        if (codeButton.isConnected) codeButton.textContent = state.roomCode;
      }, 900);
    } catch (_) {}
  });
}

function createPlayerRow(uid, player) {
  const li = document.createElement("li");
  li.className = "player-row";

  const avatar = document.createElement("span");
  avatar.className = "player-avatar";
  avatar.textContent = player.name.charAt(0).toLocaleUpperCase("de");

  const name = document.createElement("span");
  name.className = "player-name";
  name.textContent = player.name;

  const tags = document.createElement("span");
  tags.className = "player-tags";

  const presence = document.createElement("span");
  presence.className = `presence ${player.online ? "online" : ""}`;
  presence.title = player.online ? "Verbunden" : "Nicht verbunden";
  tags.append(presence);

  if (uid === state.room.hostId) tags.append(tag("Spielleitung"));
  if (uid === state.room.deputyId) tags.append(tag("Vertretung"));

  li.append(avatar, name, tags);

  if (isHost() && uid !== state.uid) {
    const select = button(
      uid === state.room.deputyId ? "Vertretung ✓" : "Als Vertretung",
      "deputy-select",
      () => setDeputy(uid)
    );
    li.append(select);

    const remove = button("×", "remove-player", () => confirmRemove(uid, player.name));
    remove.setAttribute("aria-label", `${player.name} entfernen`);
    li.append(remove);
  }

  return li;
}

async function setDeputy(uid) {
  await safeUpdate({ deputyId: uid, lastActivity: serverNow() });
}

function confirmRemove(uid, name) {
  showModal(
    "Mitspieler entfernen?",
    `<p><strong>${escapeHtml(name)}</strong> wird aus dem Warteraum entfernt.</p>`,
    [
      { label: "Abbrechen", className: "button-ghost", action: closeModal },
      {
        label: "Entfernen",
        className: "button-danger",
        action: async () => {
          closeModal();
          await safeUpdate({
            [`players/${uid}`]: null,
            deputyId: state.room.deputyId === uid ? "" : state.room.deputyId,
            lastActivity: serverNow()
          });
        }
      }
    ]
  );
}

async function startGame() {
  if (!isHost() || playerOrder().length < MIN_PLAYERS || !state.room.deputyId) return;
  await startNextRound(0);
}

async function startNextRound(index) {
  if (!isHost()) return;

  const previousRound = state.room.round || 0;
  if (previousRound) {
    await state.api.remove(photosRef(previousRound)).catch(() => {});
  }

  const order = playerOrder();
  const normalizedIndex = ((index % order.length) + order.length) % order.length;
  const now = serverNow();

  await safeUpdate({
    status: "prompt",
    paused: false,
    round: previousRound + 1,
    turnIndex: normalizedIndex,
    promptGiverId: order[normalizedIndex],
    prompt: null,
    phaseEndsAt: null,
    winners: null,
    submissions: null,
    lastActivity: now
  });
}

function renderPrompt() {
  const view = clone("#prompt-template");
  $("#prompt-round", view).textContent = `Runde ${state.room.round}`;
  $("#prompt-author", view).textContent = playerName(state.room.promptGiverId);

  const form = $("#prompt-form", view);
  const wait = $("#prompt-wait", view);
  const input = $("#prompt-input", view);
  const count = $("#prompt-count", view);

  if (isPromptGiver()) {
    form.hidden = false;
    wait.hidden = true;

    input.value = state.draftPrompt || "";
    count.textContent = `${input.value.length} / 80`;

    input.addEventListener("input", () => {
      state.draftPrompt = input.value;
      count.textContent = `${input.value.length} / 80`;
    });

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      submitPrompt(form);
    });
  } else {
    form.hidden = true;
    wait.hidden = false;
    wait.textContent = `${playerName(state.room.promptGiverId)} gibt gerade den Begriff für diese Runde ein.`;
  }

  setScreen(view);

  if (isPromptGiver()) {
    setTimeout(() => $("#prompt-input")?.focus(), 100);
  }
}

async function submitPrompt(form) {
  if (!isPromptGiver() || state.room.status !== "prompt") return;

  const input = $("#prompt-input", form);
  const error = $("#prompt-error", form);
  const submit = $("button[type='submit']", form);
  const prompt = cleanPrompt(input.value);

  error.hidden = true;
  error.textContent = "";

  if (prompt.length < 2) {
    error.textContent = "Bitte gib einen Begriff mit mindestens zwei Zeichen ein.";
    error.hidden = false;
    return;
  }

  submit.disabled = true;
  state.draftPrompt = prompt;

  try {
    await safeUpdate({
      prompt,
      status: "showing",
      phaseEndsAt: serverNow() + PROMPT_MS,
      lastActivity: serverNow()
    });
  } catch (errorObj) {
    error.textContent = friendlyError(errorObj);
    error.hidden = false;
    submit.disabled = false;
  }
}

function renderPlay() {
  const view = clone("#play-template");
  const status = state.room.status;

  $("#round-label", view).textContent = `Runde ${state.room.round}`;
  $("#prompt-text", view).textContent = state.room.prompt || "…";

  const content = $("#play-content", view);

  if (status === "showing") {
    content.append(
      helper(
        isPromptGiver()
          ? "Dein Begriff wird jetzt allen kurz angezeigt."
          : "Merke dir den Begriff – gleich beginnt die Fotophase."
      )
    );
  } else if (status === "photos") {
    if (isPromptGiver()) {
      content.append(
        helper("Du setzt diese Runde aus. Die anderen haben jetzt 30 Sekunden Zeit für ihr Foto.")
      );
    } else {
      content.append(createPhotoCapture());
    }
  }

  setScreen(view);
  startPhaseTimer(
    status === "showing" ? PROMPT_MS : PHOTO_MS,
    status === "showing" ? "photos" : "scoring"
  );
}

function createPhotoCapture() {
  const wrapper = document.createElement("div");
  wrapper.className = "capture-panel";

  const submitted = Boolean(state.room.submissions?.[state.uid]);

  if (!state.imageData) {
    wrapper.innerHTML = `
      <div class="capture-empty">
        <span class="camera-glyph" aria-hidden="true">📷</span>
        <strong>${submitted ? "Foto bereits abgeschickt" : "Jetzt ein passendes Foto machen"}</strong>
        <p>Du kannst ein Bild aufnehmen oder aus deiner Galerie wählen.</p>
      </div>
    `;
  } else {
    wrapper.innerHTML = `
      <figure class="photo-preview">
        <img src="${state.imageData}" alt="Dein ausgewähltes Foto">
        <figcaption class="photo-status">${submitted ? "Bereits gespeichert" : "Bereit zum Absenden"}</figcaption>
      </figure>
    `;
  }

  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*";
  input.setAttribute("capture", "environment");
  input.hidden = true;
  input.id = "photo-input";

  const choose = document.createElement("label");
  choose.className = "button button-secondary";
  choose.setAttribute("for", "photo-input");
  choose.textContent = state.imageData
    ? (submitted ? "Foto ersetzen" : "Anderes Foto wählen")
    : "Foto auswählen";

  const submit = document.createElement("button");
  submit.type = "button";
  submit.className = "button button-primary";
  submit.id = "upload-photo";
  submit.disabled = !state.imageData || state.imageUploading;
  submit.textContent = state.imageUploading
    ? "Wird hochgeladen …"
    : submitted
      ? "Foto aktualisieren"
      : "Foto absenden";

  const actions = document.createElement("div");
  actions.className = "sticky-actions";
  actions.append(choose, submit);

  const status = document.createElement("p");
  status.className = "upload-status";
  status.textContent = submitted
    ? "Dein Foto ist gespeichert. Du kannst es bis zum Ablauf der Zeit noch ersetzen."
    : "Noch kein Foto abgeschickt.";

  const error = document.createElement("p");
  error.className = "form-error";
  error.id = "photo-error";
  error.hidden = true;

  wrapper.append(input, status, error, actions);

  input.addEventListener("change", async () => {
    error.hidden = true;
    error.textContent = "";

    const file = input.files?.[0];
    if (!file) return;

    try {
      const prepared = await prepareImage(file);
      state.imageData = prepared.data;
      state.imageType = prepared.type;
      renderPlay();
    } catch (err) {
      error.textContent = friendlyImageError(err);
      error.hidden = false;
    }
  });

  submit.addEventListener("click", async () => {
    if (!state.imageData || state.imageUploading) return;
    if (state.room.status !== "photos" || isPromptGiver()) return;

    state.imageUploading = true;
    renderPlay();

    try {
      await state.api.set(photosRef(state.room.round, state.uid), {
        data: state.imageData,
        type: state.imageType || "image/jpeg",
        createdAt: serverNow()
      });

      await safeUpdate({
        [`submissions/${state.uid}`]: true,
        lastActivity: serverNow()
      });

      signal("success");
    } catch (err) {
      const currentError = $("#photo-error");
      if (currentError) {
        currentError.textContent = friendlyError(err);
        currentError.hidden = false;
      }
    } finally {
      state.imageUploading = false;
      renderPlay();
    }
  });

  return wrapper;
}

function renderScoring() {
  const view = clone("#scoring-template");
  setScreen(view);
  loadGallery();
}

async function loadGallery() {
  if (state.galleryLoading && state.galleryRound === state.room.round) return;

  state.galleryLoading = true;
  state.galleryRound = state.room.round;

  const gallery = document.querySelector("#photo-gallery");
  const form = document.querySelector("#scoring-form");
  const loading = document.querySelector("#gallery-loading");
  const wait = document.querySelector("#scoring-wait");

  if (!gallery || !form || !loading || !wait) {
    state.galleryLoading = false;
    return;
  }

  const isJudge = isPromptGiver();

  loading.hidden = false;
  form.hidden = true;
  wait.hidden = true;
  gallery.replaceChildren();

  try {
    const photosSnapshot = await state.api.get(photosRef());
    const photos = photosSnapshot.val() || {};

    if (state.room.status !== "scoring") return;

    const entries = Object.entries(photos)
      .filter(([uid]) => uid !== state.room.promptGiverId && state.room.players?.[uid])
      .sort((a, b) => playerName(a[0]).localeCompare(playerName(b[0]), "de"));

    loading.hidden = true;
    form.hidden = false;

    if (!entries.length) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.innerHTML = `
        <strong>Keine Fotos eingereicht</strong>
        <p>${isJudge ? "Du kannst die Runde ohne Punktvergabe bestätigen." : "Die Bewertung wird gleich abgeschlossen."}</p>
      `;
      gallery.append(empty);
    } else {
      entries.forEach(([uid, photo]) => {
        gallery.append(createPhotoOption(uid, photo, isJudge));
      });
    }

    if (isJudge) {
      wait.hidden = true;
      form.addEventListener("submit", confirmScoring, { once: true });
    } else {
      wait.hidden = false;
      wait.textContent = `${playerName(state.room.promptGiverId)} bewertet gerade die Fotos.`;
      $$("input[type='checkbox']", form).forEach((input) => {
        input.disabled = true;
      });
    }
  } catch (error) {
    loading.hidden = true;
    wait.hidden = false;
    wait.textContent = friendlyError(error);
  } finally {
    state.galleryLoading = false;
  }
}

function createPhotoOption(uid, photo, selectable = true) {
  const player = playerName(uid);

  if (!selectable) {
    const item = document.createElement("article");
    item.className = "photo-option readonly-photo";

    const image = document.createElement("img");
    image.src = photo.data;
    image.alt = `Foto von ${player}`;
    image.loading = "lazy";

    const footer = document.createElement("div");
    footer.className = "photo-footer";

    const dot = document.createElement("span");
    dot.className = "photo-check";
    dot.textContent = "✓";
    dot.style.visibility = "hidden";

    const name = document.createElement("strong");
    name.textContent = player;

    const zoom = document.createElement("button");
    zoom.type = "button";
    zoom.className = "zoom-button";
    zoom.setAttribute("aria-label", `Foto von ${player} vergrößern`);
    zoom.textContent = "↗";

    zoom.addEventListener("click", () => openPhoto(photo.data, player));
    image.addEventListener("click", () => openPhoto(photo.data, player));

    footer.append(dot, name, zoom);
    item.append(image, footer);
    return item;
  }

  const article = document.createElement("label");
  article.className = "photo-option";

  const input = document.createElement("input");
  input.type = "checkbox";
  input.name = "winner";
  input.value = uid;
  input.checked = Boolean(state.room.winners?.[uid]);

  const image = document.createElement("img");
  image.src = photo.data;
  image.alt = `Foto von ${player}`;
  image.loading = "lazy";

  const footer = document.createElement("div");
  footer.className = "photo-footer";

  const check = document.createElement("span");
  check.className = "photo-check";
  check.textContent = "✓";

  const name = document.createElement("strong");
  name.textContent = player;

  const zoom = document.createElement("button");
  zoom.type = "button";
  zoom.className = "zoom-button";
  zoom.setAttribute("aria-label", `Foto von ${player} vergrößern`);
  zoom.textContent = "↗";

  zoom.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    openPhoto(photo.data, player);
  });

  image.addEventListener("click", (event) => {
    event.preventDefault();
    openPhoto(photo.data, player);
  });

  footer.append(check, name, zoom);
  article.append(input, image, footer);
  return article;
}

async function confirmScoring(event) {
  event.preventDefault();
  if (!isPromptGiver() || state.room.status !== "scoring") return;

  const selected = $$("input[name='winner']:checked", event.currentTarget).map((input) => input.value);
  const winners = {};
  selected.forEach((uid) => {
    winners[uid] = true;
  });

  const patch = {
    status: "results",
    winners: selected.length ? winners : null,
    phaseEndsAt: serverNow() + RESULTS_MS,
    lastActivity: serverNow()
  };

  Object.keys(state.room.players || {}).forEach((uid) => {
    const base = state.room.players[uid]?.score || 0;
    patch[`players/${uid}/score`] = base + (winners[uid] ? 1 : 0);
  });

  await safeUpdate(patch);
}

function renderResults() {
  const view = clone("#results-template");
  const winners = state.room.winners || {};
  const winnerIds = Object.keys(winners);
  const board = $("#leaderboard", view);

  if (winnerIds.includes(state.uid)) {
    $("#result-title", view).textContent = "Punkt für dich!";
  } else {
    $("#result-title", view).textContent = winnerIds.length
      ? "Diese Runde ist entschieden"
      : "Diese Runde ohne Punkte";
  }

  $("#winner-copy", view).textContent = winnerIds.length
    ? `${winnerIds.map(playerName).join(", ")} ${winnerIds.length === 1 ? "erhält" : "erhalten"} einen Punkt.`
    : "In dieser Runde erhält niemand einen Punkt.";

  appendLeaderboard(board, winners);

  const actions = $("#result-actions", view);
  if (isHost()) {
    const order = playerOrder();
    const nextIndex = (((state.room.turnIndex || 0) + 1) % order.length + order.length) % order.length;
    actions.append(button("Nächste Runde", "button-primary", () => startNextRound(nextIndex)));
    actions.append(button("Spiel beenden", "button-ghost", confirmEndGame));
  }

  setScreen(view);

  if (winnerIds.includes(state.uid) && state.confettiRound !== state.room.round) {
    state.confettiRound = state.room.round;
    launchConfetti();
    signal("win");
  }

  if (isHost()) {
    startPhaseTimer(RESULTS_MS, "prompt", async () => {
      const order = playerOrder();
      const nextIndex = (((state.room.turnIndex || 0) + 1) % order.length + order.length) % order.length;
      await startNextRound(nextIndex);
    });
  } else {
    startDisplayTimer(RESULTS_MS);
  }
}

function appendLeaderboard(target, winners = {}) {
  target.replaceChildren();

  sortedPlayers(true).forEach(([uid, player]) => {
    const li = document.createElement("li");
    if (uid === state.uid) li.classList.add("me");
    if (winners[uid]) li.classList.add("winner");

    const name = document.createElement("span");
    name.className = "rank-name";
    name.textContent = player.name;

    const score = document.createElement("span");
    score.className = "score";
    score.textContent = player.score || 0;

    li.append(name, score);
    target.append(li);
  });
}

function confirmEndGame() {
  if (!isHost()) {
    showModal(
      "Spiel beenden",
      "<p>Nur die Spielleitung kann das Spiel beenden.</p>",
      [{ label: "OK", className: "button-primary", action: closeModal }]
    );
    return;
  }

  showModal(
    "Spiel beenden?",
    "<p>Der aktuelle Punktestand wird zur Abschlussansicht. Alle Fotos werden gelöscht.</p>",
    [
      { label: "Weiterspielen", className: "button-ghost", action: closeModal },
      { label: "Spiel beenden", className: "button-danger", action: endGame }
    ]
  );
}

async function endGame() {
  closeModal();
  await state.api.remove(state.api.ref(state.db, `photos/${state.roomCode}`)).catch(() => {});
  await safeUpdate({
    status: "ended",
    phaseEndsAt: null,
    submissions: null,
    lastActivity: serverNow()
  });
}

function renderEnded() {
  const view = clone("#ended-template");
  const ranking = sortedPlayers(true);
  const top = ranking[0]?.[1]?.score || 0;
  const names = ranking
    .filter(([, player]) => (player.score || 0) === top)
    .map(([, player]) => player.name);

  $("#final-winner-copy", view).textContent =
    names.length > 1
      ? `${names.join(" und ")} teilen sich mit ${top} Punkten den Sieg.`
      : `${names[0] || "Niemand"} gewinnt mit ${top} Punkten.`;

  appendLeaderboard($("#final-leaderboard", view));

  const actions = $("#ended-actions", view);
  if (isHost()) {
    actions.append(button("Revanche", "button-primary", rematch));
    actions.append(button("Raum schließen", "button-ghost", closeRoom));
  } else {
    actions.append(button("Zur Startseite", "button-secondary", leaveToHome));
  }

  setScreen(view);
}

async function rematch() {
  const patch = {
    status: "lobby",
    round: 0,
    turnIndex: null,
    promptGiverId: null,
    prompt: null,
    phaseEndsAt: null,
    winners: null,
    submissions: null,
    paused: false,
    lastActivity: serverNow()
  };

  Object.keys(state.room.players || {}).forEach((uid) => {
    patch[`players/${uid}/score`] = 0;
  });

  await safeUpdate(patch);
}

async function closeRoom() {
  if (!isHost()) return;
  await state.api.remove(state.api.ref(state.db, `photos/${state.roomCode}`)).catch(() => {});
  await state.api.remove(roomRef());
}

function renderPaused() {
  const section = document.createElement("section");
  section.className = "screen loading-screen";
  section.innerHTML = `
    <p class="eyebrow">Spiel pausiert</p>
    <h1>Verbindung zur Spielleitung unterbrochen</h1>
    <p>Das Spiel wartet bis zu zwei Minuten auf die Rückkehr.</p>
    <p id="pause-countdown" class="score">120 s</p>
  `;

  const takeover = button("Spielleitung übernehmen", "button-primary", takeOverHost);
  takeover.hidden = true;
  section.append(takeover);

  setScreen(section);

  const tick = () => {
    const host = state.room.players?.[state.room.hostId];
    const elapsed = Math.max(0, serverNow() - (host?.lastSeen || serverNow()));
    const remaining = Math.max(0, 120000 - elapsed);
    $("#pause-countdown").textContent = `${Math.ceil(remaining / 1000)} s`;
    takeover.hidden = !(isDeputy() && remaining <= 0);
  };

  tick();
  state.pausedTimerId = setInterval(tick, 500);
}

async function takeOverHost() {
  if (!isDeputy()) return;
  const host = state.room.players?.[state.room.hostId];
  if (serverNow() - (host?.lastSeen || serverNow()) < 120000) return;

  const patch = {
    hostId: state.uid,
    paused: false,
    lastActivity: serverNow()
  };

  if (state.room.status === "showing") patch.phaseEndsAt = serverNow() + PROMPT_MS;
  if (state.room.status === "photos") patch.phaseEndsAt = serverNow() + PHOTO_MS;
  if (state.room.status === "results") patch.phaseEndsAt = serverNow() + RESULTS_MS;

  await safeUpdate(patch);
}

function startPhaseTimer(duration, nextStatus, hostCallback = null) {
  const timer = $("#timer");
  if (!timer || !state.room?.phaseEndsAt) return;

  const tick = async () => {
    const remaining = Math.max(0, state.room.phaseEndsAt - serverNow());
    const seconds = Math.ceil(remaining / 1000);

    $("span", timer).textContent = String(seconds);
    timer.style.setProperty("--progress", `${Math.max(0, Math.min(100, (remaining / duration) * 100))}%`);
    timer.classList.toggle("warning", remaining <= 5000);

    if (remaining > 0) return;

    clearInterval(state.timerId);

    if (!isHost() || state.phaseTransitioning) return;

    state.phaseTransitioning = true;
    try {
      if (typeof hostCallback === "function") {
        await hostCallback();
      } else if (nextStatus === "photos") {
        await safeUpdate({
          status: "photos",
          phaseEndsAt: serverNow() + PHOTO_MS,
          lastActivity: serverNow()
        });
      } else if (nextStatus === "scoring") {
        await safeUpdate({
          status: "scoring",
          phaseEndsAt: null,
          lastActivity: serverNow()
        });
      } else if (nextStatus === "prompt") {
        const order = playerOrder();
        const nextIndex =
          (((state.room.turnIndex || 0) + 1) % order.length + order.length) % order.length;
        await startNextRound(nextIndex);
      }
    } finally {
      state.phaseTransitioning = false;
    }
  };

  tick();
  state.timerId = setInterval(tick, 200);
}

function startDisplayTimer(duration) {
  const timer = $("#timer");
  if (!timer || !state.room?.phaseEndsAt) return;

  const tick = () => {
    const remaining = Math.max(0, state.room.phaseEndsAt - serverNow());
    const seconds = Math.ceil(remaining / 1000);

    $("span", timer).textContent = String(seconds);
    timer.style.setProperty("--progress", `${Math.max(0, Math.min(100, (remaining / duration) * 100))}%`);
    timer.classList.toggle("warning", remaining <= 5000);

    if (remaining <= 0) clearInterval(state.timerId);
  };

  tick();
  state.timerId = setInterval(tick, 200);
}

async function handleRemovedOrClosed() {
  if (state.uid && state.db) {
    try {
      await state.api.remove(state.api.ref(state.db, `sessions/${state.uid}`));
    } catch (_) {}
  }

  disconnectRoomListener();
  state.roomCode = null;
  state.room = null;
  roomPill.hidden = true;
  scoreButton.hidden = true;
  showHome();

  showModal(
    "Spiel beendet",
    "<p>Der Raum wurde geschlossen oder du wurdest aus dem Warteraum entfernt.</p>",
    [{ label: "OK", className: "button-primary", action: closeModal }]
  );
}

async function leaveToHome() {
  closeModal();

  if (state.uid && state.db) {
    try {
      if (state.roomCode && !isHost()) {
        await state.api.remove(roomRef(`players/${state.uid}`));
      }
      await state.api.remove(state.api.ref(state.db, `sessions/${state.uid}`));
    } catch (_) {}
  }

  disconnectRoomListener();
  state.roomCode = null;
  state.room = null;
  showHome();
}

function requestLeave() {
  if (!state.roomCode) {
    showHome();
    return;
  }

  showModal(
    "Spiel verlassen?",
    `<p>${
      isHost()
        ? "Als Spielleitung solltest du den Raum über „Spiel beenden“ schließen."
        : "Möchtest du das laufende Spiel verlassen?"
    }</p>`,
    [
      { label: "Im Spiel bleiben", className: "button-ghost", action: closeModal },
      { label: "Verlassen", className: "button-danger", action: leaveToHome }
    ]
  );
}

function showRules() {
  showModal(
    "So funktioniert’s",
    `
      <ol class="rules-list">
        <li>Ein Spieler gibt einen Begriff ein.</li>
        <li>Alle anderen haben 30 Sekunden Zeit für ein passendes Foto.</li>
        <li>Danach sieht die Gruppe alle eingereichten Fotos.</li>
        <li>Der Begriffgeber vergibt die Punkte.</li>
        <li>Die Gewinner sehen Konfetti auf ihrem Gerät.</li>
      </ol>
      <p>Fotos werden verkleinert übertragen, sind nur während des Spiels sichtbar und werden vor der nächsten Runde gelöscht.</p>
    `,
    [{ label: "Verstanden", className: "button-primary", action: closeModal }]
  );
}

async function prepareImage(file) {
  if (!file.type.startsWith("image/")) {
    throw new Error("Bitte wähle ein Bild aus.");
  }

  if (file.size > MAX_FILE_BYTES) {
    throw new Error("Das Bild ist zu groß.");
  }

  const dataUrl = await readFileAsDataURL(file);
  const image = await loadImage(dataUrl);

  const maxSide = 960;
  const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext("2d");
  context.fillStyle = "#050607";
  context.fillRect(0, 0, width, height);
  context.drawImage(image, 0, 0, width, height);

  let quality = 0.78;
  let output = canvas.toDataURL("image/jpeg", quality);

  while (output.length > MAX_IMAGE_CHARS && quality > 0.42) {
    quality -= 0.08;
    output = canvas.toDataURL("image/jpeg", quality);
  }

  if (output.length > MAX_IMAGE_CHARS) {
    throw new Error("Das Bild konnte nicht klein genug komprimiert werden.");
  }

  return { data: output, type: "image/jpeg" };
}

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Datei konnte nicht gelesen werden."));
    reader.onload = () => resolve(reader.result);
    reader.readAsDataURL(file);
  });
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Bild konnte nicht geladen werden."));
    image.src = src;
  });
}

function openPhoto(src, player) {
  showModal(
    player,
    `<img class="photo-large" src="${src}" alt="Foto von ${escapeHtml(player)}">`,
    [{ label: "Schließen", className: "button-primary", action: closeModal }]
  );
}

function helper(text) {
  const p = document.createElement("p");
  p.className = "phase-message";
  p.textContent = text;
  return p;
}

function tag(text) {
  const span = document.createElement("span");
  span.className = "tag";
  span.textContent = text;
  return span;
}

function button(label, className, handler) {
  const el = document.createElement("button");
  el.type = "button";
  el.className = className.includes("button") ? `button ${className}` : className;
  el.textContent = label;
  el.addEventListener("click", handler);
  return el;
}

async function safeUpdate(patch) {
  try {
    await state.api.update(roomRef(), patch);
  } catch (error) {
    showFatal("Änderung nicht möglich", error);
    throw error;
  }
}

function showFatal(title, error) {
  showModal(
    title,
    `<p>${escapeHtml(friendlyError(error))}</p>`,
    [{ label: "Schließen", className: "button-primary", action: closeModal }]
  );
}

function friendlyError(error) {
  const code = error?.code || "";
  if (code.includes("permission-denied")) {
    return "Firebase hat den Zugriff abgelehnt. Prüfe die veröffentlichten Regeln.";
  }
  if (code.includes("network")) {
    return "Keine Verbindung. Bitte prüfe das Netz und versuche es erneut.";
  }
  return error?.message || "Es ist ein unerwarteter Fehler aufgetreten.";
}

function friendlyImageError(error) {
  return error?.message || "Das Foto konnte nicht verarbeitet werden.";
}

function escapeHtml(value = "") {
  const div = document.createElement("div");
  div.textContent = value;
  return div.innerHTML;
}

function showModal(title, body, actions = []) {
  closeModal();

  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";

  const modal = document.createElement("section");
  modal.className = "modal";
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  modal.setAttribute("aria-labelledby", "modal-title");

  modal.innerHTML = `
    <header class="modal-header">
      <h2 id="modal-title">${escapeHtml(title)}</h2>
      <button class="modal-close" type="button" aria-label="Schließen">×</button>
    </header>
    <div class="modal-copy">${body}</div>
    <div class="modal-actions"></div>
  `;

  $(".modal-close", modal).addEventListener("click", closeModal);
  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) closeModal();
  });

  const actionsArea = $(".modal-actions", modal);
  actions.forEach((item) => actionsArea.append(button(item.label, item.className, item.action)));

  backdrop.append(modal);
  modalRoot.append(backdrop);

  setTimeout(() => $(".modal-close", modal)?.focus(), 40);
}

function closeModal() {
  modalRoot.replaceChildren();
}

function signal(type) {
  if (!state.signals) return;

  if (navigator.vibrate) {
    navigator.vibrate(type === "win" ? [80, 40, 120] : 40);
  }

  try {
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextCtor) return;

    const context = new AudioContextCtor();
    const oscillator = context.createOscillator();
    const gain = context.createGain();

    oscillator.frequency.value = type === "win" ? 740 : 520;
    gain.gain.setValueAtTime(0.08, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.18);

    oscillator.connect(gain);
    gain.connect(context.destination);

    oscillator.start();
    oscillator.stop(context.currentTime + 0.18);
  } catch (_) {}
}

function launchConfetti() {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  const context = confettiCanvas.getContext("2d");
  const ratio = Math.min(window.devicePixelRatio || 1, 2);

  confettiCanvas.width = innerWidth * ratio;
  confettiCanvas.height = innerHeight * ratio;
  context.scale(ratio, ratio);

  const colors = ["#009D43", "#EB6608", "#FFCB03", "#009CC4", "#ffffff"];
  const pieces = Array.from({ length: 90 }, () => ({
    x: innerWidth / 2 + (Math.random() - 0.5) * 80,
    y: innerHeight * 0.35,
    vx: (Math.random() - 0.5) * 12,
    vy: -5 - Math.random() * 9,
    gravity: 0.22 + Math.random() * 0.12,
    size: 5 + Math.random() * 7,
    color: colors[Math.floor(Math.random() * colors.length)],
    rotation: Math.random() * Math.PI
  }));

  const start = performance.now();

  const frame = (now) => {
    context.clearRect(0, 0, innerWidth, innerHeight);

    pieces.forEach((piece) => {
      piece.x += piece.vx;
      piece.y += piece.vy;
      piece.vy += piece.gravity;
      piece.rotation += 0.12;

      context.save();
      context.translate(piece.x, piece.y);
      context.rotate(piece.rotation);
      context.fillStyle = piece.color;
      context.fillRect(-piece.size / 2, -piece.size / 3, piece.size, piece.size * 0.65);
      context.restore();
    });

    if (now - start < 2200) {
      requestAnimationFrame(frame);
    } else {
      context.clearRect(0, 0, innerWidth, innerHeight);
    }
  };

  requestAnimationFrame(frame);
}

appRoot.addEventListener("click", (event) => {
  const action = event.target.closest("[data-action]")?.dataset.action;
  if (!action) return;

  if (action === "show-create") showEntry("create");
  if (action === "show-join") showEntry("join");
  if (action === "show-rules") showRules();
  if (action === "home") showHome();
});

appRoot.addEventListener("submit", async (event) => {
  if (event.target.id !== "entry-form") return;

  event.preventDefault();

  const error = $("#form-error");
  const submit = event.submitter;
  const name = cleanName($("#player-name").value);

  if (name.length < 2) {
    error.textContent = "Bitte gib einen Namen mit mindestens zwei Zeichen ein.";
    error.hidden = false;
    return;
  }

  submit.disabled = true;
  error.hidden = true;

  try {
    if (event.target.dataset.mode === "create") {
      await createRoom(name);
    } else {
      await joinRoom($("#room-code").value, name);
    }
  } catch (err) {
    error.textContent = friendlyError(err);
    error.hidden = false;
    submit.disabled = false;
  }
});

document.querySelector("#brand-home")?.addEventListener("click", requestLeave);
scoreButton?.addEventListener("click", () => {
  if (!state.room) return;

  const ranking = sortedPlayers(true)
    .map(([, player], index) => `<li><strong>${index + 1}. ${escapeHtml(player.name)}</strong> – ${player.score || 0}</li>`)
    .join("");

  showModal("Punktestand", `<ol class="rules-list">${ranking}</ol>`, [
    { label: "Schließen", className: "button-primary", action: closeModal }
  ]);
});

window.addEventListener("online", () => setConnection(true));
window.addEventListener("offline", () => setConnection(false));
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeModal();
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./service-worker.js").catch(console.warn);
  });
}

initFirebase();
