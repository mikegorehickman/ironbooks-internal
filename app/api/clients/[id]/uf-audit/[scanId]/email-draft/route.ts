import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * POST /api/clients/[id]/uf-audit/[scanId]/email-draft
 *
 * Generates a client-confirmation email asking the business owner what
 * happened to each orphan UF payment. Branded HTML + plain-text, just
 * like the Ask Client email used elsewhere.
 *
 * Body (optional):
 *   { filter: "ask_client" | "pending" | "all_unresolved" }
 * Defaults to "all_unresolved" — every orphan that hasn't been finalized,
 * regardless of current resolution. This is the most useful default
 * because the bookkeeper usually wants to ask about everything they
 * haven't confirmed yet.
 *
 * Returns:
 *   { subject, email_text, email_html, customer_count, payment_count, total_amount }
 */

const BRAND = {
  teal: "#2D7A75",
  tealLight: "#E8F2F0",
  tealDark: "#1F5D58",
  tealLighter: "#F4F9F8",
  navy: "#0F1F2E",
  slate: "#475569",
  lightSlate: "#94A3B8",
  border: "#CBD5E1",
  white: "#FFFFFF",
  amber: "#D97706",
  amberLight: "#FEF3C7",
};

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; scanId: string }> }
) {
  const { id: clientLinkId, scanId } = await context.params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: client } = await service
    .from("client_links")
    .select("id, client_name")
    .eq("id", clientLinkId)
    .single();
  if (!client) return NextResponse.json({ error: "Client not found" }, { status: 404 });

  const { data: scan } = await service
    .from("uf_audit_scans" as any)
    .select("id, client_link_id, scan_to")
    .eq("id", scanId)
    .eq("client_link_id", clientLinkId)
    .single();
  if (!scan) return NextResponse.json({ error: "Scan not found" }, { status: 404 });

  const body = await (request.json().catch(() => ({}))) as { filter?: string };
  const filter = body.filter || "all_unresolved";

  // Pull orphan items matching the filter
  let q = service
    .from("uf_audit_items" as any)
    .select("*")
    .eq("scan_id", scanId)
    .eq("classification", "orphan");

  if (filter === "ask_client") {
    q = q.eq("resolution", "ask_client");
  } else if (filter === "pending") {
    q = q.eq("resolution", "pending");
  } else {
    // all_unresolved — not yet executed, not skipped
    q = q.not("resolution", "in", "(executed,skipped,failed)");
  }

  const { data: itemsRaw } = await q.order("customer_name", { ascending: true }).order("payment_date", { ascending: true });
  const items = ((itemsRaw as any[]) || []) as Array<{
    customer_name: string | null;
    customer_qbo_id: string | null;
    payment_date: string;
    payment_amount: number;
    payment_memo: string;
    applied_invoice_ids: string[];
  }>;

  // Group by customer
  const byCustomer = new Map<
    string,
    { customer: string; payments: typeof items; total: number }
  >();
  for (const it of items) {
    const key = it.customer_qbo_id || `__name:${it.customer_name || "(no customer)"}`;
    if (!byCustomer.has(key)) {
      byCustomer.set(key, {
        customer: it.customer_name || "(no customer name)",
        payments: [],
        total: 0,
      });
    }
    const g = byCustomer.get(key)!;
    g.payments.push(it);
    g.total += Number(it.payment_amount || 0);
  }
  // Sort customers by total descending so biggest groups appear first
  const customerGroups = Array.from(byCustomer.values()).sort(
    (a, b) => b.total - a.total
  );

  const clientName = (client as any).client_name as string;
  const firstName = clientName.split(/[ ,]/)[0] || "there";
  const totalAmount = customerGroups.reduce((s, g) => s + g.total, 0);
  const paymentCount = items.length;

  const subject = `Quick question on ${paymentCount} customer payment${paymentCount === 1 ? "" : "s"} — ${clientName}`;

  const emailText = buildPlain({ firstName, clientName, customerGroups, totalAmount });
  const emailHtml = buildHtml({ firstName, clientName, customerGroups, totalAmount });

  return NextResponse.json({
    ok: true,
    subject,
    email_text: emailText,
    email_html: emailHtml,
    customer_count: customerGroups.length,
    payment_count: paymentCount,
    total_amount: totalAmount,
  });
}

// ─── BUILDERS ───────────────────────────────────────────────────────────

