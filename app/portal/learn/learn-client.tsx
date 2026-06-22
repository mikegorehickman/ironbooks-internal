"use client";

import { useState } from "react";
import { Play, Download, X, GraduationCap, Clock } from "lucide-react";

interface Resource {
  id: string;
  title: string;
  description: string | null;
  category: string;
  vimeo_url: string | null;
  youtube_url: string | null;
  video_url: string | null;
  thumbnail_url: string | null;
  duration_seconds: number | null;
  download_url: string | null;
  download_label: string | null;
}

const CATEGORY_LABELS: Record<string, { label: string; subtitle: string }> = {
  fundamentals: { label: "Finance fundamentals", subtitle: "A 7-part series covering the basics every business owner should know" },
  quickstart: { label: "Start here", subtitle: "Quick wins to make these videos useful right away" },
  statements: { label: "Reading your statements", subtitle: "P&L, Balance Sheet, A/R Aging — explained" },
  cashflow: { label: "Cash flow", subtitle: "Why bank balance, profit, and cash are different" },
  taxes: { label: "Taxes", subtitle: "Setting aside, quarterlies, and what to ask your CPA" },
  growth: { label: "Growing your business", subtitle: "Pricing, hiring, reinvestment" },
  general: { label: "Other", subtitle: "" },
};

// Per-category accent glow for the branded thumbnail. Base is always the SNAP
// navy→teal gradient; the glow tints each category differently for variety.
const CATEGORY_ACCENT: Record<string, string> = {
  fundamentals: "rgba(26,155,143,0.55)",
  quickstart: "rgba(245,158,11,0.45)",
  statements: "rgba(59,130,246,0.45)",
  cashflow: "rgba(16,185,129,0.45)",
  taxes: "rgba(139,92,246,0.45)",
  growth: "rgba(244,63,94,0.42)",
  general: "rgba(26,155,143,0.45)",
};

/**
 * IronBooks-branded thumbnail shown when a Learn video has no custom image —
 * a navy→teal gradient poster with the wordmark + category, so every tile looks
 * intentional and on-brand instead of a flat box. The play button overlays this
 * (rendered by VideoTile above it).
 */
function BrandedThumb({ category }: { category: string }) {
  const glow = CATEGORY_ACCENT[category] || CATEGORY_ACCENT.general;
  const catLabel = CATEGORY_LABELS[category]?.label || "Training";
  return (
    <div className="absolute inset-0 bg-gradient-to-br from-[#0B1722] via-[#11283b] to-teal-dark">
      <div className="absolute -right-8 -top-10 w-36 h-36 rounded-full blur-2xl" style={{ background: glow }} />
      <div
        className="absolute inset-0 opacity-[0.10]"
        style={{ backgroundImage: "radial-gradient(circle at 1px 1px, #fff 1px, transparent 0)", backgroundSize: "16px 16px" }}
      />
      <div className="absolute top-2.5 left-3 flex items-center gap-1.5">
        <span className="w-1.5 h-1.5 rounded-full bg-teal" />
        <span className="text-[10px] font-extrabold tracking-[0.2em] text-white/85">IRONBOOKS</span>
      </div>
      <div className="absolute top-2.5 right-3 text-[9px] font-semibold uppercase tracking-wider text-white/55">
        {catLabel}
      </div>
    </div>
  );
}

export function LearnClient({ resources }: { resources: Resource[] }) {
  const [active, setActive] = useState<Resource | null>(null);

  // Group by category preserving table sort order within each
  const byCategory = new Map<string, Resource[]>();
  for (const r of resources) {
    if (!byCategory.has(r.category)) byCategory.set(r.category, []);
    byCategory.get(r.category)!.push(r);
  }
  // Stable category order: prefer the friendly order, append unknowns
  const orderedCats = [
    "fundamentals", "quickstart", "statements", "cashflow", "taxes", "growth", "general",
  ].filter((c) => byCategory.has(c));
  for (const c of byCategory.keys()) {
    if (!orderedCats.includes(c)) orderedCats.push(c);
  }

  return (
    <div className="space-y-8">
      <div>
        <div className="text-xs text-ink-slate uppercase tracking-wider font-semibold">Financial literacy</div>
        <h1 className="text-3xl font-bold text-navy mt-1">Learn how to read your books</h1>
        <div className="text-sm text-ink-slate mt-1">
          Short videos from your Ironbooks team. The more you understand, the better decisions you make.
        </div>
      </div>

      {resources.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-2xl p-8 text-center">
          <GraduationCap size={32} className="text-ink-light mx-auto mb-3" />
          <h2 className="font-bold text-navy">Videos coming soon</h2>
          <p className="text-sm text-ink-slate mt-2 max-w-md mx-auto">
            Your Ironbooks team is recording a short library of training videos. Check back in a
            few days — we'll let you know when the first ones land.
          </p>
        </div>
      ) : (
        orderedCats.map((cat) => {
          const list = byCategory.get(cat) || [];
          const meta = CATEGORY_LABELS[cat] || { label: cat, subtitle: "" };
          return (
            <section key={cat}>
              <div className="mb-3">
                <h2 className="font-bold text-navy">{meta.label}</h2>
                {meta.subtitle && <div className="text-xs text-ink-slate mt-0.5">{meta.subtitle}</div>}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {list.map((r) => (
                  <VideoTile key={r.id} resource={r} onPlay={() => setActive(r)} />
                ))}
              </div>
            </section>
          );
        })
      )}

      {active && <VideoModal resource={active} onClose={() => setActive(null)} />}
    </div>
  );
}

