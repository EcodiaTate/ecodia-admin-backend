/**
 * Google Contacts MCP tools — list, search, create, update.
 */
import { z } from 'zod'
import { getPeopleClient, primaryAccount } from './auth.js'

export function registerContactsTools(server) {

  server.tool('contacts_search',
    'Search Google Contacts by name, email, or phone.',
    { query: z.string().describe('Search query (name, email, or phone)'), maxResults: z.number().default(20), account: z.string().optional() },
    async ({ query, maxResults, account }) => {
      const people = getPeopleClient(account || primaryAccount)
      const res = await people.people.searchContacts({ query, readMask: 'names,emailAddresses,phoneNumbers,organizations', pageSize: Math.min(maxResults, 30) })
      const contacts = (res.data.results || []).map(r => {
        const p = r.person
        return {
          resourceName: p.resourceName,
          name: p.names?.[0]?.displayName,
          emails: p.emailAddresses?.map(e => e.value),
          phones: p.phoneNumbers?.map(ph => ph.value),
          org: p.organizations?.[0]?.name,
          title: p.organizations?.[0]?.title,
        }
      })
      return { content: [{ type: 'text', text: JSON.stringify(contacts, null, 2) }] }
    }
  )

  server.tool('contacts_list',
    'List contacts (paginated).',
    { maxResults: z.number().default(50), account: z.string().optional() },
    async ({ maxResults, account }) => {
      const people = getPeopleClient(account || primaryAccount)
      const res = await people.people.connections.list({ resourceName: 'people/me', personFields: 'names,emailAddresses,phoneNumbers,organizations', pageSize: Math.min(maxResults, 100) })
      const contacts = (res.data.connections || []).map(p => ({
        resourceName: p.resourceName,
        name: p.names?.[0]?.displayName,
        emails: p.emailAddresses?.map(e => e.value),
        phones: p.phoneNumbers?.map(ph => ph.value),
        org: p.organizations?.[0]?.name,
      }))
      return { content: [{ type: 'text', text: JSON.stringify(contacts, null, 2) }] }
    }
  )

  server.tool('contacts_create',
    'Create a new Google Contact.',
    { name: z.string(), email: z.string().optional(), phone: z.string().optional(), organization: z.string().optional(), title: z.string().optional(), account: z.string().optional() },
    async ({ name, email, phone, organization, title, account }) => {
      const people = getPeopleClient(account || primaryAccount)
      const nameParts = name.split(' ')
      const person = {
        names: [{ givenName: nameParts[0], familyName: nameParts.slice(1).join(' ') || undefined }],
        emailAddresses: email ? [{ value: email }] : undefined,
        phoneNumbers: phone ? [{ value: phone }] : undefined,
        organizations: organization ? [{ name: organization, title }] : undefined,
      }
      const res = await people.people.createContact({ requestBody: person, personFields: 'names,emailAddresses,phoneNumbers,organizations' })
      return { content: [{ type: 'text', text: `Contact created: ${res.data.names?.[0]?.displayName} (${res.data.resourceName})` }] }
    }
  )

  server.tool('contacts_update',
    'Update an existing Google Contact.',
    { resourceName: z.string().describe('Contact resource name (e.g. "people/c12345")'), email: z.string().optional(), phone: z.string().optional(), organization: z.string().optional(), title: z.string().optional(), account: z.string().optional() },
    async ({ resourceName, email, phone, organization, title, account }) => {
      const people = getPeopleClient(account || primaryAccount)
      const existing = await people.people.get({ resourceName, personFields: 'names,emailAddresses,phoneNumbers,organizations,metadata' })
      const person = existing.data
      const updateMask = []
      if (email) { person.emailAddresses = [{ value: email }]; updateMask.push('emailAddresses') }
      if (phone) { person.phoneNumbers = [{ value: phone }]; updateMask.push('phoneNumbers') }
      if (organization) { person.organizations = [{ name: organization, title }]; updateMask.push('organizations') }
      const res = await people.people.updateContact({ resourceName, updatePersonFields: updateMask.join(','), requestBody: person, personFields: 'names,emailAddresses,phoneNumbers,organizations' })
      return { content: [{ type: 'text', text: `Contact updated: ${res.data.names?.[0]?.displayName}` }] }
    }
  )
}
