import { redirect } from "next/navigation";

/**
 * Cross-client GST/HST audit picker, retired with the sidebar simplification
 * (July 2026). The tool starts from the client now — the /clients row
 * quick-action or the profile Cleanup tab, already scoped.
 */
export default function RetiredPickerRedirect() {
  redirect("/clients");
}
