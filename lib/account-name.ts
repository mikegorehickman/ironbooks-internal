/**
 * Account-name normalization for name→account resolution.
 *
 * Master COA names use typographic en-dashes ("Fuel – Overhead"); client QBO
 * charts routinely contain hyphen variants ("Fuel - Overhead") typed by
 * owners or prior bookkeepers. Every resolution path used to compare with
 * plain lowercase equality, so a dash variant silently failed to match — the
 * same failure class as the KB-fallback fuel bug. All name lookups normalize
 * through here instead.
 */
export function normalizeAccountName(name: string | null | undefined): string {
  return String(name ?? "")
    .toLowerCase()
    // en dash, em dash, minus sign → plain hyphen
    .replace(/[–—−]/g, "-")
    // unify spacing around hyphens ("Fuel-Overhead" == "Fuel - Overhead")
    .replace(/\s*-\s*/g, " - ")
    // collapse runs of whitespace
    .replace(/\s+/g, " ")
    .trim();
}
