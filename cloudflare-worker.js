const DEFAULT_FIREBASE_API_KEY = "AIzaSyCELVhy_L5dkGAVsY5in57Yv6-wdM3wHY4";
const DEFAULT_FIREBASE_PROJECT_ID = "simchas-bb35c";
const DEFAULT_FIREBASE_APP_ID = "org-gallery";
const INITIAL_SUPER_ADMIN_EMAIL_SHA256 = "d2632af59d29239eef52f10e1cfbf38e27c65c55470b355134b1cd1fb4f809d6";
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const OPENAI_VISION_MODEL = "gpt-5.4-mini";
const FACE_API_VERSION = "1.7.15";
const FACE_API_CDN_BASE = `https://cdn.jsdelivr.net/npm/@vladmandic/face-api@${FACE_API_VERSION}`;

const FACE_ASSETS = new Map([
  ["face-api.js", { upstreamPath: "dist/face-api.js", contentType: "application/javascript; charset=utf-8" }],
  ["model/ssd_mobilenetv1_model-weights_manifest.json", { upstreamPath: "model/ssd_mobilenetv1_model-weights_manifest.json", contentType: "application/json; charset=utf-8" }],
  ["model/ssd_mobilenetv1_model.bin", { upstreamPath: "model/ssd_mobilenetv1_model.bin", contentType: "application/octet-stream" }],
  ["model/face_landmark_68_model-weights_manifest.json", { upstreamPath: "model/face_landmark_68_model-weights_manifest.json", contentType: "application/json; charset=utf-8" }],
  ["model/face_landmark_68_model.bin", { upstreamPath: "model/face_landmark_68_model.bin", contentType: "application/octet-stream" }],
  ["model/face_recognition_model-weights_manifest.json", { upstreamPath: "model/face_recognition_model-weights_manifest.json", contentType: "application/json; charset=utf-8" }],
  ["model/face_recognition_model.bin", { upstreamPath: "model/face_recognition_model.bin", contentType: "application/octet-stream" }]
]);

const ALLOWED_ORIGINS = new Set([
  "https://shmuel-lamed.github.io",
  "https://0534169095-star.github.io",
  "https://xn--4dbjbascrao3i.com",
  "https://www.xn--4dbjbascrao3i.com"
]);

const ALLOWED_IMAGE_TYPES = new Map([
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/webp", "webp"],
  ["image/gif", "gif"]
]);

const ALLOWED_VIDEO_TYPES = new Map([
  ["video/mp4", "mp4"],
  ["video/webm", "webm"]
]);

function corsHeaders(request) {
  const origin = request.headers.get("Origin");
  return {
    ...(origin && ALLOWED_ORIGINS.has(origin)
      ? { "Access-Control-Allow-Origin": origin }
      : {}),
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
}

function json(request, data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders(request),
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    }
  });
}

function apiError(message, status = 400, code = "request_failed") {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function firebaseConfig(env) {
  return {
    apiKey: String(env.FIREBASE_API_KEY || DEFAULT_FIREBASE_API_KEY).trim(),
    projectId: String(env.FIREBASE_PROJECT_ID || DEFAULT_FIREBASE_PROJECT_ID).trim(),
    appId: String(env.FIREBASE_APP_ID || DEFAULT_FIREBASE_APP_ID).trim()
  };
}

function getBearerToken(request) {
  const header = request.headers.get("Authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) throw apiError("נדרשת התחברות לחשבון מאושר.", 401, "authentication_required");
  return match[1];
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(String(value || "").trim().toLowerCase());
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function verifyFirebaseAccount(idToken, env) {
  const { apiKey } = firebaseConfig(env);
  const response = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken })
    }
  );

  if (!response.ok) {
    throw apiError("תוקף ההתחברות הסתיים. התחבר מחדש ונסה שוב.", 401, "invalid_token");
  }

  const payload = await response.json();
  const account = payload.users?.[0];
  if (!account?.localId || account.disabled) {
    throw apiError("החשבון אינו זמין.", 403, "account_unavailable");
  }
  if (!account.email || account.emailVerified !== true) {
    throw apiError("נדרש חשבון Google בעל כתובת דוא״ל מאומתת.", 403, "email_not_verified");
  }
  return account;
}

function firestoreString(fields, name) {
  return fields?.[name]?.stringValue || "";
}

