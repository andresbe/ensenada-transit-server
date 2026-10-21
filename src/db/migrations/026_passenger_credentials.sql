-- Existing passenger tokens are intentionally invalidated by version 1.
ALTER TABLE users ADD COLUMN token_version integer NOT NULL DEFAULT 1 CHECK (token_version >= 1);
CREATE FUNCTION bump_user_credentials_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.password_hash IS DISTINCT FROM OLD.password_hash
     OR NEW.email IS DISTINCT FROM OLD.email OR NEW.role IS DISTINCT FROM OLD.role
     OR NEW.status IS DISTINCT FROM OLD.status OR NEW.auth_provider IS DISTINCT FROM OLD.auth_provider THEN
    NEW.token_version := OLD.token_version + 1;
  ELSIF NEW.token_version < OLD.token_version THEN
    RAISE EXCEPTION 'Credential version cannot decrease';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER users_credentials_version BEFORE UPDATE ON users
FOR EACH ROW EXECUTE FUNCTION bump_user_credentials_version();
-- Retire devices registered before Google ownership was established.
UPDATE passenger_devices d SET active=FALSE WHERE EXISTS(
  SELECT 1 FROM users u JOIN user_social_identities i ON i.user_id=u.id AND i.provider='google'
  WHERE u.id=d.user_id AND (u.password_hash IS NOT NULL OR u.auth_provider<>'google')
);
-- Repair accounts linked under the former auto-link policy. Google remains available.
UPDATE users u SET password_hash=NULL,auth_provider='google'
WHERE EXISTS(SELECT 1 FROM user_social_identities i WHERE i.user_id=u.id AND i.provider='google')
  AND (u.password_hash IS NOT NULL OR u.auth_provider<>'google');
