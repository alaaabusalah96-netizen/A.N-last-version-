-- Drop platform_users.company_id legacy column
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'platform_users'
      AND column_name = 'company_id'
  ) THEN
    IF EXISTS (
      SELECT 1 FROM platform_users
      WHERE company_id IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'Migration 009 abort: platform_users contains non-null company_id references.';
    END IF;

    ALTER TABLE platform_users DROP COLUMN company_id;
  END IF;
END $$;