function fmtMoney(n: number): string {
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

interface BuildOpts {
  firstName: string;
  clientName: string;
  customerGroups: Array<{
    customer: string;
    payments: Array<{
      payment_date: string;
      payment_amount: number;
      payment_memo: string;
    }>;
    total: number;
  }>;
  totalAmount: number;
}

function buildPlain(opts: BuildOpts): string {
  const lines: string[] = [];
  lines.push(`Hi ${opts.firstName},`);
  lines.push("");
  lines.push(
    `We're cleaning up the books for ${opts.clientName} and noticed some customer payments recorded in QuickBooks that we can't find matching bank deposits for. The total in question is about ${fmtMoney(opts.totalAmount)} across ${opts.customerGroups.length} customer${opts.customerGroups.length === 1 ? "" : "s"}.`
  );
  lines.push("");
  lines.push(
    `For each customer below, can you reply with which option fits? You can answer with the LETTER (A/B/C/D) per group — short is fine.`
  );
  lines.push("");
  lines.push(`OPTIONS for each:`);
  lines.push(`  A) Cash/cheque that came to me directly — I kept it / used it personally`);
  lines.push(`  B) Deposited but to a different account (which one?)`);
  lines.push(`  C) Customer didn't actually pay this — was a credit, error, or write-off`);
  lines.push(`  D) Not sure — let's hop on a call`);
  lines.push("");
  lines.push(`────────────────────────────────────────`);
  lines.push("");

  opts.customerGroups.slice(0, 40).forEach((g, idx) => {
    lines.push(`${idx + 1}. ${g.customer}  —  ${g.payments.length} payment${g.payments.length === 1 ? "" : "s"}, total ${fmtMoney(g.total)}`);
    g.payments.slice(0, 10).forEach((p) => {
      const memo = p.payment_memo ? ` · "${p.payment_memo.slice(0, 60)}${p.payment_memo.length > 60 ? "…" : ""}"` : "";
      lines.push(`     • ${p.payment_date}  —  ${fmtMoney(p.payment_amount)}${memo}`);
    });
    if (g.payments.length > 10) {
      lines.push(`     (${g.payments.length - 10} more not listed — same question applies)`);
    }
    lines.push(`     Your answer (A/B/C/D + any notes): _______`);
    lines.push("");
  });

  if (opts.customerGroups.length > 40) {
    lines.push(
      `(${opts.customerGroups.length - 40} more customers not listed here — we'll cover them in a follow-up.)`
    );
    lines.push("");
  }

  lines.push(
    `If multiple customers fall into the same bucket, you can just say "all of these are A" or similar.`
  );
  lines.push("");
  lines.push(`Thanks for the help — this gets us close to a clean balance sheet.`);
  lines.push("");
  lines.push(`— Ironbooks`);

  return lines.join("\n");
}

function buildHtml(opts: BuildOpts): string {
  const rows = opts.customerGroups
    .slice(0, 40)
    .map((g, idx) => {
      const rowBg = idx % 2 === 0 ? BRAND.white : BRAND.tealLighter;
      const paymentLines = g.payments
        .slice(0, 10)
        .map(
          (p) => `
        <tr>
          <td style="padding:4px 8px;color:${BRAND.slate};font-size:11px;font-variant-numeric:tabular-nums;white-space:nowrap;">${escapeHtml(p.payment_date)}</td>
          <td style="padding:4px 8px;text-align:right;color:${BRAND.navy};font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap;">${escapeHtml(fmtMoney(p.payment_amount))}</td>
          <td style="padding:4px 8px;color:${BRAND.slate};font-size:11px;font-style:italic;">${p.payment_memo ? escapeHtml(p.payment_memo.slice(0, 80)) + (p.payment_memo.length > 80 ? "…" : "") : "&nbsp;"}</td>
        </tr>`
        )
        .join("");
      const overflowNote =
        g.payments.length > 10
          ? `<tr><td colspan="3" style="padding:4px 8px;color:${BRAND.lightSlate};font-size:10px;font-style:italic;">… and ${g.payments.length - 10} more — same question applies</td></tr>`
          : "";

      return `
      <div style="margin-bottom:18px;background:${rowBg};border:1px solid ${BRAND.border};border-radius:8px;overflow:hidden;">
        <div style="background:${BRAND.teal};color:${BRAND.white};padding:8px 12px;display:flex;align-items:center;justify-content:space-between;">
          <div style="font-weight:700;font-size:13px;">${idx + 1}. ${escapeHtml(g.customer)}</div>
          <div style="font-weight:700;font-size:13px;">${escapeHtml(fmtMoney(g.total))} · ${g.payments.length} payment${g.payments.length === 1 ? "" : "s"}</div>
        </div>
        <table cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;font-family:'Figtree','Helvetica Neue',sans-serif;font-size:12px;">
          <thead>
            <tr style="background:${BRAND.tealLighter};">
              <th style="text-align:left;padding:4px 8px;color:${BRAND.slate};font-size:10px;text-transform:uppercase;letter-spacing:0.04em;font-weight:600;">Date</th>
              <th style="text-align:right;padding:4px 8px;color:${BRAND.slate};font-size:10px;text-transform:uppercase;letter-spacing:0.04em;font-weight:600;">Amount</th>
              <th style="text-align:left;padding:4px 8px;color:${BRAND.slate};font-size:10px;text-transform:uppercase;letter-spacing:0.04em;font-weight:600;">Memo / Reference</th>
            </tr>
          </thead>
          <tbody>
            ${paymentLines}
            ${overflowNote}
          </tbody>
        </table>
        <div style="padding:10px 12px;background:${BRAND.white};border-top:1px solid ${BRAND.border};">
          <div style="font-size:11px;color:${BRAND.slate};margin-bottom:6px;font-weight:600;">Your answer for this customer:</div>
          <div style="display:flex;gap:4px;flex-wrap:wrap;font-size:11px;">
            <span style="padding:4px 8px;background:${BRAND.tealLighter};border:1px solid ${BRAND.border};border-radius:4px;color:${BRAND.navy};">☐ A — cash to me</span>
            <span style="padding:4px 8px;background:${BRAND.tealLighter};border:1px solid ${BRAND.border};border-radius:4px;color:${BRAND.navy};">☐ B — different account</span>
            <span style="padding:4px 8px;background:${BRAND.tealLighter};border:1px solid ${BRAND.border};border-radius:4px;color:${BRAND.navy};">☐ C — not real payment</span>
            <span style="padding:4px 8px;background:${BRAND.tealLighter};border:1px solid ${BRAND.border};border-radius:4px;color:${BRAND.navy};">☐ D — let's call</span>
          </div>
          <div style="font-size:11px;color:${BRAND.lightSlate};margin-top:6px;">Notes: ________________________________________</div>
        </div>
      </div>`;
    })
    .join("");

  const overflowFooter =
    opts.customerGroups.length > 40
      ? `<p style="color:${BRAND.lightSlate};font-size:12px;font-style:italic;">(${opts.customerGroups.length - 40} more customers not listed — we'll cover them in a follow-up.)</p>`
      : "";

  return `<div style="font-family:'Figtree','Helvetica Neue',Helvetica,Arial,sans-serif;color:${BRAND.navy};max-width:720px;margin:0 auto;background:${BRAND.white};">
  <!-- Brand header -->
  <div style="background:${BRAND.navy};color:${BRAND.white};padding:18px 22px;border-radius:10px 10px 0 0;">
    <table cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;">
      <tr>
        <td style="vertical-align:middle;">
          <div style="font-size:20px;font-weight:700;letter-spacing:-0.01em;line-height:1.1;color:${BRAND.white};">Ironbooks</div>
          <div style="font-size:11px;color:rgba(255,255,255,0.65);margin-top:3px;letter-spacing:0.06em;text-transform:uppercase;">Confirming customer payments</div>
        </td>
      </tr>
    </table>
  </div>

  <!-- Body -->
  <div style="border:1px solid ${BRAND.border};border-top:none;padding:24px 22px;border-radius:0 0 10px 10px;background:${BRAND.white};">
    <p style="margin:0 0 14px 0;color:${BRAND.navy};line-height:1.55;">Hi ${escapeHtml(opts.firstName)},</p>
    <p style="margin:0 0 14px 0;color:${BRAND.navy};line-height:1.55;">
      We&rsquo;re cleaning up the books for <strong>${escapeHtml(opts.clientName)}</strong> and noticed some customer payments recorded in QuickBooks that we can&rsquo;t find matching bank deposits for. The total in question is about <strong>${escapeHtml(fmtMoney(opts.totalAmount))}</strong> across <strong>${opts.customerGroups.length}</strong> customer${opts.customerGroups.length === 1 ? "" : "s"}.
    </p>

    <div style="background:${BRAND.amberLight};border:1px solid ${BRAND.amber};border-radius:8px;padding:12px 14px;margin:14px 0;">
      <div style="font-size:12px;font-weight:700;color:${BRAND.amber};text-transform:uppercase;letter-spacing:0.04em;margin-bottom:6px;">For each customer below, pick one:</div>
      <table cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:12px;color:${BRAND.navy};">
        <tr><td style="padding:2px 0;"><strong style="color:${BRAND.amber};">A.</strong> Cash/cheque that came to me directly — I kept it or used it personally</td></tr>
        <tr><td style="padding:2px 0;"><strong style="color:${BRAND.amber};">B.</strong> Deposited, but to a different account (which one?)</td></tr>
        <tr><td style="padding:2px 0;"><strong style="color:${BRAND.amber};">C.</strong> Customer didn&rsquo;t actually pay — was a credit / error / write-off</td></tr>
        <tr><td style="padding:2px 0;"><strong style="color:${BRAND.amber};">D.</strong> Not sure — let&rsquo;s hop on a call</td></tr>
      </table>
    </div>

    ${rows}
    ${overflowFooter}

    <p style="margin:18px 0 0 0;color:${BRAND.navy};line-height:1.55;">
      If multiple customers fall into the same bucket, just say <em>&ldquo;all of these are A&rdquo;</em> or similar &mdash; we&rsquo;ll handle it.
    </p>
    <p style="margin:14px 0 0 0;color:${BRAND.navy};line-height:1.55;">Thanks for the help &mdash; this gets us close to a clean balance sheet.</p>
    <p style="margin:14px 0 0 0;color:${BRAND.navy};line-height:1.55;">Kindly,<br><strong>Ironbooks</strong></p>
  </div>
</div>`;
}
