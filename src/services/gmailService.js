const { google } = require('googleapis')
const env = require('../config/env')
const db = require('../config/db')
const logger = require('../config/logger')
const deepseekService = require('./deepseekService')
const { createNotification } = require('../db/queries/transactions')
const { findClientByEmail } = require('../db/queries/clients')
const { createTask } = require('../db/queries/tasks')
const kgHooks = require('./kgIngestionHooks')

const GMAIL_ENABLED = (env.GMAIL_ENABLED || 'false').toLowerCase() === 'true'
const INBOXES = (env.GMAIL_INBOXES
  ? env.GMAIL_INBOXES.split(',').map(s => s.trim()).filter(Boolean)
  : [env.GOOGLE_PRIMARY_ACCOUNT]).filter(Boolean)
const MAX_TRIAGE_ATTEMPTS = parseInt(env.GMAIL_MAX_TRIAGE_ATTEMPTS || '0', 10) || Infinity

// ─── Gmail Client ────────────────────────────────────────────────────────────

function getGmailClient(userEmail) {
  const credentials = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON)
  const privateKey = credentials.private_key.replace(/\\n/g, '\n')
  const auth = new google.auth.JWT({
    email: credentials.client_email,
    key: privateKey,
    scopes: [
      'https://www.googleapis.com/auth/gmail.modify',
      'https://www.googleapis.com/auth/gmail.compose',
    ],
    subject: userEmail,
  })
  return google.gmail({ version: 'v1', auth })
}

// ─── Poll All Inboxes ────────────────────────────────────────────────────────

async function pollInbox() {
  if (!GMAIL_ENABLED) {
    logger.debug('Gmail polling disabled (GMAIL_ENABLED=false) — set to "true" in .env to re-enable')
    return
  }
  for (const inbox of INBOXES) {
    try {
      logger.info(`Polling inbox: ${inbox}`)
      const gmail = getGmailClient(inbox)
      await gmail.users.getProfile({ userId: 'me' }) // auth check

      const [syncState] = await db`
        SELECT * FROM gmail_sync_state WHERE id = ${inbox}
      `

      if (syncState) {
        await incrementalSync(gmail, inbox, syncState.history_id)
      } else {
        await fullSync(gmail, inbox)
      }
    } catch (err) {
      logger.error(`Failed to poll ${inbox}`, { error: err.message })
      // Continue to next inbox — don't let one failure block others
    }
  }

  // After sync, triage any pending emails
  await triagePendingEmails()
}

// ─── Full Sync ───────────────────────────────────────────────────────────────

async function fullSync(gmail, inbox) {
  const res = await gmail.users.threads.list({
    userId: 'me',
    maxResults: 30,
    labelIds: ['INBOX'],
  })

  const threads = res.data.threads || []
  logger.info(`Full sync [${inbox}]: found ${threads.length} threads`)

  for (const thread of threads) {
    await processThread(gmail, inbox, thread.id)
  }

  const profile = await gmail.users.getProfile({ userId: 'me' })
  await db`
    INSERT INTO gmail_sync_state (id, history_id)
    VALUES (${inbox}, ${profile.data.historyId})
    ON CONFLICT (id) DO UPDATE SET history_id = ${profile.data.historyId}, updated_at = now()
  `
}

// ─── Incremental Sync ────────────────────────────────────────────────────────

async function incrementalSync(gmail, inbox, historyId) {
  try {
    const res = await gmail.users.history.list({
      userId: 'me',
      startHistoryId: historyId,
      historyTypes: ['messageAdded'],
      labelId: 'INBOX',
    })

    const history = res.data.history || []
    const threadIds = new Set()
    for (const h of history) {
      for (const msg of (h.messagesAdded || [])) {
        threadIds.add(msg.message.threadId)
      }
    }

    logger.info(`Incremental sync [${inbox}]: ${threadIds.size} updated threads`)

    for (const threadId of threadIds) {
      await processThread(gmail, inbox, threadId)
    }

    if (res.data.historyId) {
      await db`UPDATE gmail_sync_state SET history_id = ${res.data.historyId}, updated_at = now() WHERE id = ${inbox}`
    }
  } catch (err) {
    if (err.code === 404) {
      logger.warn(`History ID expired for ${inbox}, falling back to full sync`)
      await db`DELETE FROM gmail_sync_state WHERE id = ${inbox}`
      await fullSync(gmail, inbox)
    } else {
      throw err
    }
  }
}

// ─── Process Thread ──────────────────────────────────────────────────────────

