const kg = require('./knowledgeGraphService')
const logger = require('../config/logger')
const env = require('../config/env')

// ═══════════════════════════════════════════════════════════════════════
// KG INGESTION HOOKS
//
// Thin async hooks called from existing services. All fire-and-forget —
// KG failures never block the main flow. The LLM decides what nodes
// and relationships to create. We just feed it content.
// ═══════════════════════════════════════════════════════════════════════

function isEnabled() {
  return !!(env.NEO4J_URI && env.DEEPSEEK_API_KEY)
}

// ─── Immediate Memory Sync Helper ──────────────────────────────────
// After any ingestion that produces a high-importance node, sync it
// to the organism immediately rather than waiting for the 30-min sweep.
// Fire-and-forget, non-blocking.

async function trySyncImportant(nodeName, labels, properties) {
  try {
    const memBridge = require('./memoryBridgeService')
    const importance = properties?.importance || 0
    if (importance >= 0.9) {
      await memBridge.syncImmediateIfUrgent({ name: nodeName, labels, importance, properties })
    } else if (importance >= 0.7) {
      await memBridge.syncImmediateIfImportant({ name: nodeName, labels, importance, properties })
    }
  } catch {}
}

// ─── Gmail ───────────────────────────────────────────────────────────

async function onEmailProcessed({ threadId, fromEmail, fromName, subject, body, snippet, inbox, clientId }) {
  if (!isEnabled()) return

  try {
    // Always create the person node immediately (cheap, no LLM)
    await kg.ensureNode({
      label: 'Person',
      name: fromName || fromEmail,
      properties: { email: fromEmail },
      sourceModule: 'gmail',
    })

    // LLM ingestion for rich extraction — runs async
    const content = `Email received in ${inbox} inbox.
From: ${fromName || 'Unknown'} <${fromEmail}>
Subject: ${subject}
Body: ${(body || snippet || '').slice(0, 2000)}`

    const context = clientId ? 'Sender is a known CRM client.' : ''

    await kg.ingestFromLLM(content, {
      sourceModule: 'gmail',
      sourceId: threadId,
      context,
    })
  } catch (err) {
    logger.debug('KG email ingestion failed (non-blocking)', { error: err.message })
  }
}

async function onEmailTriaged({ threadId, subject, fromEmail, triageSummary, triageAction, triagePriority }) {
  if (!isEnabled()) return

  try {
    // Don't re-ingest via LLM — onEmailProcessed already extracted entities from the
    // full body. Just enrich the sender node with triage metadata as a structured
    // relationship, so consolidation can track triage patterns.
    await kg.ensureRelationship({
      fromLabel: 'Person',
      fromName: fromEmail,
      toLabel: 'Event',
      toName: `Email: ${subject.slice(0, 80)}`,
      relType: triageAction === 'snooze' ? 'SENT_LOW_PRIORITY'
             : triagePriority === 'high' ? 'SENT_HIGH_PRIORITY'
             : 'SENT',
      properties: {
        triage_action: triageAction,
        triage_priority: triagePriority,
        triage_summary: (triageSummary || '').slice(0, 300),
      },
      sourceModule: 'gmail_triage',
    })
  } catch (err) {
    logger.debug('KG triage ingestion failed (non-blocking)', { error: err.message })
  }
}

async function onEmailSnoozed({ threadId, subject, fromEmail, summary }) {
  if (!isEnabled()) return

  try {
    // Direct structured ingestion — no LLM needed for a snooze event.
    // Just record the recurring signal as a relationship to the sender.
    await kg.ensureNode({
      label: 'Person',
      name: fromEmail,
      properties: { email: fromEmail },
      sourceModule: 'gmail_snooze',
    })

    await kg.ensureRelationship({
      fromLabel: 'Person',
      fromName: fromEmail,
      toLabel: 'Event',
      toName: `Recurring signal: ${subject.slice(0, 80)}`,
      relType: 'SENT_RECURRING_SIGNAL',
      properties: { summary: (summary || '').slice(0, 300), snoozed_at: new Date().toISOString() },
      sourceModule: 'gmail_snooze',
    })
  } catch (err) {
    logger.debug('KG snooze ingestion failed (non-blocking)', { error: err.message })
  }
}

