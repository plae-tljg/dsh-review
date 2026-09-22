/**
 * The browser-side contribution for the `workspaceReview` Remote namespace:
 * the codecs that encode calls and decode results, and the declaration merges
 * that type `remote.workspaceReview` on the client Remote face.
 *
 * Hand-written to mirror `typert.host.js`: the typert generator would emit
 * this file from the Host face model, and the shapes here are the ones it
 * emits. The client gateway refuses a non-strict codec at mount, so every
 * parameter and every result carries `mode: 'strict'` with a `zod` schema.
 *
 * `zod` is this module's only runtime import; the contribution object is
 * plain data besides it.
 */

import { z } from 'zod'

/** The nine file states a `changes` row can carry. */
const status = z.enum([
  'added', 'modified', 'deleted', 'renamed', 'copied', 'typechange', 'untracked', 'conflicted',
])

const reviewFile = z.object({
  path: z.string(),
  status,
  index: z.string(),
  worktree: z.string(),
  staged: z.boolean(),
  unstaged: z.boolean(),
  untracked: z.boolean(),
  renamedFrom: z.string().nullable(),
  added: z.number().nullable(),
  removed: z.number().nullable(),
})

const treeNode = z.lazy(() => z.object({
  kind: z.literal('directory'),
  name: z.string(),
  path: z.string(),
  directories: z.array(treeNode),
  files: z.array(reviewFile),
  added: z.number(),
  removed: z.number(),
}))

const reviewReport = z.object({
  isRepository: z.boolean(),
  root: z.string().nullable(),
  branch: z.string().nullable(),
  detached: z.boolean(),
  upstream: z.string().nullable(),
  ahead: z.number(),
  behind: z.number(),
  files: z.array(reviewFile),
  tree: z.object({
    directories: z.array(treeNode),
    files: z.array(reviewFile),
  }),
  added: z.number(),
  removed: z.number(),
  truncated: z.boolean(),
})

const reviewDiff = z.object({
  isRepository: z.boolean(),
  untracked: z.boolean(),
  truncated: z.boolean(),
  file: z.object({
    path: z.string(),
    oldPath: z.string().nullable(),
    binary: z.boolean(),
    notice: z.string().nullable(),
    hunks: z.array(z.object({
      header: z.string(),
      oldStart: z.number(),
      newStart: z.number(),
      oldCount: z.number(),
      newCount: z.number(),
      lines: z.array(z.object({
        kind: z.enum(['add', 'del', 'ctx']),
        text: z.string(),
        oldNumber: z.number().nullable(),
        newNumber: z.number().nullable(),
      })),
    })),
  }).nullable(),
  patch: z.string(),
})

const commitMeta = z.object({
  oid: z.string(),
  short: z.string(),
  timestamp: z.number(),
  author: z.string(),
  subject: z.string(),
})

const reviewCommits = z.object({
  isRepository: z.boolean(),
  root: z.string().nullable(),
  commits: z.array(commitMeta),
})

const reviewCommit = z.object({
  isRepository: z.boolean(),
  root: z.string().nullable(),
  oid: z.string(),
  files: z.array(reviewFile),
  tree: z.object({
    directories: z.array(treeNode),
    files: z.array(reviewFile),
  }),
  added: z.number(),
  removed: z.number(),
})

/**
 * The error-code and namespace merges that type this contribution live in
 * `types/augment.d.ts`: this package is authored in plain JavaScript, and a
 * `declare module` block is not JavaScript syntax.
 */

/** The Session-identity lookup parameter both methods lead with. */
const agentParameter = {
  name: 'agent',
  wire: 'agentId',
  source: 'lookup',
  lookup: 'agent',
  codec: {
    mode: 'strict',
    typeSymbol: '@deepseek-ai/dsh-session/types#SessionId',
    schema: z.intersection(z.string(), z.unknown()),
  },
}

/** The contribution the client assembly mounts to provide `remote.workspaceReview`. */
export const TYPERT_REMOTE = {
  package: 'dsh-review',
  descriptors: [
    {
      id: 'dsh-review#workspaceReview/changes',
      service: 'workspaceReview',
      namespace: 'workspaceReview',
      method: 'changes',
      invocation: { kind: 'direct' },
      scope: { context: 'agent', wire: 'agentId' },
      parameters: [agentParameter],
      cancellation: { parameter: 'signal' },
      result: {
        mode: 'strict',
        typeSymbol: 'dsh-review/host/types#ReviewReport',
        schema: reviewReport,
      },
    },
    {
      id: 'dsh-review#workspaceReview/diff',
      service: 'workspaceReview',
      namespace: 'workspaceReview',
      method: 'diff',
      invocation: { kind: 'direct' },
      scope: { context: 'agent', wire: 'agentId' },
      parameters: [
        agentParameter,
        {
          name: 'path',
          wire: 'path',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: 'dsh-review/host/types#ReviewPath',
            schema: z.string(),
          },
        },
      ],
      cancellation: { parameter: 'signal' },
      result: {
        mode: 'strict',
        typeSymbol: 'dsh-review/host/types#ReviewDiff',
        schema: reviewDiff,
      },
    },
    {
      id: 'dsh-review#workspaceReview/commits',
      service: 'workspaceReview',
      namespace: 'workspaceReview',
      method: 'commits',
      invocation: { kind: 'direct' },
      scope: { context: 'agent', wire: 'agentId' },
      parameters: [agentParameter],
      cancellation: { parameter: 'signal' },
      result: {
        mode: 'strict',
        typeSymbol: 'dsh-review/host/types#ReviewCommits',
        schema: reviewCommits,
      },
    },
    {
      id: 'dsh-review#workspaceReview/commitChanges',
      service: 'workspaceReview',
      namespace: 'workspaceReview',
      method: 'commitChanges',
      invocation: { kind: 'direct' },
      scope: { context: 'agent', wire: 'agentId' },
      parameters: [
        agentParameter,
        {
          name: 'oid',
          wire: 'oid',
          source: 'json',
          codec: { mode: 'strict', typeSymbol: 'dsh-review/host/types#CommitId', schema: z.string() },
        },
      ],
      cancellation: { parameter: 'signal' },
      result: {
        mode: 'strict',
        typeSymbol: 'dsh-review/host/types#ReviewCommit',
        schema: reviewCommit,
      },
    },
    {
      id: 'dsh-review#workspaceReview/commitDiff',
      service: 'workspaceReview',
      namespace: 'workspaceReview',
      method: 'commitDiff',
      invocation: { kind: 'direct' },
      scope: { context: 'agent', wire: 'agentId' },
      parameters: [
        agentParameter,
        {
          name: 'oid',
          wire: 'oid',
          source: 'json',
          codec: { mode: 'strict', typeSymbol: 'dsh-review/host/types#CommitId', schema: z.string() },
        },
        {
          name: 'path',
          wire: 'path',
          source: 'json',
          codec: { mode: 'strict', typeSymbol: 'dsh-review/host/types#ReviewPath', schema: z.string() },
        },
      ],
      cancellation: { parameter: 'signal' },
      result: {
        mode: 'strict',
        typeSymbol: 'dsh-review/host/types#ReviewDiff',
        schema: reviewDiff,
      },
    },
  ],
}

export default TYPERT_REMOTE