async function readUserProfile(uid, idToken, env) {
  const { projectId, appId } = firebaseConfig(env);
  const path = [
    "artifacts",
    appId,
    "public",
    "data",
    "userProfiles",
    uid
  ].map(encodeURIComponent).join("/");
  const response = await fetch(
    `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents/${path}`,
    { headers: { "Authorization": `Bearer ${idToken}` } }
  );

  if (response.status === 404) {
    throw apiError("פרופיל המשתמש עדיין לא נוצר. רענן את האתר ונסה שוב.", 403, "profile_missing");
  }
  if (!response.ok) {
    throw apiError("לא ניתן לבדוק את הרשאות המשתמש.", 403, "profile_unavailable");
  }
  const document = await response.json();
  return {
    status: firestoreString(document.fields, "status"),
    role: firestoreString(document.fields, "role")
  };
}

async function requireUser(request, env, allowedRoles = null) {
  const idToken = getBearerToken(request);
  const account = await verifyFirebaseAccount(idToken, env);
  const isInitialSuperAdmin = await sha256(account.email) === INITIAL_SUPER_ADMIN_EMAIL_SHA256;
  const profile = isInitialSuperAdmin
    ? { status: "approved", role: "super_admin" }
    : await readUserProfile(account.localId, idToken, env);

  if (profile.status === "blocked") {
    throw apiError("החשבון חסום ואינו מורשה לבצע פעולות.", 403, "account_blocked");
  }
  if (profile.status !== "approved") {
    throw apiError("החשבון עדיין ממתין לאישור מנהל.", 403, "approval_required");
  }
  if (allowedRoles && !allowedRoles.includes(profile.role)) {
    throw apiError("לחשבון אין הרשאה לבצע פעולה זו.", 403, "permission_denied");
  }

  return {
    uid: account.localId,
    email: account.email,
    role: profile.role,
    idToken
  };
}

function safeImageId(value) {
  const id = String(value || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 120);
  if (!id) throw apiError("מזהה התמונה אינו תקין.", 400, "invalid_image_id");
  return id;
}

function decodeObjectKey(pathname, prefix) {
  const encoded = pathname.slice(prefix.length);
  if (!encoded) throw apiError("חסר מזהה קובץ.", 400, "missing_object_key");
  const key = encoded.split("/").map(part => decodeURIComponent(part)).join("/");
  if (
    key.includes("..") ||
    key.startsWith("/") ||
    (!key.startsWith("approved/") && !key.startsWith("pending/"))
  ) {
    throw apiError("מזהה הקובץ אינו תקין.", 400, "invalid_object_key");
  }
  return key;
}

function mediaUrl(request, key) {
  const origin = new URL(request.url).origin;
  const encodedKey = key.split("/").map(encodeURIComponent).join("/");
  return `${origin}/media/${encodedKey}`;
}

async function uploadImage(request, env) {
  const user = await requireUser(request, env, ["viewer", "uploader", "admin", "super_admin"]);
  const form = await request.formData();
  const file = form.get("file");
  if (!file || typeof file.arrayBuffer !== "function") {
    throw apiError("לא צורף קובץ תמונה.", 400, "file_missing");
  }

  const mimeType = String(file.type || "").toLowerCase();
  const isVideo = ALLOWED_VIDEO_TYPES.has(mimeType);
  const extension = ALLOWED_IMAGE_TYPES.get(mimeType) || ALLOWED_VIDEO_TYPES.get(mimeType);
  if (!extension) {
    throw apiError("סוג הקובץ אינו נתמך. אפשר להעלות JPG, PNG, WEBP, GIF, MP4 או WEBM.", 415, "unsupported_file_type");
  }
  const maximumBytes = isVideo ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
  if (!Number.isFinite(file.size) || file.size <= 0 || file.size > maximumBytes) {
    throw apiError(isVideo ? "גודל הסרטון חייב להיות עד 100MB." : "גודל התמונה חייב להיות עד 10MB.", 413, "file_too_large");
  }

  const imageId = safeImageId(form.get("imageId"));
  const title = String(form.get("title") || "תמונה").trim().slice(0, 120);
  const state = user.role === "viewer" ? "pending" : "approved";
  const key = `${state}/${user.uid}/${imageId}.${extension}`;

  await env.GALLERY_BUCKET.put(key, await file.arrayBuffer(), {
    httpMetadata: { contentType: mimeType },
    customMetadata: {
      ownerUid: user.uid,
      uploaderRole: user.role,
      imageId,
      title,
      mediaType: isVideo ? "video" : "image",
      state,
      uploadedAt: new Date().toISOString()
    }
  });

  return json(request, {
    success: true,
    key,
    state,
    mediaType: isVideo ? "video" : "image",
    mimeType,
    url: mediaUrl(request, key)
  }, 201);
}

