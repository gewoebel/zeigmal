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

const appRoot = document.querySelector("#app");
const modalRoot = document.querySelector("#modal-root");
const roomPill = document.querySelector("#room-pill");
const roomCodeSmall = document.querySelector("#room-code-small");
const connectionDot = document.querySelector("#connection-dot");
const offlineBanner = document.querySelector("#offline-banner");
const scoreButton = document.querySelector("#score-button");

const state = {
  uid: null, roomCode: null, room: null, db: null, auth: null, api: null,
  roomUnsub: null, connectionUnsub: null, timerId: null, pausedTimerId: null,
  serverOffset: 0, phaseTransitioning: false, online: navigator.onLine,
  draftPrompt: "", draftRound: null, imageData: "", imageType: "", imageUploading: false,
  confettiRound: null, galleryRound: null, galleryLoading: false
};

const $ = (selector, parent = document) => parent.querySelector(selector);
const $$ = (selector, parent = document) => [...parent.querySelectorAll(selector)];
const clone = (id) => document.querySelector(id).content.cloneNode(true);
const serverNow = () => Date.now() + state.serverOffset;
const roomRef = (path = "") => state.api.ref(state.db, `rooms/${state.roomCode}${path ? `/${path}` : ""}`);
const photosRef = (round = state.room?.round, path = "") => state.api.ref(state.db, `photos/${state.roomCode}/${round}${path ? `/${path}` : ""}`);
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
  clearInterval(state.timerId); clearInterval(state.pausedTimerId);
  state.timerId = null; state.pausedTimerId = null;
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
    note.textContent = "Vor dem ersten Mehrspieler-Test muss Firebase eingerichtet werden. Die Anleitung liegt dem Paket bei.";
  }
  setScreen(view); roomPill.hidden = true; scoreButton.hidden = true;
}
function showEntry(mode) {
  if (!firebaseIsConfigured) return showSetupModal();
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
  showModal("Firebase fehlt noch", `<p>Trage zuerst die Werte deines neuen Firebase-Projekts in <strong>firebase-config.js</strong> ein.</p><p><strong>FIREBASE-SETUP.md</strong> führt dich Schritt für Schritt durch die kostenlose Einrichtung.</p>`, [{ label: "Verstanden", className: "button-primary", action: closeModal }]);
}

async function restoreSession() {
  const { get, ref, remove } = state.api;
  const session = (await get(ref(state.db, `sessions/${state.uid}`))).val();
  const code = session?.roomCode;
  if (!code) return showHome();
  const room = (await get(ref(state.db, `rooms/${code}`))).val();
  const expired = room && serverNow() - (room.lastActivity || room.createdAt || 0) > ROOM_TTL;
  if (!room || !room.players?.[state.uid] || expired) {
    await remove(ref(state.db, `sessions/${state.uid}`));
    return showHome();
  }
  connectToRoom(code);
}

async function createRoom(name) {
  const { ref, runTransaction, set } = state.api;
  const now = serverNow(); let code = ""; let committed = false;
  for (let attempt = 0; attempt < 30 && !committed; attempt += 1) {
    code = String(Math.floor(1000 + Math.random() * 9000));
    const room = {
      hostId: state.uid, deputyId: "", status: "lobby", paused: false,
      createdAt: now, lastActivity: now, round: 0, maxPlayers: MAX_PLAYERS,
      players: { [state.uid]: { name, score: 0, online: true, joinedAt: now, lastSeen: now } }
    };
    const result = await runTransaction(ref(state.db, `rooms/${code}`), (current) =>
      current === null || now - (current.lastActivity || current.createdAt || 0) > ROOM_TTL ? room : undefined,
      { applyLocally: false }
    );
    committed = result.committed;
  }
  if (!committed) throw new Error("Es konnte kein freier Spielcode erzeugt werden.");
  await set(ref(state.db, `sessions/${state.uid}`), { roomCode: code });
  connectToRoom(code);
}

async function joinRoom(code, name) {
  const { get, ref, set } = state.api;
  const normalized = code.replace(/\D/g, "").slice(0, 4);
  if (normalized.length !== 4) throw new Error("Der Spielcode muss aus vier Ziffern bestehen.");
  const room = (await get(ref(state.db, `rooms/${normalized}`))).val();
  if (!room) throw new Error("Unter diesem Code wurde kein Spiel gefunden.");
  if (serverNow() - (room.lastActivity || room.createdAt || 0) > ROOM_TTL) throw new Error("Dieser Spielraum ist nicht mehr aktiv.");
  if (room.status !== "lobby") throw new Error("Dieses Spiel läuft bereits.");
  const players = Object.values(room.players || {});
  if (players.length >= MAX_PLAYERS) throw new Error("Dieser Spielraum ist bereits voll.");
  if (players.some((player) => player.name.toLocaleLowerCase("de") === name.toLocaleLowerCase("de"))) throw new Error("Dieser Name wird bereits verwendet.");
  const now = serverNow();
  await set(ref(state.db, `rooms/${normalized}/players/${state.uid}`), { name, score: 0, online: true, joinedAt: now, lastSeen: now });
  await set(ref(state.db, `sessions/${state.uid}`), { roomCode: normalized });
  connectToRoom(normalized);
}

