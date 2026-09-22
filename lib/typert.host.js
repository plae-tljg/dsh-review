/* Hand-maintained Typert artifact: keep it in step with `src/host/review.js`.
 * The Gateway serves `workspaceReview` from the invocations below, so this file
 * is the Host half's wire declaration; the checkout's typert generator would
 * emit the same descriptors from a TypeScript source. Regenerate rather than
 * hand-edit whenever the Host methods change. */

import { z } from 'zod'

const statusSchema = z.enum([
  'added', 'modified', 'deleted', 'renamed', 'copied', 'typechange', 'untracked', 'conflicted',
])

const fileSchema = z.object({
  'path': z.string().readonly(),
  'status': statusSchema.readonly(),
  'index': z.string().readonly(),
  'worktree': z.string().readonly(),
  'staged': z.boolean().readonly(),
  'unstaged': z.boolean().readonly(),
  'untracked': z.boolean().readonly(),
  'renamedFrom': z.string().readonly().nullable(),
  'added': z.number().readonly().nullable(),
  'removed': z.number().readonly().nullable(),
})

const treeNodeSchema = z.lazy(() => z.object({
  'kind': z.literal('directory').readonly(),
  'name': z.string().readonly(),
  'path': z.string().readonly(),
  'directories': z.array(treeNodeSchema).readonly(),
  'files': z.array(fileSchema).readonly(),
  'added': z.number().readonly(),
  'removed': z.number().readonly(),
}))

const reportSchema = z.object({
  'isRepository': z.boolean().readonly(),
  'root': z.string().readonly().nullable(),
  'branch': z.string().readonly().nullable(),
  'detached': z.boolean().readonly(),
  'upstream': z.string().readonly().nullable(),
  'ahead': z.number().readonly(),
  'behind': z.number().readonly(),
  'files': z.array(fileSchema).readonly(),
  'tree': z.object({
    'directories': z.array(treeNodeSchema).readonly(),
    'files': z.array(fileSchema).readonly(),
  }).readonly(),
  'added': z.number().readonly(),
  'removed': z.number().readonly(),
  'truncated': z.boolean().readonly(),
})

const lineSchema = z.object({
  'kind': z.enum(['add', 'del', 'ctx']).readonly(),
  'text': z.string().readonly(),
  'oldNumber': z.number().readonly().nullable(),
  'newNumber': z.number().readonly().nullable(),
})

const hunkSchema = z.object({
  'header': z.string().readonly(),
  'oldStart': z.number().readonly(),
  'newStart': z.number().readonly(),
  'oldCount': z.number().readonly(),
  'newCount': z.number().readonly(),
  'lines': z.array(lineSchema).readonly(),
})

const diffSchema = z.object({
  'isRepository': z.boolean().readonly(),
  'untracked': z.boolean().readonly(),
  'truncated': z.boolean().readonly(),
  'file': z.object({
    'path': z.string().readonly(),
    'oldPath': z.string().readonly().nullable(),
    'binary': z.boolean().readonly(),
    'notice': z.string().readonly().nullable(),
    'hunks': z.array(hunkSchema).readonly(),
  }).readonly().nullable(),
  'patch': z.string().readonly(),
})

const commitSchema = z.object({
  'oid': z.string().readonly(),
  'short': z.string().readonly(),
  'timestamp': z.number().readonly(),
  'author': z.string().readonly(),
  'subject': z.string().readonly(),
})

const commitsSchema = z.object({
  'isRepository': z.boolean().readonly(),
  'root': z.string().readonly().nullable(),
  'commits': z.array(commitSchema).readonly(),
})

const commitReportSchema = z.object({
  'isRepository': z.boolean().readonly(),
  'root': z.string().readonly().nullable(),
  'oid': z.string().readonly(),
  'files': z.array(fileSchema).readonly(),
  'tree': z.object({
    'directories': z.array(treeNodeSchema).readonly(),
    'files': z.array(fileSchema).readonly(),
  }).readonly(),
  'added': z.number().readonly(),
  'removed': z.number().readonly(),
})

/** A JSON string parameter (a commit id or a path). */
function stringParameter(name, typeSymbol) {
  return {
    name,
    wire: name,
    source: 'json',
    codec: { mode: 'strict', typeSymbol, schema: z.string() },
  }
}

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

