-- api's in-process tests (api:test) use their own database, so they never
-- touch the data the dev server works with.
CREATE DATABASE api_test;
