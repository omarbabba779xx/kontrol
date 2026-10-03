-- Two database roles for a production deployment.
--
--   kontrol_owner  owns the schema; used only by migrations (POSTGRES_MIGRATION_URL). Not used by the running application.
--   kontrol_login  the login the application connects as (POSTGRES_URL). Unprivileged: not a superuser, no BYPASSRLS, owns nothing.
--
-- The application drops to the kontrol_app role (NOLOGIN, created by the migrations with the table privileges) inside every
-- transaction. kontrol_login only needs to be allowed to become it, which is granted once the migrations have run.
--
-- Run as a superuser, once. Replace the passwords.

CREATE ROLE kontrol_owner LOGIN PASSWORD 'replace-with-a-long-random-password' NOSUPERUSER NOBYPASSRLS;
CREATE ROLE kontrol_login LOGIN PASSWORD 'replace-with-another-long-random-password' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;

CREATE DATABASE kontrol OWNER kontrol_owner;
\connect kontrol
REVOKE ALL ON DATABASE kontrol FROM PUBLIC;
GRANT CONNECT ON DATABASE kontrol TO kontrol_owner, kontrol_login;
ALTER SCHEMA public OWNER TO kontrol_owner;

-- Set KONTROL_RUNTIME_LOGIN=kontrol_login and the first start grants it the kontrol_app role after the migrations. To do it by hand:
--   GRANT kontrol_app TO kontrol_login;
