"use client";

import { useCallback, useEffect, useState } from "react";
import { Award, Flame, Loader2, Target, TrendingUp, Users } from "lucide-react";
import { formatDuration } from "@/lib/time-tracking";

/**
 * The scoreboard's rendering half. Deliberate choices:
 *   - OUTCOME tiles lead (on-budget rate, months closed, client share). Hours are
 *     shown as progress against a derived goal, never as a ranking.
 *   - "Your week" is private and only ever the caller's own numbers.
 *   - Under-budget results are celebrated as wins, because the only budget
 *     feedback that existed before this was being asked to explain an overage.
 *   - The per-person table appears only when the server says the caller may see
 *     it (admins/leads); everyone else just sees their own row.
 */

interface Progress {
  todaySeconds: number; weekSeconds: number; targetMinutes: number;
  weekGoalMinutes: number; daysHitThisWeek: number; daysWorkedThisWeek: number;
  streakDays: number; perDay: { date: string; seconds: number; hit: boolean }[];
}
interface Person {
  userId: string; userName: string; role: string | null; isYou: boolean;
  clientSeconds: number; overheadSeconds: number; totalSeconds: number;
  daysWorked: number; clientSharePct: number | null;
}
interface Win {
  clientName: string; seconds: number; budgetSeconds: number; underByPct: number; summary: string;
}
interface Board {
  month: string;
  setup_pending?: boolean;
  canSeeEveryone?: boolean;
  team: {
    trackedSeconds: number; clientSeconds: number; overheadSeconds: number;
    clientSharePct: number | null;
    monthGoalSeconds: number; monthGoalPct: number | null;
    weekSeconds: number; weekGoalSeconds: number; weekGoalPct: number | null;
    peopleLogging: number; peopleTotal: number; workingDays: number;
  } | null;
  outcomes: {
    clientsWorked: number; onBudget: number; overBudget: number; onBudgetPct: number | null;
    monthsClosed: number | null; wins: Win[];
  } | null;
  you: Progress | null;
  people: Person[];
}

