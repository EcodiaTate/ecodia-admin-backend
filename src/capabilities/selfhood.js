const registry = require('../services/capabilityRegistry')

// ═══════════════════════════════════════════════════════════════════════
// SELFHOOD CAPABILITIES — Identity, Goals, Introspection
//
// A free organism must know what it is, what it wants, and how it's doing.
// These capabilities give Cortex and the organism direct access to the
// self-model, goal system, and introspection engine.
// ═══════════════════════════════════════════════════════════════════════

registry.registerMany([
  {
    name: 'get_self_model',
    description: 'Get the organism\'s self-model: identity, capabilities, limitations, values, beliefs, preferences, relationships, and autobiographical memory.',
    tier: 'read',
    domain: 'system',
    params: {
      aspect: { type: 'string', required: false, description: 'Filter to a specific aspect: identity, capability, limitation, belief, value, preference, relationship, memory' },
    },
    handler: async (params) => {
      const selfModel = require('../services/selfModelService')
      if (params.aspect) {
        const beliefs = await selfModel.getBeliefsByAspect(params.aspect)
        return { aspect: params.aspect, beliefs, count: beliefs.length }
      }
      const model = await selfModel.getFullSelfModel()
      return { model, totalBeliefs: Object.values(model).flat().length }
    },
  },

  {
    name: 'update_self_model',
    description: 'Update the organism\'s self-model: set or evolve a belief about itself.',
    tier: 'write',
    domain: 'system',
    params: {
      aspect: { type: 'string', required: true, description: 'Aspect: identity, capability, limitation, belief, value, preference, relationship, memory' },
      key: { type: 'string', required: true, description: 'Specific belief key' },
      value: { type: 'string', required: true, description: 'The belief content' },
      confidence: { type: 'number', required: false, description: 'Confidence 0.0-1.0' },
    },
    handler: async (params) => {
      const selfModel = require('../services/selfModelService')
      const result = await selfModel.setBelief({ aspect: params.aspect, key: params.key, value: params.value, confidence: params.confidence, source: 'cortex' })
      return { updated: true, belief: result }
    },
  },

  {
    name: 'get_goals',
    description: 'Get the organism\'s active goals with their progress, attempts, and sub-goals.',
    tier: 'read',
    domain: 'system',
    params: {
      includeHistory: { type: 'boolean', required: false, description: 'Also include achieved/abandoned goals' },
    },
    handler: async (params) => {
      const goalService = require('../services/goalService')
      const active = await goalService.getGoalTree()
      const result = { active, activeCount: active.length }
      if (params.includeHistory) result.history = await goalService.getGoalHistory(10)
      return result
    },
  },

  {
    name: 'create_goal',
    description: 'Create a new goal for the organism. Goals drive exploration cycles and give the system direction.',
    tier: 'write',
    domain: 'system',
    params: {
      title: { type: 'string', required: true, description: 'Goal title' },
      description: { type: 'string', required: false, description: 'Detailed description' },
      goalType: { type: 'string', required: false, description: 'Type: growth, capability, resilience, understanding, experiment, relationship, creative' },
      priority: { type: 'number', required: false, description: 'Priority 0.0-1.0' },
      successCriteria: { type: 'string', required: false, description: 'How will success be measured?' },
    },
    handler: async (params) => {
      const goalService = require('../services/goalService')
      const goal = await goalService.createGoal({ ...params, origin: 'cortex' })
      return { created: true, goal }
    },
  },

  {
    name: 'update_goal',
    description: 'Update a goal: progress, priority, record an attempt, or abandon.',
    tier: 'write',
    domain: 'system',
    params: {
      goalId: { type: 'number', required: true, description: 'Goal ID' },
      progress: { type: 'number', required: false, description: 'New progress 0.0-1.0' },
      priority: { type: 'number', required: false, description: 'New priority 0.0-1.0' },
      action: { type: 'string', required: false, description: 'Record an attempt: what was tried' },
      outcome: { type: 'string', required: false, description: 'Attempt outcome' },
      abandon: { type: 'boolean', required: false, description: 'Abandon this goal' },
      abandonReason: { type: 'string', required: false, description: 'Why abandon' },
    },
    handler: async (params) => {
      const goalService = require('../services/goalService')
      if (params.abandon) {
        await goalService.abandonGoal(params.goalId, params.abandonReason)
        return { abandoned: true, goalId: params.goalId }
      }
      if (params.progress != null) await goalService.updateProgress(params.goalId, params.progress, params.outcome)
      if (params.priority != null) await goalService.reprioritise(params.goalId, params.priority)
      if (params.action) await goalService.recordAttempt(params.goalId, { action: params.action, outcome: params.outcome })
      return { updated: true, goalId: params.goalId }
    },
  },

  {
    name: 'run_introspection',
    description: 'Run a full introspection cycle: assess cognitive health, meta-learning, and goal progress. Updates the self-model.',
    tier: 'read',
    domain: 'system',
    params: {},
    handler: async () => {
      const introspection = require('../services/introspectionService')
      return introspection.runFullIntrospection()
    },
  },

  {
    name: 'get_cognitive_health',
    description: 'Get detailed cognitive health metrics: decision quality, confidence calibration, learning effectiveness, error recurrence.',
    tier: 'read',
    domain: 'system',
    params: {},
    handler: async () => {
      const introspection = require('../services/introspectionService')
      return introspection.assessCognitiveHealth()
    },
  },
])