function connectToRoom(code) {
  disconnectRoomListener();
  state.roomCode = code; roomPill.hidden = false; roomCodeSmall.textContent = code; scoreButton.hidden = false;
  state.roomUnsub = state.api.onValue(roomRef(), (snapshot) => {
    const room = snapshot.val();
    if (!room || !room.players?.[state.uid]) return handleRemovedOrClosed();
    const previousRound = state.room?.round;
    state.room = room;
    if (previousRound !== room.round) resetRoundLocalState(room.round);
    registerPresence();
    if (isHost() && room.deputyId && !room.players[room.deputyId]) {
      state.api.update(roomRef(), { deputyId: "", lastActivity: serverNow() }); return;
    }
    if (isHost() && room.paused && room.players[state.uid]?.online) { resumeAfterHostReturn(); return; }
    renderRoom();
  }, (error) => showFatal("Spiel nicht erreichbar", error));
}
function disconnectRoomListener() {
  state.roomUnsub?.(); state.connectionUnsub?.(); state.roomUnsub = null; state.connectionUnsub = null; clearTimers();
}
function resetRoundLocalState(round) {
  state.draftRound = round; state.draftPrompt = ""; state.imageData = ""; state.imageType = "";
  state.imageUploading = false; state.galleryRound = null; state.galleryLoading = false;
}
function registerPresence() {
  if (state.connectionUnsub) return;
  const { onValue, ref, update, onDisconnect, serverTimestamp } = state.api;
  state.connectionUnsub = onValue(ref(state.db, ".info/connected"), async (snapshot) => {
    if (snapshot.val() !== true || !state.roomCode) return;
    const playerRef = roomRef(`players/${state.uid}`);
    await onDisconnect(playerRef).update({ online: false, lastSeen: serverTimestamp() });
    if (isHost()) await onDisconnect(roomRef("paused")).set(true);
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
  try { await state.api.update(roomRef(), patch); } finally { state.phaseTransitioning = false; }
}

function renderRoom() {
  if (!state.room) return;
  if (state.room.paused && !isHost()) return renderPaused();
  switch (state.room.status) {
    case "lobby": renderLobby(); break;
    case "prompt": renderPrompt(); break;
    case "showing": case "photos": renderPlay(); break;
    case "scoring": renderScoring(); break;
    case "results": renderResults(); break;
    case "ended": renderEnded(); break;
    default: renderLobby();
  }
}
function sortedPlayers(byScore = false) {
  const entries = Object.entries(state.room?.players || {});
  return entries.sort((a, b) => byScore ? (b[1].score || 0) - (a[1].score || 0) || a[1].joinedAt - b[1].joinedAt : a[1].joinedAt - b[1].joinedAt);
}
function playerOrder() { return sortedPlayers(false).map(([uid]) => uid); }
function playerName(uid) { return state.room?.players?.[uid]?.name || "Unbekannt"; }

function renderLobby() {
  const view = clone("#lobby-template");
  $("#copy-code", view).textContent = state.roomCode;
  const players = sortedPlayers(false); $("#player-count", view).textContent = `${players.length} / ${MAX_PLAYERS}`;
  players.forEach(([uid, player]) => $("#lobby-list", view).append(createPlayerRow(uid, player)));
  const actions = $("#lobby-actions", view);
  if (isHost()) {
    const start = button("Spiel starten", "button-primary", startGame);
    start.disabled = players.length < MIN_PLAYERS || !state.room.deputyId;
    actions.append(start);
    if (players.length < MIN_PLAYERS) actions.prepend(helper(`Mindestens ${MIN_PLAYERS} Personen müssen im Warteraum sein.`));
    else if (!state.room.deputyId) actions.prepend(helper("Bestimme eine Stellvertretung, bevor das Spiel startet."));
  } else actions.append(helper("Die Spielleitung startet, sobald alle da sind."));
  setScreen(view);
}
function createPlayerRow(uid, player) {
  const li = document.createElement("li"); li.className = "player-row";
  li.innerHTML = `<span class="player-avatar">${escapeHtml(player.name.charAt(0).toLocaleUpperCase("de"))}</span><span class="player-name">${escapeHtml(player.name)}</span>`;
  const tags = document.createElement("span"); tags.className = "player-tags";
  const presence = document.createElement("span"); presence.className = `presence ${player.online ? "online" : ""}`; presence.title = player.online ? "Verbunden" : "Nicht verbunden"; tags.append(presence);
  if (uid === state.room.hostId) tags.append(tag("Spielleitung"));
  if (uid === state.room.deputyId) tags.append(tag("Vertretung"));
  li.append(tags);
  if (isHost() && uid !== state.uid) {
    const select = button(uid === state.room.deputyId ? "Vertretung ✓" : "Als Vertretung", "deputy-select", () => setDeputy(uid)); li.append(select);
    const remove = button("×", "remove-player", () => confirmRemove(uid, player.name)); remove.setAttribute("aria-label", `${player.name} entfernen`); li.append(remove);
  }
  return li;
}
async function setDeputy(uid) { await safeUpdate({ deputyId: uid, lastActivity: serverNow() }); }
function confirmRemove(uid, name) {
  showModal("Mitspieler entfernen?", `<p><strong>${escapeHtml(name)}</strong> wird aus dem Warteraum entfernt.</p>`, [
    { label: "Abbrechen", className: "button-ghost", action: closeModal },
    { label: "Entfernen", className: "button-danger", action: async () => { closeModal(); await safeUpdate({ [`players/${uid}`]: null, deputyId: state.room.deputyId === uid ? "" : state.room.deputyId, lastActivity: serverNow() }); } }
  ]);
}
async function startGame() {
  if (!isHost() || playerOrder().length < MIN_PLAYERS || !state.room.deputyId) return;
  await startNextRound(0);
}
async function startNextRound(index) {
  if (!isHost()) return;
  const previousRound = state.room.round || 0;
  if (previousRound) await state.api.remove(photosRef(previousRound)).catch(() => {});
  const order = playerOrder(); const normalizedIndex = index % order.length; const now = serverNow();
  await safeUpdate({
    status: "prompt", paused: false, round: previousRound + 1, turnIndex: normalizedIndex,
    promptGiverId: order[normalizedIndex], prompt: null, phaseEndsAt: null, winners: null,
    lastActivity: now
  });
}

function renderPrompt() {
  const view = clone("#prompt-template");
  $("#prompt-round", view).textContent = `Runde ${state.room.round}`;
  $("#prompt-author", view).textContent = playerName(state.room.promptGiverId);

  const form = $("#prompt-form", view);
  const wait = $("#prompt-wait", view);

  if (isPromptGiver()) {
    form.hidden = false;
    wait.hidden = true;
    const input = $("#prompt-input", view);
    input.value = state.draftPrompt;
    $("#prompt-count", view).textContent = `${input.value.length} / 80`;
  } else {
    form.hidden = true;
    wait.hidden = false;
    wait.innerHTML = `<div class="waiting-eye" aria-hidden="true">◉</div><p><strong>${escapeHtml(playerName(state.room.promptGiverId))}</strong> gibt gerade den Begriff für diese Runde ein.</p>`;
  }

  setScreen(view);
  if (isPromptGiver()) setTimeout(() => $("#prompt-input")?.focus(), 100);
}
async function submitPrompt(form) {
  if (!isPromptGiver() || state.room.status !== "prompt") return;
  const input = $("#prompt-input", form); const error = $("#prompt-error", form);
  const prompt = cleanPrompt(input.value);
  if (prompt.length < 2) { error.textContent = "Bitte gib einen Begriff mit mindestens zwei Zeichen ein."; error.hidden = false; return; }
  $("button[type=submit]", form).disabled = true;
  await safeUpdate({ status: "showing", prompt, phaseEndsAt: serverNow() + PROMPT_MS, lastActivity: serverNow() });
}

function renderPlay() {
  const view = clone("#play-template"); const status = state.room.status;
  $("#round-label", view).textContent = `Runde ${state.room.round}`; $("#prompt-text", view).textContent = state.room.prompt || "…";
  const content = $("#play-content", view);
  if (status === "showing") content.append(helper(isPromptGiver() ? "Dein Begriff wird fünf Sekunden lang angezeigt." : "Merk dir den Begriff – gleich startet die Kamera."));
  else if (isPromptGiver()) content.append(helper("Du setzt diese Runde aus. Warte, während die anderen ihr Motiv suchen."));
  else content.append(createPhotoCapture());
  setScreen(view);
  startPhaseTimer(status === "showing" ? PROMPT_MS : PHOTO_MS, status === "showing" ? "photos" : "scoring");
}
function createPhotoCapture() {
  const wrapper = document.createElement("div"); wrapper.className = "capture-panel";
  const own = state.room.submissions?.[state.uid];
  if (state.imageData) {
    wrapper.innerHTML = `<div class="photo-preview"><img src="${state.imageData}" alt="Vorschau deines Fotos"><span class="photo-status">${own ? "Abgegeben ✓" : "Bereit zum Abschicken"}</span></div>`;
  } else if (own) {
    wrapper.innerHTML = `<div class="submitted-state"><span aria-hidden="true">✓</span><strong>Foto abgegeben</strong><p>Du kannst es bis zum Ablauf der Zeit noch ersetzen.</p></div>`;
  } else {
    wrapper.innerHTML = `<div class="capture-empty"><span class="camera-glyph" aria-hidden="true">▣</span><strong>Finde das Motiv!</strong><p>Nimm ein Foto auf oder wähle eines aus deiner Galerie.</p></div>`;
  }
  const input = document.createElement("input"); input.type = "file"; input.accept = "image/*"; input.capture = "environment"; input.id = "photo-input"; input.className = "sr-only";
  const label = document.createElement("label"); label.htmlFor = "photo-input"; label.className = "button button-secondary capture-button"; label.textContent = own || state.imageData ? "Foto ersetzen" : "Foto aufnehmen";
  input.addEventListener("change", handlePhotoChosen); wrapper.append(input, label);
  if (state.imageData && !own) wrapper.append(button("Foto abschicken", "button-primary", submitPhoto));
  else if (state.imageData && own) wrapper.append(button("Neues Foto abschicken", "button-primary", submitPhoto));
  const upload = document.createElement("p"); upload.id = "upload-status"; upload.className = "upload-status"; upload.setAttribute("role", "status"); wrapper.append(upload);
  return wrapper;
}
async function handlePhotoChosen(event) {
  const file = event.target.files?.[0]; if (!file) return;
  const status = document.querySelector("#upload-status");
  try {
    if (!file.type.startsWith("image/")) throw new Error("Bitte wähle eine Bilddatei aus.");
    if (status) status.textContent = "Foto wird verkleinert …";
    const compressed = await compressImage(file);
    state.imageData = compressed.data; state.imageType = compressed.type;
    renderPlay();
  } catch (error) { if (status) status.textContent = friendlyError(error); }
}
async function compressImage(file) {
  const bitmap = await loadImage(file); const scale = Math.min(1, 720 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas"); canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext("2d", { alpha: false }); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  let data = canvas.toDataURL("image/webp", .68); let type = "image/webp";
  if (!data.startsWith("data:image/webp")) { data = canvas.toDataURL("image/jpeg", .68); type = "image/jpeg"; }
  if (data.length > MAX_IMAGE_CHARS) data = canvas.toDataURL(type, .48);
  if (data.length > MAX_IMAGE_CHARS) throw new Error("Das Foto ist trotz Verkleinerung zu groß. Bitte wähle ein einfacheres Motiv oder fotografiere erneut.");
  return { data, type };
}
async function loadImage(file) {
  if ("createImageBitmap" in window) return createImageBitmap(file, { imageOrientation: "from-image" });
  return new Promise((resolve, reject) => { const img = new Image(); const url = URL.createObjectURL(file); img.onload = () => { URL.revokeObjectURL(url); resolve(img); }; img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Das Foto konnte nicht gelesen werden.")); }; img.src = url; });
}
async function submitPhoto() {
  if (!state.imageData || state.imageUploading || isPromptGiver() || state.room.status !== "photos" || serverNow() > state.room.phaseEndsAt) return;
  state.imageUploading = true; const status = document.querySelector("#upload-status"); if (status) status.textContent = "Foto wird übertragen …";
  try {
    await state.api.set(photosRef(state.room.round, state.uid), { data: state.imageData, type: state.imageType, submittedAt: serverNow(), name: playerName(state.uid) });
    await safeUpdate({ [`submissions/${state.uid}`]: true });
    if (status) status.textContent = "Foto abgegeben ✓";
  } catch (error) { if (status) status.textContent = friendlyError(error); }
  finally { state.imageUploading = false; }
}

function startPhaseTimer(duration, nextStatus) {
  const timer = document.querySelector("#timer"); if (!timer || !state.room.phaseEndsAt) return;
  const tick = async () => {
    const remaining = Math.max(0, state.room.phaseEndsAt - serverNow());
    const seconds = Math.ceil(remaining / 1000); const span = $("span", timer); if (span) span.textContent = seconds;
    timer.style.setProperty("--progress", `${Math.min(100, remaining / duration * 100)}%`); timer.classList.toggle("warning", seconds <= 5);
    if (remaining <= 0) {
      clearInterval(state.timerId); state.timerId = null;
      if (isHost() && !state.phaseTransitioning) await advancePhase(nextStatus);
    }
  };
  tick(); state.timerId = setInterval(tick, 250);
}
async function advancePhase(nextStatus) {
  if (!isHost() || state.phaseTransitioning) return;
  state.phaseTransitioning = true;
  try {
    if (nextStatus === "photos" && state.room.status === "showing") await safeUpdate({ status: "photos", phaseEndsAt: serverNow() + PHOTO_MS, submissions: null, lastActivity: serverNow() });
    if (nextStatus === "scoring" && state.room.status === "photos") await safeUpdate({ status: "scoring", phaseEndsAt: null, lastActivity: serverNow() });
    if (nextStatus === "next" && state.room.status === "results") await startNextRound((state.room.turnIndex || 0) + 1);
  } finally { state.phaseTransitioning = false; }
}

function renderScoring() {
  const view = clone("#scoring-template");
  const isJudge = isPromptGiver();

  const wait = $("#scoring-wait", view);
  const loading = $("#gallery-loading", view);
  const form = $("#scoring-form", view);

  if (wait) wait.hidden = true;
  if (loading) loading.hidden = false;
  if (form) form.hidden = true;

  if (!isJudge && wait) {
    wait.hidden = false;
    wait.innerHTML = `<div class="waiting-eye" aria-hidden="true">◉</div><p><strong>${escapeHtml(playerName(state.room.promptGiverId))}</strong> bewertet gleich die Fotos. Du kannst sie schon ansehen.</p>`;
  }

  setScreen(view);
  loadGallery();
}
async function loadGallery() {
  if (state.galleryLoading) return;
  state.galleryLoading = true;

  try {
    const photos = (await state.api.get(photosRef())).val() || {};
    if (state.room.status !== "scoring") return;

    const gallery = document.querySelector("#photo-gallery");
    const form = document.querySelector("#scoring-form");
    const loading = document.querySelector("#gallery-loading");
    const wait = document.querySelector("#scoring-wait");
    const isJudge = isPromptGiver();

    if (!gallery || !form || !loading) return;

    gallery.replaceChildren();

    const entries = Object.entries(photos).filter(
      ([uid]) => uid !== state.room.promptGiverId && state.room.players?.[uid]
    );

    if (!entries.length) {
      gallery.innerHTML = `<div class="empty-state"><strong>Keine Fotos eingegangen</strong><p>${isJudge ? "Bestätige die Runde ohne Gewinner." : "In dieser Runde wurden keine Fotos eingereicht."}</p></div>`;
    } else {
      entries.forEach(([uid, photo]) => {
        gallery.append(createPhotoOption(uid, photo, isJudge));
      });
    }

    loading.hidden = true;
    if (wait) wait.hidden = isJudge;
    form.hidden = !isJudge;
    state.galleryRound = state.room.round;
  } catch (error) {
    const loading = document.querySelector("#gallery-loading");
    if (loading) loading.innerHTML = `<p class="form-error">${escapeHtml(friendlyError(error))}</p>`;
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
    image.addEventListener("click", () => openPhoto(photo.data, player));

    const footer = document.createElement("div");
    footer.className = "photo-footer";
    footer.innerHTML = `<strong>${escapeHtml(player)}</strong><button type="button" class="zoom-button" aria-label="Foto von ${escapeHtml(player)} vergrößern">↗</button>`;

    $("button", footer).addEventListener("click", (event) => {
      event.preventDefault();
      openPhoto(photo.data, player);
    });

    item.append(image, footer);
    return item;
  }

  const item = document.createElement("label");
  item.className = "photo-option";

  const input = document.createElement("input");
  input.type = "checkbox";
  input.name = "winner";
  input.value = uid;

  const image = document.createElement("img");
  image.src = photo.data;
  image.alt = `Foto von ${player}`;
  image.loading = "lazy";
  image.addEventListener("click", (event) => {
    event.preventDefault();
    openPhoto(photo.data, player);
  });

  const footer = document.createElement("span");
  footer.className = "photo-footer";
  footer.innerHTML = `<span class="photo-check">✓</span><strong>${escapeHtml(player)}</strong><button type="button" class="zoom-button" aria-label="Foto von ${escapeHtml(player)} vergrößern">↗</button>`;

  $("button", footer).addEventListener("click", (event) => {
    event.preventDefault();
    openPhoto(photo.data, player);
  });

  item.append(input, image, footer);
  return item;
}
function openPhoto(src, name) { showModal(`Foto von ${name}`, `<img class="photo-large" src="${src}" alt="Foto von ${escapeHtml(name)}">`, [{ label: "Schließen", className: "button-primary", action: closeModal }]); }
async function submitScoring(form) {
  if (!isPromptGiver() || state.room.status !== "scoring") return;
  const winners = $$('input[name="winner"]:checked', form).map((input) => input.value);
  const patch = { winners: winners.length ? Object.fromEntries(winners.map((uid) => [uid, true])) : null, status: "results", phaseEndsAt: serverNow() + RESULTS_MS, submissions: null, lastActivity: serverNow() };
  winners.forEach((uid) => { patch[`players/${uid}/score`] = (state.room.players?.[uid]?.score || 0) + 1; });
  $("button[type=submit]", form).disabled = true;
  await safeUpdate(patch);
}

function renderResults() {
  const view = clone("#results-template"); const winners = Object.keys(state.room.winners || {});
  $("#result-title", view).textContent = winners.length ? `${winners.length === 1 ? "Ein Punkt" : "Punkte"} für …` : "Diesmal kein Punkt";
  $("#winner-copy", view).textContent = winners.length ? winners.map(playerName).join(", ") : "Keines der Fotos wurde ausgewählt.";
  appendLeaderboard($("#leaderboard", view));
  const actions = $("#result-actions", view);
  if (isHost()) actions.append(button("Nächste Runde", "button-primary", () => startNextRound((state.room.turnIndex || 0) + 1)));
  actions.append(button("Spiel beenden", "button-ghost", confirmEndGame));
  setScreen(view);
  if (winners.includes(state.uid) && state.confettiRound !== state.room.round) { state.confettiRound = state.room.round; launchConfetti(); }
  startResultsTimer();
}
function startResultsTimer() {
  if (!state.room.phaseEndsAt) return;
  state.timerId = setInterval(async () => {
    if (state.room?.status === "results" && state.room.phaseEndsAt <= serverNow()) { clearInterval(state.timerId); state.timerId = null; if (isHost()) await advancePhase("next"); }
  }, 250);
}
function appendLeaderboard(list) {
  sortedPlayers(true).forEach(([uid, player]) => {
    const li = document.createElement("li"); if (uid === state.uid) li.classList.add("me"); if (state.room.winners?.[uid]) li.classList.add("winner");
    li.innerHTML = `<span class="rank-name">${escapeHtml(player.name)}</span><strong class="score">${player.score || 0}</strong>`; list.append(li);
  });
}
function showLeaderboard() {
  if (!state.room) return;
  const ol = document.createElement("ol"); ol.className = "leaderboard modal-leaderboard"; appendLeaderboard(ol);
  showModal("Punktestand", ol.outerHTML, [{ label: "Schließen", className: "button-primary", action: closeModal }]);
}
function confirmEndGame() {
  if (!isHost()) return showModal("Nur die Spielleitung", "<p>Nur die Spielleitung kann das Spiel beenden.</p>", [{ label: "OK", className: "button-primary", action: closeModal }]);
  showModal("Spiel beenden?", "<p>Der aktuelle Punktestand wird zur Abschlussansicht. Alle Fotos werden gelöscht.</p>", [
    { label: "Weiterspielen", className: "button-ghost", action: closeModal },
    { label: "Spiel beenden", className: "button-danger", action: endGame }
  ]);
}
async function endGame() { closeModal(); await state.api.remove(state.api.ref(state.db, `photos/${state.roomCode}`)).catch(() => {}); await safeUpdate({ status: "ended", phaseEndsAt: null, submissions: null, lastActivity: serverNow() }); }
function renderEnded() {
  const view = clone("#ended-template"); const ranking = sortedPlayers(true); const top = ranking[0]?.[1]?.score || 0;
  const names = ranking.filter(([, player]) => (player.score || 0) === top).map(([, player]) => player.name);
  $("#final-winner-copy", view).textContent = names.length > 1 ? `${names.join(" und ")} teilen sich mit ${top} Punkten den Sieg.` : `${names[0] || "Niemand"} gewinnt mit ${top} Punkten.`;
  appendLeaderboard($("#final-leaderboard", view)); const actions = $("#ended-actions", view);
  if (isHost()) { actions.append(button("Revanche", "button-primary", rematch)); actions.append(button("Raum schließen", "button-ghost", closeRoom)); }
  else actions.append(button("Zur Startseite", "button-secondary", leaveToHome));
  setScreen(view);
}
async function rematch() {
  const patch = { status: "lobby", round: 0, turnIndex: null, promptGiverId: null, prompt: null, phaseEndsAt: null, winners: null, submissions: null, paused: false, lastActivity: serverNow() };
  Object.keys(state.room.players || {}).forEach((uid) => { patch[`players/${uid}/score`] = 0; }); await safeUpdate(patch);
}
async function closeRoom() { if (!isHost()) return; await state.api.remove(state.api.ref(state.db, `photos/${state.roomCode}`)).catch(() => {}); await state.api.remove(roomRef()); }

function renderPaused() {
  const section = document.createElement("section"); section.className = "screen loading-screen";
  section.innerHTML = `<p class="eyebrow">Spiel pausiert</p><h1>Verbindung zur Spielleitung unterbrochen</h1><p>Das Spiel wartet bis zu zwei Minuten auf die Rückkehr.</p><p class="score" id="pause-countdown"></p>`;
  const takeover = button("Spielleitung übernehmen", "button-primary", takeOverHost); takeover.hidden = true; section.append(takeover); setScreen(section);
  const tick = () => { const host = state.room.players?.[state.room.hostId]; const elapsed = Math.max(0, serverNow() - (host?.lastSeen || serverNow())); const remaining = Math.max(0, 120000 - elapsed); $("#pause-countdown").textContent = `${Math.ceil(remaining / 1000)} s`; takeover.hidden = !(isDeputy() && remaining <= 0); };
  tick(); state.pausedTimerId = setInterval(tick, 500);
}
async function takeOverHost() {
  if (!isDeputy()) return; const host = state.room.players?.[state.room.hostId]; if (serverNow() - (host?.lastSeen || serverNow()) < 120000) return;
  const patch = { hostId: state.uid, paused: false, lastActivity: serverNow() };
  if (state.room.status === "showing") patch.phaseEndsAt = serverNow() + PROMPT_MS;
  if (state.room.status === "photos") patch.phaseEndsAt = serverNow() + PHOTO_MS;
  if (state.room.status === "results") patch.phaseEndsAt = serverNow() + RESULTS_MS;
  await safeUpdate(patch);
}

async function handleRemovedOrClosed() {
  if (state.uid && state.db) try { await state.api.remove(state.api.ref(state.db, `sessions/${state.uid}`)); } catch (_) {}
  disconnectRoomListener(); state.roomCode = null; state.room = null; roomPill.hidden = true; scoreButton.hidden = true; showHome();
  showModal("Spiel beendet", "<p>Der Raum wurde geschlossen oder du wurdest aus dem Warteraum entfernt.</p>", [{ label: "OK", className: "button-primary", action: closeModal }]);
}
async function leaveToHome() {
  closeModal();
  if (state.uid && state.db) try {
    if (state.roomCode && !isHost()) await state.api.remove(roomRef(`players/${state.uid}`));
    await state.api.remove(state.api.ref(state.db, `sessions/${state.uid}`));
  } catch (_) {}
  disconnectRoomListener(); state.roomCode = null; state.room = null; showHome();
}
function requestLeave() {
  if (!state.roomCode) return showHome();
  showModal("Spiel verlassen?", `<p>${isHost() ? "Als Spielleitung solltest du den Raum über „Spiel beenden“ schließen." : "Möchtest du das laufende Spiel verlassen?"}</p>`, [
    { label: "Im Spiel bleiben", className: "button-ghost", action: closeModal },
    { label: "Verlassen", className: "button-danger", action: leaveToHome }
  ]);
}
function showRules() {
  showModal("So funktioniert’s", `<ol class="rules-list"><li>Drei bis acht Personen treten einem Raum bei.</li><li>Reihum gibt jemand einen freien Begriff ein.</li><li>Der Begriff erscheint fünf Sekunden auf allen Geräten.</li><li>Alle anderen haben 30 Sekunden für ein passendes Foto.</li><li>Der Begriffgeber wählt beliebig viele erfüllte Fotos aus.</li><li>Jede Auswahl gibt einen Punkt. Gewinner sehen Konfetti.</li></ol><p class="privacy-note">Fotos werden verkleinert übertragen, sind nur für die Spielgruppe sichtbar und werden vor der nächsten Runde gelöscht.</p>`, [{ label: "Verstanden", className: "button-primary", action: closeModal }]);
}

function helper(text) { const p = document.createElement("p"); p.className = "phase-message"; p.textContent = text; return p; }
function tag(text) { const span = document.createElement("span"); span.className = "tag"; span.textContent = text; return span; }
function button(label, className, handler) { const el = document.createElement("button"); el.type = "button"; el.className = className.includes("button") ? `button ${className}` : className; el.textContent = label; el.addEventListener("click", handler); return el; }
async function safeUpdate(patch) { try { await state.api.update(roomRef(), patch); } catch (error) { showFatal("Änderung nicht möglich", error); throw error; } }
function showFatal(title, error) { showModal(title, `<p>${escapeHtml(friendlyError(error))}</p>`, [{ label: "Schließen", className: "button-primary", action: closeModal }]); }
function friendlyError(error) {
  const code = error?.code || ""; if (code.includes("permission-denied")) return "Firebase hat den Zugriff abgelehnt. Prüfe, ob database.rules.json veröffentlicht wurde.";
  if (code.includes("network")) return "Keine Verbindung. Bitte prüfe das Netz und versuche es erneut.";
  return error?.message || "Es ist ein unerwarteter Fehler aufgetreten.";
}
function escapeHtml(value = "") { const div = document.createElement("div"); div.textContent = value; return div.innerHTML; }
function showModal(title, body, actions = []) {
  closeModal(); const backdrop = document.createElement("div"); backdrop.className = "modal-backdrop";
  const modal = document.createElement("section"); modal.className = "modal"; modal.setAttribute("role", "dialog"); modal.setAttribute("aria-modal", "true"); modal.setAttribute("aria-labelledby", "modal-title");
  modal.innerHTML = `<div class="modal-header"><h2 id="modal-title">${escapeHtml(title)}</h2><button class="modal-close" type="button" aria-label="Schließen">×</button></div><div class="modal-body">${body}</div>`;
  $(".modal-close", modal).addEventListener("click", closeModal);
  if (actions.length) { const footer = document.createElement("div"); footer.className = "modal-actions"; actions.forEach((item) => footer.append(button(item.label, item.className, item.action))); modal.append(footer); }
  backdrop.append(modal); modalRoot.append(backdrop); setTimeout(() => $(".modal-close", modal)?.focus(), 20);
}
function closeModal() { modalRoot.replaceChildren(); }

function launchConfetti() {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const canvas = document.querySelector("#confetti"); const ctx = canvas.getContext("2d"); const dpr = Math.min(devicePixelRatio || 1, 2);
  canvas.width = innerWidth * dpr; canvas.height = innerHeight * dpr; ctx.scale(dpr, dpr);
  const colors = ["#009D43", "#EB6608", "#FFCB03", "#009CC4", "#ffffff"];
  const pieces = Array.from({ length: 100 }, () => ({ x: innerWidth / 2, y: innerHeight * .28, vx: (Math.random() - .5) * 13, vy: -Math.random() * 11 - 3, g: .24 + Math.random() * .12, r: Math.random() * 6, s: 5 + Math.random() * 7, c: colors[Math.floor(Math.random() * colors.length)] }));
  let frame = 0; const draw = () => { ctx.clearRect(0, 0, innerWidth, innerHeight); pieces.forEach((p) => { p.x += p.vx; p.y += p.vy; p.vy += p.g; p.r += .18; ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r); ctx.fillStyle = p.c; ctx.fillRect(-p.s / 2, -p.s / 3, p.s, p.s * .65); ctx.restore(); }); if (frame++ < 150) requestAnimationFrame(draw); else ctx.clearRect(0, 0, innerWidth, innerHeight); }; draw();
}

async function initializeFirebase() {
  if (!firebaseIsConfigured) { showHome(); return; }
  try {
    const [appModule, authModule, databaseModule] = await Promise.all([import(`${FIREBASE_BASE}/firebase-app.js`), import(`${FIREBASE_BASE}/firebase-auth.js`), import(`${FIREBASE_BASE}/firebase-database.js`)]);
    const app = appModule.initializeApp(firebaseConfig); state.auth = authModule.getAuth(app); state.db = databaseModule.getDatabase(app); state.api = { ...authModule, ...databaseModule };
    databaseModule.onValue(databaseModule.ref(state.db, ".info/serverTimeOffset"), (snapshot) => { state.serverOffset = snapshot.val() || 0; });
    authModule.onAuthStateChanged(state.auth, async (user) => { if (!user) return; state.uid = user.uid; setConnection(true); await restoreSession(); });
    if (!state.auth.currentUser) await authModule.signInAnonymously(state.auth);
  } catch (error) { console.error(error); setConnection(false); showHome(); showFatal("Firebase konnte nicht gestartet werden", error); }
}

appRoot.addEventListener("click", (event) => {
  const action = event.target.closest("[data-action]")?.dataset.action;
  if (action === "show-create") showEntry("create"); if (action === "show-join") showEntry("join"); if (action === "show-rules") showRules(); if (action === "home") showHome();
  if (event.target.closest("#copy-code")) navigator.clipboard?.writeText(state.roomCode).then(() => { event.target.closest("#copy-code").textContent = "Kopiert!"; setTimeout(() => { const code = document.querySelector("#copy-code"); if (code) code.textContent = state.roomCode; }, 900); });
});
appRoot.addEventListener("input", (event) => {
  if (event.target.id === "room-code") event.target.value = event.target.value.replace(/\D/g, "").slice(0, 4);
  if (event.target.id === "prompt-input") { state.draftPrompt = event.target.value.slice(0, 80); const count = document.querySelector("#prompt-count"); if (count) count.textContent = `${state.draftPrompt.length} / 80`; }
});
appRoot.addEventListener("submit", async (event) => {
  event.preventDefault(); const form = event.target;
  if (form.id === "entry-form") {
    const name = cleanName($("#player-name", form).value); const error = $("#form-error", form);
    if (name.length < 2) { error.textContent = "Bitte gib mindestens zwei Zeichen ein."; error.hidden = false; return; }
    const submit = $("button[type=submit]", form); submit.disabled = true;
    try { form.dataset.mode === "create" ? await createRoom(name) : await joinRoom($("#room-code", form).value, name); }
    catch (err) { error.textContent = friendlyError(err); error.hidden = false; submit.disabled = false; }
  }
  if (form.id === "prompt-form") await submitPrompt(form);
  if (form.id === "scoring-form") await submitScoring(form);
});
document.querySelector("#brand-home").addEventListener("click", requestLeave);
scoreButton.addEventListener("click", showLeaderboard);
window.addEventListener("online", () => setConnection(true)); window.addEventListener("offline", () => setConnection(false));
window.addEventListener("keydown", (event) => { if (event.key === "Escape") closeModal(); });
if ("serviceWorker" in navigator) window.addEventListener("load", () => navigator.serviceWorker.register("./service-worker.js").catch(console.warn));
initializeFirebase();