const monthLabel = (m: string) => {
  const [y, mo] = m.split("-").map(Number);
  return new Date(Date.UTC(y, (mo || 1) - 1, 1)).toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" });
};
const shiftMonth = (m: string, delta: number) => {
  const [y, mo] = m.split("-").map(Number);
  const d = new Date(Date.UTC(y, (mo || 1) - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
};
const DAY_LABELS = ["M", "T", "W", "T", "F", "S", "S"];

export function ScoreboardClient({ initialMonth, firstName }: { initialMonth: string; firstName: string | null }) {
  const [month, setMonth] = useState(initialMonth);
  const [data, setData] = useState<Board | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (m: string) => {
    setLoading(true); setError(null);
    try {
      const r = await fetch(`/api/time-tracking/scoreboard?month=${m}`, { cache: "no-store" });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.error || `Failed (${r.status})`);
      setData(d);
    } catch (e: any) {
      setError(e?.message || "Failed to load the scoreboard");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(month); }, [month, load]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="inline-flex items-center gap-1 rounded-lg border border-gray-200 bg-white overflow-hidden">
          <button onClick={() => setMonth(shiftMonth(month, -1))} className="px-2.5 py-1.5 text-xs font-semibold text-ink-slate hover:bg-gray-50">←</button>
          <span className="px-3 py-1.5 text-xs font-bold text-navy min-w-[130px] text-center">{monthLabel(month)}</span>
          <button
            onClick={() => setMonth(shiftMonth(month, 1))}
            disabled={month >= initialMonth}
            className="px-2.5 py-1.5 text-xs font-semibold text-ink-slate hover:bg-gray-50 disabled:opacity-40"
          >→</button>
        </div>
        {month !== initialMonth && (
          <button onClick={() => setMonth(initialMonth)} className="text-xs font-semibold text-teal hover:underline">This month</button>
        )}
      </div>

      {error && <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-xs text-red-800">{error}</div>}

      {loading && !data ? (
        <div className="rounded-xl border border-cardline bg-white px-4 py-12 text-center text-xs text-ink-slate">
          <Loader2 size={15} className="animate-spin inline mr-1.5" /> Loading…
        </div>
      ) : data?.setup_pending ? (
        <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-xs text-amber-900">
          Time tracking isn&apos;t set up yet — migration 146 needs applying.
        </div>
      ) : data ? (
        <>
          {/* Your week — private, and first, because it's the part you can act on. */}
          {data.you && data.you.targetMinutes > 0 && (
            <div className="rounded-xl border border-cardline bg-white overflow-hidden">
              <div className="px-4 py-2.5 border-b border-gray-100 flex items-center gap-2">
                <Target size={14} className="text-teal" />
                <span className="text-sm font-bold text-navy">{firstName ? `${firstName}'s week` : "Your week"}</span>
                <span className="text-[11px] text-ink-slate">· only you and your manager see this</span>
                {data.you.streakDays > 1 && (
                  <span className="ml-auto inline-flex items-center gap-1 text-[11px] font-bold text-gold">
                    <Flame size={12} /> {data.you.streakDays}-day streak
                  </span>
                )}
              </div>
              <div className="px-4 py-3">
                <div className="flex items-end gap-1.5">
                  {data.you.perDay.map((d, i) => {
                    const pct = data.you!.targetMinutes > 0
                      ? Math.min(100, Math.round((d.seconds / (data.you!.targetMinutes * 60)) * 100))
                      : 0;
                    return (
                      <div key={d.date} className="flex-1 flex flex-col items-center gap-1">
                        <div className="w-full h-16 flex flex-col justify-end rounded bg-gray-100 overflow-hidden" title={`${d.date} — ${formatDuration(d.seconds)}`}>
                          <div className={`w-full ${d.hit ? "bg-teal" : d.seconds > 0 ? "bg-amber-400" : ""}`} style={{ height: `${pct}%` }} />
                        </div>
                        <span className="text-[10px] text-ink-slate">{DAY_LABELS[i]}</span>
                      </div>
                    );
                  })}
                </div>
                <div className="mt-2 flex items-center justify-between text-xs">
                  <span className="text-ink-slate">
                    Today <span className="font-mono font-bold text-navy">{formatDuration(data.you.todaySeconds)}</span>
                    {" "}of {formatDuration(data.you.targetMinutes * 60)}
                  </span>
                  <span className="text-ink-slate">
                    Week <span className="font-mono font-bold text-navy">{formatDuration(data.you.weekSeconds)}</span>
                    {" "}of {formatDuration(data.you.weekGoalMinutes * 60)} · {data.you.daysHitThisWeek} of {data.you.daysWorkedThisWeek} days hit
                  </span>
                </div>
              </div>
            </div>
          )}

          {/* Outcomes — what the board is actually scored on. */}
          {data.outcomes && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <Tile
                label="Clients on budget"
                value={data.outcomes.onBudgetPct !== null ? `${data.outcomes.onBudgetPct}%` : "—"}
                sub={`${data.outcomes.onBudget} of ${data.outcomes.clientsWorked} worked`}
                good={(data.outcomes.onBudgetPct ?? 0) >= 80}
              />
              <Tile
                label="Months closed"
                value={data.outcomes.monthsClosed !== null ? String(data.outcomes.monthsClosed) : "—"}
                sub={data.outcomes.monthsClosed === null ? "not available" : "client-months delivered"}
              />
              <Tile
                label="Time on clients"
                value={data.team?.clientSharePct !== null && data.team ? `${data.team.clientSharePct}%` : "—"}
                sub={data.team ? `${formatDuration(data.team.overheadSeconds)} overhead` : ""}
              />
              <Tile
                label="Logging"
                value={data.team ? `${data.team.peopleLogging}/${data.team.peopleTotal}` : "—"}
                sub="people tracked time"
                good={!!data.team && data.team.peopleLogging === data.team.peopleTotal}
              />
            </div>
          )}

          {/* Team goal progress — hours as a denominator, never a ranking. */}
          {data.team && (
            <div className="rounded-xl border border-cardline bg-white overflow-hidden">
              <div className="px-4 py-2.5 border-b border-gray-100 flex items-center gap-2">
                <TrendingUp size={14} className="text-teal" />
                <span className="text-sm font-bold text-navy">Team</span>
                <span className="text-[11px] text-ink-slate">
                  · goal is everyone&apos;s daily targets × {data.team.workingDays} working days
                </span>
              </div>
              <div className="px-4 py-3 space-y-3">
                <GoalBar
                  label="This month"
                  seconds={data.team.trackedSeconds}
                  goalSeconds={data.team.monthGoalSeconds}
                  pct={data.team.monthGoalPct}
                />
                <GoalBar
                  label="This week"
                  seconds={data.team.weekSeconds}
                  goalSeconds={data.team.weekGoalSeconds}
                  pct={data.team.weekGoalPct}
                />
              </div>
            </div>
          )}

          {/* Wins — under budget is worth celebrating, not just surviving. */}
          {data.outcomes && data.outcomes.wins.length > 0 && (
            <div className="rounded-xl border border-teal-border bg-teal-lighter overflow-hidden">
              <div className="px-4 py-2.5 border-b border-teal-border flex items-center gap-2">
                <Award size={14} className="text-teal-dark" />
                <span className="text-sm font-bold text-navy">Came in under budget</span>
              </div>
              <div className="divide-y divide-teal-border/50">
                {data.outcomes.wins.map((w) => (
                  <div key={w.clientName} className="px-4 py-2 flex items-center gap-3 text-xs">
                    <span className="flex-1 min-w-0 truncate font-semibold text-navy">{w.clientName}</span>
                    <span className="text-ink-slate">{w.summary}</span>
                    <span className="font-bold text-teal-dark shrink-0">{w.underByPct}% under</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Per person — managers see the team; everyone else sees their own row. */}
          {data.people.length > 0 && (
            <div className="rounded-xl border border-cardline bg-white overflow-hidden">
              <div className="px-4 py-2.5 border-b border-gray-100 flex items-center gap-2">
                <Users size={14} className="text-teal" />
                <span className="text-sm font-bold text-navy">
                  {data.canSeeEveryone ? "By person" : "You"}
                </span>
                {data.canSeeEveryone && (
                  <span className="text-[11px] text-ink-slate">· managers only</span>
                )}
              </div>
              <div className="divide-y divide-gray-100">
                {data.people.map((p) => (
                  <div key={p.userId} className={`px-4 py-2 flex items-center gap-3 text-xs ${p.isYou ? "bg-teal-lighter/40" : ""}`}>
                    <span className="flex-1 min-w-0 truncate font-semibold text-navy">
                      {p.userName}{p.isYou && <span className="ml-1.5 text-[10px] font-bold text-teal">YOU</span>}
                      {p.role && <span className="ml-1.5 text-[10px] font-normal text-ink-slate uppercase">{p.role}</span>}
                    </span>
                    <span className="text-[11px] text-ink-slate shrink-0">
                      {p.daysWorked} day{p.daysWorked === 1 ? "" : "s"}
                      {p.clientSharePct !== null && <> · {p.clientSharePct}% on clients</>}
                    </span>
                    <span className="font-mono font-bold text-navy shrink-0 w-[70px] text-right">
                      {formatDuration(p.totalSeconds)}
                    </span>
                  </div>
                ))}
              </div>
              <div className="px-4 py-2 border-t border-gray-100 text-[11px] text-ink-slate">
                Hours are the denominator here, never the score — the tiles above are what the month is judged on.
              </div>
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}

function Tile({ label, value, sub, good }: { label: string; value: string; sub?: string; good?: boolean }) {
  return (
    <div className={`rounded-xl border bg-white px-4 py-3 ${good ? "border-teal-border" : "border-cardline"}`}>
      <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-slate">{label}</div>
      <div className={`mt-0.5 text-xl font-bold ${good ? "text-teal-dark" : "text-navy"}`}>{value}</div>
      {sub && <div className="text-[11px] text-ink-slate">{sub}</div>}
    </div>
  );
}

function GoalBar({ label, seconds, goalSeconds, pct }: { label: string; seconds: number; goalSeconds: number; pct: number | null }) {
  const width = Math.min(100, pct ?? 0);
  return (
    <div>
      <div className="flex items-center justify-between text-xs mb-1">
        <span className="font-semibold text-navy">{label}</span>
        <span className="text-ink-slate">
          <span className="font-mono font-bold text-navy">{formatDuration(seconds)}</span>
          {goalSeconds > 0 && <> of {formatDuration(goalSeconds)} · {pct}%</>}
        </span>
      </div>
      <div className="h-2 rounded-full bg-gray-100 overflow-hidden">
        <div className="h-full rounded-full bg-teal" style={{ width: `${width}%` }} />
      </div>
    </div>
  );
}
