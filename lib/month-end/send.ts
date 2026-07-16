import { sendMonthEndEmail } from "./email";
import { periodBounds } from "./period";
import { getPortalRecipients } from "./recipients";
import {
  claimPackageForSend,
  releaseSendClaim,
  recoverStaleMonthEndPackages,
  type MonthEndPackageRow,
} from "./claim";
import { verifyOperationalGates } from "./operational-gates";
import { SEND_CONCURRENCY } from "./constants";
import { mapPool } from "./concurrency";
import { notifyWorkComplete } from "../work-complete";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Service = { from: (table: string) => any };

export interface SendPackageResult {
  packageId: string;
  clientLinkId: string;
  clientName: string;
  ok: boolean;
  skipped?: boolean;
  error?: string;
  emailMessageId?: string;
}

async function loadClientName(
  service: Service,
  pkg: MonthEndPackageRow
): Promise<string> {
  if ((pkg as any).client_links?.client_name) {
    return (pkg as any).client_links.client_name;
  }
  const { data } = await service
    .from("client_links")
    .select("client_name")
    .eq("id", pkg.client_link_id)
    .single();
  return data?.client_name || "Client";
}

async function finalizeSuccessfulSend(
  service: Service,
  pkg: MonthEndPackageRow,
  sentBy: string,
  lastMessageId: string | undefined,
  partialErrors: string[],
  sentAsDraft: boolean
): Promise<void> {
  const now = new Date().toISOString();
  const period = periodBounds({
    periodYear: pkg.period_year,
    periodMonth: pkg.period_month,
  });

  const finalizePatch: any = {
    status: "sent",
    portal_published_at: now,
    email_sent_at: now,
    email_message_id: lastMessageId || null,
    sent_by: sentBy,
    send_error: partialErrors.length ? partialErrors.join("; ").slice(0, 2000) : null,
    // Permanent record that THIS month went out as DRAFT — the portal
    // banner + gut-check panel key off it, and it survives graduation.
    sent_as_draft: sentAsDraft,
    updated_at: now,
  };
  let { data: finalized, error: finalizeError } = await service
    .from("month_end_packages")
    .update(finalizePatch)
    .eq("id", pkg.id)
    .eq("status", "sending")
    .select("id")
    .maybeSingle();

  // Pending-migration fallback: if migration 130's sent_as_draft column isn't
  // applied yet, the patch 400s — retry without it so a schema lag can never
  // block a close (same class as the migration-113 board blank-out).
  if (!finalized && finalizeError) {
    delete finalizePatch.sent_as_draft;
    ({ data: finalized } = await service
      .from("month_end_packages")
      .update(finalizePatch)
      .eq("id", pkg.id)
      .eq("status", "sending")
      .select("id")
      .maybeSingle());
  }

  if (!finalized) {
    throw new Error("Finalize failed — package status changed during send");
  }

  await service
    .from("client_links")
    .update({ latest_closed_period: pkg.period_end } as any)
    .eq("id", pkg.client_link_id);

  if (pkg.reclass_job_id) {
    await service
      .from("reclass_jobs")
      .update({
        month_closed_at: now,
        month_closed_by: sentBy,
      } as any)
      .eq("id", pkg.reclass_job_id)
      .is("month_closed_at", null);
  }

  await service.from("audit_log").insert({
    event_type: "month_end_delivered",
    user_id: sentBy,
    request_payload: {
      package_id: pkg.id,
      client_link_id: pkg.client_link_id,
      period_year: period.periodYear,
      period_month: period.periodMonth,
      email_message_id: lastMessageId,
      partial_email_errors: partialErrors.length ? partialErrors : null,
    },
  } as any);

  // Ping the leads that this client's month-end is closed + delivered
  // (SNAP-native replacement for the old Double task-post).
  const monthLabel = new Date(period.periodYear, period.periodMonth - 1, 1)
    .toLocaleString("en-US", { month: "long", year: "numeric" });
  await notifyWorkComplete(service, {
    kind: "Month-end close",
    clientLinkId: pkg.client_link_id,
    summary: `${monthLabel} closed and the statement package was delivered to the client.`,
    actorName: null,
  });
}