// ─── LinkedIn ────────────────────────────────────────────────────────

async function onLinkedInDMProcessed({ dm }) {
  if (!isEnabled()) return

  try {
    const messages = (dm.messages || []).slice(-5)
    const content = `LinkedIn DM conversation with ${dm.participant_name}${dm.participant_headline ? ' (' + dm.participant_headline + ')' : ''}:
${messages.map(m => `${m.sender}: ${m.text}`).join('\n')}`

    await kg.ingestFromLLM(content, {
      sourceModule: 'linkedin_dm',
      sourceId: dm.id,
      context: dm.participant_company ? `Works at ${dm.participant_company}` : '',
    })
  } catch (err) {
    logger.debug('KG LinkedIn DM ingestion failed (non-blocking)', { error: err.message })
  }
}

async function onLinkedInProfileProcessed({ profile }) {
  if (!isEnabled()) return

  try {
    await kg.ensureNode({
      label: 'Person',
      name: profile.name,
      properties: {
        linkedin_url: profile.linkedin_url,
        headline: profile.headline,
        company: profile.company,
        location: profile.location,
        industry: profile.industry,
      },
      sourceModule: 'linkedin_profile',
      sourceId: profile.id,
    })

    if (profile.company) {
      await kg.ensureRelationship({
        fromLabel: 'Person',
        fromName: profile.name,
        toLabel: 'Organisation',
        toName: profile.company,
        relType: 'WORKS_AT',
        properties: { title: profile.headline },
        sourceModule: 'linkedin_profile',
      })
    }
  } catch (err) {
    logger.debug('KG LinkedIn profile ingestion failed (non-blocking)', { error: err.message })
  }
}

// ─── CRM ─────────────────────────────────────────────────────────────

async function onClientUpdated({ client, previousStage }) {
  if (!isEnabled()) return

  try {
    await kg.ensureNode({
      label: 'Person',
      name: client.name,
      properties: {
        email: client.email,
        company: client.company,
        phone: client.phone,
        stage: client.stage,
        priority: client.priority,
      },
      sourceModule: 'crm',
      sourceId: client.id,
    })

    if (client.company) {
      await kg.ensureRelationship({
        fromLabel: 'Person',
        fromName: client.name,
        toLabel: 'Organisation',
        toName: client.company,
        relType: 'WORKS_AT',
        sourceModule: 'crm',
      })
    }

    if (previousStage && previousStage !== client.stage) {
      await kg.ensureRelationship({
        fromLabel: 'Person',
        fromName: client.name,
        toLabel: 'Event',
        toName: `Pipeline: ${previousStage} → ${client.stage}`,
        relType: 'MOVED_STAGE',
        properties: { from: previousStage, to: client.stage, when: new Date().toISOString() },
        sourceModule: 'crm',
      })
    }
  } catch (err) {
    logger.debug('KG CRM ingestion failed (non-blocking)', { error: err.message })
  }
}

async function onProjectCreated({ project, clientName }) {
  if (!isEnabled()) return

  try {
    await kg.ensureNode({
      label: 'Project',
      name: project.name,
      properties: {
        description: project.description,
        status: project.status,
        tech_stack: (project.tech_stack || []).join(', '),
        repo_url: project.repo_url,
        budget: project.budget_aud,
      },
      sourceModule: 'crm',
      sourceId: project.id,
    })

    if (clientName) {
      await kg.ensureRelationship({
        fromLabel: 'Person',
        fromName: clientName,
        toLabel: 'Project',
        toName: project.name,
        relType: 'OWNS',
        sourceModule: 'crm',
      })
    }
  } catch (err) {
    logger.debug('KG project ingestion failed (non-blocking)', { error: err.message })
  }
}

// ─── Finance ─────────────────────────────────────────────────────────

