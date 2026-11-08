-- Migration 018: Set explicit search_path on trigger functions for database security and advisor compliance

ALTER FUNCTION trg_fn_journal_entries_immutability() SET search_path = public;
ALTER FUNCTION trg_fn_journal_lines_immutability() SET search_path = public;
ALTER FUNCTION audit_logs_block_mutation() SET search_path = public;
