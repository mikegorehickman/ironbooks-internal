// One-time setup: create the private `client-uploads` Storage bucket used
// by the portal Messages feature (migration 58). Idempotent — safe to
// re-run; updates limits if the bucket already exists.
//
// All reads/writes go through API routes with the service role + signed
// URLs, so the bucket stays fully private (no public access, no storage
// RLS policies needed for the anon key).
import { readFileSync } from "fs";
const env = readFileSync(".env.local", "utf8");
for (const line of env.split("\n")) {
  const m = line.match(/^([A-Z_]+)="?([^"]*)"?$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
import { createClient } from "@supabase/supabase-js";

const BUCKET = "client-uploads";
const MAX_BYTES = 25 * 1024 * 1024; // keep in sync with lib/client-comms.ts

const supa = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

(async () => {
  const { data: buckets, error: listErr } = await supa.storage.listBuckets();
  if (listErr) {
    console.error("Failed to list buckets:", listErr.message);
    process.exit(1);
  }
  const existing = (buckets || []).find((b) => b.name === BUCKET);

  if (existing) {
    const { error } = await supa.storage.updateBucket(BUCKET, {
      public: false,
      fileSizeLimit: MAX_BYTES,
    });
    if (error) {
      console.error("Failed to update bucket:", error.message);
      process.exit(1);
    }
    console.log(`Bucket "${BUCKET}" already existed — limits refreshed (private, ${MAX_BYTES / 1024 / 1024}MB cap).`);
  } else {
    const { error } = await supa.storage.createBucket(BUCKET, {
      public: false,
      fileSizeLimit: MAX_BYTES,
    });
    if (error) {
      console.error("Failed to create bucket:", error.message);
      process.exit(1);
    }
    console.log(`Created private bucket "${BUCKET}" (${MAX_BYTES / 1024 / 1024}MB cap).`);
  }
})();
