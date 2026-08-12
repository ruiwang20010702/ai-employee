CREATE TABLE governed_graph_nodes (
  tenant_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  node_key TEXT NOT NULL,
  project_id TEXT NOT NULL,
  graph_version INTEGER NOT NULL CHECK (graph_version = 1),
  node_type TEXT NOT NULL,
  revision TEXT NOT NULL,
  payload_ciphertext TEXT NOT NULL,
  sensitivity TEXT NOT NULL CHECK (
    sensitivity IN ('public', 'internal', 'confidential')
  ),
  expires_at TIMESTAMPTZ,
  observed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, node_id),
  UNIQUE (tenant_id, project_id, node_key, revision)
);

CREATE INDEX governed_graph_nodes_project_type_idx
ON governed_graph_nodes (tenant_id, project_id, node_type, observed_at DESC);

CREATE TABLE governed_graph_edges (
  tenant_id TEXT NOT NULL,
  edge_id TEXT NOT NULL,
  relation_key TEXT NOT NULL,
  project_id TEXT NOT NULL,
  graph_version INTEGER NOT NULL CHECK (graph_version = 1),
  edge_type TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('intended', 'runtime')),
  from_node_id TEXT NOT NULL,
  to_node_id TEXT NOT NULL,
  authorization_hash TEXT,
  payload_ciphertext TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'invalidated')),
  sensitivity TEXT NOT NULL CHECK (
    sensitivity IN ('public', 'internal', 'confidential')
  ),
  expires_at TIMESTAMPTZ,
  valid_from TIMESTAMPTZ NOT NULL,
  invalidated_at TIMESTAMPTZ,
  observed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, edge_id),
  FOREIGN KEY (tenant_id, from_node_id)
    REFERENCES governed_graph_nodes (tenant_id, node_id),
  FOREIGN KEY (tenant_id, to_node_id)
    REFERENCES governed_graph_nodes (tenant_id, node_id)
);

CREATE INDEX governed_graph_edges_project_type_idx
ON governed_graph_edges (
  tenant_id, project_id, edge_type, phase, observed_at DESC
);

CREATE INDEX governed_graph_edges_relation_idx
ON governed_graph_edges (
  tenant_id, project_id, relation_key, observed_at DESC
);

CREATE INDEX governed_graph_edges_from_idx
ON governed_graph_edges (tenant_id, project_id, from_node_id, observed_at DESC);

CREATE INDEX governed_graph_edges_to_idx
ON governed_graph_edges (tenant_id, project_id, to_node_id, observed_at DESC);