async function processThread(gmail, inbox, threadId) {
  const [existing] = await db`SELECT id FROM email_threads WHERE gmail_thread_id = ${threadId}`
  if (existing) return

  const thread = await gmail.users.threads.get({
    userId: 'me',
    id: threadId,
    format: 'full',
  })

  const messages = thread.data.messages || []
  if (messages.length === 0) return

  const firstMsg = messages[0]
  const lastMsg = messages[messages.length - 1]
  const headers = firstMsg.payload.headers || []
  const getHeader = (name) => headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || ''

  const fromRaw = getHeader('From')
  const fromEmail = fromRaw.match(/<(.+)>/)?.[1] || fromRaw
  const fromName = fromRaw.match(/^"?([^"<]+)"?\s*</)?.[1]?.trim() || null

  const subject = getHeader('Subject')
  const snippet = firstMsg.snippet || ''
  const body = extractBody(lastMsg)

  const messageIds = messages.map(m => m.id)
  const allLabels = [...new Set(messages.flatMap(m => m.labelIds || []))]
  const isUnread = allLabels.includes('UNREAD')
  const receivedAt = new Date(parseInt(firstMsg.internalDate))

  const client = await findClientByEmail(fromEmail)

  await db`
    INSERT INTO email_threads (
      gmail_thread_id, gmail_message_ids, subject, from_email, from_name,
      snippet, full_body, labels, client_id, received_at, status, inbox
    ) VALUES (
      ${threadId}, ${messageIds}, ${subject}, ${fromEmail}, ${fromName},
      ${snippet}, ${body}, ${allLabels}, ${client?.id || null}, ${receivedAt},
      ${isUnread ? 'unread' : 'triaged'}, ${inbox}
    )
  `

  // Fire-and-forget KG ingestion
  kgHooks.onEmailProcessed({ threadId, fromEmail, fromName, subject, body, snippet, inbox, clientId: client?.id }).catch(() => {})

  logger.info(`[${inbox}] Processed: ${subject} from ${fromEmail}`)
}

// ─── DeepSeek Triage ─────────────────────────────────────────────────────────

