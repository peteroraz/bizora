ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at timestamptz;

CREATE TABLE IF NOT EXISTS user_identities (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id),
  provider varchar(32) NOT NULL,
  provider_subject varchar(255) NOT NULL,
  email varchar(320) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_identities_provider_subject_key UNIQUE (provider, provider_subject)
);

CREATE INDEX IF NOT EXISTS user_identities_user_id_idx ON user_identities (user_id);

CREATE TABLE IF NOT EXISTS auth_tokens (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id),
  purpose varchar(32) NOT NULL,
  token_hash varchar(64) NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS auth_tokens_user_purpose_idx ON auth_tokens (user_id, purpose);
