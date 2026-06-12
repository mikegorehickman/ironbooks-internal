import {
  emailPortalUsersAboutMessage,
  type MessageEmailDelivery,
} from "@/lib/client-comms";

/**
 * Batch every ask_client row on a reclass job into ONE portal message
 * (client_communications, kind=message so the client can reply in-thread)
 * plus ONE notification email — never one email per transaction.
 *
 * Called from reclass execution. Idempotent per job: an audit_log marker
 * (reclass_ask_client_sent) blocks re-sends when a job is re-executed.
 */
export interface AskClientSendResult {
  sent: boolean;
  count: number;
  reason?: "no_ask_client_rows" | "already_sent" | "job_not_found" | "insert_failed";
  emailDelivery?: MessageEmailDelivery;
}

export async function sendAskClientQuestions(
  service: any,
  params: { reclassJobId: string; portalOrigin: string }
): Promise<AskClientSendResult> {
  const { data: rows } = await service
    .from("reclassifications")
    .select("transaction_date, transaction_amount, description, vendor_name, from_account_name")
    .eq("reclass_job_id", params.reclassJobId)
    .eq("decision", "ask_client")
    .order("transaction_date", { ascending: true });
  if (!rows || rows.length === 0) return { sent: false, count: 0, reason: "no_ask_client_rows" };

  const { data: job } = await service
    .from("reclass_jobs")
    .select("id, client_link_id, bookkeeper_id")
    .eq("id", params.reclassJobId)
    .single();
  if (!job) return { sent: false, count: rows.length, reason: "job_not_found" };

  // Idempotency: one batch per job, even across re-executes.
  const { data: prior } = await service
    .from("audit_log")
    .select("id")
    .eq("event_type", "reclass_ask_client_sent")
    .contains("request_payload", { reclass_job_id: params.reclassJobId })
    .limit(1);
  if (prior && prior.length > 0) return { sent: false, count: rows.length, reason: "already_sent" };

  const { data: client } = await service
    .from("client_links")
    .select("client_name")
    .eq("id", job.client_link_id)
    .single();
  const clientName = client?.client_name || "your business";

  const n = rows.length;
  const lines = rows.map((r: any, i: number) => {
    const date = formatDate(r.transaction_date);
    const amount = formatMoney(r.transaction_amount);
    const what = (r.vendor_name || r.description || "Unlabeled transaction").trim();
    const from = r.from_account_name ? ` (from ${r.from_account_name})` : "";
    return `${i + 1}. ${date} — ${amount} — ${what}${from}`;
  });

  // Keep the body inside the same 8,000-char ceiling the messages API
  // enforces; overflow lines collapse into a count rather than a 2nd email.
  let list = lines;
  const fullList = lines.join("\n");
  if (fullList.length > 7000) {
    let used = 0;
    let cut = lines.length;
    for (let i = 0; i < lines.length; i++) {
      used += lines[i].length + 1;
      if (used > 6800) { cut = i; break; }
    }
    list = [...lines.slice(0, cut), `…plus ${lines.length - cut} more — your bookkeeper will follow up on those.`];
  }

  const subject =
    n === 1
      ? "Quick question about a transaction"
      : `Quick question about ${n} transactions`;
  const body = [
    `Hi! While categorizing your books we found ${n === 1 ? "a transaction" : `${n} transactions`} we couldn't identify with certainty. Could you tell us what ${n === 1 ? "it was" : "each of these was"} for?`,
    ``,
    ...list,
    ``,
    `The fastest way to answer: open the Categorize page in your portal (${params.portalOrigin}/portal/categorize) and pick a category from the dropdown next to each one — if money just moved between your own accounts, choose it under "Money moved between my accounts." Or just reply to this message with a quick note for each. Thanks!`,
  ].join("\n");

  const { error: insertErr } = await service.from("client_communications").insert({
    client_link_id: job.client_link_id,
    sender_user_id: job.bookkeeper_id,
    direction: "to_client",
    kind: "message",
    subject,
    body,
  });
  if (insertErr) {
    console.error(`[reclass-ask-client] comm insert failed: ${insertErr.message}`);
    return { sent: false, count: n, reason: "insert_failed" };
  }

  // One email for the whole batch; generous snippet so every transaction
  // line survives into the email instead of being cut at the default 400.
  const emailDelivery = await emailPortalUsersAboutMessage(service, {
    clientLinkId: job.client_link_id,
    clientName,
    kind: "message",
    subject,
    body,
    portalOrigin: params.portalOrigin,
    snippetChars: 7000,
    portalPath: "/portal/categorize",
    ctaLabel: "Log in to categorize",
  });

  await service.from("audit_log").insert({
    event_type: "reclass_ask_client_sent",
    user_id: job.bookkeeper_id,
    request_payload: {
      reclass_job_id: params.reclassJobId,
      client_link_id: job.client_link_id,
      transaction_count: n,
      email_delivery: emailDelivery,
      message: `Asked client about ${n} transaction${n === 1 ? "" : "s"} (portal message${emailDelivery.sent ? " + email" : ", email NOT delivered"})`,
    },
  });

  return { sent: true, count: n, emailDelivery };
}

function formatDate(iso: string | null): string {
  if (!iso) return "Unknown date";
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  if (!y || !m || !d) return iso;
  return new Date(y, m - 1, d).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatMoney(n: number | null): string {
  const v = Math.abs(Number(n) || 0);
  return `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
