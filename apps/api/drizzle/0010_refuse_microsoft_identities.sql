-- Stop when a Microsoft identity exists. Do not delete the row or any other user data.
DO $$ BEGIN IF EXISTS (SELECT 1 FROM user_identities WHERE provider = 'microsoft') THEN RAISE EXCEPTION 'microsoft identities exist and were not deleted'; END IF; END $$;
