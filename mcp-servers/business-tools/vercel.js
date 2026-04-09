/**
 * Vercel MCP tools — projects, deployments, build logs.
 */
import { z } from 'zod'

const VERCEL_TOKEN = process.env.VERCEL_API_TOKEN || ''
const VERCEL_TEAM = process.env.VERCEL_TEAM_ID || ''
const BASE = 'https://api.vercel.com'

async function vercelFetch(path, opts = {}) {
  const url = new URL(path, BASE)
  if (VERCEL_TEAM) url.searchParams.set('teamId', VERCEL_TEAM)
  const res = await fetch(url, {
    ...opts,
    headers: { Authorization: `Bearer ${VERCEL_TOKEN}`, 'Content-Type': 'application/json', ...opts.headers },
  })
  if (!res.ok) throw new Error(`Vercel API ${res.status}: ${await res.text()}`)
  return res.json()
}

export function registerVercelTools(server) {

  server.tool('vercel_list_projects',
    'List all Vercel projects.',
    async () => {
      const data = await vercelFetch('/v9/projects?limit=50')
      const projects = (data.projects || []).map(p => ({
        id: p.id,
        name: p.name,
        framework: p.framework,
        url: p.targets?.production?.url || p.latestDeployments?.[0]?.url,
        updatedAt: p.updatedAt,
      }))
      return { content: [{ type: 'text', text: JSON.stringify(projects, null, 2) }] }
    })

  server.tool('vercel_list_deployments',
    'List recent deployments for a Vercel project.',
    {
      projectId: z.string().optional().describe('Project ID or name'),
      limit: z.number().optional().describe('Max results (default 10)'),
    },
    async ({ projectId, limit = 10 } = {}) => {
      const params = projectId ? `?projectId=${projectId}&limit=${limit}` : `?limit=${limit}`
      const data = await vercelFetch(`/v6/deployments${params}`)
      const deployments = (data.deployments || []).map(d => ({
        id: d.uid,
        url: d.url,
        state: d.state || d.readyState,
        target: d.target,
        branch: d.meta?.githubCommitRef,
        commitSha: d.meta?.githubCommitSha?.slice(0, 7),
        creator: d.creator?.email,
        createdAt: d.createdAt,
      }))
      return { content: [{ type: 'text', text: JSON.stringify(deployments, null, 2) }] }
    })

  server.tool('vercel_get_deployment',
    'Get details of a specific deployment including build logs.',
    { deploymentId: z.string().describe('Deployment ID') },
    async ({ deploymentId }) => {
      const [deploy, events] = await Promise.all([
        vercelFetch(`/v13/deployments/${deploymentId}`),
        vercelFetch(`/v2/deployments/${deploymentId}/events`).catch(() => []),
      ])
      const logs = Array.isArray(events) ? events.filter(e => e.type === 'stdout' || e.type === 'stderr').map(e => e.payload?.text || '').join('\n').slice(-5000) : ''
      return { content: [{ type: 'text', text: JSON.stringify({
        id: deploy.id,
        url: deploy.url,
        state: deploy.readyState,
        target: deploy.target,
        errorMessage: deploy.errorMessage,
        buildLogs: logs || '(no logs)',
      }, null, 2) }] }
    })

  server.tool('vercel_trigger_deploy',
    'Trigger a new deployment for a project (redeploy latest).',
    {
      projectId: z.string().describe('Project ID or name'),
      target: z.string().optional().describe('"production" or "preview" (default: production)'),
    },
    async ({ projectId, target = 'production' }) => {
      const data = await vercelFetch(`/v6/deployments?projectId=${projectId}&limit=1&target=${target}`)
      const latest = data.deployments?.[0]
      if (!latest) return { content: [{ type: 'text', text: 'No deployment found to redeploy.' }] }

      const result = await vercelFetch(`/v13/deployments`, {
        method: 'POST',
        body: JSON.stringify({ name: latest.name, target, deploymentId: latest.uid }),
      })
      return { content: [{ type: 'text', text: `Deployment triggered: ${result.url || result.id}` }] }
    })
}
