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

/**
 * Does this client have a balance sheet to look at?
 *
 * bs_enabled === false is the "owed BS" tag — balance-sheet cleanup deferred, so
 * the portal's BS tab has nothing behind it. Anything other than an explicit
 * true is treated as unavailable, so a read failure omits the line rather than
 * promising a statement the client can't open.
 */
async function loadBalanceSheetAvailable(
  service: Service,
  clientLinkId: string
): Promise<boolean> {
  const { data, error } = await service
    .from("client_links")
    .select("bs_enabled")
    .eq("id", clientLinkId)
    .single();
  if (error) {
    console.warn(
      `[month-end] couldn't read bs_enabled for ${clientLinkId} — omitting the ` +
        `balance-sheet line from the email: ${error.message}`
    );
    return false;
  }
  return (data as any)?.bs_enabled === true;
}

async function finalizeSuccessfulSend(
  service: Service,
  pkg: MonthEndPackageRow,
  sentBy: string,
  lastMessageId: string | undefined,
  partialErrors: string[]
): Promise<void> {
  const now = new Date().toISOString();
  const period = periodBounds({
    periodYear: pkg.period_year,
    periodMonth: pkg.period_month,
  });

  const { data: finalized } = await service
    .from("month_end_packages")
    .update({
      status: "sent",
      portal_published_at: now,
      email_sent_at: now,
      email_message_id: lastMessageId || null,
      sent_by: sentBy,
      send_error: partialErrors.length ? partialErrors.join("; ").slice(0, 2000) : null,
      updated_at: now,
    } as any)
    .eq("id", pkg.id)
    .eq("status", "sending")
    .select("id")
    .maybeSingle();

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
  opts?: { force?: boolean; includesNotice?: boolean }
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

  const balanceSheetAvailable = await loadBalanceSheetAvailable(service, pkg.client_link_id);

  let lastMessageId: string | undefined;
  const errors: string[] = [];

  try {
    for (const r of recipients) {
      const result = await sendMonthEndEmail({
        clientName,
        recipientEmail: r.email,
        recipientFirstName: r.firstName,
        period,
        includesNotice: !!opts?.includesNotice,
        portalUrl,
        balanceSheetAvailable,
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

    await finalizeSuccessfulSend(service, pkg, sentBy, lastMessageId, errors);

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
  opts?: { force?: boolean; includesNotice?: boolean }
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