async function onTransactionCategorized({ transaction, clientName }) {
  if (!isEnabled()) return

  try {
    if (clientName && transaction.category) {
      await kg.ensureRelationship({
        fromLabel: 'Person',
        fromName: clientName,
        toLabel: 'Transaction',
        toName: `${transaction.description} ($${Math.abs(transaction.amount_aud)})`,
        relType: transaction.type === 'credit' ? 'PAID' : 'WAS_PAID_FOR',
        properties: {
          amount: transaction.amount_aud,
          category: transaction.category,
          date: transaction.date,
        },
        sourceModule: 'finance',
      })
    }
  } catch (err) {
    logger.debug('KG finance ingestion failed (non-blocking)', { error: err.message })
  }
}

// ─── Calendar ───────────────────────────────────────────────────────

async function onCalendarEventProcessed({ event, calendarEmail }) {
  if (!isEnabled()) return
  if (!event.summary) return // skip empty events

  try {
    // Create person nodes for attendees
    const attendees = typeof event.attendees === 'string' ? JSON.parse(event.attendees) : (event.attendees || [])
    for (const att of attendees) {
      if (att.email && !att.self && att.email !== calendarEmail) {
        await kg.ensureNode({
          label: 'Person',
          name: att.name || att.email,
          properties: { email: att.email },
          sourceModule: 'calendar',
        })
      }
    }

    const attendeeNames = attendees
      .filter(a => !a.self && a.email !== calendarEmail)
      .map(a => a.name || a.email)
      .join(', ')

    const content = `Calendar event: ${event.summary}
When: ${event.start_time}${event.all_day ? ' (all day)' : ` to ${event.end_time}`}
${event.location ? `Location: ${event.location}` : ''}
${attendeeNames ? `Attendees: ${attendeeNames}` : ''}
${event.description ? `Description: ${(event.description || '').slice(0, 1000)}` : ''}
Calendar: ${calendarEmail}`

    await kg.ingestFromLLM(content, {
      sourceModule: 'calendar',
      sourceId: event.id,
      context: 'This is a calendar event. Extract people, topics, meeting purposes, and any relationships between attendees.',
    })
  } catch (err) {
    logger.debug('KG calendar ingestion failed (non-blocking)', { error: err.message })
  }
}

// ─── Claude Code Sessions ────────────────────────────────────────────

async function onCCSessionCompleted({ session, projectName }) {
  if (!isEnabled()) return

  try {
    // Direct structured ingestion — CC session metadata is already structured,
    // no LLM extraction needed. Create session node + link to project.
    const sessionName = `CC: ${(session.initial_prompt || 'unnamed').slice(0, 80)}`

    await kg.ensureNode({
      label: 'CCSession',
      name: sessionName,
      properties: {
        status: session.status,
        cost_usd: session.cc_cost_usd || 0,
        prompt: (session.initial_prompt || '').slice(0, 500),
        project: projectName || null,
      },
      sourceModule: 'claude_code',
      sourceId: session.id,
    })

    if (projectName) {
      await kg.ensureRelationship({
        fromLabel: 'CCSession',
        fromName: sessionName,
        toLabel: 'Project',
        toName: projectName,
        relType: session.status === 'error' ? 'FAILED_ON' : 'WORKED_ON',
        properties: { cost_usd: session.cc_cost_usd || 0 },
        sourceModule: 'claude_code',
      })
    }

    // Immediate sync: CC session outcomes are high-value for organism's Evo
    trySyncImportant(
      sessionName,
      ['CCSession'],
      { importance: session.status === 'error' ? 0.8 : 0.7, status: session.status, project: projectName },
    )
  } catch (err) {
    logger.debug('KG CC session ingestion failed (non-blocking)', { error: err.message })
  }
}

// ─── Codebase Intelligence ──────────────────────────────────────────

async function onCodebaseIndexed({ codebaseId, codebaseName, language, fileCount }) {
  if (!isEnabled()) return

  try {
    await kg.ensureNode({
      label: 'Codebase',
      name: codebaseName,
      properties: { language, file_count: fileCount },
      sourceModule: 'codebase_intelligence',
      sourceId: codebaseId,
    })
  } catch (err) {
    logger.debug('KG codebase ingestion failed (non-blocking)', { error: err.message })
  }
}

// ─── Deployments ────────────────────────────────────────────────────