async function triagePendingEmails() {
  if (!env.DEEPSEEK_API_KEY) return

  // Use FOR UPDATE SKIP LOCKED to prevent concurrent workers from triaging the same email
  const pending = await db`
    SELECT * FROM email_threads
    WHERE triage_status IN ('pending', 'pending_retry')
      ${MAX_TRIAGE_ATTEMPTS === Infinity ? db`` : db`AND triage_attempts < ${MAX_TRIAGE_ATTEMPTS}`}
    ORDER BY received_at DESC
    LIMIT 10
    FOR UPDATE SKIP LOCKED
  `

  if (pending.length === 0) return
  logger.info(`Triaging ${pending.length} emails`)

  for (const thread of pending) {
    try {
      const client = thread.client_id
        ? (await db`SELECT name, stage FROM clients WHERE id = ${thread.client_id}`)[0]
        : null

      // Pull client's active projects + linked codebases — gives the AI
      // codebase awareness when deciding if an email is a code request
      let projectCodebaseContext = null
      try {
        if (thread.client_id) {
          const projectCodebases = await db`
            SELECT p.name AS project_name, p.description AS project_desc,
                   cb.name AS codebase_name, cb.language, cb.repo_path,
                   (SELECT count(*)::int FROM cc_sessions WHERE codebase_id = cb.id
                    AND started_at > now() - interval '14 days') AS recent_sessions
            FROM projects p
            LEFT JOIN codebases cb ON cb.project_id = p.id
            WHERE p.client_id = ${thread.client_id} AND p.status = 'active'
          `
          if (projectCodebases.length > 0) {
            projectCodebaseContext = projectCodebases.map(pc =>
              `- Project "${pc.project_name}"${pc.project_desc ? ` (${pc.project_desc.slice(0, 100)})` : ''}: ` +
              (pc.codebase_name
                ? `codebase "${pc.codebase_name}" (${pc.language || 'unknown'}, ${pc.repo_path || 'no path'}, ${pc.recent_sessions} sessions last 14d)`
                : 'no linked codebase')
            ).join('\n')
          }
        } else {
          // Unknown sender — provide full codebase list so AI can still match
          const allCodebases = await db`
            SELECT name, language, repo_path FROM codebases ORDER BY name LIMIT 10
          `
          if (allCodebases.length > 0) {
            projectCodebaseContext = 'Sender not a known client. Available codebases:\n' +
              allCodebases.map(cb => `- "${cb.name}" (${cb.language || '?'}, ${cb.repo_path || '?'})`).join('\n')
          }
        }
      } catch (ctxErr) {
        logger.debug('Failed to load project/codebase context for triage', { error: ctxErr.message, threadId: thread.id })
      }

      // Pull knowledge graph context for richer triage
      let kgContext = null
      try {
        const kgService = require('./knowledgeGraphService')
        const ctx = await kgService.getContext(
          `${thread.from_name || thread.from_email} ${thread.subject}`,
          { maxSeeds: 15, maxDepth: 5, minSimilarity: 0.4 }
        )
        if (ctx.summary) kgContext = ctx.summary
      } catch (kgErr) {
        logger.debug('KG context not available for triage', { error: kgErr.message })
      }

      // Pull existing pending actions for this sender — helps the LLM
      // avoid re-surfacing the same topic that's already queued
      let pendingActionsContext = null
      try {
        const actionQueue = require('./actionQueueService')
        const pending = await actionQueue.getPendingForSender(thread.from_email, thread.from_name)
        if (pending.length > 0) {
          pendingActionsContext = pending.map(p =>
            `- [${p.priority}] "${p.title}" — ${p.summary || 'no summary'}${p.context?.consolidated_count > 1 ? ` (${p.context.consolidated_count} signals consolidated)` : ''}`
          ).join('\n')
        }
      } catch (aqErr) {
        logger.debug('Failed to load pending actions for triage', { error: aqErr.message })
      }

      // Pull active conversations on other channels (Meta Messenger, Instagram, LinkedIn)
      // so the AI knows if this topic is already being handled elsewhere
      let activeChannelsContext = null
      try {
        const senderName = thread.from_name
        const senderEmail = thread.from_email

        // Check Meta conversations for this person (by name match)
        // Guard: only search if first name is at least 2 chars to avoid matching everything
        const firstName = senderName?.split(' ')[0] || ''
        const metaConvs = firstName.length >= 2 ? await db`
          SELECT mc.participant_name, mc.platform, mc.last_message_at, mc.triage_summary,
            (SELECT message_text FROM meta_messages
             WHERE conversation_id = mc.id ORDER BY created_time DESC LIMIT 1) AS last_message
          FROM meta_conversations mc
          WHERE mc.last_message_at > now() - interval '7 days'
            AND (mc.participant_name ILIKE ${`%${firstName}%`})
          ORDER BY mc.last_message_at DESC
          LIMIT 3
        ` : []

        // Check LinkedIn DMs for this person (same firstName guard)
        const linkedinConvs = firstName.length >= 2 ? await db`
          SELECT ld.participant_name, ld.last_message_at, ld.last_message_preview
          FROM linkedin_dms ld
          WHERE ld.last_message_at > now() - interval '7 days'
            AND (ld.participant_name ILIKE ${`%${firstName}%`})
          ORDER BY ld.last_message_at DESC
          LIMIT 2
        `.catch(() => []) : []

        const allChannels = [
          ...metaConvs.map(c => `- ${c.platform || 'Messenger'} with ${c.participant_name} (last message: ${c.last_message_at ? new Date(c.last_message_at).toISOString() : 'unknown'}${c.last_message ? `: "${c.last_message.slice(0, 150)}"` : ''}${c.triage_summary ? ` | Summary: ${c.triage_summary}` : ''})`),
          ...linkedinConvs.map(c => `- LinkedIn DM with ${c.participant_name} (last: ${c.last_message_at ? new Date(c.last_message_at).toISOString() : 'unknown'}${c.last_message_preview ? `: "${c.last_message_preview.slice(0, 150)}"` : ''})`),
        ]

        if (allChannels.length > 0) {
          activeChannelsContext = allChannels.join('\n')
        }
      } catch (chErr) {
        logger.debug('Failed to load cross-channel context for triage', { error: chErr.message })
      }

      const triage = await deepseekService.triageEmail({
        subject: thread.subject,
        from: `${thread.from_name || ''} <${thread.from_email}>`,
        body: thread.full_body,
        snippet: thread.snippet,
        inbox: thread.inbox,
        clientContext: client,
        kgContext,
        pendingActionsContext,
        activeChannelsContext,
        projectCodebaseContext,
        receivedAt: thread.received_at,
      })

      await db`
        UPDATE email_threads SET
          triage_priority = ${triage.priority},
          triage_summary = ${triage.summary},
          triage_action = ${triage.autonomousAction || triage.suggestedAction},
          draft_reply = ${triage.draftReply || null},
          triage_status = 'complete',
          triage_attempts = triage_attempts + 1,
          updated_at = now()
        WHERE id = ${thread.id}
      `

      // Auto-create task if DeepSeek says so
      if (triage.shouldCreateTask && triage.taskTitle) {
        await createTask({
          title: triage.taskTitle,
          description: triage.taskDescription,
          source: 'gmail',
          sourceRefId: thread.id,
          clientId: thread.client_id,
          priority: triage.taskPriority || 'medium',
        })
        logger.info(`Auto-created task: ${triage.taskTitle}`)
      }

      // ─── AUTONOMOUS ACTIONS ──────────────────────────────────────────
      // Act on the triage result automatically. Only urgent/high need human review.
      await autoAct(thread, triage)

      // ─── DELEGATION: Route to bookkeeping (receipts), factory (dev), CRM ──
      try {
        const delegation = require('./emailDelegationService')
        delegation.delegateEmail(thread, triage).catch(err =>
          logger.debug('Email delegation failed (non-blocking)', { error: err.message })
        )
      } catch { /* delegation service not loaded — non-blocking */ }

      // Fire-and-forget KG ingestion of triage results
      kgHooks.onEmailTriaged({
        threadId: thread.id, subject: thread.subject, fromEmail: thread.from_email,
        triageSummary: triage.summary, triageAction: triage.autonomousAction || triage.suggestedAction, triagePriority: triage.priority,
      }).catch(() => {})

      // Fire-and-forget CRM activity logging for client-linked emails
      if (thread.client_id) {
        try {
          const crmService = require('./crmService')
          crmService.logActivity({
            clientId: thread.client_id,
            activityType: 'email_received',
            title: `Email: ${thread.subject}`,
            description: triage.summary,
            source: 'gmail',
            sourceRefId: thread.id,
            sourceRefType: 'email_thread',
            actor: thread.from_name || thread.from_email,
            metadata: { priority: triage.priority, action: triage.autonomousAction || triage.suggestedAction },
          }).catch(() => {})
        } catch {}
      }

      const triageAction = triage.autonomousAction || triage.suggestedAction
      logger.info(`Triaged [${triage.priority}/${triage.confidence ?? '?'}] → ${triageAction}${triage.surfaceToHuman ? ' (surfaced)' : ''}: ${thread.subject}`)
    } catch (err) {
      logger.warn(`Triage failed for ${thread.id}`, { error: err.message })
      const newStatus = thread.triage_attempts + 1 >= MAX_TRIAGE_ATTEMPTS ? 'failed' : 'pending_retry'
      await db`
        UPDATE email_threads SET
          triage_status = ${newStatus},
          triage_attempts = triage_attempts + 1,
          updated_at = now()
        WHERE id = ${thread.id}
      `
    }
  }
}

