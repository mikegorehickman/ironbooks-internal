"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { PlayCircle, ClipboardList, CheckCircle2, Loader2, ArrowRight, ArrowLeft, CalendarCheck, Gift } from "lucide-react";
import { ONBOARDING_REWARD_LABEL, type PortalOnboardingState } from "@/lib/portal-onboarding";
import { OnboardingForm, EMPTY_ANSWERS, type OnboardingAnswers } from "./onboarding-form";


export function OnboardingWizard({
  clientName, jurisdiction, videoUrl, calendarUrl, initialAnswers, state,
}: {
  clientName: string;
  jurisdiction: string;
  videoUrl: string;
  /** GHL onboarding-call calendar embed URL ("" when not configured). */
  calendarUrl: string;
  /** Draft answers, or the client profile pre-filled into the form. */
  initialAnswers: OnboardingAnswers;
  state: PortalOnboardingState;
}) {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [videoDone, setVideoDone] = useState(!!state.video_watched_at);
  const [formDone, setFormDone] = useState(!!state.form_submitted_at);
  const [callDone, setCallDone] = useState(!!state.call_booked_at);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function post(payload: any): Promise<boolean> {
    setBusy(true); setError("");
    try {
      const res = await fetch("/api/portal/onboarding", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || "Something went wrong");
      return true;
    } catch (e: any) {
      setError(e?.message || "Something went wrong");
      return false;
    } finally {
      setBusy(false);
    }
  }

  const steps = [
    { icon: PlayCircle, label: "Welcome", done: videoDone },
    { icon: ClipboardList, label: "Your business", done: formDone },
    { icon: CalendarCheck, label: "Book your call", done: callDone },
    { icon: Gift, label: "Thank you", done: !!state.completed_at },
  ];

  async function markVideo() { if (await post({ action: "watch_video" })) { setVideoDone(true); setStep(1); } }
  /** Confirm the call is booked, then complete — which triggers the gift card.
   *  The GHL appointment webhook sets the same flag authoritatively; this is the
   *  client-side confirmation so the wizard never dead-ends waiting on a hook. */
  async function confirmCallBooked() {
    if (!callDone && !(await post({ action: "book_call" }))) return;
    setCallDone(true);
    if (await post({ action: "complete" })) setStep(3);
  }

  // "I'll do this later" — snooze the welcome sequence for THIS browser session
  // only (a session cookie, no expiry). They drop into the portal; the sequence
  // greets them again at the start of their next visit, and the nag banner
  // keeps a way back in the meantime. Not persisted, so nothing is marked done.
  function doLater() {
    document.cookie = "snap_ob_snoozed=1; path=/; samesite=lax";
    router.push("/portal");
  }

  return (
    <div>
      <div className="mb-6 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold text-navy">Welcome to Ironbooks, {clientName.split(/[ ,]/)[0]} 👋</h1>
          <p className="text-sm text-ink-slate mt-1">Four quick steps so we can get your books right — about 5 minutes, and there's a coffee in it for you.</p>
        </div>
        <button
          type="button"
          onClick={doLater}
          className="flex-shrink-0 mt-1 text-sm font-semibold text-ink-slate hover:text-navy whitespace-nowrap"
          title="Skip for now — we'll show this again next time you sign in"
        >
          I&apos;ll do this later
        </button>
      </div>

      {/* Stepper */}
      <div className="flex items-center gap-2 mb-6">
        {steps.map((s, i) => {
          const Icon = s.done ? CheckCircle2 : s.icon;
          const active = i === step;
          return (
            <button key={i} onClick={() => setStep(i)}
              className={`flex-1 flex items-center gap-2 rounded-xl border px-3 py-2 text-left transition-colors ${
                active ? "border-teal bg-teal-lighter" : s.done ? "border-emerald-200 bg-emerald-50" : "border-cardline bg-white"}`}>
              <Icon size={16} className={s.done ? "text-emerald-600" : active ? "text-teal" : "text-ink-light"} />
              <span className={`text-xs font-bold ${active ? "text-teal" : s.done ? "text-emerald-700" : "text-ink-slate"}`}>
                {i + 1}. {s.label}
              </span>
            </button>
          );
        })}
      </div>

      {error && <div className="mb-4 p-3 bg-rust-tint border border-rust-border rounded-lg text-sm text-rust">{error}</div>}

      <div className="bg-white rounded-2xl border border-hairline p-6">
        {/* STEP 0 — video */}
        {step === 0 && (
          <div className="space-y-4">
            <h2 className="text-lg font-bold text-navy">Watch this 2-minute intro</h2>
            <p className="text-sm text-ink-slate">Here's how Ironbooks works and what we'll do for you.</p>
            <div className="aspect-video w-full rounded-xl overflow-hidden bg-navy/90 flex items-center justify-center">
              {videoUrl ? (
                <iframe src={videoUrl} title="Ironbooks onboarding" className="w-full h-full" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowFullScreen />
              ) : (
                <div className="text-white/70 text-sm flex flex-col items-center gap-2"><PlayCircle size={40} /><span>Intro video coming soon.</span></div>
              )}
            </div>
            <div className="flex justify-end">
              <button onClick={markVideo} disabled={busy}
                className="inline-flex items-center gap-2 bg-teal hover:bg-teal-dark text-white text-sm font-semibold px-5 py-2.5 rounded-lg disabled:opacity-60">
                {busy ? <Loader2 size={15} className="animate-spin" /> : <ArrowRight size={15} />} Next: your business
              </button>
            </div>
          </div>
        )}

        {/* STEP 1 — the full intake, paged + autosaved */}
        {step === 1 && (
          <div className="space-y-4">
            <h2 className="text-lg font-bold text-navy">Tell us about your business</h2>
            <p className="text-sm text-ink-slate">
              This is the detail your bookkeeper needs to set your books up properly. It&apos;s a few
              pages — take them at your own pace, we save your answers as you go.
            </p>
            <OnboardingForm
              initial={initialAnswers}
              busy={busy}
              onSaveProgress={async (answers, pageNo) =>
                post({ action: "save_progress", answers, page: pageNo })
              }
              onSubmit={async (answers) => {
                if (await post({ action: "submit_form", answers })) {
                  setFormDone(true);
                  setStep(2);
                }
              }}
            />
          </div>
        )}
        {/* STEP 2 — book the onboarding call */}
        {step === 2 && (
          <div className="space-y-4">
            <h2 className="text-lg font-bold text-navy">Book your onboarding call</h2>
            <p className="text-sm text-ink-slate">
              A 30-minute call with your bookkeeper to walk through your books, answer your
              questions, and agree what happens next. Pick a time that suits you.
            </p>

            {calendarUrl ? (
              <div className="rounded-xl border border-cardline overflow-hidden">
                <iframe
                  src={calendarUrl}
                  title="Book your onboarding call"
                  className="w-full"
                  style={{ height: 620, border: "none" }}
                />
              </div>
            ) : (
              <div className="rounded-xl border border-gold-border bg-gold-tint px-4 py-3 text-sm text-gold-deep">
                The booking calendar isn&apos;t connected yet — your Ironbooks team will reach out to
                schedule your call. You can still finish setup below.
              </div>
            )}

            <div className="flex justify-between items-center pt-2 gap-3 flex-wrap">
              <button onClick={() => setStep(1)} className="inline-flex items-center gap-1.5 text-sm font-semibold text-ink-slate hover:text-navy">
                <ArrowLeft size={15} /> Back
              </button>
              <button onClick={confirmCallBooked} disabled={busy}
                className="inline-flex items-center gap-2 bg-teal hover:bg-teal-dark text-white text-sm font-semibold px-5 py-2.5 rounded-lg disabled:opacity-60">
                {busy ? <Loader2 size={15} className="animate-spin" /> : <CalendarCheck size={15} />}
                {callDone ? "Continue" : "I've booked my call"}
              </button>
            </div>
            <p className="text-[11px] text-ink-light text-center">
              Booked it above? We&apos;ll pick that up automatically — this button just moves you along.
            </p>
          </div>
        )}

        {/* STEP 3 — done + thank-you reward */}
        {step === 3 && (
          <div className="space-y-4 text-center">
            <div className="inline-flex w-14 h-14 rounded-full bg-teal-lighter border border-teal-border items-center justify-center">
              <Gift size={26} className="text-teal-dark" />
            </div>
            <h2 className="text-lg font-bold text-navy">You&apos;re all set — coffee&apos;s on us ☕</h2>
            <p className="text-sm text-ink-slate max-w-md mx-auto leading-relaxed">
              Thanks for getting your setup done. We&apos;re sending a{" "}
              <strong className="text-navy">{ONBOARDING_REWARD_LABEL}</strong> to your email as a
              thank-you — it usually lands within a few minutes.
            </p>
            <p className="text-xs text-ink-light max-w-md mx-auto">
              Your bookkeeper takes it from here. If they need bank statements or anything else,
              they&apos;ll ask you in Messages.
            </p>
            <div className="flex justify-center gap-2 pt-2">
              <button onClick={() => router.push("/portal")}
                className="inline-flex items-center gap-2 bg-teal hover:bg-teal-dark text-white text-sm font-semibold px-5 py-2.5 rounded-lg">
                <ArrowRight size={15} /> Go to my dashboard
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

