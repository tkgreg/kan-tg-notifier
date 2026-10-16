-- Run as the inbox table owner after migration 0001. No credential is embedded.
-- Set LOGIN and a generated password separately through the deployment operator.
-- Scope is the verified @neary_kan_bot / Neary Skin Co.LTD group only.
BEGIN;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pulse_telegram_reader') THEN
    CREATE ROLE pulse_telegram_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
      NOINHERIT NOREPLICATION NOBYPASSRLS;
  END IF;
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO pulse_telegram_reader', current_database());
END
$$;
GRANT USAGE ON SCHEMA public TO pulse_telegram_reader;
GRANT SELECT ON TABLE public.pulse_telegram_inbox TO pulse_telegram_reader;
ALTER TABLE public.pulse_telegram_inbox ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pulse_telegram_reader_scope ON public.pulse_telegram_inbox;
CREATE POLICY pulse_telegram_reader_scope ON public.pulse_telegram_inbox
  FOR SELECT TO pulse_telegram_reader
  USING (bot_id = 8867888093 AND chat_id = -1003976782755);
COMMIT;

-- No access to user_mappings, chat_subscriptions, event_log or sequences is granted.
-- The existing notifier table owner can continue to INSERT; FORCE RLS is not enabled.