async function serveImage(request, env, pathname) {
  const key = decodeObjectKey(pathname, "/media/");

  if (key.startsWith("pending/")) {
    const user = await requireUser(request, env, ["viewer", "uploader", "admin", "super_admin"]);
    const ownerUid = key.split("/")[1] || "";
    if (user.uid !== ownerUid && !["admin", "super_admin"].includes(user.role)) {
      throw apiError("אין הרשאה לצפות בתמונה הממתינה.", 403, "permission_denied");
    }
  }

  const rangeHeader = request.headers.get("Range");
  const objectHead = rangeHeader ? await env.GALLERY_BUCKET.head(key) : null;
  let requestedRange = null;
  if (rangeHeader && objectHead) {
    const match = rangeHeader.match(/^bytes=(\d*)-(\d*)$/i);
    if (match) {
      const size = objectHead.size;
      let start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2] || 0));
      let end = match[2] ? Number(match[2]) : size - 1;
      if (Number.isFinite(start) && Number.isFinite(end) && start >= 0 && start <= end && start < size) {
        end = Math.min(end, size - 1);
        requestedRange = { offset: start, length: end - start + 1, total: size };
      }
    }
  }
  const object = await env.GALLERY_BUCKET.get(
    key,
    requestedRange ? { range: { offset: requestedRange.offset, length: requestedRange.length } } : undefined
  );
  if (!object) throw apiError("קובץ המדיה לא נמצא.", 404, "not_found");

  const headers = new Headers(corsHeaders(request));
  object.writeHttpMetadata(headers);
  headers.set("ETag", object.httpEtag);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Accept-Ranges", "bytes");
  if (requestedRange) {
    headers.set("Content-Range", `bytes ${requestedRange.offset}-${requestedRange.offset + requestedRange.length - 1}/${requestedRange.total}`);
    headers.set("Content-Length", String(requestedRange.length));
  }
  headers.set(
    "Cache-Control",
    key.startsWith("approved/")
      ? "public, max-age=3600, s-maxage=86400"
      : "private, no-store"
  );
  return new Response(object.body, { headers, status: requestedRange ? 206 : 200 });
}

async function approveImage(request, env) {
  const user = await requireUser(request, env, ["admin", "super_admin"]);
  const payload = await request.json().catch(() => ({}));
  const key = String(payload.key || "");
  if (!/^pending\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+\.(jpg|png|webp|gif|mp4|webm)$/.test(key)) {
    throw apiError("מזהה קובץ המדיה הממתין אינו תקין.", 400, "invalid_object_key");
  }

  const approvedKey = `approved/${key.slice("pending/".length)}`;
  const source = await env.GALLERY_BUCKET.get(key);
  if (!source) {
    const existingApproved = await env.GALLERY_BUCKET.head(approvedKey);
    if (existingApproved) {
      return json(request, {
        success: true,
        key: approvedKey,
        state: "approved",
        url: mediaUrl(request, approvedKey)
      });
    }
    throw apiError("קובץ המדיה הממתין לא נמצא.", 404, "not_found");
  }

  await env.GALLERY_BUCKET.put(approvedKey, source.body, {
    httpMetadata: source.httpMetadata,
    customMetadata: {
      ...(source.customMetadata || {}),
      state: "approved",
      approvedBy: user.uid,
      approvedAt: new Date().toISOString()
    }
  });
  await env.GALLERY_BUCKET.delete(key);

  return json(request, {
    success: true,
    key: approvedKey,
    state: "approved",
    url: mediaUrl(request, approvedKey)
  });
}

async function deleteImage(request, env, pathname) {
  await requireUser(request, env, ["super_admin"]);
  const key = decodeObjectKey(pathname, "/media/");
  await env.GALLERY_BUCKET.delete(key);
  return json(request, { success: true, key });
}