async function onDeploymentCompleted({ deployment, codebaseName, sessionId }) {
  if (!isEnabled()) return

  try {
    // Direct structured ingestion — deployment data is fully structured already.
    const isFailure = deployment.deploy_status === 'failed' || deployment.deploy_status === 'reverted'
    const deployName = `Deploy: ${codebaseName} — ${deployment.deploy_status} (${(deployment.commit_sha || '').slice(0, 7)})`

    await kg.ensureNode({
      label: 'Deployment',
      name: deployName,
      properties: {
        status: deployment.deploy_status,
        target: deployment.deploy_target,
        commit_sha: deployment.commit_sha,
        error_message: deployment.error_message || null,
        reverted: !!deployment.reverted_at,
      },
      sourceModule: 'deployment',
      sourceId: deployment.id,
    })

    if (codebaseName) {
      await kg.ensureRelationship({
        fromLabel: 'Deployment',
        fromName: deployName,
        toLabel: 'Codebase',
        toName: codebaseName,
        relType: isFailure ? 'FAILED_DEPLOY_TO' : 'DEPLOYED_TO',
        sourceModule: 'deployment',
      })
    }

    // Deploy failures are urgent — organism's Thymos needs to know immediately
    trySyncImportant(
      deployName,
      ['Deployment'],
      { importance: isFailure ? 0.9 : 0.7, status: deployment.deploy_status, codebase: codebaseName },
    )
  } catch (err) {
    logger.debug('KG deployment ingestion failed (non-blocking)', { error: err.message })
  }
}

// ─── Google Drive ────────────────────────────────────────────────────

async function onDriveFileProcessed({ file }) {
  if (!isEnabled()) return

  try {
    const contentPreview = (file.content_text || '').slice(0, 2000)

    await kg.ensureNode({
      label: 'Document',
      name: file.name,
      properties: {
        source: 'google_drive',
        mime_type: file.mime_type,
        folder: file.parent_folder_name,
        owner: file.owner_email,
        web_link: file.web_view_link,
        last_modified: file.modified_time,
        last_modified_by: file.last_modifying_user,
      },
      sourceModule: 'google_drive',
      sourceId: file.id,
    })

    if (contentPreview) {
      await kg.ingestFromLLM(
        `Google Drive document: ${file.name}
Type: ${file.mime_type}
Folder: ${file.parent_folder_name || 'root'}
Owner: ${file.owner_email || 'unknown'}
Last modified by: ${file.last_modifying_user || 'unknown'}

Content:
${contentPreview}`, {
          sourceModule: 'google_drive',
          sourceId: file.id,
          context: 'This is a Google Drive document. Extract entities, topics, decisions, action items, and any relationships between people or projects mentioned.',
        }
      )
    }
  } catch (err) {
    logger.debug('KG Drive ingestion failed (non-blocking)', { error: err.message })
  }
}

// ─── Vercel ─────────────────────────────────────────────────────────

async function onVercelDeployment({ deployment, projectName }) {
  if (!isEnabled()) return

  try {
    // Direct structured ingestion — Vercel metadata is already machine-structured.
    const name = projectName || deployment.name
    const isError = deployment.state === 'ERROR'
    const deployName = `Vercel: ${name} — ${deployment.state} (${deployment.meta?.githubCommitRef || 'unknown'})`

    await kg.ensureNode({
      label: 'Deployment',
      name: deployName,
      properties: {
        platform: 'vercel',
        state: deployment.state,
        target: deployment.target || 'preview',
        branch: deployment.meta?.githubCommitRef || null,
        commit_message: (deployment.meta?.githubCommitMessage || '').slice(0, 200),
        error_message: isError ? (deployment.errorMessage || null) : null,
        url: deployment.url ? `https://${deployment.url}` : null,
      },
      sourceModule: 'vercel',
      sourceId: deployment.uid,
    })

    if (name) {
      await kg.ensureRelationship({
        fromLabel: 'Deployment',
        fromName: deployName,
        toLabel: 'Project',
        toName: name,
        relType: isError ? 'FAILED_DEPLOY_TO' : 'DEPLOYED_TO',
        properties: { branch: deployment.meta?.githubCommitRef || null },
        sourceModule: 'vercel',
      })
    }
  } catch (err) {
    logger.debug('KG Vercel ingestion failed (non-blocking)', { error: err.message })
  }
}

