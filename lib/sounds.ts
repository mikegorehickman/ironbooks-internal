/**
 * SNAP sound effects — small, satisfying audio cues for completion events.
 *
 * Sounds live in `public/sounds/`. Drop in mp3 / wav files matching the
 * names below and they'll play automatically. If a file is missing the
 * player fails silently (no console errors, no broken UX).
 *
 * Mute state is persisted in localStorage per-browser so each bookkeeper
 * controls their own. The sidebar toggle reads/writes this same key.
 *
 * Sound files expected (drop them at these paths):
 *   public/sounds/client-graduated.mp3   — Onboarding → Month-over-month
 *   public/sounds/scan-complete.mp3      — Any long-running scan finishes
 *   public/sounds/finalize-failed.mp3    — Partial or failed QBO finalize
 */

export type SoundEvent =
  | "client_graduated"
  | "scan_complete"
  | "finalize_failed"
  | "message_received";

const SOUND_FILES: Record<SoundEvent, string> = {
  client_graduated: "/sounds/client-graduated.mp3",
  scan_complete: "/sounds/scan-complete.mp3",
  finalize_failed: "/sounds/finalize-failed.mp3",
  message_received: "/sounds/message-received.wav",
};

const MUTE_KEY = "snap.sounds.muted";

/**
 * True if the user has muted SNAP sounds. SSR-safe (returns false).
 * Defaults to NOT muted on first visit — so the satisfying-feedback
 * moment lands; bookkeepers who don't want it can flip the sidebar toggle.
 */
export function isMuted(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(MUTE_KEY) === "1";
  } catch {
    return false;
  }
}

export function setMuted(muted: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(MUTE_KEY, muted ? "1" : "0");
    // Notify any listeners (sidebar toggle, etc.) so the icon flips
    // immediately without a refresh.
    window.dispatchEvent(new CustomEvent("snap-sounds-muted-change", { detail: muted }));
  } catch {
    // localStorage might be blocked (private browsing, etc.) — just no-op
  }
}

/**
 * Subscribe to mute-state changes. Returns an unsubscribe function.
 * Used by the sidebar toggle to keep its icon in sync.
 */
export function onMutedChange(cb: (muted: boolean) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = (e: Event) => cb((e as CustomEvent).detail);
  window.addEventListener("snap-sounds-muted-change", handler);
  return () => window.removeEventListener("snap-sounds-muted-change", handler);
}

/**
 * Play a sound effect. Fire-and-forget — never throws, never blocks.
 * Respects the mute toggle. Safe to call from anywhere in a client component.
 *
 *   playSound("scan_complete")
 *
 * Browsers may block playback until the user has interacted with the page
 * (autoplay policy). That's fine for our use cases — every event we play
 * a sound for is itself triggered by a click.
 */
export function playSound(event: SoundEvent): void {
  if (typeof window === "undefined") return;
  if (isMuted()) return;
  const src = SOUND_FILES[event];
  if (!src) return;

  try {
    const audio = new Audio(src);
    audio.volume = 0.5; // sensible default — not jarring
    // Catch promise rejection so a missing file doesn't blow up the
    // calling context. We deliberately swallow — sounds are nice-to-have,
    // never load-bearing.
    audio.play().catch(() => {});
  } catch {
    // Audio constructor itself can throw in obscure environments — ignore
  }
}
