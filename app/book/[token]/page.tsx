import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { retrieveCheckoutSession } from "@/lib/stripe-billing";

export const dynamic = "force-dynamic";

/**
 * /book/[token] — the post-payment scheduling page.
 *
 * The one-time token is issued at checkout. Payment is confirmed server-side by
 * retrieving the Checkout Session (no webhook needed for the happy path). Once
 * paid we embed the coach's GHL calendar; a GHL appointment webhook later sets
 * consumed_at, which flips this page to "already booked" so it can't be reused.
 */
export default async function BookPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const service = createServiceSupabase();
  const { data: booking } = await service
    .from("coaching_call_bookings")
    .select("*")
    .eq("token", token)
    .maybeSingle();
  if (!booking) notFound();
  const b = booking as any;

  // Only the buyer (or an internal user) may open the link.
  const { data: profile } = await service.from("users").select("role").eq("id", user.id).single();
  const isInternal = ["admin", "lead", "bookkeeper", "viewer"].includes((profile as any)?.role);
  if (b.buyer_user_id !== user.id && !isInternal) notFound();

  const { data: coach } = await service
    .from("coaching_call_settings")
    .select("coach_name, ghl_embed_url")
    .eq("coach_key", b.coach_key)
    .maybeSingle();
  const coachName = (coach as any)?.coach_name || "your coach";
  const embedUrl = (coach as any)?.ghl_embed_url || null;

  // Confirm payment server-side if we haven't recorded it yet.
  let paid = b.payment_status === "paid";
  if (!paid && b.stripe_checkout_session_id) {
    const s = await retrieveCheckoutSession(b.stripe_checkout_session_id);
    if (s?.payment_status === "paid") {
      paid = true;
      await service.from("coaching_call_bookings").update({ payment_status: "paid" } as any).eq("token", token);
    }
  }

  const Shell = ({ children }: { children: React.ReactNode }) => (
    <div className="min-h-screen bg-slate-50 flex flex-col items-center px-4 py-10">
      <div className="w-full max-w-3xl">
        <div className="text-center mb-6">
          <div className="text-xl font-black text-navy">Ironbooks</div>
          <div className="text-xs text-ink-slate tracking-wide">Coaching call · {coachName} · 30 min</div>
        </div>
        {children}
      </div>
    </div>
  );

  // Already booked — single-use lock.
  if (b.consumed_at) {
    return (
      <Shell>
        <div className="bg-white border border-slate-200 rounded-2xl p-8 text-center">
          <h1 className="text-lg font-bold text-navy">Your call is booked ✓</h1>
          <p className="text-sm text-ink-slate mt-2">
            {b.booked_at ? `Scheduled for ${new Date(b.booked_at).toLocaleString()}.` : "Your time is confirmed."} You&apos;ll get a calendar invite from {coachName}.
          </p>
          <Link href="/portal/billing" className="mt-4 inline-block text-sm font-semibold text-teal hover:text-teal-dark">
            Back to billing
          </Link>
        </div>
      </Shell>
    );
  }

  // Paid but not yet scheduled — show the calendar.
  if (paid) {
    return (
      <Shell>
        <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
          <div className="px-6 py-4 border-b border-slate-100">
            <h1 className="text-base font-bold text-navy">Payment received — pick your time</h1>
            <p className="text-xs text-ink-slate mt-0.5">
              Choose a slot with {coachName} below. This link works once — book the time that suits you.
            </p>
          </div>
          {embedUrl ? (
            <iframe
              src={embedUrl}
              title={`Book with ${coachName}`}
              className="w-full"
              style={{ height: 720, border: "none" }}
            />
          ) : (
            <div className="px-6 py-10 text-center text-sm text-ink-slate">
              Your payment is confirmed, but the scheduling calendar isn&apos;t set up yet.
              Your Ironbooks team will reach out to {coachName === "your coach" ? "schedule" : `book you with ${coachName}`} shortly.
            </div>
          )}
        </div>
      </Shell>
    );
  }

  // Not paid (e.g. they navigated here without completing checkout).
  return (
    <Shell>
      <div className="bg-white border border-slate-200 rounded-2xl p-8 text-center">
        <h1 className="text-lg font-bold text-navy">Payment not completed</h1>
        <p className="text-sm text-ink-slate mt-2">
          We couldn&apos;t confirm payment for this call yet. If you just paid, give it a moment and refresh.
        </p>
        <Link href="/portal/billing" className="mt-4 inline-block bg-teal hover:bg-teal-dark text-white text-sm font-bold px-5 py-2.5 rounded-lg">
          Back to billing
        </Link>
      </div>
    </Shell>
  );
}
