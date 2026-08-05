CREATE TABLE work_plans (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  requester_key TEXT NOT NULL,
  requester_ciphertext TEXT NOT NULL,
  objective_ciphertext TEXT NOT NULL,
  plan_ciphertext TEXT NOT NULL,
  plan_hash TEXT NOT NULL,
  max_level TEXT NOT NULL CHECK (max_level IN ('L0', 'L1', 'L2', 'L3', 'L4')),
  policy_decision TEXT NOT NULL CHECK (
    policy_decision IN ('ALLOW', 'REQUIRE_APPROVAL')
  ),
  status TEXT NOT NULL CHECK (
    status IN (
      'ready', 'awaiting_approval', 'approved', 'rejected',
      'executing', 'verifying', 'completed', 'failed', 'cancelled'
    )
  ),
  approval_version INTEGER NOT NULL DEFAULT 1 CHECK (approval_version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT work_plans_tenant_id_unique UNIQUE (tenant_id, id),
  CONSTRAINT work_plans_tenant_hash_unique UNIQUE (tenant_id, plan_hash)
);

CREATE INDEX work_plans_status_idx
ON work_plans (tenant_id, status, created_at DESC);

CREATE TABLE work_plan_approvals (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  work_plan_id TEXT NOT NULL,
  plan_hash TEXT NOT NULL,
  approval_version INTEGER NOT NULL CHECK (approval_version > 0),
  decision TEXT NOT NULL CHECK (decision IN ('approved', 'rejected')),
  actor TEXT NOT NULL,
  reason_ciphertext TEXT NOT NULL,
  expires_at TIMESTAMPTZ,
  max_consumptions INTEGER NOT NULL DEFAULT 1 CHECK (max_consumptions > 0),
  consumed INTEGER NOT NULL DEFAULT 0 CHECK (
    consumed >= 0 AND consumed <= max_consumptions
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, work_plan_id, approval_version),
  CONSTRAINT work_plan_approvals_plan_fkey
    FOREIGN KEY (tenant_id, work_plan_id)
    REFERENCES work_plans (tenant_id, id)
    ON DELETE CASCADE
);

CREATE INDEX work_plan_approvals_active_idx
ON work_plan_approvals (tenant_id, work_plan_id, expires_at)
WHERE decision = 'approved' AND consumed < max_consumptions;