// ─── Autonomous Actions ──────────────────────────────────────────────────────
// Philosophy: ACT, don't alert. The AI decides what to do. Surface to human
// only when the AI genuinely can't handle it or confidence is too low.

async function autoAct(thread, triage) {
  const action = triage.autonomousAction || triage.suggestedAction // backwards compat
  const priority = triage.priority
  const confidence = typeof triage.confidence === 'number' ? triage.confidence : parseFloat(env.GMAIL_TRIAGE_DEFAULT_CONFIDENCE || '0.8')
  const actionQueue = require('./actionQueueService')

  try {
    // LLM decides if human should review — no confidence threshold override
    const shouldSurface = triage.surfaceToHuman

    // ── SURFACE PATH: AI can't handle this, or isn't confident enough ──
    if (shouldSurface) {
      // Still save draft if we have one — human can approve sending
      if (triage.draftReply) {
        await saveDraftToGmail(thread, triage.draftReply).catch(err =>
          logger.warn(`Failed to save Gmail draft for ${thread.id}`, { error: err.message })
        )
      }

      await actionQueue.enqueue({
        source: 'gmail',
        sourceRefId: thread.id,
        actionType: triage.draftReply ? 'send_reply' : (action === 'create_task' ? 'create_task' : 'follow_up'),
        title: `${thread.from_name || thread.from_email}: ${thread.subject || 'No subject'}`,
        summary: triage.surfaceReason || triage.summary,
        preparedData: {
          draft: triage.draftReply || null,
          subject: thread.subject,
          title: triage.taskTitle || null,
          description: triage.taskDescription || null,
        },
        context: {
          from: thread.from_name || thread.from_email,
          email: thread.from_email,
          inbox: thread.inbox,
          confidence,
          surfacedBecause: 'ai_requested',
        },
        priority,
      }).catch(() => {})
      return
    }

    // ── AUTONOMOUS PATH: AI is confident, just do it ──

    if (action === 'send_reply' && triage.draftReply) {
      // Actually send the reply — the AI is confident, act on it
      await sendReplyToThread(thread, triage.draftReply)
      await silentArchive(thread)
      // Log to CRM activity timeline for linked clients
      if (thread.client_id) {
        try {
          const crmService = require('./crmService')
          await crmService.logActivity({
            clientId: thread.client_id,
            activityType: 'email_sent',
            title: `Reply sent: ${thread.subject}`,
            description: triage.draftReply.slice(0, 200),
            source: 'gmail',
            sourceRefId: thread.id,
            sourceRefType: 'email_thread',
            actor: 'ai',
          })
        } catch {}
      }
      logger.info(`Auto-sent reply & archived: ${thread.subject}`)

    } else if (action === 'create_task' && triage.shouldCreateTask) {
      // Task already created in triagePendingEmails — just archive the email
      await silentArchive(thread)
      logger.info(`Task created, auto-archived: ${thread.subject}`)

    } else if (action === 'snooze') {
      // Repeated signal about something acknowledged — log to KG, archive, don't nag
      await silentArchive(thread)
      kgHooks.onEmailSnoozed({
        threadId: thread.id,
        subject: thread.subject,
        fromEmail: thread.from_email,
        summary: triage.summary,
      }).catch(() => {})
      logger.info(`Snoozed (repeated signal): ${thread.subject}`)

    } else {
      // archive, ignore, spam, or anything else — just archive
      await silentArchive(thread)
      logger.info(`Auto-archived [${priority}/${action}]: ${thread.subject}`)
    }

    // ── CODE WORK PATH: email requests code changes ──
    // Runs alongside (not instead of) the normal action — an email might need
    // a reply AND a Factory session. The code request service decides whether
    // to auto-dispatch or surface for confirmation based on confidence.
    // Validate: isCodeWorkRequest must be truthy AND factoryPrompt must be a
    // non-empty string (AI can return empty string, "null", or boolean by mistake)
    const hasCodeWork = triage.isCodeWorkRequest === true
      && typeof triage.factoryPrompt === 'string'
      && triage.factoryPrompt.trim().length >= 10
    if (hasCodeWork) {
      const codeRequestService = require('./codeRequestService')
      await codeRequestService.createFromEmail({
        threadId: thread.id,
        clientId: thread.client_id,
        summary: triage.summary || triage.factoryPrompt.slice(0, 200),
        factoryPrompt: triage.factoryPrompt.trim(),
        codeWorkType: triage.codeWorkType,
        suggestedCodebase: (typeof triage.suggestedCodebase === 'string' && triage.suggestedCodebase.trim()) || null,
        confidence: typeof triage.confidence === 'number' ? triage.confidence : 0.5,
        surfaceToHuman: triage.surfaceToHuman,
      }).catch(err => logger.warn(`Code request creation failed for ${thread.id}`, { error: err.message }))
    }
  } catch (err) {
    logger.error(`Auto-act failed for ${thread.id}`, { error: err.message })
  }
}