async function sendEmail(request, env) {
  const user = await requireUser(request, env, ["super_admin"]);
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) {
    throw apiError("שירות הדוא״ל עדיין לא הוגדר בשרת.", 503, "email_not_configured");
  }
  const payload = await request.json().catch(() => ({}));
  const to = String(payload.to || "").trim().toLowerCase();
  const subject = String(payload.subject || "").trim();
  const textBody = String(payload.text || "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to) || to.length > 254) {
    throw apiError("כתובת הדוא״ל של הנמען אינה תקינה.", 400, "invalid_recipient");
  }
  if (subject.length < 1 || subject.length > 160) {
    throw apiError("נושא ההודעה חייב להכיל עד 160 תווים.", 400, "invalid_subject");
  }
  if (textBody.length < 1 || textBody.length > 5000) {
    throw apiError("תוכן ההודעה חייב להכיל עד 5,000 תווים.", 400, "invalid_email_body");
  }

  const idempotencyKey = `gallery-${user.uid}-${crypto.randomUUID()}`;
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey
    },
    body: JSON.stringify({
      from: String(env.EMAIL_FROM).trim(),
      to: [to],
      subject,
      text: textBody,
      reply_to: user.email
    })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.id) {
    console.error("Email provider rejected request", response.status, result?.name || result?.message || "unknown");
    throw apiError("ספק הדוא״ל לא הצליח לשלוח את ההודעה.", 502, "email_send_failed");
  }
  return json(request, { success: true, id: result.id });
}

function safeAiSearchImage(value) {
  const id = safeImageId(value?.id);
  const title = String(value?.title || "תמונה").trim().slice(0, 120);
  const folder = String(value?.folder || "כללי").trim().slice(0, 80);
  const date = String(value?.date || "").trim().slice(0, 20);
  let url;
  try {
    url = new URL(String(value?.url || ""));
  } catch {
    throw apiError("אחת מכתובות התמונות אינה תקינה.", 400, "invalid_image_url");
  }
  if (url.protocol !== "https:") {
    throw apiError("כתובת תמונה חייבת להשתמש בחיבור מאובטח.", 400, "invalid_image_url");
  }
  return { id, title, folder, date, url: url.toString() };
}

function extractOpenAIOutputText(payload) {
  for (const item of payload?.output || []) {
    for (const content of item?.content || []) {
      if (content?.type === "output_text" && typeof content.text === "string") {
        return content.text;
      }
    }
  }
  return "";
}

async function aiImageSearch(request, env) {
  await requireUser(request, env, ["viewer", "uploader", "admin", "super_admin"]);
  if (!env.OPENAI_API_KEY) {
    throw apiError("חיפוש ה־AI עדיין לא הוגדר בשרת.", 503, "openai_key_missing");
  }

  const payload = await request.json().catch(() => ({}));
  const query = String(payload.query || "").trim().slice(0, 240);
  if (query.length < 3) {
    throw apiError("יש לכתוב תיאור באורך של שלוש אותיות לפחות.", 400, "query_too_short");
  }
  if (!Array.isArray(payload.images) || payload.images.length === 0 || payload.images.length > 8) {
    throw apiError("ניתן לסרוק בין תמונה אחת לשמונה תמונות בכל קבוצה.", 400, "invalid_image_batch");
  }

  const images = payload.images.map(safeAiSearchImage);
  const knownIds = new Set(images.map(image => image.id));
  const content = [{
    type: "input_text",
    text: `מצא אילו תמונות מתאימות לבקשת החיפוש הבאה בעברית: "${query}". החזר רק מזהים של תמונות שיש להן התאמה חזותית ברורה או סבירה. אל תחזיר תמונה רק בגלל שם הקובץ.`
  }];

  images.forEach(image => {
    content.push({
      type: "input_text",
      text: `IMAGE_ID=${image.id}; כותרת=${image.title}; תיקייה=${image.folder}; תאריך=${image.date || "לא ידוע"}`
    });
    content.push({
      type: "input_image",
      image_url: image.url,
      detail: "low"
    });
  });

  const openAIResponse = await fetch(OPENAI_RESPONSES_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: OPENAI_VISION_MODEL,
      store: false,
      input: [{ role: "user", content }],
      text: {
        format: {
          type: "json_schema",
          name: "gallery_image_search",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              matches: {
                type: "array",
                items: { type: "string" }
              }
            },
            required: ["matches"]
          }
        }
      }
    })
  });

  const openAIPayload = await openAIResponse.json().catch(() => ({}));
  if (!openAIResponse.ok) {
    console.error("OpenAI search request failed", openAIResponse.status, openAIPayload?.error?.code || "unknown");
    throw apiError("מנוע חיפוש ה־AI אינו זמין כרגע.", 502, "openai_request_failed");
  }

  let parsed;
  try {
    parsed = JSON.parse(extractOpenAIOutputText(openAIPayload));
  } catch {
    throw apiError("מנוע ה־AI החזיר תשובה לא תקינה.", 502, "invalid_openai_response");
  }
  const matches = Array.isArray(parsed?.matches)
    ? [...new Set(parsed.matches.map(safeImageId).filter(id => knownIds.has(id)))]
    : [];

  return json(request, { success: true, matches });
}

