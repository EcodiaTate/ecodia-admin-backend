const db = require('../../config/db')

async function createTask({ title, description, source, sourceRefId, clientId, projectId, priority }) {
  const [task] = await db`
    INSERT INTO tasks (title, description, source, source_ref_id, client_id, project_id, priority)
    VALUES (${title}, ${description || null}, ${source || 'manual'}, ${sourceRefId || null},
            ${clientId || null}, ${projectId || null}, ${priority || 'medium'})
    RETURNING *
  `
  return task
}

module.exports = { createTask }
