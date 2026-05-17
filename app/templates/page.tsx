import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { createServerSupabase } from "@/lib/supabase";
import { MasterCOAEditor } from "./editor";
import { INDUSTRIES, type IndustryKey } from "@/lib/industries";

export default async function MasterCOAPage({
  searchParams,
}: {
  searchParams: Promise<{ industry?: string }>;
}) {
  const params = await searchParams;
  const requestedIndustry = (params.industry || "painters") as IndustryKey;
  const validIndustry = INDUSTRIES.some((i) => i.key === requestedIndustry)
    ? requestedIndustry
    : "painters";

  const supabase = await createServerSupabase();

  // Check role for read-only vs editable
  const { data: { user } } = await supabase.auth.getUser();
  const { data: profile } = user
    ? await supabase.from("users").select("role").eq("id", user.id).single()
    : { data: null };

  const canEdit = profile && ["admin", "lead"].includes(profile.role);

  // Pre-fetch both jurisdictions for fast tab switching, filtered to the
  // selected industry. After Migration 13, every supported industry has its
  // own seeded COA — no fallback to painters. An empty result means that
  // industry/jurisdiction combo isn't seeded yet, and the editor will show
  // an "empty state" rather than silently showing painters' data (which
  // made it look like industry switching wasn't working).
  async function fetchByJurisdiction(jur: "US" | "CA") {
    return supabase
      .from("master_coa")
      .select("*")
      .eq("jurisdiction", jur)
      .eq("industry", validIndustry)
      .order("sort_order");
  }

  const [usData, caData, usageData] = await Promise.all([
    fetchByJurisdiction("US"),
    fetchByJurisdiction("CA"),
    supabase.from("master_coa_usage").select("*"),
  ]);

  const usageMap = new Map((usageData.data || []).map((u: any) => [u.id, u]));

  const usAccounts = (usData.data || []).map((a) => ({
    ...a,
    usage: usageMap.get(a.id) || { times_used_in_cleanups: 0, times_used_in_rules: 0 },
  }));

  const caAccounts = (caData.data || []).map((a) => ({
    ...a,
    usage: usageMap.get(a.id) || { times_used_in_cleanups: 0, times_used_in_rules: 0 },
  }));

  return (
    <AppShell>
      <TopBar
        title="Master COA"
        subtitle={
          canEdit
            ? "Standard chart of accounts — edit, add, reorder"
            : "Standard chart of accounts (read-only)"
        }
      />
      <div className="px-8 py-6">
        <MasterCOAEditor
          initialUS={usAccounts}
          initialCA={caAccounts}
          canEdit={!!canEdit}
          currentIndustry={validIndustry}
        />
      </div>
    </AppShell>
  );
}
