-- 063: Listener triggers — DB event bus for the in-process listener subsystem.
--
-- Three triggers share one notify function. Payload is JSON with table, action,
-- row (selected fields via to_jsonb(NEW)), and epoch timestamp.
--
-- NOTE: LISTEN/NOTIFY requires a direct database connection, not a pgBouncer
-- pooled connection. Ensure DATABASE_URL (or a dedicated LISTEN URL) is a
-- direct connection when enabling the dbBridge listener.

-- Generic notify function: fires pg_notify on the shared channel.
CREATE OR REPLACE FUNCTION public.eos_listener_notify() RETURNS trigger AS $$
DECLARE payload jsonb;
BEGIN
  IF (TG_OP = 'DELETE') THEN payload := to_jsonb(OLD); ELSE payload := to_jsonb(NEW); END IF;
  PERFORM pg_notify('eos_listener_events', json_build_object(
    'table', TG_TABLE_NAME, 'action', TG_OP, 'row', payload, 'ts', extract(epoch from now())
  )::text);
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

-- cc_sessions: fire ONLY when status or pipeline_stage changes (not every UPDATE)
DROP TRIGGER IF EXISTS trg_cc_sessions_status_notify ON public.cc_sessions;
CREATE TRIGGER trg_cc_sessions_status_notify
  AFTER UPDATE OF status, pipeline_stage ON public.cc_sessions
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status OR OLD.pipeline_stage IS DISTINCT FROM NEW.pipeline_stage)
  EXECUTE FUNCTION public.eos_listener_notify();

-- email_events: fire on insert (new emails arriving)
DROP TRIGGER IF EXISTS trg_email_events_insert_notify ON public.email_events;
CREATE TRIGGER trg_email_events_insert_notify
  AFTER INSERT ON public.email_events
  FOR EACH ROW EXECUTE FUNCTION public.eos_listener_notify();

-- status_board: fire on insert or meaningful field changes
DROP TRIGGER IF EXISTS trg_status_board_notify ON public.status_board;
CREATE TRIGGER trg_status_board_notify
  AFTER INSERT OR UPDATE ON public.status_board
  FOR EACH ROW EXECUTE FUNCTION public.eos_listener_notify();
