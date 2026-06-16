/**
 * Backfill client_links profile fields from GHL + Stripe + onboarding_leads.
 *
 * For each active client, fills BLANK profile fields only (never clobbers a
 * value a bookkeeper already entered) from, in priority order:
 *   1. GHL contact (matched by client_email) — name, phone, address
 *   2. onboarding_leads (linked by client_link_id) — name/phone/business +
 *      the onboarding-form answers (revenue band, software, employees, …)
 *   3. Stripe customer (via stripe_customer_id) — address, phone, name
 *
 * DRY RUN by default — pass --apply to write. Prints a per-client diff and a
 * coverage summary.
 *
 * Run:
 *   npx tsx scripts/backfill-client-profiles.ts
 *   STRIPE_SECRET_KEY='sk_live_...' npx tsx scripts/backfill-client-profiles.ts --apply
 *
 * Needs GHL_API_KEY + GHL_LOCATION_ID and the Supabase service-role key in
 * .env.local. STRIPE_SECRET_KEY is optional — if absent/empty, Stripe
 * enrichment is skipped (GHL + onboarding still run).
 */

import { readFileSync } from "fs";

const env = readFileSync(".env.local", "utf8");
for (const raw of env.split("\n")) {
  const line = raw.replace(/\r$/, "").trim();
  if (!line || line.startsWith("#")) continue;
  const eq = line.indexOf("=");
  if (eq === -1) continue;
  const key = line.slice(0, eq).trim();
  let val = line.slice(eq + 1).trim();
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
    val = val.slice(1, -1);
  }
  if (key && !process.env[key]) process.env[key] = val;
}

import { createClient } from "@supabase/supabase-js";
import { findGhlContactByEmail, findGhlContactByCompany } from "@/lib/ghl";
import { getStripeCustomer, findStripeCustomerIdByEmail } from "@/lib/stripe-billing";
import { getClientDetails } from "@/lib/double";
import { extractFormAnswers } from "@/lib/onboarding";

const APPLY = process.argv.includes("--apply");
const STRIPE_ON = !!(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_SECRET_KEY.length > 5);
const DOUBLE_ON = !!(process.env.DOUBLE_CLIENT_ID && process.env.DOUBLE_CLIENT_ID.length > 3
  && process.env.DOUBLE_CLIENT_SECRET && process.env.DOUBLE_CLIENT_SECRET.length > 3);

