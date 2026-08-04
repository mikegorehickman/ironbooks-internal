import { NextResponse } from "next/server";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import {
  DEFECT_TYPES, LIVE_STATUSES, SEVERITY_RANK, isKnownDefectType,
  reportDefects, type DefectReport, type DefectSeverity,
} from "@/lib/book-defects";

/**
 * /api/book-defects
 *
 * GET  → the fleet board: every active client, its live defects, exposure, and
 *        when each defect type was last swept.
 * POST → a scanner reporting results for one defect type (the path used by the
 *        ephemeral scanners that have no table to derive from).
 *
 * Admin/lead. The GET deliberately returns CLEAN clients too — a ledger that
 * only lists the broken ones can't tell you how many books you can trust,
 * which is the number this whole thing exists to produce.
 */
export const dynamic = "force-dynamic";

async function gate() {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const service = createServiceSupabase();
  const { data: actor } = await service
    .from("users").select("role").eq("id", user.id).single();
  if (!["admin", "lead"].includes((actor as any)?.role || "")) {
    return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  return { service, userId: user.id };
}

export async function GET(request: Request) {
  const g = await gate();
  if ("error" in g) return g.error;
  const { service } = g;

  const url = new URL(request.url);
  const clientFilter = url.searchParams.get("client");

  try {
    let defectsQ = (service as any)
      .from("book_defects")
      .select(
        "id, client_link_id, defect_type, status, severity, exposure_cents, item_count, " +
        "detail, detected_at, last_seen_at, resolved_at, resolution, note, assigned_to"
      )
      .limit(20000);
    if (clientFilter) defectsQ = defectsQ.eq("client_link_id", clientFilter);
    const { data: defectRows, error } = await defectsQ;
    if (error) throw error;
    const defects = (defectRows as any[]) || [];

    // Active clients, so the board can report "N of M clean". is_active IS NULL
    // is legacy-active — the same convention drift that hid client messages.
    let clientsQ = service
      .from("client_links")
      .select("id, client_name, is_active, assigned_bookkeeper_id, cleanup_completed_at, daily_recon_enabled");
    if (clientFilter) clientsQ = clientsQ.eq("id", clientFilter);
    const { data: clientRows } = await clientsQ;
    const clients = ((clientRows as any[]) || []).filter((c) => c.is_active !== false);

    const { data: scanRows } = await (service as any)
      .from("book_defect_scans")
      .select("defect_type, ran_at, clients_scanned, defects_found, auto_resolved")
      .order("ran_at", { ascending: false })
      .limit(500);
    const lastScan = new Map<string, any>();
    for (const s of ((scanRows as any[]) || [])) {
      if (!lastScan.has(s.defect_type)) lastScan.set(s.defect_type, s);
    }

    const byClient = new Map<string, any[]>();
    for (const d of defects) {
      const arr = byClient.get(d.client_link_id) || [];
      arr.push(d);
      byClient.set(d.client_link_id, arr);
    }

    const rows = clients.map((c) => {
      const all = byClient.get(c.id) || [];
      const live = all.filter((d) => LIVE_STATUSES.includes(d.status));
      live.sort(
        (a, b) =>
          SEVERITY_RANK[a.severity as DefectSeverity] - SEVERITY_RANK[b.severity as DefectSeverity] ||
          (b.exposure_cents || 0) - (a.exposure_cents || 0)
      );
      return {
        clientLinkId: c.id,
        clientName: c.client_name,
        inProduction: c.daily_recon_enabled === true,
        cleanupDone: !!c.cleanup_completed_at,
        defects: live,
        acceptedCount: all.filter((d) => d.status === "accepted").length,
        resolvedCount: all.filter((d) => d.status === "resolved").length,
        exposureCents: live.reduce((s, d) => s + (d.exposure_cents || 0), 0),
        worstSeverity: live[0]?.severity ?? null,
      };
    });

    rows.sort(
      (a, b) =>
        b.defects.length - a.defects.length ||
        b.exposureCents - a.exposureCents ||
        a.clientName.localeCompare(b.clientName)
    );

    const clean = rows.filter((r) => r.defects.length === 0).length;
    const totalExposure = rows.reduce((s, r) => s + r.exposureCents, 0);

    return NextResponse.json({
      types: DEFECT_TYPES.map((t) => ({
        key: t.key, label: t.label, description: t.description,
        defaultSeverity: t.defaultSeverity, fleetHref: t.fleetHref, derivable: t.derivable,
        lastScan: lastScan.get(t.key) ?? null,
        affected: rows.filter((r) => r.defects.some((d) => d.defect_type === t.key)).length,
        exposureCents: rows.reduce(
          (s, r) => s + r.defects.filter((d) => d.defect_type === t.key)
            .reduce((x, d) => x + (d.exposure_cents || 0), 0), 0
        ),
      })),
      rows,
      totals: { clients: rows.length, clean, dirty: rows.length - clean, exposureCents: totalExposure },
    });
  } catch (err: any) {
    if (/relation .* does not exist|schema cache/i.test(err?.message || "")) {
      return NextResponse.json({ setup_pending: true, types: [], rows: [], totals: null });
    }
    console.error("[book-defects GET]", err?.message);
    return NextResponse.json({ error: "Failed to load the ledger" }, { status: 500 });
  }
}

/**
 * POST — a scanner reporting one defect type.
 * Body: { defectType, reports: [{clientLinkId, exposureCents?, itemCount?, severity?, detail?}],
 *         scope: "fleet" | { clients: [id] }, source?, clientsScanned? }
 */
export async function POST(request: Request) {
  const g = await gate();
  if ("error" in g) return g.error;
  const { service, userId } = g;

  const body = await request.json().catch(() => ({}));
  const type = String(body.defectType || "");
  if (!isKnownDefectType(type)) {
    return NextResponse.json(
      { error: `Unknown defectType. Known: ${DEFECT_TYPES.map((d) => d.key).join(", ")}` },
      { status: 400 }
    );
  }
  const reports: DefectReport[] = Array.isArray(body.reports) ? body.reports : [];
  const scope =
    body.scope === "fleet"
      ? ({ kind: "fleet" } as const)
      : ({ kind: "clients", ids: Array.isArray(body.scope?.clients) ? body.scope.clients : [] } as const);

  if (scope.kind === "clients" && scope.ids.length === 0) {
    return NextResponse.json(
      { error: 'scope must be "fleet" or { clients: [ids] } — an empty scope would resolve nothing and mean nothing' },
      { status: 400 }
    );
  }

  try {
    const result = await reportDefects(service, {
      defectType: type,
      reports,
      scope,
      clientsScanned: typeof body.clientsScanned === "number" ? body.clientsScanned : undefined,
      source: String(body.source || "manual"),
      ranBy: userId,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (err: any) {
    console.error("[book-defects POST]", err?.message);
    return NextResponse.json({ error: err?.message || "Failed to record" }, { status: 500 });
  }
}
