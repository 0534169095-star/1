CREATE TABLE IF NOT EXISTS gallery_documents (
  collection_name TEXT NOT NULL,
  document_id TEXT NOT NULL,
  data_json TEXT NOT NULL DEFAULT '{}',
  owner_uid TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (collection_name, document_id)
);

CREATE INDEX IF NOT EXISTS idx_gallery_documents_collection_updated
  ON gallery_documents (collection_name, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_gallery_documents_owner
  ON gallery_documents (collection_name, owner_uid);
