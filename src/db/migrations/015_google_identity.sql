CREATE TABLE user_social_identities (
  provider TEXT NOT NULL CHECK (provider = 'google'),
  subject TEXT NOT NULL CHECK (length(subject) BETWEEN 1 AND 255),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (provider, subject),
  UNIQUE (user_id, provider)
);