// ─── Meta / Facebook ────────────────────────────────────────────────

async function onMetaPostCreated({ post, pageName }) {
  if (!isEnabled()) return

  try {
    if (!post.message && !post.story) return

    const content = `Facebook/Instagram post on ${pageName || 'page'}:
${post.message || post.story || ''}
Type: ${post.type || 'unknown'}
Engagement: ${post.likes?.summary?.total_count || 0} likes, ${post.comments?.summary?.total_count || 0} comments, ${post.shares?.count || 0} shares`

    await kg.ingestFromLLM(content, {
      sourceModule: 'meta',
      sourceId: post.id,
      context: 'This is a social media post. Extract topics, mentions, and any business-relevant content.',
    })
  } catch (err) {
    logger.debug('KG Meta post ingestion failed (non-blocking)', { error: err.message })
  }
}

async function onMetaConversationUpdated({ conversation, participantName, platform, newMessageCount }) {
  if (!isEnabled()) return

  try {
    await kg.ensureNode({
      label: 'Person',
      name: participantName || conversation.participant_id || 'Unknown',
      properties: {
        [`${platform}_id`]: conversation.participant_id,
        platform,
      },
      sourceModule: `meta_${platform}`,
      sourceId: conversation.id,
    })

    // We don't ingest message content to KG to avoid privacy issues with DMs
    // Just track the relationship
    await kg.ensureRelationship({
      fromLabel: 'Person',
      fromName: participantName || conversation.participant_id,
      toLabel: 'Event',
      toName: `${platform} conversation (${newMessageCount} new messages)`,
      relType: 'MESSAGED_VIA',
      properties: { platform, lastMessageAt: conversation.last_message_at },
      sourceModule: `meta_${platform}`,
    })
  } catch (err) {
    logger.debug('KG Meta conversation ingestion failed (non-blocking)', { error: err.message })
  }
}

// ─── Symbridge Messages ─────────────────────────────────────────────

async function onSymbridgeMessage({ direction, messageType, payload, sourceSystem, correlationId }) {
  if (!isEnabled()) return

  // Skip high-frequency low-value message types — heartbeats, acks, and routine
  // health signals would flood the graph with noise nodes.
  const skipTypes = new Set(['heartbeat', 'ack', 'pong', 'health_check', 'keepalive'])
  if (skipTypes.has(messageType)) return

  try {
    // Direct structured ingestion — symbridge payloads are machine-structured JSON,
    // not natural language. Parse directly into nodes/rels instead of LLM extraction.
    const eventName = `Symbridge: ${messageType} (${direction})`

    await kg.ensureNode({
      label: 'SymbridgeEvent',
      name: eventName,
      properties: {
        direction,
        message_type: messageType,
        source_system: sourceSystem,
        correlation_id: correlationId || null,
        // Capture meaningful payload fields without dumping raw JSON
        description: payload?.description || payload?.message || payload?.type || messageType,
        outcome: payload?.outcome || payload?.status || null,
        confidence: payload?.confidence || null,
      },
      sourceModule: 'symbridge',
      sourceId: correlationId || null,
    })

    // Only create cross-body relationship for substantive message types
    const substantive = new Set(['proposal', 'result', 'factory_result', 'hypothesis', 'discovery', 'directive'])
    if (substantive.has(messageType) && payload?.codebase) {
      await kg.ensureRelationship({
        fromLabel: 'SymbridgeEvent',
        fromName: eventName,
        toLabel: 'Codebase',
        toName: payload.codebase,
        relType: direction === 'outbound' ? 'PROPOSED_FOR' : 'RESULTED_IN',
        sourceModule: 'symbridge',
      })
    }
  } catch (err) {
    logger.debug('KG symbridge ingestion failed (non-blocking)', { error: err.message })
  }
}

// ─── Action Queue — Decision Intelligence ────────────────────────────
// Rich structured signals that feed back into suppression + priority learning.

