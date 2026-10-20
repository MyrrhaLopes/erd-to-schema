CREATE TYPE "UserType" AS ENUM ('ADMIN', 'MEMBER', 'GUEST');
CREATE TYPE "Status" AS ENUM ('ACTIVE', 'INACTIVE', 'BLOCKED');
CREATE TYPE "MemberFunction" AS ENUM ('COORDINATOR', 'RESEARCHER', 'STUDENT');
CREATE TYPE "AuditAction" AS ENUM ('CREATE', 'UPDATE', 'DELETE');

CREATE TABLE "Person" (
  id bigserial PRIMARY KEY,
  uuid uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  "fullName" varchar(200) NOT NULL,
  document varchar(14) UNIQUE,
  status "Status" NOT NULL DEFAULT 'ACTIVE',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE "Person" IS 'Pessoa física cadastrada no sistema.';
COMMENT ON COLUMN "Person"."fullName" IS 'Nome completo';

CREATE TABLE "User" (
  id bigserial PRIMARY KEY,
  uuid uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  "personId" bigint NOT NULL UNIQUE REFERENCES "Person" (id) ON DELETE CASCADE,
  "loginId" varchar(120) NOT NULL,
  type "UserType" NOT NULL DEFAULT 'MEMBER',
  status "Status" NOT NULL DEFAULT 'ACTIVE',
  preferences jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX user_login_active ON "User" ("loginId") WHERE status = 'ACTIVE'::"Status";
COMMENT ON TABLE "User" IS 'Conta de acesso de uma pessoa.';

CREATE TABLE "Project" (
  id bigserial PRIMARY KEY,
  uuid uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  title varchar(255) NOT NULL,
  "clientId" bigint REFERENCES "User" (id) ON DELETE SET NULL,
  "ownerId" bigint NOT NULL REFERENCES "User" (id) ON DELETE RESTRICT,
  "startsOn" date,
  budget numeric(12,2),
  status "Status" NOT NULL DEFAULT 'ACTIVE',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_budget_positive CHECK (budget >= 0)
);
CREATE INDEX project_owner_idx ON "Project" ("ownerId");

CREATE TABLE "ProjectMember" (
  "projectId" bigint NOT NULL REFERENCES "Project" (id) ON DELETE CASCADE,
  "userId" bigint NOT NULL REFERENCES "User" (id) ON DELETE CASCADE,
  "memberFunction" "MemberFunction" NOT NULL,
  PRIMARY KEY ("projectId", "userId")
);

CREATE TABLE "AuditLog" (
  id bigserial PRIMARY KEY,
  "userId" bigint REFERENCES "User" (id) ON DELETE SET NULL,
  action "AuditAction" NOT NULL,
  entity varchar(60) NOT NULL,
  payload jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_entity_idx ON "AuditLog" (entity, created_at);

CREATE TABLE "Setting" (
  key varchar(80) PRIMARY KEY,
  value text NOT NULL
);

-- @erd:tags Person "Módulo A — Cadastro e Pessoas"
-- @erd:tags User "Módulo A — Cadastro e Pessoas"
-- @erd:tags Project "Módulo B — Projetos"
-- @erd:tags ProjectMember "Módulo B — Projetos"
-- @erd:tags AuditLog "Módulo C — Auditoria"
-- @erd:ref AuditLog(entity) -> Project(title) N:1 "registra"
