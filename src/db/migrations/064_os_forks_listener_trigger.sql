-- 064: os_forks listener trigger
--
-- Extends eos_listener_notify_compact() to handle the os_forks table,
-- then adds an AFTER UPDATE trigger on public.os_forks so fork state
-- changes are broadcast on the eos_listener_events channel.
--
-- Whitelisted os_forks columns: fork_id, parent_id, status,
-- last_heartbeat, result, next_step, started_at, ended_at.
--
-- Uses eos_listener_notify_compact (not eos_listener_notify) to avoid
-- sending large brief/context_mode text fields over LISTEN/NOTIFY.

-- Step 1: Extend eos_listener_notify_compact to handle os_forks rows.
-- Preserves existing behaviour for cc_sessions, email_events, status_board.
CREATE OR REPLACE FUNCTION public.eos_listener_notify_compact()
  RETURNS trigger
  LANGUAGE plpgsql
AS $$
DECLARE
  payload jsonb;
  row_compact jsonb;
BEGIN
  IF (TG_TABLE_NAME = 'cc_sessions') THEN
    row_compact := jsonb_build_object(
      'id',               COALESCE(NEW.id,               OLD.id),
      'status',           COALESCE(NEW.status,           OLD.status),
      'pipeline_stage',   COALESCE(NEW.pipeline_stage,   OLD.pipeline_stage),
      'codebase_id',      COALESCE(NEW.codebase_id,      OLD.codebase_id),
      'completed_at',     COALESCE(NEW.completed_at,     OLD.completed_at),
      'commit_sha',       COALESCE(NEW.commit_sha,       OLD.commit_sha),
      'confidence_score', COALESCE(NEW.confidence_score, OLD.confidence_score),
      'error_message',    COALESCE(NEW.error_message,    OLD.error_message)
    );
  ELSIF (TG_TABLE_NAME = 'email_events') THEN
    row_compact := to_jsonb(NEW);
  ELSIF (TG_TABLE_NAME = 'status_board') THEN
    row_compact := jsonb_build_object(
      'id',              COALESCE(NEW.id,              OLD.id),
      'entity_type',     COALESCE(NEW.entity_type,     OLD.entity_type),
      'entity_ref',      COALESCE(NEW.entity_ref,      OLD.entity_ref),
      'name',            COALESCE(NEW.name,            OLD.name),
      'status',          COALESCE(NEW.status,          OLD.status),
      'next_action',     COALESCE(NEW.next_action,     OLD.next_action),
      'next_action_by',  COALESCE(NEW.next_action_by,  OLD.next_action_by),
      'priority',        COALESCE(NEW.priority,        OLD.priority),
      'archived_at',     COALESCE(NEW.archived_at,     OLD.archived_at)
    );
  ELSIF (TG_TABLE_NAME = 'os_forks') THEN
    row_compact := jsonb_build_object(
      'fork_id',         COALESCE(NEW.fork_id,         OLD.fork_id),
      'parent_id',       COALESCE(NEW.parent_id,       OLD.parent_id),
      'status',          COALESCE(NEW.status,          OLD.status),
      'last_heartbeat',  COALESCE(NEW.last_heartbeat,  OLD.last_heartbeat),
      'result',          COALESCE(NEW.result,          OLD.result),
      'next_step',       COALESCE(NEW.next_step,       OLD.next_step),
      'started_at',      COALESCE(NEW.started_at,      OLD.started_at),
      'ended_at',        COALESCE(NEW.ended_at,        OLD.ended_at)
    );
  ELSE
    row_compact := jsonb_build_object('id', COALESCE(NEW.id, OLD.id));
  END IF;

  payload := jsonb_build_object(
    'table',  TG_TABLE_NAME,
    'action', TG_OP,
    'row',    row_compact,
    'ts',     extract(epoch from now())
  );

  PERFORM pg_notify('eos_listener_events', payload::text);
  RETURN COALESCE(NEW, OLD);
END;
$$;

-- Step 2: Add trigger on os_forks.
-- Fire on UPDATE of status or last_heartbeat only (not every UPDATE).
DROP TRIGGER IF EXISTS trg_os_forks_status_notify ON public.os_forks;
CREATE TRIGGER trg_os_forks_status_notify
  AFTER UPDATE OF status, last_heartbeat ON public.os_forks
  FOR EACH ROW
  WHEN (
    OLD.status IS DISTINCT FROM NEW.status
    OR OLD.last_heartbeat IS DISTINCT FROM NEW.last_heartbeat
  )
  EXECUTE FUNCTION public.eos_listener_notify_compact();
