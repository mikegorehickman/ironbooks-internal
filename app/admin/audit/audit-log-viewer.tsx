"use client";

import { useState, useMemo } from "react";
import { Search, Filter, Download, Clock, User as UserIcon, FileText, Database, X } from "lucide-react";

/** Mirrors AuditFeedRow from lib/audit-query — the shape both the page and the
 *  filter API now return, straight off audit_log rather than the capped view. */
interface AuditEvent {
  id: string;
  event_type: string;
  occurred_at: string | null;
  user_id: string | null;
  user_name: string | null;
  user_role: string | null;
  job_id: string | null;
  action_id: string | null;
  client_link_id: string | null;
  client_name: string | null;
  request_payload: any;
  response_payload: any;
  error_message: string | null;
}

interface User { id: string; full_name: string }
interface Client { id: string; client_name: string }

const EVENT_TYPES = [
  "job_start",
  "job_complete",
  "job_failed",
  "stage_start",
  "stage_complete",
  "qbo_create_parent",
  "qbo_create_child",
  "qbo_rename",
  "qbo_inactivate",
  "action_resolved",
  "user_invited",
  "user_permission_change",
  "error",
  "warning",
];

export function AuditLogViewer({
  initialEvents,
  initialNotes = [],
  users,
  clients,
}: {
  initialEvents: AuditEvent[];
  initialNotes?: string[];
  users: User[];
  clients: Client[];
}) {
  const [events, setEvents] = useState(initialEvents);
  const [notes, setNotes] = useState<string[]>(initialNotes);
  const [loading, setLoading] = useState(false);
  const [filters, setFilters] = useState({
    user_id: "",
    client_link_id: "",
    event_type: "",
    since: "",
    search: "",
  });
  const [selected, setSelected] = useState<AuditEvent | null>(null);

  async function applyFilters() {
    setLoading(true);
    const params = new URLSearchParams();
    if (filters.user_id) params.set("user_id", filters.user_id);
    if (filters.client_link_id) params.set("client_link_id", filters.client_link_id);
    if (filters.event_type) params.set("event_type", filters.event_type);
    if (filters.since) params.set("since", new Date(filters.since).toISOString());

    const res = await fetch(`/api/admin/audit?${params}`);
    const data = await res.json();
    setEvents(data.events || []);
    setNotes(data.error ? [data.error] : data.notes || []);
    setLoading(false);
  }

  function resetFilters() {
    setFilters({ user_id: "", client_link_id: "", event_type: "", since: "", search: "" });
    setEvents(initialEvents);
    setNotes(initialNotes);
  }

  const filteredEvents = useMemo(() => {
    if (!filters.search) return events;
    const s = filters.search.toLowerCase();
    return events.filter(
      (e) =>
        e.event_type.toLowerCase().includes(s) ||
        e.user_name?.toLowerCase().includes(s) ||
        e.client_name?.toLowerCase().includes(s) ||
        JSON.stringify(e.request_payload).toLowerCase().includes(s) ||
        JSON.stringify(e.response_payload).toLowerCase().includes(s)
    );
  }, [events, filters.search]);

  function exportCSV() {
    // client_id travels alongside client — an event whose name didn't resolve is
    // still traceable, instead of exporting as an anonymous blank cell.
    const rows = [
      ["timestamp", "user", "role", "event_type", "client", "client_id", "job_id", "details"],
      ...filteredEvents.map((e) => [
        e.occurred_at || "",
        e.user_name || "system",
        e.user_role || "",
        e.event_type,
        e.client_name || (e.client_link_id ? "(unnamed client)" : "(no client — fleet-level)"),
        e.client_link_id || "",
        e.job_id || "",
        JSON.stringify(e.request_payload || e.response_payload || ""),
      ]),
    ];
    const csv = rows
      .map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(","))
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `ironbooks-audit-${new Date().toISOString().split("T")[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div>
      {/* Filters */}
      <div className="rounded-xl bg-white border border-gray-200 mb-4 p-4">
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-2 flex-1 min-w-[200px]">
            <Search size={16} className="text-ink-light" />
            <input
              type="text"
              placeholder="Search events..."
              value={filters.search}
              onChange={(e) => setFilters({ ...filters, search: e.target.value })}
              className="flex-1 px-2 py-1.5 text-sm outline-none text-navy"
            />
          </div>

          <select
            value={filters.user_id}
            onChange={(e) => setFilters({ ...filters, user_id: e.target.value })}
            className="px-3 py-1.5 border border-gray-200 rounded-md text-xs text-navy bg-white"
          >
            <option value="">All users</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>{u.full_name}</option>
            ))}
          </select>

          <select
            value={filters.client_link_id}
            onChange={(e) => setFilters({ ...filters, client_link_id: e.target.value })}
            className="px-3 py-1.5 border border-gray-200 rounded-md text-xs text-navy bg-white"
          >
            <option value="">All clients</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>{c.client_name}</option>
            ))}
          </select>

          <select
            value={filters.event_type}
            onChange={(e) => setFilters({ ...filters, event_type: e.target.value })}
            className="px-3 py-1.5 border border-gray-200 rounded-md text-xs text-navy bg-white"
          >
            <option value="">All events</option>
            {EVENT_TYPES.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>

          <input
            type="date"
            value={filters.since}
            onChange={(e) => setFilters({ ...filters, since: e.target.value })}
            className="px-3 py-1.5 border border-gray-200 rounded-md text-xs text-navy"
          />

          <button
            onClick={applyFilters}
            disabled={loading}
            className="inline-flex items-center gap-2 bg-navy text-white text-xs font-semibold px-3 py-1.5 rounded-md hover:bg-navy-light disabled:opacity-50"
          >
            <Filter size={12} />
            Apply
          </button>

          <button
            onClick={resetFilters}
            className="text-xs font-semibold text-ink-slate hover:text-navy"
          >
            Reset
          </button>

          <button
            onClick={exportCSV}
            className="ml-auto inline-flex items-center gap-2 bg-teal hover:bg-teal-dark text-white text-xs font-semibold px-3 py-1.5 rounded-md"
          >
            <Download size={12} />
            Export CSV
          </button>
        </div>
      </div>

      {/* Coverage notes — what this result does NOT include. Stated because a
          short list with no explanation reads as "nothing happened". */}
      {notes.length > 0 && (
        <div className="mb-3 rounded-lg border border-[#DAB461]/40 bg-[#DAB461]/10 px-4 py-3">
          <div className="text-[11px] font-bold uppercase tracking-wider text-[#8A6D2F] mb-1">
            Coverage
          </div>
          <ul className="space-y-1">
            {notes.map((n, i) => (
              <li key={i} className="text-xs text-[#6B5524] leading-relaxed">
                {n}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Results count */}
      <div className="text-xs text-ink-slate mb-3 px-1">
        {filteredEvents.length} events{loading && " (loading...)"}
        {filteredEvents.length > 0 && (
          <>
            {" · "}
            {filteredEvents.filter((e) => e.client_link_id).length} tied to a client
          </>
        )}
      </div>

      {/* Events table */}
      <div className="rounded-xl overflow-hidden bg-white border border-gray-200">
        <div
          className="grid items-center px-5 py-3 text-xs font-bold uppercase tracking-wider bg-gray-50 text-ink-slate border-b border-gray-200"
          style={{ gridTemplateColumns: "1.2fr 1.2fr 1.5fr 1.5fr 1fr" }}
        >
          <div>Time</div>
          <div>User</div>
          <div>Event</div>
          <div>Target</div>
          <div></div>
        </div>

        {filteredEvents.length === 0 ? (
          <p className="py-12 text-center text-sm text-ink-slate">No events match your filters.</p>
        ) : (
          filteredEvents.map((event) => (
            <div
              key={event.id}
              className="grid items-center px-5 py-3 hover:bg-teal-lighter cursor-pointer border-b border-gray-100"
              style={{ gridTemplateColumns: "1.2fr 1.2fr 1.5fr 1.5fr 1fr" }}
              onClick={() => setSelected(event)}
            >
              <div className="text-xs text-navy">
                <div className="font-medium">
                  {new Date(event.occurred_at || 0).toLocaleTimeString("en-US", {
                    hour12: false,
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit",
                  })}
                </div>
                <div className="text-ink-light">
                  {new Date(event.occurred_at || 0).toLocaleDateString()}
                </div>
              </div>

              <div className="flex items-center gap-2">
                {event.user_name ? (
                  <>
                    <div className="rounded-full flex items-center justify-center font-bold text-[10px] flex-shrink-0 w-6 h-6 bg-teal-light text-teal">
                      {event.user_name.charAt(0)}
                    </div>
                    <div>
                      <div className="text-xs font-semibold text-navy truncate">
                        {event.user_name}
                      </div>
                      <div className="text-[10px] text-ink-slate capitalize">{event.user_role}</div>
                    </div>
                  </>
                ) : (
                  <span className="text-xs text-ink-light italic">System</span>
                )}
              </div>

              <div>
                <span
                  className="inline-block px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider"
                  style={getEventStyle(event.event_type)}
                >
                  {event.event_type.replace(/_/g, " ")}
                </span>
                {event.request_payload?.message && (
                  <div className="text-xs text-ink-slate mt-1 line-clamp-1">
                    {event.request_payload.message}
                  </div>
                )}
              </div>

              <div className="text-xs">
                {event.client_name && (
                  <div className="flex items-center gap-1 text-navy">
                    <Database size={11} className="text-ink-light" />
                    <span className="font-medium truncate">{event.client_name}</span>
                  </div>
                )}
                {event.job_id && (
                  <div className="text-ink-light text-[10px] mt-0.5 truncate">
                    Job: {event.job_id.slice(0, 8)}...
                  </div>
                )}
              </div>

              <div className="text-right">
                <button className="text-xs font-semibold text-teal hover:text-teal-dark">
                  View →
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Event detail modal */}
      {selected && <EventDetailModal event={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

function EventDetailModal({ event, onClose }: { event: AuditEvent; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl max-w-2xl w-full max-h-[80vh] flex flex-col">
        <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
          <h3 className="text-base font-bold text-navy">Event Details</h3>
          <button onClick={onClose} className="p-1 rounded hover:bg-gray-100">
            <X size={18} className="text-ink-slate" />
          </button>
        </div>

        <div className="p-6 overflow-y-auto space-y-4">
          <div className="grid grid-cols-2 gap-4 text-sm">
            <Field label="Event Type" value={event.event_type} />
            <Field label="Timestamp" value={event.occurred_at ? new Date(event.occurred_at).toLocaleString() : "—"} />
            <Field label="User" value={event.user_name || "System"} />
            <Field label="Role" value={event.user_role || "—"} />
            <Field label="Client" value={event.client_name || "—"} />
            <Field label="Job ID" value={event.job_id || "—"} />
          </div>

          {event.request_payload && (
            <div>
              <div className="text-xs font-bold uppercase tracking-wider text-ink-slate mb-2">
                Request Payload
              </div>
              <pre className="bg-gray-50 rounded-lg p-3 text-xs overflow-x-auto text-navy">
                {JSON.stringify(event.request_payload, null, 2)}
              </pre>
            </div>
          )}

          {event.response_payload && (
            <div>
              <div className="text-xs font-bold uppercase tracking-wider text-ink-slate mb-2">
                Response Payload
              </div>
              <pre className="bg-gray-50 rounded-lg p-3 text-xs overflow-x-auto text-navy">
                {JSON.stringify(event.response_payload, null, 2)}
              </pre>
            </div>
          )}

          {event.error_message && (
            <div>
              <div className="text-xs font-bold uppercase tracking-wider text-red-600 mb-2">
                Error
              </div>
              <pre className="bg-red-50 border border-red-200 rounded-lg p-3 text-xs text-red-700">
                {event.error_message}
              </pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs font-semibold uppercase tracking-wider text-ink-slate mb-0.5">
        {label}
      </div>
      <div className="text-sm text-navy">{value}</div>
    </div>
  );
}

function getEventStyle(eventType: string): { color: string; backgroundColor: string } {
  if (eventType.includes("fail") || eventType === "error") {
    return { color: "#DC2626", backgroundColor: "#FEE2E2" };
  }
  if (eventType === "warning") {
    return { color: "#F59E0B", backgroundColor: "#FEF3C7" };
  }
  if (eventType.includes("complete")) {
    return { color: "#10B981", backgroundColor: "#D1FAE5" };
  }
  if (eventType.includes("permission_change") || eventType.includes("invited")) {
    return { color: "#7C3AED", backgroundColor: "#EDE9FE" };
  }
  if (eventType.startsWith("stage_")) {
    return { color: "#2563EB", backgroundColor: "#DBEAFE" };
  }
  return { color: "#475569", backgroundColor: "#F1F5F9" };
}