export async function deliverPackage(
  service: Service,
  packageId: string,
  sentBy: string,
  appBaseUrl: string,
  opts?: { force?: boolean }
): Promise<SendPackageResult> {
  const claim = await claimPackageForSend(service, packageId);
  if (!claim.ok) {
    return {
      packageId,
      clientLinkId: "",
      clientName: "",
      ok: false,
      error: claim.error,
    };
  }

  const pkg = claim.pkg;
  const clientLinkId = pkg.client_link_id;

  if (claim.alreadySent) {
    const clientName = await loadClientName(service, pkg);
    return {
      packageId,
      clientLinkId,
      clientName,
      ok: true,
      skipped: true,
    };
  }

  const period = periodBounds({
    periodYear: pkg.period_year,
    periodMonth: pkg.period_month,
  });

  // `force` bypasses the operational gates: used when an admin/lead has
  // explicitly reviewed the statements and approved the close (Monthly Rec
  // manager approval) — their judgment overrides "no reclass job this
  // period"-style blocks that don't apply to cleanup-graduating clients.
  if (!opts?.force) {
    const gates = await verifyOperationalGates(service, clientLinkId, period);
    if (!gates.ok) {
      const msg = `Operational gates failed at send time: ${gates.blockReasons.join(", ")}`;
      await releaseSendClaim(service, packageId, msg, "ready_to_send");
      const clientName = await loadClientName(service, pkg);
      return { packageId, clientLinkId, clientName, ok: false, error: msg };
    }
  }

  const clientName = await loadClientName(service, pkg);
  const portalUrl = `${appBaseUrl}/portal/statements/${period.periodYear}/${period.periodMonth}`;
  const recipients = await getPortalRecipients(service, clientLinkId);

  if (!recipients.length) {
    await releaseSendClaim(service, packageId, "No portal recipients", "failed");
    return { packageId, clientLinkId, clientName, ok: false, error: "No portal recipients" };
  }

  // DRAFT vs VERIFIED stage (Mike, 2026-07-15). The client's stage decides
  // the email framing + the portal banner — the bookkeeper's flow doesn't
  // change. Fail-soft to draft=false so a pre-migration env sends the
  // classic email rather than blocking the close.
  let isDraft = false;
  let nudge = false;
  try {
    const { data: stageRow } = await service
      .from("client_links")
      .select("statements_stage")
      .eq("id", clientLinkId)
      .single();
    isDraft = stageRow?.statements_stage === "draft";
    if (isDraft) {
      // Nudge when an earlier month already went out as DRAFT and the client
      // never responded in the portal (stay draft + remind, never auto-flip).
      const { data: priorDrafts } = await service
        .from("month_end_packages")
        .select("id")
        .eq("client_link_id", clientLinkId)
        .eq("status", "sent")
        .eq("sent_as_draft", true)
        .neq("id", pkg.id)
        .limit(1);
      if (priorDrafts?.length) {
        const { data: reviews } = await service
          .from("statement_reviews")
          .select("id")
          .eq("client_link_id", clientLinkId)
          .limit(1);
        nudge = !reviews?.length;
      }
    }
  } catch {
    /* pre-migration env — classic verified-style email */
  }

  let lastMessageId: string | undefined;
  const errors: string[] = [];

  try {
    for (const r of recipients) {
      const result = await sendMonthEndEmail({
        clientName,
        recipientEmail: r.email,
        recipientFirstName: r.firstName,
        period,
        portalUrl,
        isDraft,
        nudge,
      });
      if (result.ok) {
        lastMessageId = result.messageId;
      } else {
        errors.push(`${r.email}: ${result.error}`);
      }
    }

    if (errors.length === recipients.length) {
      await releaseSendClaim(service, packageId, errors.join("; "), "failed");
      return { packageId, clientLinkId, clientName, ok: false, error: errors.join("; ") };
    }

    await finalizeSuccessfulSend(service, pkg, sentBy, lastMessageId, errors, isDraft);

    return {
      packageId,
      clientLinkId,
      clientName,
      ok: true,
      emailMessageId: lastMessageId,
      error: errors.length ? errors.join("; ") : undefined,
    };
  } catch (err: any) {
    const msg = err?.message || "Unexpected send failure";
    await releaseSendClaim(service, packageId, msg, "ready_to_send");
    return { packageId, clientLinkId, clientName, ok: false, error: msg };
  }
}

export async function deliverPackagesBulk(
  service: Service,
  packageIds: string[],
  sentBy: string,
  appBaseUrl: string,
  opts?: { force?: boolean }
): Promise<{
  sent: number;
  failed: number;
  skipped: number;
  results: SendPackageResult[];
}> {
  await recoverStaleMonthEndPackages(service);

  const uniqueIds = [...new Set(packageIds)];
  const results = await mapPool(uniqueIds, SEND_CONCURRENCY, (id) =>
    deliverPackage(service, id, sentBy, appBaseUrl, opts)
  );

  const sent = results.filter((r) => r.ok && !r.skipped).length;
  const skipped = results.filter((r) => r.ok && r.skipped).length;
  const failed = results.filter((r) => !r.ok).length;
  return { sent, failed, skipped, results };
}
