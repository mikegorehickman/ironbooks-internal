-- DEMO SEED for reviewing the escalations feature (run AFTER migration 105).
-- Creates click-through escalations on TEST clients only ("Test Painting Co
-- LLC" / "Test Co") — never on real clients. All reasons are prefixed [DEMO].
-- Derived badges (BS OWED, BILLING, DISCONNECTED, STUCK) need no seeding —
-- they show real data.
--
-- To remove every trace after review:
--   DELETE FROM client_escalations WHERE reason LIKE '[DEMO]%';

-- Open, high priority, unassigned — shows the "needs an owner" state.
INSERT INTO client_escalations (client_link_id, kind, reason, note, priority, raised_by)
SELECT c.id, 'general', '[DEMO] Needs senior review', 'Client asked about switching to accrual reporting — needs a senior opinion before we respond.', 'high', u.id
FROM client_links c, users u
WHERE c.client_name ILIKE '%test painting%' AND u.email ILIKE 'mike@%'
LIMIT 1
ON CONFLICT DO NOTHING;

-- Open, billing kind, assigned — shows owner display + kind variety.
INSERT INTO client_escalations (client_link_id, kind, reason, note, priority, raised_by, assignee_id)
SELECT c.id, 'billing', '[DEMO] Billing issue', 'E-transfer bounced twice; needs a call before the next close.', 'high', u.id, u.id
FROM client_links c, users u
WHERE c.client_name ILIKE '%test co%' AND c.client_name NOT ILIKE '%painting%' AND u.email ILIKE 'mike@%'
LIMIT 1
ON CONFLICT DO NOTHING;

-- Resolved — shows the history/resolved state in the queue.
INSERT INTO client_escalations (client_link_id, kind, reason, note, priority, raised_by, assignee_id, status, resolved_by, resolved_at, resolution_note)
SELECT c.id, 'general', '[DEMO] Waiting on decision', 'Resolved example so the review shows the full lifecycle.', 'low', u.id, u.id, 'resolved', u.id, now() - interval '2 days', 'Talked to the client — proceeding as planned.'
FROM client_links c, users u
WHERE c.client_name ILIKE '%test painting%' AND u.email ILIKE 'mike@%'
LIMIT 1
ON CONFLICT DO NOTHING;
