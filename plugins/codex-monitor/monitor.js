function cleanError(error) {
  const text = error instanceof Error ? error.message : String(error)
  return text.replace(/([A-Z]:\\[^\s"']+)/gi, '[local path]').slice(0, 240)
}

function publicSession(session) {
  const {
    rolloutPath: _rolloutPath,
    historyMode: _historyMode,
    rawStatus: _rawStatus,
    rawStatusReason: _rawStatusReason,
    ...view
  } = session
  return view
}

export function createMonitor(source, options = {}) {
  const now = options.now || (() => new Date().toISOString())
  const startedAt = now()
  const volatileRecords = new Map()
  let dismissedRuns = new Map()
  const recordStore = options.recordStore || {
    list: async () => new Map(volatileRecords),
    remember: async (sessionId) => {
      if (!volatileRecords.has(sessionId)) volatileRecords.set(sessionId, now())
      return new Map(volatileRecords)
    },
    remove: async (sessionId) => volatileRecords.delete(sessionId),
    removeMany: async (sessionIds) => {
      for (const sessionId of sessionIds) volatileRecords.delete(sessionId)
    },
    dismissRunning: async (sessionId, observedAt) => {
      volatileRecords.delete(sessionId)
      dismissedRuns.set(sessionId, observedAt)
      return new Map(dismissedRuns)
    }
  }
  const sessions = new Map()
  const defaultIds = new Set()
  const extraIds = new Set()
  const pendingIds = new Set()
  let operationQueue = Promise.resolve()
  let pendingDefault = false
  let running = false
  let activeScope = null
  let disposed = false
  let idlePromise = Promise.resolve()
  let resolveIdle = null
  let generatedAt = null
  let lastScope = null
  let health = { index: 'loading', rollout: 'loading', records: 'loading', lastError: null }

  function serialized(operation) {
    const run = operationQueue.then(operation, operation)
    operationQueue = run.then(() => undefined, () => undefined)
    return run
  }

  async function accessRecords(operation) {
    try {
      return await operation()
    } catch (error) {
      const failure = new Error(error instanceof Error ? error.message : String(error))
      failure.healthSource = 'records'
      throw failure
    }
  }

  async function readRecords() {
    if (recordStore.readState) {
      const state = await accessRecords(() => recordStore.readState())
      dismissedRuns = state.dismissedRuns
      return state.sessions
    }
    return accessRecords(() => recordStore.list())
  }

  function isDismissedRun(session) {
    return session && (session.rawStatus || session.status) === 'running'
      && Boolean(session.observedAt) && dismissedRuns.get(session.sessionId) === session.observedAt
  }

  function classify(session, records) {
    const rawStatus = session.rawStatus || session.status
    const rawStatusReason = session.rawStatusReason || session.statusReason
    const hasRecord = records.has(session.sessionId)
    const recordedAt = hasRecord ? records.get(session.sessionId) : null
    if (isDismissedRun(session)) {
      return { ...session, rawStatus, rawStatusReason, recordedAt: null, status: 'record',
        statusReason: '本轮运行标记已手动清理，新一轮开始后恢复跟踪', statusSource: 'record-store', reviewable: false }
    }
    if (rawStatus === 'unknown') {
      return {
        ...session,
        rawStatus,
        rawStatusReason,
        recordedAt,
        status: 'unknown',
        reviewable: hasRecord
      }
    }
    if (!hasRecord) {
      return {
        ...session,
        rawStatus,
        rawStatusReason,
        recordedAt: null,
        status: 'record',
        statusReason: '未记录到本监控中的运行过程',
        statusSource: 'record-store'
      }
    }
    return { ...session, rawStatus, rawStatusReason, recordedAt, status: rawStatus }
  }

  function currentRolloutHealth() {
    return [...sessions.values()].some((session) => session.status === 'unknown' && session.statusUncertain !== true) ? 'degraded' : 'ok'
  }

  function missingRecordedSession(sessionId, recordedAt, reason = '对应会话源中未找到该会话') {
    return {
      sessionId,
      title: '未知会话',
      cwd: '',
      source: '',
      modelProvider: '',
      model: '',
      reasoningEffort: '',
      tokensUsed: null,
      questionCount: null,
      contextUsedTokens: null,
      contextWindowTokens: null,
      contextObservedAt: null,
      createdAt: null,
      updatedAt: recordedAt,
      observedAt: null,
      recordedAt,
      status: 'unknown',
      rawStatus: 'unknown',
      rawStatusReason: reason,
      statusReason: `${reason}，可审核完成以移除运行记录`,
      statusSource: 'record-store',
      recordOnly: true,
      reviewable: true
    }
  }

  function beginIdleCycle() {
    if (!resolveIdle) {
      idlePromise = new Promise((resolve) => { resolveIdle = resolve })
    }
  }

  function endIdleCycle() {
    if (resolveIdle) resolveIdle()
    resolveIdle = null
  }

  function refreshDefault() {
    return serialized(async () => {
      const result = await source.queryDefault()
      let records = await readRecords()
      const nextIds = new Set(result.sessions.map((item) => item.sessionId))
      for (const id of defaultIds) {
        if (!nextIds.has(id) && !extraIds.has(id)) sessions.delete(id)
      }
      defaultIds.clear()
      for (const session of result.sessions) {
        const previous = sessions.get(session.sessionId)
        const newlyCompleted = options.trackCompletedTurns === true
          && session.status === 'turn_completed' && session.observedAt >= startedAt
          && previous?.observedAt !== session.observedAt
        if ((session.status === 'running' || newlyCompleted) && !isDismissedRun(session) && !records.has(session.sessionId)) {
          records = await accessRecords(() => recordStore.remember(session.sessionId))
        }
        defaultIds.add(session.sessionId)
        sessions.set(session.sessionId, classify(session, records))
        if (!disposed) options.onSessionObserved?.(session)
      }

      for (const [sessionId, recordedAt] of records) {
        if (nextIds.has(sessionId)) continue
        let session = null
        let missingReason = '对应会话源中未找到该会话'
        try {
          session = await source.querySession(sessionId)
        } catch (error) {
          missingReason = `定向查询失败：${cleanError(error)}`
        }
        extraIds.add(sessionId)
        sessions.set(sessionId, session
          ? classify(session, records)
          : missingRecordedSession(sessionId, recordedAt, missingReason))
        if (session && !disposed) options.onSessionObserved?.(session)
      }
      generatedAt = result.queriedAt || now()
      lastScope = 'default'
      health = {
        index: 'ok',
        rollout: currentRolloutHealth(),
        records: 'ok',
        lastError: null
      }
    })
  }

  function refreshSession(sessionId) {
    return serialized(async () => {
      let records = await readRecords()
      const session = await source.querySession(sessionId)
      if (!isDismissedRun(session)) records = await accessRecords(() => recordStore.remember(sessionId))
      extraIds.add(sessionId)
      sessions.set(sessionId, session
        ? classify(session, records)
        : missingRecordedSession(sessionId, records.get(sessionId)))
      if (session && !disposed) options.onSessionObserved?.(session)
      health = {
        ...health,
        index: 'ok',
        rollout: currentRolloutHealth(),
        records: 'ok',
        lastError: null
      }
      generatedAt = now()
      lastScope = 'session'
    })
  }

  async function drain() {
    if (running || disposed) return
    running = true
    beginIdleCycle()
    try {
      while (!disposed && (pendingDefault || pendingIds.size > 0)) {
        if (pendingDefault) {
          pendingDefault = false
          activeScope = 'default'
          try {
            await refreshDefault()
          } catch (error) {
            const dimension = error?.healthSource === 'records' ? 'records' : 'index'
            health = { ...health, [dimension]: 'degraded', lastError: cleanError(error) }
            generatedAt = now()
          } finally {
            activeScope = null
          }
          continue
        }
        const sessionId = pendingIds.values().next().value
        pendingIds.delete(sessionId)
        activeScope = 'session'
        try {
          await refreshSession(sessionId)
        } catch (error) {
          const dimension = error?.healthSource === 'records' ? 'records' : 'index'
          health = { ...health, [dimension]: 'degraded', lastError: cleanError(error) }
          generatedAt = now()
        } finally {
          activeScope = null
        }
      }
    } finally {
      running = false
      endIdleCycle()
      if (!disposed && (pendingDefault || pendingIds.size > 0)) void drain()
    }
  }

  function requestDefault() {
    if (disposed) return false
    if (running && activeScope === 'default') return true
    pendingDefault = true
    beginIdleCycle()
    void drain()
    return true
  }

  function requestSession(sessionId) {
    if (disposed) return false
    pendingIds.add(sessionId)
    beginIdleCycle()
    void drain()
    return true
  }

  function snapshot() {
    const sources = source.health?.()
    const failures = Object.values(sources || {}).filter((item) => item.status === 'degraded')
    return {
      sessions: [...sessions.values()]
        .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')))
        .map(publicSession),
      generatedAt,
      refreshing: running || pendingDefault || pendingIds.size > 0,
      lastScope,
      window: { days: options.days === null ? null : options.days || 7, limit: options.limit || 100 },
      ...(sources ? { sources } : {}),
      health: failures.length
        ? { ...health, index: 'degraded', lastError: health.lastError || failures.flatMap((item) => item.errors || []).join('；') }
        : health
    }
  }

  function dismissRunning(sessionId, observedAt) {
    return serialized(async () => {
      const latest = await source.querySession(sessionId)
      if (!latest || latest.status !== 'running' || latest.observedAt !== observedAt) {
        throw Object.assign(new Error('会话状态或轮次已变化，请刷新后重试'), { status: 409 })
      }
      dismissedRuns = await accessRecords(() => recordStore.dismissRunning(sessionId, observedAt))
      const view = classify(latest, new Map())
      sessions.set(sessionId, view)
      extraIds.add(sessionId)
      generatedAt = now()
      health = { ...health, records: 'ok', rollout: currentRolloutHealth(), lastError: null }
      return publicSession(view)
    })
  }

  function reviewCompleted(sessionId) {
    return serialized(async () => {
      const current = sessions.get(sessionId)
      if (!current) throw Object.assign(new Error('会话不存在'), { status: 404 })
      if (current.status !== 'turn_completed' && current.reviewable !== true) {
        throw Object.assign(new Error('仅待审核会话或未知运行记录可以审核完成'), { status: 400 })
      }
      const fresh = await source.querySession(sessionId)
      if (fresh?.status === 'running') {
        sessions.set(sessionId, { ...fresh, recordedAt: current.recordedAt })
        generatedAt = now()
        throw Object.assign(new Error('会话已开始新轮次，请刷新后重试'), { status: 409 })
      }
      try {
        await accessRecords(() => recordStore.remove(sessionId))
      } catch (error) {
        health = { ...health, records: 'degraded', lastError: cleanError(error) }
        generatedAt = now()
        throw error
      }
      const latest = sessions.get(sessionId)
      if (latest?.recordOnly) {
        sessions.delete(sessionId)
        extraIds.delete(sessionId)
      } else if (latest?.rawStatus === 'turn_completed' || latest?.rawStatus === 'unknown') {
        sessions.set(sessionId, classify(latest, new Map()))
      }
      health = { ...health, rollout: currentRolloutHealth(), records: 'ok', lastError: null }
      generatedAt = now()
      return sessions.has(sessionId) ? publicSession(sessions.get(sessionId)) : null
    })
  }

  function reviewAllCompleted(sessionIds) {
    return serialized(async () => {
      const reviewedIds = []
      const skippedIds = []
      const failures = []
      const candidates = []
      const latestSessions = new Map()
      for (const sessionId of new Set(sessionIds)) {
        const current = sessions.get(sessionId)
        if (!current || (current.status !== 'turn_completed' && current.reviewable !== true)) {
          skippedIds.push(sessionId)
        } else {
          candidates.push(sessionId)
        }
      }

      // Re-read each selected session: a new turn may have started since the
      // browser displayed the review lane. Never approve that running turn.
      for (let offset = 0; offset < candidates.length; offset += 4) {
        await Promise.all(candidates.slice(offset, offset + 4).map(async (sessionId) => {
          try {
            const latest = await source.querySession(sessionId)
            if (latest?.status === 'running') {
              skippedIds.push(sessionId)
              const current = sessions.get(sessionId)
              sessions.set(sessionId, { ...latest, recordedAt: current.recordedAt })
              return
            }
            latestSessions.set(sessionId, latest)
            reviewedIds.push(sessionId)
          } catch (error) {
            failures.push({ sessionId, error: cleanError(error) })
          }
        }))
      }

      if (reviewedIds.length > 0) {
        try {
          await accessRecords(() => recordStore.removeMany(reviewedIds))
        } catch (error) {
          health = { ...health, records: 'degraded', lastError: cleanError(error) }
          generatedAt = now()
          throw error
        }
        for (const sessionId of reviewedIds) {
          const latest = latestSessions.get(sessionId)
          if (latest) {
            sessions.set(sessionId, classify(latest, new Map()))
          } else {
            sessions.delete(sessionId)
            extraIds.delete(sessionId)
          }
        }
      }
      generatedAt = now()
      health = { ...health, rollout: currentRolloutHealth(), records: 'ok', lastError: null }
      return { reviewedCount: reviewedIds.length, reviewedIds, skippedIds, failures }
    })
  }

  return {
    requestDefault,
    requestSession,
    reviewCompleted,
    reviewAllCompleted,
    dismissRunning,
    snapshot,
    waitForIdle: () => idlePromise,
    close: () => {
      disposed = true
      pendingDefault = false
      pendingIds.clear()
      return operationQueue.finally(endIdleCycle)
    }
  }
}