async function onActionDismissed({ action, reason, reasonCategory }) {
  if (!isEnabled()) return

  try {
    // Structured category is far more useful than free-text for pattern extraction
    const categoryLabel = reasonCategory || 'unspecified'
    const consolidatedCount = action.context?.consolidated_count || 1
    const suppressionNote = action.context?.suppression_evaluation || 'none'
    const waitTime = action.created_at
      ? Math.round((Date.now() - new Date(action.created_at).getTime()) / 1000)
      : 'unknown'

    const content = `Action DISMISSED (correction signal):
Source: ${action.source}
Type: ${action.action_type}
Title: ${action.title}
Summary: ${action.summary || 'N/A'}
Priority when surfaced: ${action.priority}
Dismiss category: ${categoryLabel}
Dismiss reason detail: ${reason || 'none given'}
From: ${action.context?.from || 'unknown'} (${action.context?.email || ''})
Surfaced because: ${action.context?.surfacedBecause || 'ai_requested'}
Confidence when surfaced: ${action.context?.confidence ?? 'unknown'}
Consolidated signals: ${consolidatedCount}
Suppression evaluation at enqueue: ${suppressionNote}
Time in queue before dismissal: ${waitTime}s
Resource key: ${action.resource_key || 'none'}`

    await kg.ingestFromLLM(content, {
      sourceModule: 'action_queue_dismissed',
      sourceId: action.id,
      context: `A human dismissed this action. CORRECTION SIGNAL — extract specific learnable patterns:
1. The dismiss category "${categoryLabel}" tells you WHY it was wrong to surface.
2. If category is "wrong_sender", learn to suppress future items from ${action.context?.email || action.context?.from || 'this sender'}.
3. If category is "wrong_priority", the action was OK but priority was miscalibrated for ${action.source}/${action.action_type}.
4. If category is "not_relevant", this (source,action_type) combination should be reviewed for suppression.
5. If category is "already_handled", the system was too slow or duplicated something handled externally.
6. Track the pattern (source=${action.source}, type=${action.action_type}, sender=${action.context?.email || 'unknown'}) — if this pattern repeats, future items should be auto-suppressed.`,
    })
  } catch (err) {
    logger.debug('KG action dismissed ingestion failed (non-blocking)', { error: err.message })
  }
}

async function onActionExecuted({ action, result }) {
  if (!isEnabled()) return

  try {
    const consolidatedCount = action.context?.consolidated_count || 1
    const suppressionNote = action.context?.suppression_evaluation || 'none'
    const waitTime = action.created_at
      ? Math.round((Date.now() - new Date(action.created_at).getTime()) / 1000)
      : 'unknown'

    const content = `Action APPROVED and executed (positive signal):
Source: ${action.source}
Type: ${action.action_type}
Title: ${action.title}
Summary: ${action.summary || 'N/A'}
Priority: ${action.priority}
Result: ${result?.message || 'completed'}
From: ${action.context?.from || 'unknown'} (${action.context?.email || ''})
Consolidated signals: ${consolidatedCount}
Suppression evaluation at enqueue: ${suppressionNote}
Time in queue before approval: ${waitTime}s
Resource key: ${action.resource_key || 'none'}`

    await kg.ingestFromLLM(content, {
      sourceModule: 'action_queue',
      sourceId: action.id,
      context: `An action was approved and executed — POSITIVE signal. Extract:
1. This confirms (source=${action.source}, type=${action.action_type}, sender=${action.context?.email || 'unknown'}) is a pattern worth surfacing.
2. The approval time of ${waitTime}s indicates urgency — fast approvals mean high-value items.
3. If this sender has been executed before, strengthen the pattern — increase surfacing confidence for them.
4. Track the result quality to inform future draft generation.`,
    })

    // Cognitive broadcast: tell the organism an action was executed
    sendCognitiveBroadcast('action_outcome', 0.4, {
      source: action.source,
      action_type: action.action_type,
      title: action.title,
      result: result?.message,
    })
  } catch (err) {
    logger.debug('KG action queue ingestion failed (non-blocking)', { error: err.message })
  }
}

// ─── Direct Actions (organism → integration without CC) ─────────────

