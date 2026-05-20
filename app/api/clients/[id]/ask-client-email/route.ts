import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";

/**
 * POST /api/clients/[id]/ask-client-email
 *
 * Generates the "Ask the client about unknown transactions" email body.
 * Pulls every flagged / low-confidence row from the client's most
 * recent reclass job and groups them by vendor so the bookkeeper can
 * paste a single email into Double instead of writing one from scratch.
 *
 * Persists the generated body + timestamp on client_links so the card
 * view can show "Created · just now" and the bookkeeper can recopy
 * later without regenerating.
 *
 * Returns:
 *   {
 *     email_text: string        // plain-text body
 *     email_html: string        // branded HTML body
 *     created_at: string
 *     transaction_count: number
 *     vendor_count: number
 *   }
 */
export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id: clientLinkId } = await context.params;
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

  // Most-recent reclass job for this client.
  const { data: lastReclass } = await service
    .from("reclass_jobs")
    .select("id, date_range_start, date_range_end")
    .eq("client_link_id", clientLinkId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  // Pull flagged + low-confidence rows. If there's no reclass job yet
  // we still return an email skeleton so the bookkeeper can edit it
  // manually for early-onboarding cases.
  let flaggedRows: any[] = [];
  if (lastReclass) {
    const { data: rows } = await service
      .from("reclassifications")
      .select(
        "vendor_name, transaction_amount, transaction_date, description, from_account_name, ai_reasoning, decision, ai_confidence"
      )
      .eq("reclass_job_id", (lastReclass as any).id)
      .in("decision", ["flagged", "needs_review"])
      .order("transaction_date", { ascending: true });
    flaggedRows = rows || [];
  }

  // Group by vendor — collapses "Sherwin-Williams x 12 txns" into one
  // ask-the-client bullet.
  const byVendor = new Map<
    string,
    { vendor: string; count: number; total: number; samples: any[] }
  >();
  for (const r of flaggedRows) {
    const key = (r.vendor_name || "Unknown vendor").trim();
    const entry = byVendor.get(key) || {
      vendor: key,
      count: 0,
      total: 0,
      samples: [] as any[],
    };
    entry.count++;
    entry.total += Number(r.transaction_amount || 0);
    if (entry.samples.length < 2) {
      entry.samples.push({
        date: r.transaction_date,
        amount: Number(r.transaction_amount || 0),
        memo: (r.description || "").slice(0, 80),
      });
    }
    byVendor.set(key, entry);
  }
  const vendorGroups = Array.from(byVendor.values()).sort(
    (a, b) => Math.abs(b.total) - Math.abs(a.total)
  );

  const clientName = (client as any).client_name as string;
  const firstName = clientName.split(/[ ,]/)[0] || "there";
  const rangeNote =
    lastReclass && (lastReclass as any).date_range_start
      ? ` (period ${(lastReclass as any).date_range_start} → ${(lastReclass as any).date_range_end})`
      : "";

  const emailText = buildPlain({
    firstName,
    clientName,
    rangeNote,
    vendorGroups,
  });
  const emailHtml = buildHtml({
    firstName,
    clientName,
    rangeNote,
    vendorGroups,
  });

  const now = new Date().toISOString();
  await service
    .from("client_links")
    .update({
      ask_client_email_created_at: now,
      ask_client_email_created_by: user.id,
      ask_client_email_body: emailText,
    } as any)
    .eq("id", clientLinkId);

  return NextResponse.json({
    ok: true,
    email_text: emailText,
    email_html: emailHtml,
    created_at: now,
    transaction_count: flaggedRows.length,
    vendor_count: vendorGroups.length,
  });
}

function fmtMoney(n: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(Math.abs(n));
}

