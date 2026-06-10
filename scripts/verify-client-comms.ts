// End-to-end verification of the client communications feature
// (migration 58 + client-uploads bucket). Exercises the real stack:
//
//   1. table exists + insert to_client notification & from_client message
//   2. unread-count queries (portal badge + /today widget shapes)
//   3. signed-upload-URL flow exactly as the browser does it
//      (createSignedUploadUrl → PUT → createSignedUrl → GET → compare)
//   4. mark-read updates
//   5. full cleanup (rows + file)
//
// Safe to run against prod: uses a clearly-marked test body and removes
// everything it created.
import { readFileSync } from "fs";
const env = readFileSync(".env.local", "utf8");
for (const line of env.split("\n")) {
  const m = line.match(/^([A-Z_]+)="?([^"]*)"?$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
import { createClient } from "@supabase/supabase-js";

const BUCKET = "client-uploads";
const svc: any = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "✓" : "✗ FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

(async () => {
  // Use any active client as the test subject
  const { data: client } = await svc
    .from("client_links")
    .select("id, client_name")
    .eq("is_active", true)
    .limit(1)
    .single();
  if (!client) {
    console.error("No active client found — aborting");
    process.exit(1);
  }
  console.log(`Test client: ${client.client_name} (${client.id})\n`);
  const cleanupIds: string[] = [];
  let testPath: string | null = null;

  try {
    // 1. Inserts
    const { data: notif, error: e1 } = await svc
      .from("client_communications")
      .insert({
        client_link_id: client.id,
        direction: "to_client",
        kind: "notification",
        subject: "TEST — please ignore",
        body: "[verify-client-comms] automated test notification",
      })
      .select("*")
      .single();
    check("insert to_client notification", !!notif && !e1, e1?.message);
    if (notif) cleanupIds.push(notif.id);

    const { data: msg, error: e2 } = await svc
      .from("client_communications")
      .insert({
        client_link_id: client.id,
        direction: "from_client",
        kind: "message",
        body: "[verify-client-comms] automated test message",
        attachments: [{ path: `${client.id}/test.pdf`, name: "test.pdf", size: 123, content_type: "application/pdf" }],
      })
      .select("*")
      .single();
    check("insert from_client message w/ attachment meta", !!msg && !e2, e2?.message);
    if (msg) cleanupIds.push(msg.id);

    // 2. Badge + widget queries
    const { count: unreadBadge } = await svc
      .from("client_communications")
      .select("id", { count: "exact", head: true })
      .eq("client_link_id", client.id)
      .eq("direction", "to_client")
      .is("read_at", null);
    check("portal badge query counts the notification", (unreadBadge || 0) >= 1, `count=${unreadBadge}`);

    const { data: inbox } = await svc
      .from("client_communications")
      .select("id, client_link_id, body, attachments, created_at")
      .eq("direction", "from_client")
      .is("read_at", null)
      .order("created_at", { ascending: false })
      .limit(50);
    const inboxHasOurs = ((inbox as any[]) || []).some((r) => r.id === msg?.id);
    check("/today widget query returns the inbound message", inboxHasOurs);

    // 3. Storage round-trip (exact browser flow)
    testPath = `${client.id}/9999-99/${Date.now()}-verify-test.txt`;
    const { data: signedUp, error: e3 } = await svc.storage
      .from(BUCKET)
      .createSignedUploadUrl(testPath);
    check("createSignedUploadUrl", !!signedUp?.token && !e3, e3?.message);

    if (signedUp) {
      const content = `verify-client-comms ${testPath}`;
      const putRes = await fetch(signedUp.signedUrl, {
        method: "PUT",
        headers: { "Content-Type": "text/plain" },
        body: content,
      });
      check("browser-style PUT to signed upload URL", putRes.ok, `status=${putRes.status}`);

      const { data: signedDown, error: e4 } = await svc.storage
        .from(BUCKET)
        .createSignedUrl(testPath, 60, { download: "verify-test.txt" });
      check("createSignedUrl (download)", !!signedDown?.signedUrl && !e4, e4?.message);

      if (signedDown) {
        const got = await fetch(signedDown.signedUrl);
        const text = await got.text();
        check("download content matches upload", got.ok && text === content);
      }
    }

    // 4. Mark-read
    const { error: e5 } = await svc
      .from("client_communications")
      .update({ read_at: new Date().toISOString() })
      .in("id", cleanupIds);
    check("mark-read update", !e5, e5?.message);

    const { count: afterRead } = await svc
      .from("client_communications")
      .select("id", { count: "exact", head: true })
      .eq("client_link_id", client.id)
      .eq("direction", "to_client")
      .is("read_at", null);
    check("badge clears after mark-read", (afterRead || 0) === 0, `count=${afterRead}`);
  } finally {
    // 5. Cleanup
    if (cleanupIds.length > 0) {
      await svc.from("client_communications").delete().in("id", cleanupIds);
    }
    if (testPath) {
      await svc.storage.from(BUCKET).remove([testPath]);
    }
    const { data: leftover } = await svc
      .from("client_communications")
      .select("id")
      .in("id", cleanupIds);
    check("cleanup: test rows deleted", ((leftover as any[]) || []).length === 0);
  }

  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
