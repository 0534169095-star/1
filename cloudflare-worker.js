const FIREBASE_API_KEY = "AIzaSyCELVhy_L5dkGAVsY5in57Yv6-wdM3wHY4";
const FIREBASE_PROJECT_ID = "simchas-bb35c";
const APP_ID = "org-gallery";
const INITIAL_SUPER_ADMIN_EMAIL_SHA256 = "d2632af59d29239eef52f10e1cfbf38e27c65c55470b355134b1cd1fb4f809d6";
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

const ALLOWED_ORIGINS = new Set([
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

async function verifyFirebaseAccount(idToken) {
  const response = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(FIREBASE_API_KEY)}`,
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

async function readUserProfile(uid, idToken) {
  const path = [
    "artifacts",
    APP_ID,
    "public",
    "data",
    "userProfiles",
    uid
  ].map(encodeURIComponent).join("/");
  const response = await fetch(
    `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/${path}`,
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

async function requireUser(request, allowedRoles = null) {
  const idToken = getBearerToken(request);
  const account = await verifyFirebaseAccount(idToken);
  const isInitialSuperAdmin = await sha256(account.email) === INITIAL_SUPER_ADMIN_EMAIL_SHA256;
  const profile = isInitialSuperAdmin
    ? { status: "approved", role: "super_admin" }
    : await readUserProfile(account.localId, idToken);

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
  const user = await requireUser(request, ["viewer", "uploader", "admin", "super_admin"]);
  const form = await request.formData();
  const file = form.get("file");
  if (!file || typeof file.arrayBuffer !== "function") {
    throw apiError("לא צורף קובץ תמונה.", 400, "file_missing");
  }

  const mimeType = String(file.type || "").toLowerCase();
  const extension = ALLOWED_IMAGE_TYPES.get(mimeType);
  if (!extension) {
    throw apiError("סוג הקובץ אינו נתמך. אפשר להעלות JPG, PNG, WEBP או GIF.", 415, "unsupported_file_type");
  }
  if (!Number.isFinite(file.size) || file.size <= 0 || file.size > MAX_IMAGE_BYTES) {
    throw apiError("גודל התמונה חייב להיות עד 10MB.", 413, "file_too_large");
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
      state,
      uploadedAt: new Date().toISOString()
    }
  });

  return json(request, {
    success: true,
    key,
    state,
    url: mediaUrl(request, key)
  }, 201);
}

async function serveImage(request, env, pathname) {
  const key = decodeObjectKey(pathname, "/media/");

  if (key.startsWith("pending/")) {
    const user = await requireUser(request, ["viewer", "uploader", "admin", "super_admin"]);
    const ownerUid = key.split("/")[1] || "";
    if (user.uid !== ownerUid && !["admin", "super_admin"].includes(user.role)) {
      throw apiError("אין הרשאה לצפות בתמונה הממתינה.", 403, "permission_denied");
    }
  }

  const object = await env.GALLERY_BUCKET.get(key);
  if (!object) throw apiError("התמונה לא נמצאה.", 404, "not_found");

  const headers = new Headers(corsHeaders(request));
  object.writeHttpMetadata(headers);
  headers.set("ETag", object.httpEtag);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set(
    "Cache-Control",
    key.startsWith("approved/")
      ? "public, max-age=3600, s-maxage=86400"
      : "private, no-store"
  );
  return new Response(object.body, { headers });
}

async function approveImage(request, env) {
  const user = await requireUser(request, ["admin", "super_admin"]);
  const payload = await request.json().catch(() => ({}));
  const key = String(payload.key || "");
  if (!/^pending\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+\.(jpg|png|webp|gif)$/.test(key)) {
    throw apiError("מזהה התמונה הממתינה אינו תקין.", 400, "invalid_object_key");
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
    throw apiError("התמונה הממתינה לא נמצאה.", 404, "not_found");
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
  await requireUser(request, ["super_admin"]);
  const key = decodeObjectKey(pathname, "/media/");
  await env.GALLERY_BUCKET.delete(key);
  return json(request, { success: true, key });
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