async function serveFaceAsset(request, env, pathname) {
  let assetPath;
  try {
    assetPath = decodeURIComponent(pathname.slice("/face-assets/".length));
  } catch {
    throw apiError("כתובת נכס זיהוי הפנים אינה תקינה.", 400, "invalid_face_asset");
  }

  const asset = FACE_ASSETS.get(assetPath);
  if (!asset) {
    throw apiError("נכס זיהוי הפנים לא נמצא.", 404, "face_asset_not_found");
  }

  const cacheKey = `system/face-api/${FACE_API_VERSION}/${assetPath}`;
  let body;
  let contentType = asset.contentType;
  const cached = await env.GALLERY_BUCKET.get(cacheKey);

  if (cached) {
    body = cached.body;
    contentType = cached.httpMetadata?.contentType || contentType;
  } else {
    const upstreamUrl = `${FACE_API_CDN_BASE}/${asset.upstreamPath}`;
    const upstream = await fetch(upstreamUrl, {
      headers: { "User-Agent": "simchas-gallery-worker/1.0" }
    });
    if (!upstream.ok) {
      throw apiError("לא ניתן לטעון את מנוע זיהוי הפנים.", 502, "face_asset_upstream_failed");
    }
    const bytes = await upstream.arrayBuffer();
    await env.GALLERY_BUCKET.put(cacheKey, bytes, {
      httpMetadata: { contentType },
      customMetadata: {
        source: upstreamUrl,
        cachedAt: new Date().toISOString()
      }
    });
    body = bytes;
  }

  return new Response(body, {
    headers: {
      ...corsHeaders(request),
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=604800, s-maxage=31536000, immutable",
      "X-Content-Type-Options": "nosniff"
    }
  });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      const origin = request.headers.get("Origin");
      if (origin && !ALLOWED_ORIGINS.has(origin)) {
        return new Response(null, { status: 403 });
      }
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    try {
      if (!env.GALLERY_BUCKET) {
        throw apiError("החיבור לדלי R2 אינו מוגדר.", 500, "bucket_binding_missing");
      }

      const url = new URL(request.url);
      if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
        const result = await env.GALLERY_BUCKET.list({ limit: 1 });
        return json(request, {
          success: true,
          service: "simchas-gallery-api",
          bucketConnected: true,
          objectsFound: result.objects.length
        });
      }
      if (request.method === "POST" && url.pathname === "/upload") {
        return await uploadImage(request, env);
      }
      if (request.method === "POST" && url.pathname === "/approve") {
        return await approveImage(request, env);
      }
      if (request.method === "POST" && url.pathname === "/ai-search") {
        return await aiImageSearch(request, env);
      }
      if (request.method === "POST" && url.pathname === "/send-email") {
        return await sendEmail(request, env);
      }
      if (request.method === "GET" && url.pathname.startsWith("/face-assets/")) {
        return await serveFaceAsset(request, env, url.pathname);
      }
      if (request.method === "GET" && url.pathname.startsWith("/media/")) {
        return await serveImage(request, env, url.pathname);
      }
      if (request.method === "DELETE" && url.pathname.startsWith("/media/")) {
        return await deleteImage(request, env, url.pathname);
      }
      return json(request, { success: false, message: "הנתיב המבוקש אינו קיים." }, 404);
    } catch (error) {
      console.error("Worker request failed", error);
      return json(request, {
        success: false,
        code: error?.code || "internal_error",
        message: error?.message || "אירעה שגיאה פנימית."
      }, Number(error?.status) || 500);
    }
  }
};
