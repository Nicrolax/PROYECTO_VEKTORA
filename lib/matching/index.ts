/**
 * VEKTORA · FASE 4 — API pública del motor de matching híbrido.
 *
 *   import { createTaskMatcher } from '@/lib/matching';
 *
 *   const result = await createTaskMatcher().matchTask({ taskId, assign: true });
 *   result.shortlist[0]?.explanation.summary
 */

import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { TaskMatcher, type TaskMatcherOptions } from './matcher';
import { SupabaseMatchingRepository } from './repository';

export { MatchingError, TaskMatcher, renderTaskForMatching } from './matcher';
export type { MatchTaskInput, MatchTaskResult, TaskMatcherOptions } from './matcher';

export { MatchingRepositoryError, SupabaseMatchingRepository } from './repository';
export type {
  AcceptResult,
  ApplyMatchesResult,
  MatchingRepository,
  MatchTaskRecord,
} from './repository';

export {
  ENGINE_VERSION,
  rankCandidates,
  rescaleVectorSimilarity,
  scoreCandidate,
  scoreReputation,
  scoreSkills,
} from './scoring';
export type {
  CandidateSkill,
  MatchCandidate,
  MatchExplanation,
  MatchTaskContext,
  RankingResult,
  RejectedCandidate,
  ReputationBreakdown,
  ScoredCandidate,
  SkillBreakdown,
} from './scoring';

export {
  getMatchingConfig,
  loadMatchingConfig,
  MatchingConfigError,
  MatchingConfigSchema,
  resetMatchingConfigCache,
} from './config';
export type { MatchingConfig, MatchingEnv } from './config';

/** Motor listo para usar contra Supabase con `service_role`. */
export function createTaskMatcher(options: Partial<TaskMatcherOptions> = {}): TaskMatcher {
  const repository = options.repository ?? new SupabaseMatchingRepository(getSupabaseAdmin());
  return new TaskMatcher({
    repository,
    ...(options.embeddings === undefined ? {} : { embeddings: options.embeddings }),
    ...(options.config === undefined ? {} : { config: options.config }),
  });
}
