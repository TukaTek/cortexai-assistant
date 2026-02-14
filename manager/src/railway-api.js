// Thin GraphQL client for Railway's public API.
// Uses Node 22's native fetch — no additional dependencies needed.

const RAILWAY_API_URL = "https://backboard.railway.com/graphql/v2";
const RAILWAY_API_TOKEN = process.env.RAILWAY_API_TOKEN || "";

if (!RAILWAY_API_TOKEN) {
  console.warn("[railway-api] RAILWAY_API_TOKEN is not set — API calls will fail.");
}

/**
 * Execute a Railway GraphQL query/mutation.
 * @param {string} query - GraphQL query or mutation string
 * @param {object} variables - GraphQL variables
 * @returns {Promise<object>} - The `data` portion of the GraphQL response
 */
export async function railwayGql(query, variables = {}) {
  const res = await fetch(RAILWAY_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${RAILWAY_API_TOKEN}`,
    },
    body: JSON.stringify({ query, variables }),
  });

  // Handle rate limiting (429) with retry.
  if (res.status === 429) {
    const retryAfter = parseInt(res.headers.get("Retry-After") || "5", 10);
    console.warn(`[railway-api] rate limited, retrying in ${retryAfter}s`);
    await new Promise((r) => setTimeout(r, retryAfter * 1000));
    return railwayGql(query, variables);
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Railway API HTTP ${res.status}: ${text}`);
  }

  const json = await res.json();
  if (json.errors && json.errors.length > 0) {
    const msgs = json.errors.map((e) => e.message).join("; ");
    throw new Error(`Railway API error: ${msgs}`);
  }

  return json.data;
}

// --- GraphQL operations ---

export const PROJECT_CREATE = `
  mutation projectCreate($input: ProjectCreateInput!) {
    projectCreate(input: $input) {
      id
      name
      environments { edges { node { id name } } }
    }
  }
`;

export const PROJECT_QUERY = `
  query project($id: String!) {
    project(id: $id) {
      id
      name
      environments { edges { node { id name } } }
      services {
        edges {
          node {
            id
            name
            serviceInstances {
              edges {
                node {
                  latestDeployment { id status createdAt }
                  domains {
                    serviceDomains { domain }
                    customDomains { domain }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

export const PROJECT_DELETE = `
  mutation projectDelete($id: String!) {
    projectDelete(id: $id)
  }
`;

export const SERVICE_CREATE = `
  mutation serviceCreate($input: ServiceCreateInput!) {
    serviceCreate(input: $input) {
      id
      name
    }
  }
`;

export const VOLUME_CREATE = `
  mutation volumeCreate($input: VolumeCreateInput!) {
    volumeCreate(input: $input) {
      id
    }
  }
`;

export const VARIABLE_COLLECTION_UPSERT = `
  mutation variableCollectionUpsert($input: VariableCollectionUpsertInput!) {
    variableCollectionUpsert(input: $input)
  }
`;

export const SERVICE_INSTANCE_DEPLOY = `
  mutation serviceInstanceDeploy($serviceId: String!, $environmentId: String!) {
    serviceInstanceDeploy(serviceId: $serviceId, environmentId: $environmentId)
  }
`;

export const SERVICE_INSTANCE_REDEPLOY = `
  mutation serviceInstanceRedeploy($serviceId: String!, $environmentId: String!) {
    serviceInstanceRedeploy(serviceId: $serviceId, environmentId: $environmentId)
  }
`;

export const DEPLOYMENTS_QUERY = `
  query deployments($input: DeploymentListInput!) {
    deployments(input: $input, first: 1) {
      edges {
        node {
          id
          status
          createdAt
        }
      }
    }
  }
`;

export const SERVICE_DOMAIN_CREATE = `
  mutation serviceDomainCreate($input: ServiceDomainCreateInput!) {
    serviceDomainCreate(input: $input) {
      id
      domain
    }
  }
`;
