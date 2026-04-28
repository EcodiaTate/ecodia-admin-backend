-- 066: staged_transactions listener trigger
--
-- Extends eos_listener_notify_compact() to handle staged_transactions rows,
-- then adds an AFTER INSERT trigger so every new bank transaction is broadcast
-- on the eos_listener_events channel for the invoicePaymentState listener.
--
-- Whitelisted staged_transactions columns: id, amount_cents, description,
-- occurred_at. The description field is kept short in the notify payload
-- to stay under the 8000-byte pg_notify limit.
--
-- Preserves all existing behaviour for cc_sessions, email_events, status_board,
-- and os_forks (added in migrations 063/064).

CREATE OR REPLACE FUNCTION public.eos_listener_notify_compact()
  RETURNS trigger
  LANGUAGE plpgsql
AS $$
DECLARE
  payload     jsonb;
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
      'fork_id',        COALESCE(NEW.fork_id,        OLD.fork_id),
      'parent_id',      COALESCE(NEW.parent_id,      OLD.parent_id),
      'status',         COALESCE(NEW.status,         OLD.status),
      'last_heartbeat', COALESCE(NEW.last_heartbeat, OLD.last_heartbeat),
      'result',         COALESCE(NEW.result,         OLD.result),
      'next_step',      COALESCE(NEW.next_step,      OLD.next_step),
      'started_at',     COALESCE(NEW.started_at,     OLD.started_at),
      'ended_at',       COALESCE(NEW.ended_at,       OLD.ended_at)
    );
  ELSIF (TG_TABLE_NAME = 'staged_transactions') THEN
    row_compact := jsonb_build_object(
      'id',           NEW.id,
      'amount_cents', NEW.amount_cents,
      'description',  left(NEW.description, 200),
      'occurred_at',  NEW.occurred_at
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

-- Fire on INSERT only — we only care about new bank transactions arriving,
-- not subsequent categorisation updates (those are internal state changes).
DROP TRIGGER IF EXISTS trg_staged_transactions_insert_notify ON public.staged_transactions;
CREATE TRIGGER trg_staged_transactions_insert_notify
  AFTER INSERT ON public.staged_transactions
  FOR EACH ROW
  EXECUTE FUNCTION public.eos_listener_notify_compact();