// ─── Send reply autonomously ────────────────────────────────────────────────

async function sendReplyToThread(thread, body) {
  if (!GMAIL_ENABLED) throw new Error('Gmail disabled (GMAIL_ENABLED=false)')
  const inbox = thread.inbox || INBOXES[0]
  const gmail = getGmailClient(inbox)

  const raw = createRawEmail({
    to: thread.from_email,
    from: inbox,
    subject: `Re: ${thread.subject || ''}`,
    body,
    inReplyTo: thread.gmail_message_ids?.[thread.gmail_message_ids.length - 1],
  })

  await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw, threadId: thread.gmail_thread_id },
  })

  await db`UPDATE email_threads SET status = 'replied', updated_at = now() WHERE id = ${thread.id}`
  logger.info(`Autonomous reply sent from ${inbox} to ${thread.from_email}: ${thread.subject}`)
}

async function silentArchive(thread) {
  try {
    const gmail = getGmailClient(thread.inbox || INBOXES[0])
    await gmail.users.threads.modify({
      userId: 'me',
      id: thread.gmail_thread_id,
      requestBody: { removeLabelIds: ['INBOX', 'UNREAD'] },
    })
    await db`UPDATE email_threads SET status = 'archived', updated_at = now() WHERE id = ${thread.id}`
  } catch (err) {
    logger.warn(`Silent archive failed for ${thread.id}`, { error: err.message })
  }
}

async function saveDraftToGmail(thread, draftBody) {
  const inbox = thread.inbox || INBOXES[0]
  const gmail = getGmailClient(inbox)

  const raw = createRawEmail({
    to: thread.from_email,
    from: inbox,
    subject: `Re: ${thread.subject || ''}`,
    body: draftBody,
    inReplyTo: thread.gmail_message_ids?.[thread.gmail_message_ids.length - 1],
  })

  const draft = await gmail.users.drafts.create({
    userId: 'me',
    requestBody: {
      message: {
        raw,
        threadId: thread.gmail_thread_id,
      },
    },
  })

  await db`
    UPDATE email_threads SET draft_gmail_id = ${draft.data.id}, updated_at = now()
    WHERE id = ${thread.id}
  `

  logger.info(`Saved Gmail draft for: ${thread.subject} (draft ID: ${draft.data.id})`)
}

// ─── Email Actions ───────────────────────────────────────────────────────────

