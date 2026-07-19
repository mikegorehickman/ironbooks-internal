/**
 * Entity type — the client's tax classification, which drives the filing form
 * and the owner-equity account mapping in the year-end tax export.
 *
 * Authoritative source: client_links.entity_type (migration 135), one of the
 * four values below. When it's null (client predates the field), we DERIVE a
 * best guess from the legacy free-text corporate_type so nothing reads blank —
 * but the profile toggle writes entity_type explicitly.
 *
 *   US filing form        Canada filing form
 *   c_corp      → 1120        → T2
 *   s_corp      → 1120-S      → T2
 *   partnership → 1065        → T2125 / T5013
 *   sole_prop   → Schedule C  → T2125
 */

export type EntityType = "c_corp" | "s_corp" | "partnership" | "sole_prop";

export const ENTITY_LABEL: Record<EntityType, string> = {
  c_corp: "C-Corporation",
  s_corp: "S-Corporation",
  partnership: "Partnership",
  sole_prop: "Sole Proprietor",
};

/** Options offered in the profile toggle, by country. Canada has no C/S
 * split — a corporation is a corporation for T2 purposes. */
export function entityOptionsFor(jurisdiction: string | null | undefined): EntityType[] {
  const isCA = String(jurisdiction || "").toUpperCase().startsWith("CA");
  return isCA
    ? ["c_corp", "partnership", "sole_prop"]     // "Corporation" shown for c_corp in CA
    : ["c_corp", "s_corp", "partnership", "sole_prop"];
}

/** CA relabels c_corp as plain "Corporation" (no C/S distinction up north). */
export function entityLabel(t: EntityType, jurisdiction?: string | null): string {
  if (t === "c_corp" && String(jurisdiction || "").toUpperCase().startsWith("CA")) return "Corporation";
  return ENTITY_LABEL[t];
}

/** Resolve the effective entity type: stored value wins; else derive from the
 * legacy corporate_type free text; else default to c_corp (most of the fleet
 * is incorporated). Never returns null so downstream logic is total. */
export function resolveEntityType(
  entityType: string | null | undefined,
  corporateType?: string | null
): EntityType {
  const e = String(entityType || "").toLowerCase();
  if (e === "c_corp" || e === "s_corp" || e === "partnership" || e === "sole_prop") return e as EntityType;

  const c = String(corporateType || "");
  if (/s[-_ ]?corp/i.test(c)) return "s_corp";
  if (/partnership/i.test(c)) return "partnership";
  if (/sole|proprietor/i.test(c)) return "sole_prop";
  // "Corporation", "Inc", "Ltd", "LLC"(assumed corp unless told otherwise) → corp
  return "c_corp";
}

/** The return form the preparer files, given entity + country. */
export function taxFormFor(entityType: EntityType, jurisdiction: string | null | undefined): string {
  const isCA = String(jurisdiction || "").toUpperCase().startsWith("CA");
  if (isCA) return entityType === "sole_prop" || entityType === "partnership" ? "T2125" : "T2";
  switch (entityType) {
    case "c_corp": return "Form 1120";
    case "s_corp": return "Form 1120-S";
    case "partnership": return "Form 1065";
    case "sole_prop": return "Schedule C";
  }
}

/** True for the pass-through/personal-return entities where owner money is
 * drawings/equity rather than payroll + shareholder loan. */
export function isSolePropLike(entityType: EntityType): boolean {
  return entityType === "sole_prop" || entityType === "partnership";
}