const supa = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } }
);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Profile fields we may fill. (Form-answer fields are filled from
// onboarding_leads only.)
const FIELDS = [
  "contact_first_name", "contact_last_name", "client_phone", "client_email",
  "legal_business_name", "trade_type", "corporate_type", "fiscal_year_end",
  "country", "state_province", "address_line1", "address_line2", "city",
  "postal_code", "annual_revenue_range", "taxes_up_to_date", "prior_bookkeeper",
  "accounting_software", "payroll_provider", "employee_count_range",
  "uses_business_cards", "keeps_receipts",
] as const;
type Field = (typeof FIELDS)[number];

/** Fuzzy match an onboarding form answer by label keywords. */
function answerFinder(answers: { label: string; value: string }[]) {
  return (...keywords: string[]): string | null => {
    for (const a of answers) {
      const label = a.label.toLowerCase();
      if (keywords.every((k) => label.includes(k))) return a.value;
    }
    return null;
  };
}

(async () => {
  console.log(`\n${APPLY ? "APPLY" : "DRY RUN"} — backfilling client profiles`);
  console.log(`  Double: ${DOUBLE_ON ? "on" : "OFF (no/empty DOUBLE keys)"}`);
  console.log(`  GHL:    ${process.env.GHL_API_KEY ? "on" : "OFF (no key)"}`);
  console.log(`  Stripe: ${STRIPE_ON ? "on" : "OFF (no/empty STRIPE_SECRET_KEY)"}\n`);

  const { data, error } = await supa
    .from("client_links")
    .select(
      "id, client_name, client_email, stripe_customer_id, double_client_id, jurisdiction, " + FIELDS.join(", ")
    )
    .eq("is_active", true)
    .order("client_name");

  if (error) {
    console.error("✗ client_links query failed:", error.message);
    process.exit(1);
  }

  const rows = (data as any[]) || [];
  let touched = 0;
  let fieldsFilled = 0;
  const noGhlMatch: string[] = [];

  for (const row of rows) {
    const name = row.client_name || row.id;
    const proposed: Partial<Record<Field, string>> = {};

    // Only consider fields currently blank.
    const isBlank = (f: Field) => row[f] == null || String(row[f]).trim() === "";
    const propose = (f: Field, val: string | null | undefined) => {
      if (val && String(val).trim() && isBlank(f) && !proposed[f]) {
        proposed[f] = String(val).trim();
      }
    };

    let discoveredEmail = (row.client_email || "").trim() || null;

    // ── 0. Double (system of record) — authoritative email + state ──
    // Double has every linked client (double_client_id) and holds the
    // primary_email. We pull it FIRST so the GHL match below can use an
    // exact email instead of a fuzzy business-name search.
    if (DOUBLE_ON && row.double_client_id && /^\d+$/.test(String(row.double_client_id))) {
      try {
        const d: any = await getClientDetails(Number(row.double_client_id));
        if (d) {
          if (d.primary_email) {
            propose("client_email", d.primary_email);
            if (!discoveredEmail) discoveredEmail = String(d.primary_email).trim();
          }
          propose("state_province", d.address_state);
          // Opportunistic — only if Double returns these keys (shape is loose).
          propose("client_phone", d.phone || d.primary_phone);
          propose("city", d.address_city || d.city);
          propose("address_line1", d.address_line1 || d.address);
          propose("postal_code", d.address_postal_code || d.postal_code);
        }
      } catch (e: any) {
        console.warn(`  ⚠ Double lookup failed for ${name}: ${e.message}`);
      }
      await sleep(120); // polite to Double rate limit (300/5min)
    }

    // ── 1. GHL contact — by email if we have one, else by business name ──
    // The discovered email is captured into `discoveredEmail` so we can both
    // fill client_email AND use it to match Stripe below, even when SNAP had
    // no email on file to begin with.
    if (process.env.GHL_API_KEY) {
      try {
        const c = discoveredEmail
          ? await findGhlContactByEmail(discoveredEmail)
          : await findGhlContactByCompany(row.client_name || "");
        if (!c) noGhlMatch.push(name);
        if (c) {
          propose("contact_first_name", c.firstName);
          propose("contact_last_name", c.lastName);
          propose("client_email", c.email);
          propose("client_phone", c.phone);
          propose("legal_business_name", c.companyName);
          propose("address_line1", c.address1);
          propose("city", c.city);
          propose("state_province", c.state);
          propose("postal_code", c.postalCode);
          // Deliberately NOT proposing c.country — GHL defaults it to the
          // location country ("CA"), which is wrong for US clients. Country
          // is derived from the authoritative `jurisdiction` enum below.
          if (!discoveredEmail && c.email) discoveredEmail = c.email.trim();
        }
      } catch (e: any) {
        console.warn(`  ⚠ GHL lookup failed for ${name}: ${e.message}`);
      }
      await sleep(150); // polite to GHL rate limit
    }

    // Derive country from the authoritative jurisdiction enum (US/CA),
    // not from GHL's unreliable default.
    if (row.jurisdiction === "US") propose("country", "United States");
    else if (row.jurisdiction === "CA") propose("country", "Canada");

    // ── 2. onboarding_leads (form answers + contact) ──
    try {
      const { data: lead } = await (supa as any)
        .from("onboarding_leads")
        .select("full_name, business_name, email, phone, ob_form_payload")
        .eq("client_link_id", row.id)
        .maybeSingle();
      if (lead) {
        if (lead.full_name) {
          const [first, ...rest] = String(lead.full_name).split(" ");
          propose("contact_first_name", first);
          propose("contact_last_name", rest.join(" "));
        }
        propose("client_phone", lead.phone);
        propose("client_email", lead.email);
        propose("legal_business_name", lead.business_name);

        const answers = extractFormAnswers(lead.ob_form_payload);
        if (answers.length) {
          const find = answerFinder(answers);
          propose("trade_type", find("trade") || find("type", "business"));
          propose("corporate_type", find("corporate") || find("corp", "type"));
          propose("fiscal_year_end", find("fiscal") || find("year", "end"));
          propose("annual_revenue_range", find("revenue"));
          propose("taxes_up_to_date", find("tax"));
          propose("prior_bookkeeper", find("bookkeeper") || find("accountant"));
          propose("accounting_software", find("software") || find("accounting"));
          propose("payroll_provider", find("payroll"));
          propose("employee_count_range", find("employee"));
          propose("uses_business_cards", find("card"));
          propose("keeps_receipts", find("receipt"));
        }
      }
    } catch {
      // onboarding_leads table may not exist in this env — ignore.
    }

    // ── 3. Stripe customer ──
    // Use the stored customer id, or find it by the email we just discovered.
    let stripeCustomerId: string | null = row.stripe_customer_id || null;
    if (STRIPE_ON && !stripeCustomerId && discoveredEmail) {
      try {
        stripeCustomerId = await findStripeCustomerIdByEmail(discoveredEmail);
        if (stripeCustomerId && row.stripe_customer_id !== stripeCustomerId) {
          // Persist the freshly-matched customer id (separate from profile fields).
          if (APPLY) {
            await supa
              .from("client_links")
              .update({ stripe_customer_id: stripeCustomerId } as any)
              .eq("id", row.id);
          }
        }
      } catch { /* fail-soft */ }
    }
    if (STRIPE_ON && stripeCustomerId) {
      try {
        const cust = await getStripeCustomer(stripeCustomerId);
        if (cust) {
          if (cust.name && (isBlank("contact_first_name") || isBlank("contact_last_name"))) {
            const [first, ...rest] = cust.name.split(" ");
            propose("contact_first_name", first);
            propose("contact_last_name", rest.join(" "));
          }
          propose("client_phone", cust.phone);
          if (cust.address) {
            propose("address_line1", cust.address.line1);
            propose("address_line2", cust.address.line2);
            propose("city", cust.address.city);
            propose("state_province", cust.address.state);
            propose("postal_code", cust.address.postal_code);
            propose("country", cust.address.country);
          }
        }
      } catch (e: any) {
        console.warn(`  ⚠ Stripe lookup failed for ${name}: ${e.message}`);
      }
      await sleep(60);
    }

    const keys = Object.keys(proposed) as Field[];
    if (keys.length === 0) continue;

    touched++;
    fieldsFilled += keys.length;
    console.log(`\n${name}  (+${keys.length})`);
    for (const k of keys) console.log(`    ${k}: ${proposed[k]}`);

    if (APPLY) {
      const { error: upErr } = await supa
        .from("client_links")
        .update({ ...proposed, profile_updated_at: new Date().toISOString() } as any)
        .eq("id", row.id);
      if (upErr) console.error(`    ✗ write failed: ${upErr.message}`);
    }
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(`RESULTS  (${rows.length} active clients)`);
  console.log("=".repeat(60));
  console.log(`  ${APPLY ? "Updated" : "Would update"}: ${touched} clients, ${fieldsFilled} fields`);
  if (noGhlMatch.length) {
    console.log(`  ⚠ No confident GHL match (link manually): ${noGhlMatch.length}`);
    for (const n of noGhlMatch) console.log(`      ${n}`);
  }
  if (!APPLY && touched) console.log(`\n→ Re-run with --apply to write.\n`);
  else console.log("");
})();
