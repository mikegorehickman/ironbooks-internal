import { AlertCircle, Mail } from "lucide-react";

/**
 * Shared error state for portal pages when resolvePortalContext fails.
 * Friendly messaging — never expose technical detail to clients.
 */
export function PortalErrorState({
  code, message,
}: {
  code: "no_session" | "not_client" | "no_mapping" | "no_qbo" | "fetch_failed";
  message?: string;
}) {
  const friendly = {
    no_session: {
      title: "Please sign in",
      body: "Your session expired. Click the magic link in your email again to get back in.",
    },
    not_client: {
      title: "Portal access not available",
      body: "This account doesn't have portal access set up. Reach out to your Ironbooks team if you think this is a mistake.",
    },
    no_mapping: {
      title: "Your portal is still being set up",
      body: "Your Ironbooks team needs to finish provisioning your account. You'll get an email when it's ready — usually within an hour.",
    },
    no_qbo: {
      title: "Books not connected yet",
      body: "Your QuickBooks isn't connected to Ironbooks yet, so we can't show your financials. Your bookkeeper will sort this out.",
    },
    fetch_failed: {
      title: "Something went wrong",
      body: "We hit an error loading your data. Try refreshing — if it keeps happening, let your bookkeeper know.",
    },
  }[code];

  return (
    <div className="bg-white border border-slate-200 rounded-2xl p-8 max-w-xl mx-auto text-center">
      <AlertCircle size={32} className="text-amber-600 mx-auto mb-3" />
      <h2 className="text-lg font-bold text-navy">{friendly.title}</h2>
      <p className="text-sm text-ink-slate mt-2">{friendly.body}</p>
      {process.env.NODE_ENV === "development" && message && (
        <pre className="mt-4 text-[10px] text-left bg-slate-50 border border-slate-200 p-2 rounded text-ink-slate whitespace-pre-wrap">
          Dev detail: {message}
        </pre>
      )}
      <a
        href="mailto:admin@ironbooks.com"
        className="mt-4 inline-flex items-center gap-1.5 text-xs text-teal-dark hover:underline"
      >
        <Mail size={12} /> Email admin@ironbooks.com
      </a>
    </div>
  );
}
