/**
 * The Review tab's asynchronous half: reading the report and the diffs.
 *
 * The component never awaits anything. It calls `start`, `refresh`, and
 * `select`, and this face performs the Remote reads and writes the outcome
 * through the store's own actions — the Slot-standard `inject` shape, so the
 * session id is resolved by the framework and the write set stays the store's.
 *
 * One read is in force per purpose: asking again retires the read still in
 * flight, whose settlement then writes nothing. A `RemoteResult` never
 * rejects — the failure is the error branch of the settled value.
 *
 * Every read also carries a deadline. A Remote call that never settles — a
 * namespace that did not mount, a carrier that lost its stream — would
 * otherwise leave the tab saying "Reading…" forever, which reads as a slow read
 * rather than as the failure it is. The deadline turns that into a stated
 * error, and the reader can retry.
 */

/** How long one read may take before the tab says so. */
const READ_TIMEOUT_MS = 20_000

/**
 * Coerce a caller-supplied diff context onto a number.
 *
 * The wire codec rejects a non-number, and a call site that forgets the
 * argument would otherwise pass the AbortSignal into its place; defaulting here
 * makes such a slip degrade to the standard context instead of failing the read.
 * @param {unknown} context - The caller's value.
 * @returns {number} A finite line count, or 3.
 */
function contextSize(context) {
  return typeof context === 'number' && Number.isFinite(context) ? context : 3
}

/**
 * Settle a read against a deadline, folding every rejection into the failure
 * branch the caller already handles.
 * @param {Promise<object>} call - The Remote call.
 * @param {number} timeoutMs - How long to wait.
 * @returns {Promise<{ ok: true, value: any } | { ok: false, error: { code: string, message: string } }>} The settled outcome.
 */
function withDeadline(call, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve({ ok: false, error: { code: 'client/timeout', message: `read exceeded ${String(timeoutMs)}ms` } })
    }, timeoutMs)
    const settle = (outcome) => { clearTimeout(timer); resolve(outcome) }
    call.then(settle, (error) => {
      settle({ ok: false, error: { code: 'client/failed', message: error instanceof Error ? error.message : String(error) } })
    })
  })
}

/**
 * Bind the tab's reads to one Remote face.
 * @param {object} remote - The client Remote face carrying `workspaceReview`.
 * @param {Function} [getConversation] - Reads the live `uiConversation` service, or undefined.
 * @returns {Function} The Slot `inject` factory: session and bound actions in, face out.
 */
