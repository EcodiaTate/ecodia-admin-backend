-- Google Calendar events
CREATE TABLE IF NOT EXISTS calendar_events (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    google_event_id     TEXT UNIQUE NOT NULL,
    calendar_id         TEXT NOT NULL DEFAULT 'primary',
    summary             TEXT,
    description         TEXT,
    location            TEXT,
    start_time          TIMESTAMPTZ NOT NULL,
    end_time            TIMESTAMPTZ NOT NULL,
    all_day             BOOLEAN DEFAULT false,
    status              TEXT DEFAULT 'confirmed'
                        CHECK (status IN ('confirmed', 'tentative', 'cancelled')),
    organizer_email     TEXT,
    organizer_name      TEXT,
    attendees           JSONB DEFAULT '[]',
    recurring_event_id  TEXT,
    html_link           TEXT,
    conference_link     TEXT,
    source_calendar     TEXT DEFAULT 'tate@ecodia.au',
    raw_data            JSONB,
    created_at          TIMESTAMPTZ DEFAULT now(),
    updated_at          TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_calendar_events_start ON calendar_events(start_time);
CREATE INDEX IF NOT EXISTS idx_calendar_events_end ON calendar_events(end_time);
CREATE INDEX IF NOT EXISTS idx_calendar_events_google_id ON calendar_events(google_event_id);
CREATE INDEX IF NOT EXISTS idx_calendar_events_source ON calendar_events(source_calendar);

-- Sync state for incremental calendar sync
CREATE TABLE IF NOT EXISTS calendar_sync_state (
    id              TEXT PRIMARY KEY,  -- calendar email address
    sync_token      TEXT,              -- Google Calendar sync token for incremental sync
    updated_at      TIMESTAMPTZ DEFAULT now()
);