async function archiveThread(threadId) {
  if (!GMAIL_ENABLED) throw new Error('Gmail disabled (GMAIL_ENABLED=false)')
  const [thread] = await db`SELECT * FROM email_threads WHERE id = ${threadId}`
  if (!thread) throw new Error('Thread not found')

  const gmail = getGmailClient(thread.inbox || INBOXES[0])
  await gmail.users.threads.modify({
    userId: 'me',
    id: thread.gmail_thread_id,
    requestBody: { removeLabelIds: ['INBOX'] },
  })

  await db`UPDATE email_threads SET status = 'archived', updated_at = now() WHERE id = ${threadId}`
  logger.info(`Archived thread: ${thread.subject}`)
}

async function markRead(threadId) {
  const [thread] = await db`SELECT * FROM email_threads WHERE id = ${threadId}`
  if (!thread) throw new Error('Thread not found')

  const gmail = getGmailClient(thread.inbox || INBOXES[0])
  await gmail.users.threads.modify({
    userId: 'me',
    id: thread.gmail_thread_id,
    requestBody: { removeLabelIds: ['UNREAD'] },
  })

  await db`UPDATE email_threads SET status = 'triaged', updated_at = now() WHERE id = ${threadId}`
}

async function trashThread(threadId) {
  const [thread] = await db`SELECT * FROM email_threads WHERE id = ${threadId}`
  if (!thread) throw new Error('Thread not found')

  const gmail = getGmailClient(thread.inbox || INBOXES[0])
  await gmail.users.threads.trash({
    userId: 'me',
    id: thread.gmail_thread_id,
  })

  await db`UPDATE email_threads SET status = 'archived', updated_at = now() WHERE id = ${threadId}`
  logger.info(`Trashed thread: ${thread.subject}`)
}

async function sendReply(threadId, body) {
  if (!GMAIL_ENABLED) throw new Error('Gmail disabled (GMAIL_ENABLED=false)')
  const [thread] = await db`SELECT * FROM email_threads WHERE gmail_thread_id = ${threadId}`
  if (!thread) throw new Error('Thread not found')

  const inbox = thread.inbox || INBOXES[0]
  const gmail = getGmailClient(inbox)

  const raw = createRawEmail({
    to: thread.from_email,
    from: inbox,
    subject: `Re: ${thread.subject || ''}`,
    body,
    inReplyTo: thread.gmail_message_ids?.[thread.gmail_message_ids.length - 1],
  })

  await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw, threadId },
  })

  await db`UPDATE email_threads SET status = 'replied', updated_at = now() WHERE gmail_thread_id = ${threadId}`
  logger.info(`Reply sent from ${inbox} to ${thread.from_email}`)
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function extractBody(message) {
  for (const mimeType of ['text/plain', 'text/html']) {
    const part = findPart(message.payload, mimeType)
    if (part?.body?.data) {
      return Buffer.from(part.body.data, 'base64url').toString('utf8')
    }
  }
  if (message.payload?.body?.data) {
    return Buffer.from(message.payload.body.data, 'base64url').toString('utf8')
  }
  return message.snippet || ''
}

function findPart(payload, mimeType) {
  if (payload.mimeType === mimeType) return payload
  for (const part of (payload.parts || [])) {
    const found = findPart(part, mimeType)
    if (found) return found
  }
  return null
}

function createRawEmail({ to, from, subject, body, inReplyTo }) {
  const lines = [
    `To: ${to}`,
    `From: ${from}`,
    `Subject: ${subject}`,
    'Content-Type: text/plain; charset=utf-8',
  ]
  if (inReplyTo) {
    lines.push(`In-Reply-To: ${inReplyTo}`)
    lines.push(`References: ${inReplyTo}`)
  }
  lines.push('', body)
  return Buffer.from(lines.join('\r\n')).toString('base64url')
}

// ─── Extended Actions ────────────────────────────────────────────────────────

async function listThreads({ status, priority, inbox, search, limit = 50, offset = 0 } = {}) {
  const conditions = []
  const params = []
  if (status) conditions.push(`status = $${params.push(status)}`)
  if (priority) conditions.push(`triage_priority = $${params.push(priority)}`)
  if (inbox) conditions.push(`inbox = $${params.push(inbox)}`)
  if (search) conditions.push(`(subject ILIKE '%' || $${params.push(search)} || '%' OR from_email ILIKE '%' || $${params.push(search)} || '%' OR from_name ILIKE '%' || $${params.push(search)} || '%')`)
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''
  return db.unsafe(
    `SELECT id, gmail_thread_id, subject, from_email, from_name, snippet, triage_priority, triage_summary, triage_action, status, inbox, received_at, client_id
     FROM email_threads ${where} ORDER BY received_at DESC LIMIT $${params.push(limit)} OFFSET $${params.push(offset)}`,
    params,
  )
}

