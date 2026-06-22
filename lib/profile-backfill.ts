/**
 * GHL → client-profile backfill (shared by the nightly cron and any manual run).
 *
 * For every active client with an email, look up their GHL contact (exact
 * email) and fill in BLANK profile fields only — never clobbering a value a
 * bookkeeper already entered. Country is derived from the authoritative
 * `jurisdiction` enum, not GHL's unreliable default. Best-effort per client:
 * a GHL miss or error just leaves that client untouched.
 */
import { findGhlContactByEmail } from "./ghl";

const GHL_FIELDS = [
  "contact_first_name",
  "contact_last_name",
  "client_phone",
  "legal_business_name",
  "address_line1",
  "city",
  "state_province",
  "postal_code",
  "country",
] as const;

export interface BackfillResult {
  total: number;
  touched: number;
  fieldsFilled: number;
  noMatch: string[];
}

export async function backfillProfilesFromGhl(
  service: any,
  opts: { apply: boolean } = { apply: true }
): Promise<BackfillResult> {
  const { data, error } = await service
    .from("client_links")
    .select("id, client_name, client_email, jurisdiction, " + GHL_FIELDS.join(", "))
    .eq("is_active", true)
    .order("client_name");
  if (error) throw new Error(`client_links query failed: ${error.message}`);

  const rows = (data as any[]) || [];
  let touched = 0;
  let fieldsFilled = 0;
  const noMatch: string[] = [];

  for (const row of rows) {
    const name = row.client_name || row.id;
    const email = (row.client_email || "").trim();
    if (!email) {
      noMatch.push(name);
      continue;
    }

    let c;
    try {
      c = await findGhlContactByEmail(email);
    } catch {
      c = null;
    }
    if (!c) {
      noMatch.push(name);
      continue;
    }

    const proposed: Record<string, string> = {};
    const isBlank = (f: string) => row[f] == null || String(row[f]).trim() === "";
    const propose = (f: string, v: string | null | undefined) => {
      if (v && String(v).trim() && isBlank(f) && !proposed[f]) proposed[f] = String(v).trim();
    };

    propose("contact_first_name", c.firstName);
    propose("contact_last_name", c.lastName);
    propose("client_phone", c.phone);
    propose("legal_business_name", c.companyName);
    propose("address_line1", c.address1);
    propose("city", c.city);
    propose("state_province", c.state);
    propose("postal_code", c.postalCode);
    if (row.jurisdiction === "US") propose("country", "United States");
    else if (row.jurisdiction === "CA") propose("country", "Canada");

    const keys = Object.keys(proposed);
    if (keys.length === 0) continue;

    touched++;
    fieldsFilled += keys.length;

    if (opts.apply) {
      await service
        .from("client_links")
        .update({ ...proposed, profile_updated_at: new Date().toISOString() })
        .eq("id", row.id);
    }

    // Polite to the GHL rate limit.
    await new Promise((r) => setTimeout(r, 150));
  }

  return { total: rows.length, touched, fieldsFilled, noMatch };
}