function buildPlain(opts: {
  firstName: string;
  clientName: string;
  rangeNote: string;
  vendorGroups: Array<{ vendor: string; count: number; total: number; samples: any[] }>;
}): string {
  const lines: string[] = [];
  lines.push(`Hi ${opts.firstName},`);
  lines.push("");
  lines.push(
    `As we're cleaning up the books for ${opts.clientName}${opts.rangeNote}, we've come across some transactions we'd like to confirm with you before categorizing. A quick reply on each below would be a huge help.`
  );
  lines.push("");
  if (opts.vendorGroups.length === 0) {
    lines.push(
      `(We don't have any specific transactions to ask about yet — we'll send a follow-up once we have a list.)`
    );
  } else {
    opts.vendorGroups.slice(0, 25).forEach((g, i) => {
      const sample = g.samples[0]
        ? ` (first: ${g.samples[0].date}${g.samples[0].memo ? ` "${g.samples[0].memo}"` : ""})`
        : "";
      lines.push(
        `${i + 1}. ${g.vendor} — ${g.count} transaction${g.count === 1 ? "" : "s"}, total ${fmtMoney(g.total)}${sample}`
      );
      lines.push(`   What was this for / what category should it go to?`);
      lines.push("");
    });
    if (opts.vendorGroups.length > 25) {
      lines.push(
        `(${opts.vendorGroups.length - 25} more vendors not listed here — we'll cover them in a follow-up.)`
      );
      lines.push("");
    }
  }
  lines.push(
    `Feel free to reply with a quick note per item — even one-liners are fine.`
  );
  lines.push("");
  lines.push(`Thanks,`);
  lines.push(`Ironbooks`);
  return lines.join("\n");
}

function buildHtml(opts: {
  firstName: string;
  clientName: string;
  rangeNote: string;
  vendorGroups: Array<{ vendor: string; count: number; total: number; samples: any[] }>;
}): string {
  const BRAND = {
    teal: "#2D7A75",
    tealLighter: "#F4F9F8",
    navy: "#0F1F2E",
    slate: "#475569",
    border: "#CBD5E1",
    white: "#FFFFFF",
  };
  const items =
    opts.vendorGroups.length === 0
      ? `<p style="color:${BRAND.slate};font-style:italic;">(We don't have any specific transactions to ask about yet — we'll send a follow-up once we have a list.)</p>`
      : opts.vendorGroups
          .slice(0, 25)
          .map((g) => {
            const sample = g.samples[0]
              ? `<div style="color:${BRAND.slate};font-size:12px;">First: ${g.samples[0].date}${g.samples[0].memo ? ` &middot; <em>"${g.samples[0].memo}"</em>` : ""}</div>`
              : "";
            return `<li style="margin-bottom:14px;">
                <div style="font-weight:600;color:${BRAND.navy};">${escapeHtml(g.vendor)} &mdash; ${g.count} transaction${g.count === 1 ? "" : "s"}, total ${fmtMoney(g.total)}</div>
                ${sample}
                <div style="color:${BRAND.slate};margin-top:4px;">What was this for / what category should it go to?</div>
              </li>`;
          })
          .join("\n");
  return `<div style="font-family:'Figtree','Helvetica Neue',Helvetica,Arial,sans-serif;color:${BRAND.navy};max-width:640px;margin:0 auto;background:${BRAND.white};">
  <div style="background:${BRAND.navy};color:${BRAND.white};padding:18px 22px;border-radius:10px 10px 0 0;">
    <div style="font-size:20px;font-weight:700;letter-spacing:-0.01em;color:${BRAND.white};">Ironbooks</div>
    <div style="font-size:11px;color:rgba(255,255,255,0.65);margin-top:3px;letter-spacing:0.06em;text-transform:uppercase;">Quick questions on a few transactions</div>
  </div>
  <div style="border:1px solid ${BRAND.border};border-top:none;padding:24px 22px;border-radius:0 0 10px 10px;background:${BRAND.white};">
    <p style="margin:0 0 14px 0;color:${BRAND.navy};line-height:1.55;">Hi ${escapeHtml(opts.firstName)},</p>
    <p style="margin:0 0 14px 0;color:${BRAND.navy};line-height:1.55;">As we're cleaning up the books for <strong>${escapeHtml(opts.clientName)}</strong>${escapeHtml(opts.rangeNote)}, we've come across some transactions we'd like to confirm with you before categorizing. A quick reply on each below would be a huge help.</p>
    <ol style="padding-left:18px;color:${BRAND.navy};">
      ${items}
    </ol>
    ${opts.vendorGroups.length > 25 ? `<p style="color:${BRAND.slate};font-size:12px;">(${opts.vendorGroups.length - 25} more vendors not listed here &mdash; we'll cover them in a follow-up.)</p>` : ""}
    <p style="margin:18px 0 0 0;color:${BRAND.navy};line-height:1.55;">Feel free to reply with a quick note per item &mdash; even one-liners are fine.</p>
    <p style="margin:14px 0 0 0;color:${BRAND.navy};line-height:1.55;">Thanks,<br>Ironbooks</p>
  </div>
</div>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
