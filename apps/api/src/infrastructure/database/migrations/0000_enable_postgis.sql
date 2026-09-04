-- Trilha — 0000_enable_postgis
--
-- PostGIS is central infrastructure for this product (constitution §Architecture),
-- so enabling it is an explicit, reviewable migration rather than a hidden step in
-- a bootstrap script or a container entrypoint.
--
-- `postgis` provides the geometry/geography types and the ST_* function family.
CREATE EXTENSION IF NOT EXISTS postgis;

-- Deterministic, non-enumerable identifiers (constitution §Engineering: IDs are not
-- publicly enumerable). pgcrypto supplies gen_random_uuid() on every supported
-- PostgreSQL version we target.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