async function onDirectAction({ actionType, params, result, status, durationMs }) {
  if (!isEnabled()) return

  try {
    // Direct structured ingestion — action metadata is already structured.
    // Use a rolling node per action type to track patterns without accumulation.
    await kg.ensureNode({
      label: 'DirectAction',
      name: `DirectAction: ${actionType}`,
      properties: {
        action_type: actionType,
        last_status: status,
        last_duration_ms: durationMs,
        last_result: typeof result === 'string' ? result.slice(0, 200) : (result?.message || status),
        description: `${actionType}: ${status} (${durationMs}ms)`,
      },
      sourceModule: 'direct_action',
    })
  } catch (err) {
    logger.debug('KG direct action ingestion failed (non-blocking)', { error: err.message })
  }
}

// ─── Factory Outcome with Immediate Sync ────────────────────────────

async function onFactoryOutcome({ session, outcome, confidence, filesChanged, commitSha, error }) {
  if (!isEnabled()) return

  // Sync Factory outcomes to organism immediately — Evo needs this for hypothesis formation
  try {
    const memBridge = require('./memoryBridgeService')
    await memBridge.syncImmediateIfImportant({
      name: `Factory: ${outcome} — ${(session.initial_prompt || '').slice(0, 60)}`,
      labels: ['FactoryOutcome'],
      importance: outcome === 'success' ? 0.7 : outcome === 'deploy_failed' ? 0.9 : 0.6,
      properties: {
        outcome,
        confidence,
        codebase: session.codebase_name,
        trigger: session.trigger_source,
        files_changed: (filesChanged || []).slice(0, 10).join(', '),
      },
    })
  } catch {}

  // Cognitive broadcast to organism's Atune
  sendCognitiveBroadcast('factory_outcome', confidence || 0.5, {
    session_id: session.id,
    outcome,
    codebase: session.codebase_name,
    files_changed: filesChanged,
    commit_sha: commitSha,
    error,
  })
}

// ─── System Events (maintenance cycles, worker signals) ─────────────

async function onSystemEvent({ type, decisions, actioned, pressure }) {
  if (!isEnabled()) return

  // Only record system events when something actually happened (decisions actioned).
  // Routine idle cycles with 0 decisions are pure noise — skip entirely.
  if (!actioned || actioned === 0) return

  try {
    // Direct structured ingestion — system events are numeric metrics, not prose.
    // A single rolling node per event type avoids unbounded node accumulation.
    await kg.ensureNode({
      label: 'SystemEvent',
      name: `System: ${type}`,
      properties: {
        last_decisions: decisions,
        last_actioned: actioned,
        last_pressure: pressure,
        description: `${type}: ${actioned}/${decisions} decisions actioned at pressure ${(pressure || 0).toFixed(2)}`,
      },
      sourceModule: 'system',
    })
  } catch (err) {
    logger.debug('KG system event ingestion failed (non-blocking)', { error: err.message })
  }
}

// ─── Cognitive Broadcast Helper ─────────────────────────────────────
// Sends structured percepts to the organism's cognitive cycle (Atune)

function sendCognitiveBroadcast(perceptType, salience, content) {
  if (env.COGNITIVE_BROADCAST_ENABLED === 'false') return

  try {
    const symbridge = require('./symbridgeService')
    symbridge.send('cognitive_broadcast', {
      percept_type: perceptType,
      salience: Math.max(0, Math.min(1, salience)),
      content,
      source: 'ecodiaos',
      timestamp: new Date().toISOString(),
    }).catch(() => {})
  } catch {}
}

module.exports = {
  onEmailProcessed,
  onEmailTriaged,
  onEmailSnoozed,
  onLinkedInDMProcessed,
  onLinkedInProfileProcessed,
  onClientUpdated,
  onProjectCreated,
  onTransactionCategorized,
  onCalendarEventProcessed,
  onCCSessionCompleted,
  onCodebaseIndexed,
  onDeploymentCompleted,
  onDriveFileProcessed,
  onVercelDeployment,
  onMetaPostCreated,
  onMetaConversationUpdated,
  onSymbridgeMessage,
  onActionDismissed,
  onActionExecuted,
  onDirectAction,
  onFactoryOutcome,
  onSystemEvent,
  sendCognitiveBroadcast,
}