export function reviewFace(remote, getConversation) {
  // Checked here, where the face is built, so a namespace that never mounted
  // fails at registration instead of leaving the first read pending forever.
  if (typeof remote?.workspaceReview?.changes !== 'function') {
    throw new Error('dsh-review: remote.workspaceReview is not mounted')
  }
  /** The conversation snapshot source per session, resolved once it exists. */
  const sources = new Map()
  const conversationFor = (sessionId) => {
    const cached = sources.get(sessionId)
    if (cached !== undefined) return cached
    let source
    try {
      const uiConversation = getConversation?.()
      source = uiConversation?.binding?.(sessionId)?.snapshot
    } catch {
      source = undefined
    }
    // A binding may not exist on the first render (a fresh or archived
    // session); resolve it on a later call rather than caching the absence.
    if (source !== undefined) sources.set(sessionId, source)
    return source
  }
  return (sessionId, actions) => {
    /** Per tab, the generation a settlement must match; the latest request wins. */
    const generations = new Map()
    /** Per tab and path, the same guard for one diff body. */
    const diffGenerations = new Map()

    /**
     * Claim the next generation for one key, retiring whatever was in flight.
     * @param {Map<string, number>} table - The generation table for this purpose.
     * @param {string} key - Tab id, or `tabId` plus path.
     * @returns {number} The generation this read must still hold to write.
     */
    const claim = (table, key) => {
      const generation = (table.get(key) ?? 0) + 1
      table.set(key, generation)
      return generation
    }

    /**
     * Read the report and write it into the store.
     * @param {string} tabId - The tab being drawn.
     * @param {AbortSignal} signal - The tab record's lifetime.
     */
    const load = (tabId, signal) => {
      if (signal.aborted) return
      const generation = claim(generations, tabId)
      actions.loading(tabId)
      void withDeadline(remote.workspaceReview.changes(sessionId, signal), READ_TIMEOUT_MS).then((result) => {
        // A newer read of this tab was asked for since, or the record is gone
        // and its bookkeeping with it: nothing left for this one to write.
        if (generations.get(tabId) !== generation) return
        if (result.ok) actions.loaded(tabId, result.value)
        else actions.failed(tabId, result.error.code, result.error.message)
      })
    }

    /**
     * Read one path's diff body unless it is already held.
     * @param {string} tabId - The tab being drawn.
     * @param {string} path - The path to read.
     * @param {AbortSignal} signal - The tab record's lifetime.
     */
    const loadDiff = (tabId, path, context, signal) => {
      if (signal.aborted) return
      const key = `${tabId}\u0000${path}`
      const generation = claim(diffGenerations, key)
      actions.diffLoading(tabId, path)
      void withDeadline(remote.workspaceReview.diff(sessionId, path, contextSize(context), signal), READ_TIMEOUT_MS).then((result) => {
        if (diffGenerations.get(key) !== generation) return
        if (result.ok) actions.diffLoaded(tabId, path, result.value)
        else actions.diffFailed(tabId, path, result.error.code, result.error.message)
      })
    }

    /**
     * Read the recent commit list.
     * @param {string} tabId - The tab being drawn.
     * @param {AbortSignal} signal - The tab record's lifetime.
     */
    const loadCommits = (tabId, signal) => {
      if (signal.aborted) return
      const key = `commits\u0000${tabId}`
      const generation = claim(generations, key)
      actions.commitsLoading(tabId)
      void withDeadline(remote.workspaceReview.commits(sessionId, signal), READ_TIMEOUT_MS).then((result) => {
        if (generations.get(key) !== generation) return
        if (result.ok) actions.commitsLoaded(tabId, result.value)
        else actions.commitsFailed(tabId, result.error.code, result.error.message)
      })
    }

    /**
     * Read one commit's changed files.
     * @param {string} tabId - The tab being drawn.
     * @param {string} oid - The commit to read.
     * @param {AbortSignal} signal - The tab record's lifetime.
     */
    const loadCommit = (tabId, oid, signal) => {
      if (signal.aborted) return
      const key = `commitFiles\u0000${tabId}\u0000${oid}`
      const generation = claim(generations, key)
      actions.commitLoading(tabId, oid)
      void withDeadline(remote.workspaceReview.commitChanges(sessionId, oid, signal), READ_TIMEOUT_MS).then((result) => {
        if (generations.get(key) !== generation) return
        if (result.ok) actions.commitLoaded(tabId, oid, result.value)
        else actions.commitFailed(tabId, oid, result.error.code, result.error.message)
      })
    }

    /**
     * Read one path's diff within one commit.
     * @param {string} tabId - The tab being drawn.
     * @param {string} oid - The commit.
     * @param {string} path - The path to read.
     * @param {AbortSignal} signal - The tab record's lifetime.
     */
    const loadCommitDiff = (tabId, oid, path, context, signal) => {
      if (signal.aborted) return
      const key = `commitDiff\u0000${tabId}\u0000${oid}\u0000${path}`
      const generation = claim(diffGenerations, key)
      actions.commitDiffLoading(tabId, oid, path)
      void withDeadline(remote.workspaceReview.commitDiff(sessionId, oid, path, contextSize(context), signal), READ_TIMEOUT_MS).then((result) => {
        if (diffGenerations.get(key) !== generation) return
        if (result.ok) actions.commitDiffLoaded(tabId, oid, path, result.value)
        else actions.commitDiffFailed(tabId, oid, path, result.error.code, result.error.message)
      })
    }

    /**
     * Read the workspace file tree (Files view).
     * @param {string} tabId - The tab being drawn.
     * @param {AbortSignal} signal - The tab record's lifetime.
     */
    const loadFiles = (tabId, signal) => {
      if (signal.aborted) return
      const key = `files\u0000${tabId}`
      const generation = claim(generations, key)
      actions.filesLoading(tabId)
      void withDeadline(remote.workspaceReview.listFiles(sessionId, signal), READ_TIMEOUT_MS).then((result) => {
        if (generations.get(key) !== generation) return
        if (result.ok) actions.filesLoaded(tabId, result.value)
        else actions.filesFailed(tabId, result.error.code, result.error.message)
      })
    }

    /**
     * Read one workspace file's content (Files view).
     * @param {string} tabId - The tab being drawn.
     * @param {string} path - The file to read.
     * @param {AbortSignal} signal - The tab record's lifetime.
     */
    const loadFileContent = (tabId, path, signal) => {
      if (signal.aborted) return
      const key = `file\u0000${tabId}\u0000${path}`
      const generation = claim(diffGenerations, key)
      actions.fileLoading(tabId, path)
      void withDeadline(remote.workspaceReview.readFile(sessionId, path, signal), READ_TIMEOUT_MS).then((result) => {
        if (diffGenerations.get(key) !== generation) return
        if (result.ok) actions.fileLoaded(tabId, path, result.value)
        else actions.fileReadFailed(tabId, path, result.error.code, result.error.message)
      })
    }

    /**
     * Write one workspace file's content (Files view editor).
     * @param {string} tabId - The tab being drawn.
     * @param {string} path - The file to write.
     * @param {string} text - The new content.
     * @param {AbortSignal} signal - The tab record's lifetime.
     * @returns {Promise<void>} Resolves once the store has the outcome.
     */
    const saveFile = (tabId, path, text, signal) => {
      if (signal.aborted) return Promise.resolve()
      actions.fileSaving(tabId)
      return withDeadline(remote.workspaceReview.writeFile(sessionId, path, text, signal), READ_TIMEOUT_MS).then((result) => {
        if (result.ok) actions.fileSaved(tabId, path, text)
        else actions.fileSaveFailed(tabId, result.error.code, result.error.message)
      })
    }

    return {
      /** The session identity, for building a workspace file address. */
      sessionId,
      /** The session's conversation snapshot source, for the Rounds view. */
      conversation: conversationFor(sessionId),
      start(tabId, signal) {
        actions.start(tabId)
        signal.addEventListener('abort', () => {
          generations.delete(tabId)
          diffGenerations.forEach((_, key) => {
            if (key.startsWith(`${tabId}\u0000`)) diffGenerations.delete(key)
          })
          actions.forget(tabId)
        }, { once: true })
        load(tabId, signal)
      },
      refresh(tabId, signal) {
        load(tabId, signal)
      },
      select(tabId, path, held, context, signal) {
        actions.select(tabId, path)
        if (!held) loadDiff(tabId, path, context, signal)
      },
      open(tabId, path, context, signal) {
        loadDiff(tabId, path, context, signal)
      },
      listCommits(tabId, signal) {
        loadCommits(tabId, signal)
      },
      openCommit(tabId, oid, signal) {
        loadCommit(tabId, oid, signal)
      },
      openCommitDiff(tabId, oid, path, context, signal) {
        loadCommitDiff(tabId, oid, path, context, signal)
      },
      listFiles(tabId, signal) {
        loadFiles(tabId, signal)
      },
      openFileContent(tabId, path, signal) {
        loadFileContent(tabId, path, signal)
      },
      saveFile(tabId, path, text, signal) {
        return saveFile(tabId, path, text, signal)
      },
    }
  }
}