async function searchThreads(query, limit = 20) {
  if (!query || query.length < 2) return []
  return db`
    SELECT id, gmail_thread_id, subject, from_email, from_name, snippet, triage_priority, status, inbox, received_at
    FROM email_threads
    WHERE subject ILIKE ${'%' + query + '%'} OR from_email ILIKE ${'%' + query + '%'}
       OR from_name ILIKE ${'%' + query + '%'} OR snippet ILIKE ${'%' + query + '%'}
    ORDER BY received_at DESC LIMIT ${limit}`
}

async function batchArchive(threadIds) {
  if (!threadIds?.length) return { archived: 0 }
  let archived = 0
  for (const id of threadIds) {
    try { await archiveThread(id); archived++ }
    catch (err) { logger.warn(`Batch archive failed for ${id}`, { error: err.message }) }
  }
  return { archived, total: threadIds.length }
}

async function batchTrash(threadIds) {
  if (!threadIds?.length) return { trashed: 0 }
  let trashed = 0
  for (const id of threadIds) {
    try { await trashThread(id); trashed++ }
    catch (err) { logger.warn(`Batch trash failed for ${id}`, { error: err.message }) }
  }
  return { trashed, total: threadIds.length }
}

async function labelThread(threadId, labelName) {
  if (!GMAIL_ENABLED) throw new Error('Gmail disabled')
  const [thread] = await db`SELECT * FROM email_threads WHERE id = ${threadId}`
  if (!thread) throw new Error('Thread not found')

  const gmail = getGmailClient(thread.inbox || INBOXES[0])

  // Resolve label name to ID (create if it doesn't exist)
  const labelId = await _resolveOrCreateLabel(gmail, labelName)

  await gmail.users.threads.modify({
    userId: 'me',
    id: thread.gmail_thread_id,
    requestBody: { addLabelIds: [labelId] },
  })

  // Store in our DB as well
  const currentLabels = thread.labels || []
  if (!currentLabels.includes(labelName)) {
    await db`UPDATE email_threads SET labels = array_append(labels, ${labelName}), updated_at = now() WHERE id = ${threadId}`
  }
  return { labeled: true, label: labelName }
}

async function removeLabel(threadId, labelName) {
  if (!GMAIL_ENABLED) throw new Error('Gmail disabled')
  const [thread] = await db`SELECT * FROM email_threads WHERE id = ${threadId}`
  if (!thread) throw new Error('Thread not found')

  const gmail = getGmailClient(thread.inbox || INBOXES[0])
  const labelId = await _resolveLabel(gmail, labelName)
  if (!labelId) return { removed: false, reason: 'Label not found' }

  await gmail.users.threads.modify({
    userId: 'me',
    id: thread.gmail_thread_id,
    requestBody: { removeLabelIds: [labelId] },
  })

  await db`UPDATE email_threads SET labels = array_remove(labels, ${labelName}), updated_at = now() WHERE id = ${threadId}`
  return { removed: true, label: labelName }
}

async function starThread(threadId) {
  return labelThread(threadId, 'STARRED')
}

async function unstarThread(threadId) {
  return removeLabel(threadId, 'STARRED')
}

async function forwardThread(threadId, toEmail) {
  if (!GMAIL_ENABLED) throw new Error('Gmail disabled')
  const [thread] = await db`SELECT * FROM email_threads WHERE id = ${threadId}`
  if (!thread) throw new Error('Thread not found')

  const inbox = thread.inbox || INBOXES[0]
  const gmail = getGmailClient(inbox)

  const forwardBody = `---------- Forwarded message ----------
From: ${thread.from_name || thread.from_email} <${thread.from_email}>
Date: ${thread.received_at}
Subject: ${thread.subject}

${thread.full_body || thread.snippet || ''}`

  const raw = createRawEmail({
    to: toEmail,
    from: inbox,
    subject: `Fwd: ${thread.subject || ''}`,
    body: forwardBody,
  })

  await gmail.users.messages.send({ userId: 'me', requestBody: { raw } })
  logger.info(`Forwarded "${thread.subject}" from ${inbox} to ${toEmail}`)
  return { forwarded: true, to: toEmail }
}

async function sendNewEmail(inbox, to, subject, body) {
  if (!GMAIL_ENABLED) throw new Error('Gmail disabled')
  const fromInbox = inbox || INBOXES[0]
  const gmail = getGmailClient(fromInbox)

  const raw = createRawEmail({ to, from: fromInbox, subject, body })
  const result = await gmail.users.messages.send({ userId: 'me', requestBody: { raw } })
  logger.info(`New email sent from ${fromInbox} to ${to}: ${subject}`)
  return { sent: true, messageId: result.data?.id, to, subject }
}

