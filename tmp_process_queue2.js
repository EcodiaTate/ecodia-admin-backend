require('./src/capabilities');
const db = require('./src/config/db');
const registry = require('./src/services/capabilityRegistry');

(async () => {
  try {
    // Execute create_task for build failure (source must be cortex per constraint)
    const taskId = '75d8eb25-9bfd-4357-810f-1ad69c673200';
    const [taskItem] = await db`
      UPDATE action_queue
      SET status = 'approved', approved_at = now(), error_message = null
      WHERE id = ${taskId} AND status = 'pending'
      RETURNING *
    `;
    if (taskItem) {
      const pd = typeof taskItem.prepared_data === 'string' ? JSON.parse(taskItem.prepared_data) : taskItem.prepared_data;
      const result = await registry.execute('create_task', {
        title: pd.title,
        description: pd.description,
        priority: 'urgent',
        source: 'cortex'
      }, { source: 'action_queue', item: taskItem });
      if (result.success) {
        await db`UPDATE action_queue SET status = 'executed', executed_at = now() WHERE id = ${taskId}`;
        console.log('Executed create_task:', JSON.stringify(result.result));
      } else {
        await db`UPDATE action_queue SET status = 'pending', error_message = ${result.error} WHERE id = ${taskId}`;
        console.log('Failed create_task:', result.error);
      }
    } else {
      console.log('create_task not found or already handled');
    }

    // Execute create_sheet for Bank Australia analysis
    const sheetId = 'dd081d9d-2ebe-47ad-8b3e-2020af80a272';
    const [sheetItem] = await db`
      UPDATE action_queue
      SET status = 'approved', approved_at = now(), error_message = null
      WHERE id = ${sheetId} AND status = 'pending'
      RETURNING *
    `;
    if (sheetItem) {
      const pd = typeof sheetItem.prepared_data === 'string' ? JSON.parse(sheetItem.prepared_data) : sheetItem.prepared_data;
      const result = await registry.execute('create_sheet', pd, { source: 'action_queue', item: sheetItem });
      if (result.success) {
        await db`UPDATE action_queue SET status = 'executed', executed_at = now() WHERE id = ${sheetId}`;
        console.log('Executed create_sheet:', JSON.stringify(result.result));
      } else {
        await db`UPDATE action_queue SET status = 'pending', error_message = ${result.error} WHERE id = ${sheetId}`;
        console.log('Failed create_sheet:', result.error);
      }
    } else {
      console.log('create_sheet not found or already handled');
    }

    // Summary
    const remaining = await db`SELECT count(*) as cnt FROM action_queue WHERE status = 'pending' AND priority = 'urgent'`;
    console.log('\nRemaining urgent items:', remaining[0].cnt);

    process.exit(0);
  } catch (err) {
    console.error('Fatal error:', err);
    process.exit(1);
  }
})();
