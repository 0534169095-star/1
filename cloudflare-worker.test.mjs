import test from "node:test";
import assert from "node:assert/strict";
import worker from "./cloudflare-worker.js";

class MockD1 {
  constructor() { this.rows = new Map(); }
  key(collection, id) { return `${collection}/${id}`; }
  prepare(sql) {
    const database = this;
    let bindings = [];
    return {
      bind(...values) { bindings = values; return this; },
      async first() {
        if (sql.includes("SELECT 1 AS connected")) return { connected: 1 };
        if (sql.includes("json_extract")) {
          const email = String(bindings[0] || "").toLowerCase();
          for (const [key, row] of database.rows) {
            if (!key.startsWith("userProfiles/")) continue;
            if (String(JSON.parse(row.data_json).email || "").toLowerCase() === email) return row;
          }
          return null;
        }
        const row = database.rows.get(database.key(bindings[0], bindings[1]));
        return row ? { ...row } : null;
      },
      async all() {
        const collection = bindings[0];
        return {
          results: [...database.rows.entries()]
            .filter(([key]) => key.startsWith(`${collection}/`))
            .map(([, row]) => ({ ...row }))
        };
      },
      async run() {
        if (sql.trim().startsWith("INSERT INTO gallery_documents")) {
          const hasFixedCollection = sql.includes("VALUES ('userProfiles'");
          const [collection, id, dataJson, ownerUid, createdAt, updatedAt] = hasFixedCollection
            ? ["userProfiles", ...bindings]
            : bindings;
          database.rows.set(database.key(collection, id), {
            document_id: id,
            data_json: dataJson,
            owner_uid: ownerUid,
            created_at: createdAt,
            updated_at: updatedAt
          });
        } else if (sql.trim().startsWith("DELETE FROM gallery_documents")) {
          const hasFixedCollection = sql.includes("collection_name = 'userProfiles'");
          const [collection, id] = hasFixedCollection ? ["userProfiles", bindings[0]] : bindings;
          database.rows.delete(database.key(collection, id));
        }
        return { success: true };
      }
    };
  }
}

const originalFetch = globalThis.fetch;

test.before(() => {
  globalThis.fetch = async url => {
    if (String(url).startsWith("https://oauth2.googleapis.com/tokeninfo")) {
      return Response.json({
        sub: "google-user-1",
        email: "user@example.com",
        email_verified: "true",
        aud: "601586229891-giorl13mdpu7kfbeb6h2aj6qjpkphmmo.apps.googleusercontent.com",
        name: "Test User"
      });
    }
    return new Response("not mocked", { status: 500 });
  };
});

test.after(() => { globalThis.fetch = originalFetch; });

function env(database) {
  return {
    GALLERY_DB: database,
    GALLERY_BUCKET: { async list() { return { objects: [] }; } }
  };
}

function request(path, method = "GET", body) {
  return new Request(`https://simchas-gallery-api.example${path}`, {
    method,
    headers: {
      Origin: "https://shmuel-lamed.github.io",
      Authorization: "Bearer google-token",
      ...(body ? { "Content-Type": "application/json" } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
}

test("new users cannot approve or promote themselves", async () => {
  const database = new MockD1();
  const response = await worker.fetch(request("/data/userProfiles/google-user-1", "PUT", {
    data: { displayName: "Test", email: "user@example.com", status: "approved", role: "super_admin" }
  }), env(database));
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.data.status, "pending");
  assert.equal(payload.data.role, "viewer");
});

test("approved uploader can create image metadata but cannot delete it", async () => {
  const database = new MockD1();
  database.rows.set("userProfiles/google-user-1", {
    document_id: "google-user-1",
    data_json: JSON.stringify({ uid: "google-user-1", email: "user@example.com", status: "approved", role: "uploader" }),
    created_at: Date.now(),
    updated_at: Date.now()
  });
  const create = await worker.fetch(request("/data/images/image-1", "PUT", {
    data: { id: "image-1", title: "Test image", uploadedBy: "google-user-1" }
  }), env(database));
  assert.equal(create.status, 200);

  const remove = await worker.fetch(request("/data/images/image-1", "DELETE"), env(database));
  assert.equal(remove.status, 403);
});

test("health reports both D1 and R2", async () => {
  const response = await worker.fetch(request("/health"), env(new MockD1()));
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.databaseConnected, true);
  assert.equal(payload.bucketConnected, true);
});