// ─── VIDEO TILE ─────────────────────────────────────────────────────────

function VideoTile({ resource, onPlay }: { resource: Resource; onPlay: () => void }) {
  const hasEmbed = !!(resource.vimeo_url || resource.youtube_url || resource.video_url);

  return (
    <div
      className={`bg-white border border-slate-200 rounded-xl overflow-hidden ${
        hasEmbed ? "hover:border-teal/40 hover:shadow-sm cursor-pointer" : "opacity-60"
      }`}
      onClick={hasEmbed ? onPlay : undefined}
    >
      <div className="aspect-video bg-navy flex items-center justify-center relative overflow-hidden">
        {resource.thumbnail_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={resource.thumbnail_url} alt="" className="absolute inset-0 w-full h-full object-cover" />
        ) : (
          <BrandedThumb category={resource.category} />
        )}
        <div className={`relative z-10 ${hasEmbed ? "" : "opacity-60"}`}>
          {hasEmbed ? (
            <div className="w-12 h-12 rounded-full bg-white/15 backdrop-blur-sm border border-white/30 flex items-center justify-center shadow-lg">
              <Play size={20} className="text-white ml-0.5" />
            </div>
          ) : (
            <Clock size={24} className="text-white/90" />
          )}
        </div>
        {resource.duration_seconds && (
          <div className="absolute bottom-1 right-1 text-[9px] bg-black/60 text-white px-1 rounded z-10">
            {formatDuration(resource.duration_seconds)}
          </div>
        )}
        {!hasEmbed && (
          <div className="absolute bottom-1 left-1 text-[9px] bg-amber-500 text-white px-1.5 rounded z-10 font-semibold">
            COMING SOON
          </div>
        )}
      </div>
      <div className="p-3 space-y-1.5">
        <div className="text-sm font-semibold text-navy leading-snug">{resource.title}</div>
        {resource.description && (
          <div className="text-[11px] text-ink-slate line-clamp-2">{resource.description}</div>
        )}
        {resource.download_url && (
          <a
            href={resource.download_url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="inline-flex items-center gap-1 text-[10px] font-semibold text-teal-dark hover:underline"
          >
            <Download size={10} />
            {resource.download_label || "Download companion file"}
          </a>
        )}
      </div>
    </div>
  );
}

// ─── VIDEO MODAL ────────────────────────────────────────────────────────

function VideoModal({ resource, onClose }: { resource: Resource; onClose: () => void }) {
  const embedSrc = buildEmbedSrc(resource);
  return (
    <div
      className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl max-w-4xl w-full overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-200">
          <div className="min-w-0">
            <h3 className="font-bold text-navy truncate">{resource.title}</h3>
            {resource.description && (
              <div className="text-xs text-ink-slate mt-0.5 line-clamp-1">{resource.description}</div>
            )}
          </div>
          <button onClick={onClose} className="text-ink-slate hover:text-navy ml-3">
            <X size={20} />
          </button>
        </div>
        <div className="bg-black aspect-video">
          {embedSrc ? (
            <iframe
              src={embedSrc}
              allow="autoplay; fullscreen; picture-in-picture"
              allowFullScreen
              className="w-full h-full"
              title={resource.title}
            />
          ) : resource.video_url ? (
            <video src={resource.video_url} controls autoPlay className="w-full h-full" />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-white text-sm">
              Video not available
            </div>
          )}
        </div>
        {resource.download_url && (
          <div className="px-5 py-3 border-t border-slate-200 bg-slate-50">
            <a
              href={resource.download_url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-xs font-semibold text-teal-dark hover:underline"
            >
              <Download size={12} />
              {resource.download_label || "Download companion file"}
            </a>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── HELPERS ────────────────────────────────────────────────────────────

function buildEmbedSrc(r: Resource): string | null {
  // Vimeo: handle three URL shapes
  //   1. vimeo.com/12345
  //   2. vimeo.com/12345/abc123   ← private/unlisted with privacy hash
  //   3. player.vimeo.com/video/12345  (already an embed URL)
  // For private videos the hash MUST be forwarded as ?h=... or the
  // embed returns 401. (This is the reason your first set of links
  // wouldn't play — the hashes were getting stripped.)
  if (r.vimeo_url) {
    const m = r.vimeo_url.match(/vimeo\.com\/(?:video\/)?(\d+)(?:\/([a-z0-9]+))?/i);
    if (m) {
      const id = m[1];
      const hash = m[2];
      return hash
        ? `https://player.vimeo.com/video/${id}?h=${hash}`
        : `https://player.vimeo.com/video/${id}`;
    }
    if (r.vimeo_url.includes("player.vimeo.com")) return r.vimeo_url;
  }
  if (r.youtube_url) {
    const m = r.youtube_url.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/))([\w-]{11})/);
    if (m) return `https://www.youtube.com/embed/${m[1]}`;
  }
  return null;
}

function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
}