/** The Host-face manifest the typert loader registers for this package. */
export const TYPERT = {
  package: 'dsh-review',
  face: 'host',
  schemas: [],
  invocations: [
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
        schema: reportSchema,
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
        schema: diffSchema,
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
        schema: commitsSchema,
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
        stringParameter('oid', 'dsh-review/host/types#CommitId'),
      ],
      cancellation: { parameter: 'signal' },
      result: {
        mode: 'strict',
        typeSymbol: 'dsh-review/host/types#ReviewCommit',
        schema: commitReportSchema,
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
        stringParameter('oid', 'dsh-review/host/types#CommitId'),
        stringParameter('path', 'dsh-review/host/types#ReviewPath'),
      ],
      cancellation: { parameter: 'signal' },
      result: {
        mode: 'strict',
        typeSymbol: 'dsh-review/host/types#ReviewDiff',
        schema: diffSchema,
      },
    },
  ],
  model: {
    services: [
      {
        description: "Host Remote service reading one session workspace's uncommitted changes over the git CLI.",
        summary: 'Read-only workspace review: uncommitted status, line counts, and unified diffs.',
        tags: [],
        jsDoc: "/** Host Remote service reading one session workspace's uncommitted changes over the git CLI. */",
        key: 'workspaceReview',
        exportName: 'WorkspaceReview',
        members: [
          {
            kind: 'method',
            name: 'changes',
            signature: '@Remote async changes(agent: object, signal: AbortSignal): Promise<ReviewReport>',
            summary: "The branch summary and every uncommitted file of the session's workspace.",
            jsDoc: "/** The branch summary and every uncommitted file of the session's workspace. */",
          },
          {
            kind: 'method',
            name: 'diff',
            signature: '@Remote async diff(agent: object, path: string, signal: AbortSignal): Promise<ReviewDiff>',
            summary: 'The unified diff of one changed path, parsed into hunks.',
            jsDoc: '/** The unified diff of one changed path, parsed into hunks. */',
          },
          {
            kind: 'method',
            name: 'commits',
            signature: '@Remote async commits(agent: object, signal: AbortSignal): Promise<ReviewCommits>',
            summary: 'The recent commits of the session workspace, newest first.',
            jsDoc: '/** The recent commits of the session workspace, newest first. */',
          },
          {
            kind: 'method',
            name: 'commitChanges',
            signature: '@Remote async commitChanges(agent: object, oid: string, signal: AbortSignal): Promise<ReviewCommit>',
            summary: "One commit's changed files, with counts and a directory tree.",
            jsDoc: "/** One commit's changed files, with counts and a directory tree. */",
          },
          {
            kind: 'method',
            name: 'commitDiff',
            signature: '@Remote async commitDiff(agent: object, oid: string, path: string, signal: AbortSignal): Promise<ReviewDiff>',
            summary: 'The unified diff of one path within one commit, parsed into hunks.',
            jsDoc: '/** The unified diff of one path within one commit, parsed into hunks. */',
          },
        ],
        types: [
          {
            name: 'ReviewFileStatus',
            declaration: "export type ReviewFileStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'typechange' | 'untracked' | 'conflicted';",
          },
          {
            name: 'ReviewFile',
            declaration: 'export interface ReviewFile { readonly path: string; readonly status: ReviewFileStatus; readonly index: string; readonly worktree: string; readonly staged: boolean; readonly unstaged: boolean; readonly untracked: boolean; readonly renamedFrom: string | null; readonly added: number | null; readonly removed: number | null; }',
          },
          {
            name: 'ReviewReport',
            declaration: 'export interface ReviewReport { readonly isRepository: boolean; readonly root: string | null; readonly branch: string | null; readonly detached: boolean; readonly upstream: string | null; readonly ahead: number; readonly behind: number; readonly files: readonly ReviewFile[]; readonly added: number; readonly removed: number; readonly truncated: boolean; }',
          },
          {
            name: 'ReviewLine',
            declaration: "export interface ReviewLine { readonly kind: 'add' | 'del' | 'ctx'; readonly text: string; readonly oldNumber: number | null; readonly newNumber: number | null; }",
          },
          {
            name: 'ReviewHunk',
            declaration: 'export interface ReviewHunk { readonly header: string; readonly oldStart: number; readonly newStart: number; readonly oldCount: number; readonly newCount: number; readonly lines: readonly ReviewLine[]; }',
          },
          {
            name: 'ReviewFileDiff',
            declaration: 'export interface ReviewFileDiff { readonly path: string; readonly oldPath: string | null; readonly binary: boolean; readonly notice: string | null; readonly hunks: readonly ReviewHunk[]; }',
          },
          {
            name: 'ReviewDiff',
            declaration: 'export interface ReviewDiff { readonly isRepository: boolean; readonly untracked: boolean; readonly truncated: boolean; readonly file: ReviewFileDiff | null; readonly patch: string; }',
          },
          {
            name: 'CommitId',
            declaration: 'export type CommitId = string;',
          },
          {
            name: 'ReviewCommitMeta',
            declaration: 'export interface ReviewCommitMeta { readonly oid: string; readonly short: string; readonly timestamp: number; readonly author: string; readonly subject: string; }',
          },
          {
            name: 'ReviewCommits',
            declaration: 'export interface ReviewCommits { readonly isRepository: boolean; readonly root: string | null; readonly commits: readonly ReviewCommitMeta[]; }',
          },
          {
            name: 'ReviewCommit',
            declaration: 'export interface ReviewCommit { readonly isRepository: boolean; readonly root: string | null; readonly oid: string; readonly files: readonly ReviewFile[]; readonly added: number; readonly removed: number; }',
          },
        ],
      },
    ],
    events: [],
    objects: [],
  },
}

export default TYPERT