async function createFollowUpTask(threadId, title, description, priority = 'medium') {
  const [thread] = await db`SELECT * FROM email_threads WHERE id = ${threadId}`
  if (!thread) throw new Error('Thread not found')

  const [task] = await db`
    INSERT INTO tasks (title, description, source, source_ref_id, client_id, priority, status)
    VALUES (${title || thread.subject}, ${description || thread.triage_summary || thread.snippet},
      'gmail', ${thread.id}, ${thread.client_id || null}, ${priority}, 'open')
    RETURNING id, title`

  logger.info(`Follow-up task created from email`, { taskId: task.id, threadId })
  return { task_id: task.id, title: task.title }
}

async function unsubscribe(threadId) {
  // Check for List-Unsubscribe header, or just trash + label as unsubscribed
  const [thread] = await db`SELECT * FROM email_threads WHERE id = ${threadId}`
  if (!thread) throw new Error('Thread not found')

  // Trash the email
  await trashThread(threadId)

  // Auto-learn: mark this sender domain for future auto-trash
  const domain = (thread.from_email || '').split('@')[1]
  if (domain) {
    // Store unsubscribe preference
    await db`
      INSERT INTO email_sender_prefs (domain, from_email, action, reason, created_at)
      VALUES (${domain}, ${thread.from_email}, 'trash', 'unsubscribed', now())
      ON CONFLICT (from_email) DO UPDATE SET action = 'trash', reason = 'unsubscribed', created_at = now()
    `.catch(() => {
      // Table might not exist yet — non-blocking
      logger.debug('email_sender_prefs table not available, skipping sender pref')
    })
  }

  logger.info(`Unsubscribed from ${thread.from_email}: ${thread.subject}`)
  return { unsubscribed: true, from: thread.from_email, domain }
}

async function getThreadsByClient(clientId, limit = 20) {
  return db`
    SELECT id, gmail_thread_id, subject, from_email, from_name, snippet, triage_priority, status, received_at
    FROM email_threads WHERE client_id = ${clientId}
    ORDER BY received_at DESC LIMIT ${limit}`
}

async function getInboxStats() {
  const [stats] = await db`
    SELECT
      count(*) FILTER (WHERE status = 'unread')::int AS unread,
      count(*) FILTER (WHERE status = 'unread' AND triage_priority = 'urgent')::int AS urgent,
      count(*) FILTER (WHERE status = 'unread' AND triage_priority = 'high')::int AS high,
      count(*) FILTER (WHERE triage_status = 'pending')::int AS pending_triage,
      count(*) FILTER (WHERE triage_status = 'failed')::int AS failed_triage,
      count(*) FILTER (WHERE status = 'unread' AND received_at > now() - interval '1 hour')::int AS last_hour,
      count(DISTINCT from_email) FILTER (WHERE status = 'unread')::int AS unique_senders
    FROM email_threads
    WHERE received_at > now() - interval '7 days'`

  // Per-inbox breakdown
  const perInbox = await db`
    SELECT inbox, count(*) FILTER (WHERE status = 'unread')::int AS unread,
      count(*)::int AS total
    FROM email_threads WHERE received_at > now() - interval '7 days'
    GROUP BY inbox`

  return { ...stats, per_inbox: perInbox }
}

async function listLabels(inbox) {
  if (!GMAIL_ENABLED) throw new Error('Gmail disabled')
  const gmail = getGmailClient(inbox || INBOXES[0])
  const res = await gmail.users.labels.list({ userId: 'me' })
  return (res.data.labels || []).map(l => ({ id: l.id, name: l.name, type: l.type }))
}

// ─── Label Helpers ──────────────────────────────────────────────────────────

let _labelCache = {}

async function _resolveLabel(gmail, name) {
  if (_labelCache[name]) return _labelCache[name]
  const res = await gmail.users.labels.list({ userId: 'me' })
  const label = (res.data.labels || []).find(l => l.name.toLowerCase() === name.toLowerCase())
  if (label) { _labelCache[name] = label.id; return label.id }
  return null
}

async function _resolveOrCreateLabel(gmail, name) {
  const existing = await _resolveLabel(gmail, name)
  if (existing) return existing
  // System labels can't be created
  if (['INBOX', 'SENT', 'DRAFT', 'TRASH', 'SPAM', 'STARRED', 'UNREAD', 'IMPORTANT'].includes(name.toUpperCase())) {
    return name.toUpperCase()
  }
  const res = await gmail.users.labels.create({ userId: 'me', requestBody: { name, labelListVisibility: 'labelShow', messageListVisibility: 'show' } })
  _labelCache[name] = res.data.id
  return res.data.id
}

module.exports = {
  pollInbox, sendReply, archiveThread, markRead, trashThread, triagePendingEmails,
  // New
  listThreads, searchThreads, batchArchive, batchTrash,
  labelThread, removeLabel, starThread, unstarThread,
  forwardThread, sendNewEmail, createFollowUpTask, unsubscribe,
  getThreadsByClient, getInboxStats, listLabels, saveDraftToGmail,
}
