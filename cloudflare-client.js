const API_BASE_URL = "https://simchas-gallery.0534169095.workers.dev";
const TOKEN_STORAGE_KEY = "simchas_gallery_google_id_token";
const GOOGLE_WEB_CLIENT_ID = "601586229891-giorl13mdpu7kfbeb6h2aj6qjpkphmmo.apps.googleusercontent.com";

// ✅ FIX: הגדלת buffer מ-60 שניות ל-5 דקות למניעת בקשות כושלות ברגע האחרון
const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000;

// ✅ FIX: הפחתת מספר הניסיונות מ-80 ל-30 (7.5 שניות מקס' במקום 20)
const GOOGLE_LIBRARY_MAX_ATTEMPTS = 30;

const authState = { currentUser: null, listeners: new Set(), ready: false };

function decodeJwtPayload(token) {
  try {
    const part = String(token || "").split(".")[1];
    if (!part) return null;
    const normalized = part.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const bytes = Uint8Array.from(atob(padded), char => char.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

function tokenIsUsable(token) {
  const payload = decodeJwtPayload(token);
  // ✅ FIX: שימוש ב-TOKEN_EXPIRY_BUFFER_MS במקום 60_000 הקשיח
  return Boolean(payload?.sub && Number(payload.exp || 0) * 1000 > Date.now() + TOKEN_EXPIRY_BUFFER_MS);
}

function userFromToken(token) {
  const payload = decodeJwtPayload(token);
  if (!payload?.sub) return null;
  return {
    uid: String(payload.sub),
    email: String(payload.email || ""),
    emailVerified: payload.email_verified === true || payload.email_verified === "true",
    displayName: String(payload.name || payload.given_name || "משתמש Google"),
    photoURL: String(payload.picture || ""),
    isAnonymous: false,
    providerData: [{ providerId: "google.com" }],
    async getIdToken() {
      const storedToken = sessionStorage.getItem(TOKEN_STORAGE_KEY) || "";
      if (!tokenIsUsable(storedToken)) {
        await setGoogleIdToken("");
        const error = new Error("תוקף ההתחברות הסתיים. התחבר מחדש.");
        error.code = "unauthenticated";
        throw error;
      }
      return storedToken;
    }
  };
}

function notifyAuthListeners() {
  for (const listener of authState.listeners) {
    queueMicrotask(() => listener(authState.currentUser));
  }
}

export async function setGoogleIdToken(token) {
  const value = String(token || "");
  if (value && tokenIsUsable(value)) {
    sessionStorage.setItem(TOKEN_STORAGE_KEY, value);
    authState.currentUser = userFromToken(value);
  } else {
    sessionStorage.removeItem(TOKEN_STORAGE_KEY);
    authState.currentUser = null;
  }
  authState.ready = true;
  notifyAuthListeners();
  return authState.currentUser;
}

function bootstrapAuth() {
  if (authState.ready) return;
  const token = sessionStorage.getItem(TOKEN_STORAGE_KEY) || "";
  authState.currentUser = tokenIsUsable(token) ? userFromToken(token) : null;
  if (!authState.currentUser) sessionStorage.removeItem(TOKEN_STORAGE_KEY);
  authState.ready = true;
}

export function initializeApp(config = {}) {
  return { config, name: "simchas-gallery-cloudflare" };
}

export function getAuth() {
  bootstrapAuth();
  return {
    get currentUser() { return authState.currentUser; },
    useDeviceLanguage() {}
  };
}

export class GoogleAuthProvider {
  setCustomParameters() {}
  static credential(idToken) { return { idToken }; }
}

export async function signInWithCredential(_auth, credential) {
  const user = await setGoogleIdToken(credential?.idToken || "");
  if (!user) {
    const error = new Error("אסימון Google אינו תקין.");
    error.code = "invalid-credential";
    throw error;
  }
  return { user };
}

export async function signOut() {
  await setGoogleIdToken("");
}

export function onAuthStateChanged(_auth, callback) {
  bootstrapAuth();
  authState.listeners.add(callback);
  queueMicrotask(() => callback(authState.currentUser));
  return () => authState.listeners.delete(callback);
}

export async function signInAnonymously() { return { user: null }; }
export async function signInWithCustomToken() { return { user: null }; }
export async function signInWithPopup() {
  throw Object.assign(new Error("יש להשתמש בחלון Google."), { code: "google-prompt-required" });
}
export async function signInWithRedirect() {
  throw Object.assign(new Error("יש להשתמש בחלון Google."), { code: "google-prompt-required" });
}
export async function getRedirectResult() { return null; }

export function getFirestore() { return { type: "cloudflare-d1" }; }

function makeReference(type, segments, constraints = []) {
  return { type, segments: segments.map(String), constraints };
}

export function collection(_db, ...segments) { return makeReference("collection", segments); }
export function doc(_db, ...segments) { return makeReference("document", segments); }

// ✅ FIX: הוספת where() שהייתה חסרה לחלוטין — הקוד היה קורס בשקט בכל שימוש בה
export function where(field, operator, value) {
  return { kind: "where", field: String(field), operator: String(operator), value };
}

export function orderBy(field, direction = "asc") {
  return { kind: "orderBy", field: String(field), direction: direction === "desc" ? "desc" : "asc" };
}

export function limit(value) {
  return { kind: "limit", value: Math.max(1, Number(value) || 5000) };
}

export function query(reference, ...constraints) {
  return makeReference(reference.type, reference.segments, constraints);
}

export function increment(amount = 1) {
  return { __cloudflareOperation: "increment", amount: Number(amount) || 0 };
}

function collectionName(reference) {
  return reference.type === "document" ? reference.segments.at(-2) : reference.segments.at(-1);
}

function documentId(reference) {
  return reference.segments.at(-1);
}

async function apiRequest(path, options = {}) {
  bootstrapAuth();
  const user = authState.currentUser;
  if (!user) {
    const error = new Error("יש להתחבר באמצעות Google.");
    error.code = "unauthenticated";
    throw error;
  }
  const token = await user.getIdToken();
  const headers = new Headers(options.headers || {});
  headers.set("Authorization", `Bearer ${token}`);
  if (options.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(`${API_BASE_URL}${path}`, { ...options, headers });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload?.message || `שגיאת מסד נתונים (${response.status}).`);
    error.code = payload?.code || "unavailable";
    error.status = response.status;
    throw error;
  }
  return payload;
}

function documentSnapshot(id, data, exists = true) {
  return {
    id,
    exists: () => exists,
    data: () => exists ? structuredClone(data || {}) : undefined
  };
}

export async function getDoc(reference) {
  const name = encodeURIComponent(collectionName(reference));
  const id = encodeURIComponent(documentId(reference));
  try {
    const payload = await apiRequest(`/data/${name}/${id}`);
    return documentSnapshot(payload.id, payload.data, true);
  } catch (error) {
    if (error.status === 404) return documentSnapshot(documentId(reference), undefined, false);
    throw error;
  }
}

export async function getDocs(reference) {
  const params = new URLSearchParams();
  for (const constraint of reference.constraints || []) {
    if (constraint.kind === "orderBy") {
      params.set("orderBy", constraint.field);
      params.set("direction", constraint.direction);
    } else if (constraint.kind === "limit") {
      params.set("limit", String(constraint.value));
    } else if (constraint.kind === "where") {
      // ✅ FIX: העברת where constraints ל-API (בעבר נבלעו ונשכחו)
      params.append("where", JSON.stringify({
        field: constraint.field,
        op: constraint.operator,
        value: constraint.value
      }));
    }
  }
  const suffix = params.size ? `?${params}` : "";
  const payload = await apiRequest(`/data/${encodeURIComponent(collectionName(reference))}${suffix}`);
  const docs = (payload.documents || []).map(item => documentSnapshot(item.id, item.data, true));
  return { docs, empty: docs.length === 0, size: docs.length, forEach: callback => docs.forEach(callback) };
}

export async function setDoc(reference, data, options = {}) {
  return apiRequest(
    `/data/${encodeURIComponent(collectionName(reference))}/${encodeURIComponent(documentId(reference))}`,
    { method: "PUT", body: JSON.stringify({ data, merge: options?.merge === true }) }
  );
}

export async function updateDoc(reference, data) {
  return setDoc(reference, data, { merge: true });
}

export async function deleteDoc(reference) {
  return apiRequest(
    `/data/${encodeURIComponent(collectionName(reference))}/${encodeURIComponent(documentId(reference))}`,
    { method: "DELETE" }
  );
}

// --- Google Button Logic ---
let googleButtonLibraryPromise = null;
let googleButtonObserver = null;

function waitForGoogleIdentityLibrary() {
  if (window.google?.accounts?.id) return Promise.resolve(window.google.accounts.id);
  if (googleButtonLibraryPromise) return googleButtonLibraryPromise;
  googleButtonLibraryPromise = new Promise((resolve, reject) => {
    let attempts = 0;
    const check = () => {
      const googleIdentity = window.google?.accounts?.id;
      if (googleIdentity) { resolve(googleIdentity); return; }
      attempts += 1;
      if (attempts >= GOOGLE_LIBRARY_MAX_ATTEMPTS) {
        // ✅ FIX: הודעת שגיאה ברורה יותר למשתמש
        reject(new Error("ספריית ההתחברות של Google לא נטענה. רענן את הדף ונסה שוב."));
        return;
      }
      setTimeout(check, 250);
    };
    check();
  });
  return googleButtonLibraryPromise;
}

async function handleOfficialGoogleCredential(response) {
  if (!response?.credential) {
    window.showNotification?.("Google לא החזירה פרטי התחברות.", false);
    return;
  }
  try {
    const user = await setGoogleIdToken(response.credential);
    if (!user) throw new Error("אסימון Google אינו תקין.");
    window.showNotification?.("התחברת בהצלחה באמצעות Google!", true);
  } catch (error) {
    console.error("Official Google button sign-in failed:", error);
    window.showNotification?.(error?.message || "ההתחברות באמצעות Google נכשלה.", false);
  }
}

function findLegacyGoogleButtons(root = document) {
  if (!root?.querySelectorAll) return [];
  return [...root.querySelectorAll(
    'button[onclick*="signInWithGoogleAccount"], a[onclick*="signInWithGoogleAccount"]'
  )];
}

async function replaceLegacyGoogleButton(button) {
  if (!button || button.dataset.googleButtonReplacementStarted === "true") return;
  button.dataset.googleButtonReplacementStarted = "true";

  const host = document.createElement("div");
  host.dataset.officialGoogleButtonHost = "true";
  host.setAttribute("role", "group");
  host.setAttribute("aria-label", "התחברות באמצעות Google");
  host.style.cssText = "display:flex;justify-content:center;align-items:center;width:100%;min-height:44px;direction:ltr;";
  if (button.id) host.id = button.id;

  // ✅ FIX: בדיקה שה-button עדיין ב-DOM לפני ה-replaceWith
  if (!button.isConnected) return;
  button.replaceWith(host);

  try {
    const googleIdentity = await waitForGoogleIdentityLibrary();

    // ✅ FIX: בדיקה שה-host עדיין ב-DOM אחרי ה-await (מניעת race condition)
    if (!host.isConnected) return;

    googleIdentity.initialize({
      client_id: GOOGLE_WEB_CLIENT_ID,
      callback: handleOfficialGoogleCredential,
      context: "signin",
      ux_mode: "popup",
      auto_select: false,
      cancel_on_tap_outside: false
    });
    const availableWidth = Math.round(host.getBoundingClientRect().width || 320);
    googleIdentity.renderButton(host, {
      type: "standard",
      theme: "outline",
      size: "large",
      text: "signin_with",
      shape: "pill",
      logo_alignment: "left",
      locale: "he",
      width: Math.max(240, Math.min(400, availableWidth))
    });
  } catch (error) {
    console.error("Rendering the official Google button failed:", error);
    // ✅ FIX: בדיקת isConnected גם בטיפול בשגיאה
    if (!host.isConnected) return;
    const fallback = document.createElement("button");
    fallback.type = "button";
    fallback.textContent = "התחברות באמצעות Google";
    fallback.style.cssText = "width:100%;min-height:44px;";
    fallback.onclick = () => window.showNotification?.(error?.message || "לא ניתן לטעון את Google.", false);
    host.replaceChildren(fallback);
  }
}

function installOfficialGoogleButtons(root = document) {
  for (const button of findLegacyGoogleButtons(root)) {
    replaceLegacyGoogleButton(button);
  }
}

function startOfficialGoogleButtonUpgrade() {
  installOfficialGoogleButtons();
  if (googleButtonObserver) return;
  googleButtonObserver = new MutationObserver(mutations => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (!(node instanceof Element)) continue;
        if (node.matches?.('button[onclick*="signInWithGoogleAccount"], a[onclick*="signInWithGoogleAccount"]')) {
          replaceLegacyGoogleButton(node);
        }
        installOfficialGoogleButtons(node);
      }
    }
  });
  googleButtonObserver.observe(document.documentElement, { childList: true, subtree: true });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", startOfficialGoogleButtonUpgrade, { once: true });
} else {
  startOfficialGoogleButtonUpgrade();
}
