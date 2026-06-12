-- Migration 67: client answers for ask-client reclass rows
-- The portal "Categorize" page writes the client's pick + note here;
-- the bookkeeper sees it as a chip on the reclass review screen and as
-- a from_client message on /today.
ALTER TABLE reclassifications
  ADD COLUMN IF NOT EXISTS client_response_account text,
  ADD COLUMN IF NOT EXISTS client_response_note text,
  ADD COLUMN IF NOT EXISTS client_responded_at timestamptz;
