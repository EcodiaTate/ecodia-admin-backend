const db = require('./src/config/db');

(async () => {
  try {
    // === DISMISS items that should not be executed ===
    const dismissals = [
      {
        id: '2beb248b-b00e-4903-a6ff-21d860a84a5c',
        reason: 'Build is known-failing (npm run build exits 1). Retriggering would waste compute. Fix the build first.'
      },
      {
        id: '05893126-412c-4d48-8d98-cd0bf8dda728',
        reason: 'CSV contains synthetic/fabricated data (ACME CORP, BETA LLC, round numbers). Ingesting would corrupt bookkeeping ledger.'
      },
      {
        id: '602bfe2d-6386-44d0-81ed-07fb4b00ca15',
        reason: 'CSV contains synthetic/fabricated personal account data. Not from actual bank export.'
      },
      {
        id: '99872ac1-3c75-400d-b131-78e21a028792',
        reason: 'CSV contains synthetic data (Opening Balance, generic descriptions). Not from actual Bank Australia export.'
      }
    ];

    console.log('=== DISMISSING 4 items ===');
    for (const { id, reason } of dismissals) {
      const contextPatch = JSON.stringify({
        dismissed_at: new Date().toISOString(),
        dismissed_reason: reason,
        dismissed_by: 'factory_reflection'
      });
      const [item] = await db`
        UPDATE action_queue
        SET status = 'dismissed',
            context = context || ${contextPatch}::jsonb
        WHERE id = ${id} AND status = 'pending'
        RETURNING id, title
      `;
      if (item) {
        console.log('  Dismissed:', item.title);
      } else {
        console.log('  Not found or already handled:', id.substring(0, 8));
      }
    }

    // === EXECUTE items that should run ===
    console.log('\n=== EXECUTING 2 items ===');

    // Execute create_task for build failure
    const taskId = '75d8eb25-9bfd-4357-810f-1ad69c673200';
    const [taskItem] = await db`
      UPDATE action_queue
      SET status = 'approved', approved_at = now()
      WHERE id = ${taskId} AND status = 'pending'
      RETURNING *
    `;
    if (taskItem) {
      try {
        const pd = typeof taskItem.prepared_data === 'string' ? JSON.parse(taskItem.prepared_data) : taskItem.prepared_data;
        // Insert task directly
        const [task] = await db`
          INSERT INTO tasks (title, description, priority, source, status)
          VALUES (${pd.title}, ${pd.description}, ${'urgent'}, ${'vercel'}, ${'open'})
          RETURNING id, title
        `;
        await db`UPDATE action_queue SET status = 'executed', executed_at = now() WHERE id = ${taskId}`;
        console.log('  Executed create_task:', task.title, '(task id:', task.id + ')');
      } catch (err) {
        await db`UPDATE action_queue SET status = 'pending', error_message = ${err.message} WHERE id = ${taskId}`;
        console.log('  Failed create_task:', err.message);
      }
    } else {
      console.log('  create_task not found or already handled');
    }

    // Execute create_sheet for Bank Australia analysis
    const sheetId = 'dd081d9d-2ebe-47ad-8b3e-2020af80a272';
    const [sheetItem] = await db`
      UPDATE action_queue
      SET status = 'approved', approved_at = now()
      WHERE id = ${sheetId} AND status = 'pending'
      RETURNING *
    `;
    if (sheetItem) {
      try {
        // Try to use the capability registry
        const registry = require('./src/services/capabilityRegistry');
        const pd = typeof sheetItem.prepared_data === 'string' ? JSON.parse(sheetItem.prepared_data) : sheetItem.prepared_data;
        const result = await registry.execute('create_sheet', pd, { source: 'action_queue', item: sheetItem });
        if (result.success) {
          await db`UPDATE action_queue SET status = 'executed', executed_at = now() WHERE id = ${sheetId}`;
          console.log('  Executed create_sheet:', result.result);
        } else {
          await db`UPDATE action_queue SET status = 'pending', error_message = ${result.error} WHERE id = ${sheetId}`;
          console.log('  Failed create_sheet:', result.error);
        }
      } catch (err) {
        await db`UPDATE action_queue SET status = 'pending', error_message = ${err.message} WHERE id = ${sheetId}`;
        console.log('  Failed create_sheet:', err.message);
      }
    } else {
      console.log('  create_sheet not found or already handled');
    }

    // Summary
    console.log('\n=== SUMMARY ===');
    const remaining = await db`SELECT count(*) as cnt FROM action_queue WHERE status = 'pending' AND priority = 'urgent'`;
    console.log('Remaining urgent items:', remaining[0].cnt);
    const allPending = await db`SELECT count(*) as cnt FROM action_queue WHERE status = 'pending'`;
    console.log('Total pending items:', allPending[0].cnt);

    process.exit(0);
  } catch (err) {
    console.error('Fatal error:', err);
    process.exit(1);
  }
})();
