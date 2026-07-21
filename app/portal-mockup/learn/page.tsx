/**
 * Learn — training LMS mockup.
 *
 * Video library + per-client progress tracking. Lets bookkeepers (Ironbooks)
 * push training content out to all clients (or specific ones), and lets the
 * client see what's available, what they've watched, and what to do next.
 *
 * Real version:
 *   - Videos hosted in Vimeo/Wistia (or YouTube unlisted) for analytics
 *   - Progress stored in Supabase per (user_id, video_id)
 *   - Admin UI in SNAP to upload/organize/assign videos
 *   - Optional: short quizzes, completion certificates
 */
import { Play, Clock, CheckCircle2, BookOpen, TrendingUp, Award, Lock } from "lucide-react";

export default function LearnMockup() {
  return (
    <div className="space-y-8">
      <div>
        <div className="text-xs text-ink-slate uppercase tracking-wider font-semibold">Financial literacy</div>
        <h1 className="text-3xl font-bold text-navy mt-1">Learn how to read your books</h1>
        <div className="text-sm text-ink-slate mt-1">
          Short videos and lessons from your Ironbooks team. The more you understand,
          the better decisions you make.
        </div>
      </div>

      {/* Progress summary */}
      <div className="grid grid-cols-3 gap-4">
        <ProgressStat icon={CheckCircle2} label="Watched" value="7" total="24" color="emerald" />
        <ProgressStat icon={Clock} label="In your queue" value="3" color="amber" />
        <ProgressStat icon={Award} label="Earned" value="2" suffix="badges" color="teal" />
      </div>

      {/* Continue watching */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-bold text-navy">Continue where you left off</h2>
        </div>
        <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden flex">
          <div className="w-64 bg-navy aspect-video flex items-center justify-center relative">
            <Play size={32} className="text-white opacity-80" />
            <div className="absolute bottom-0 left-0 right-0 h-1 bg-white/20">
              <div className="h-full w-2/5 bg-teal"></div>
            </div>
            <div className="absolute bottom-2 right-2 text-[10px] bg-black/60 text-white px-1.5 py-0.5 rounded">
              4:12 / 9:30
            </div>
          </div>
          <div className="flex-1 p-5">
            <div className="text-[10px] uppercase tracking-wider font-bold text-teal-dark">Lesson 3 of 6 · Cash flow basics</div>
            <h3 className="font-bold text-navy mt-1">Why profitable businesses still run out of cash</h3>
            <p className="text-sm text-ink-slate mt-2">
              You can be profitable on paper but cash-poor in your bank account. This 10-minute
              lesson explains why and how to spot it before it bites you.
            </p>
            <button className="mt-3 inline-flex items-center gap-1.5 px-3 py-1.5 bg-teal text-white text-xs font-semibold rounded-lg hover:bg-teal-dark">
              <Play size={11} /> Resume
            </button>
          </div>
        </div>
      </section>

      {/* Course tracks */}
      <section>
        <h2 className="font-bold text-navy mb-3">Learning tracks</h2>
        <div className="grid grid-cols-2 gap-4">
          <TrackCard
            icon={BookOpen}
            title="Reading your financial statements"
            description="6 videos · 47 min total"
            progress={2}
            total={6}
            color="teal"
          />
          <TrackCard
            icon={TrendingUp}
            title="Cash flow & cash management"
            description="5 videos · 38 min total"
            progress={3}
            total={5}
            color="amber"
          />
          <TrackCard
            icon={Award}
            title="Tax planning for painters"
            description="4 videos · 31 min total"
            progress={2}
            total={4}
            color="purple"
          />
          <TrackCard
            icon={Lock}
            title="Growing your painting business"
            description="6 videos · 52 min total"
            progress={0}
            total={6}
            color="slate"
            locked
            unlockHint="Complete 'Reading your financial statements' first"
          />
        </div>
      </section>

      {/* Single videos / library */}
      <section>
        <h2 className="font-bold text-navy mb-3">Quick lessons</h2>
        <div className="grid grid-cols-3 gap-3">
          {[
            { title: "What is gross profit?", duration: "3:20", watched: true },
            { title: "How to read an A/R Aging report", duration: "5:10", watched: true },
            { title: "When to pay yourself vs reinvest", duration: "7:45", watched: false },
            { title: "Why your bank balance doesn't match your books", duration: "6:30", watched: false },
            { title: "Quarterly taxes 101", duration: "4:50", watched: true },
            { title: "Pricing your jobs to actually be profitable", duration: "11:20", watched: false },
          ].map((v, i) => (
            <VideoTile key={i} {...v} />
          ))}
        </div>
      </section>

      {/* Suggested by your bookkeeper */}
      <section>
        <div className="bg-teal/5 border border-teal/30 rounded-xl p-4">
          <div className="flex items-start gap-3">
            <div className="w-8 h-8 rounded-full bg-teal text-white flex items-center justify-center font-bold text-sm flex-shrink-0">
              L
            </div>
            <div className="flex-1">
              <div className="text-xs font-bold text-teal-dark uppercase tracking-wider">From Lisa, your Ironbooks bookkeeper</div>
              <div className="text-sm text-navy mt-1 italic">
                "Hey Corby — based on what we talked about last call, I think these two videos
                will help. The hire-vs-subcontract one is especially relevant given your growth this quarter."
              </div>
              <div className="mt-3 flex gap-2">
                <button className="text-xs px-3 py-1 bg-white border border-slate-300 rounded font-semibold">
                  📺 Hire vs subcontract math
                </button>
                <button className="text-xs px-3 py-1 bg-white border border-slate-300 rounded font-semibold">
                  📺 Setting aside for taxes
                </button>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

function ProgressStat({ icon: Icon, label, value, total, suffix, color }: { icon: any; label: string; value: string; total?: string; suffix?: string; color: string }) {
  const colors: Record<string, string> = {
    emerald: "text-emerald-700",
    amber: "text-amber-700",
    teal: "text-teal-dark",
  };
  return (
    <div className="bg-white border border-slate-200 rounded-xl p-4 flex items-center gap-3">
      <Icon size={20} className={colors[color]} />
      <div>
        <div className="text-xs text-ink-slate">{label}</div>
        <div className="text-xl font-bold text-navy">
          {value}{total && <span className="text-ink-light text-sm font-normal"> / {total}</span>}
          {suffix && <span className="text-ink-slate text-sm font-normal"> {suffix}</span>}
        </div>
      </div>
    </div>
  );
}

function TrackCard({ icon: Icon, title, description, progress, total, color, locked, unlockHint }: { icon: any; title: string; description: string; progress: number; total: number; color: string; locked?: boolean; unlockHint?: string }) {
  const colors: Record<string, string> = {
    teal: "border-teal/30 bg-teal/5",
    amber: "border-amber-200 bg-amber-50",
    purple: "border-teal-border bg-teal-light",
    slate: "border-slate-200 bg-slate-50 opacity-60",
  };
  const pct = total > 0 ? Math.round((progress / total) * 100) : 0;
  return (
    <div className={`p-5 border rounded-2xl ${colors[color]}`}>
      <div className="flex items-start gap-3">
        <Icon size={20} className="text-ink-slate flex-shrink-0 mt-0.5" />
        <div className="flex-1">
          <h3 className="font-bold text-navy">{title}</h3>
          <div className="text-xs text-ink-slate mt-0.5">{description}</div>
          {!locked ? (
            <>
              <div className="mt-3 h-1.5 bg-white rounded-full overflow-hidden">
                <div className="h-full bg-teal" style={{ width: `${pct}%` }}></div>
              </div>
              <div className="mt-1 text-[11px] text-ink-slate">
                {progress} of {total} watched
              </div>
            </>
          ) : (
            <div className="mt-2 text-[11px] text-ink-light italic">
              <Lock size={9} className="inline mr-0.5" />
              {unlockHint}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function VideoTile({ title, duration, watched }: { title: string; duration: string; watched: boolean }) {
  return (
    <div className="bg-white border border-slate-200 rounded-xl overflow-hidden hover:border-teal/40 hover:shadow-sm cursor-pointer">
      <div className="aspect-video bg-navy/80 flex items-center justify-center relative">
        <Play size={20} className="text-white opacity-80" />
        <div className="absolute bottom-1 right-1 text-[9px] bg-black/60 text-white px-1 rounded">
          {duration}
        </div>
        {watched && (
          <div className="absolute top-1 right-1 bg-emerald-500 text-white rounded-full p-0.5">
            <CheckCircle2 size={11} />
          </div>
        )}
      </div>
      <div className="p-2.5">
        <div className="text-xs font-semibold text-navy line-clamp-2">{title}</div>
      </div>
    </div>
  );
}
