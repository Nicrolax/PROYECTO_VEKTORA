/**
 * VEKTORA — API pública de la capa de datos.
 *
 *   import { getSupabaseAdmin, toNumber } from '@/lib/supabase';
 */

export {
  createSupabaseAdmin,
  getSupabaseAdmin,
  isSupabaseAdminConfigured,
  resetSupabaseAdmin,
  resolveAdminCredentials,
  supabaseAdmin,
  SupabaseAdminError,
} from './admin';
export type { SupabaseAdminOptions } from './admin';

export { toNumber } from './types';
export type {
  AccountStatus,
  ActorType,
  AiRunRow,
  ApplicationStatus,
  ApplyProjectPlanResult,
  AuditLogRow,
  DeliverableRow,
  DependencyType,
  PgNumeric,
  PgVector,
  ProfileRow,
  ProjectDagResult,
  ProjectRow,
  ProjectStatus,
  ProjectTaskRow,
  ProjectVisibility,
  ProviderProfileRow,
  ProviderSkillRow,
  QaStatus,
  ReputationEventRow,
  ReputationEventType,
  ReviewRow,
  ReviewSource,
  SkillRow,
  TaskApplicationRow,
  TaskDependencyRow,
  TaskStatus,
  UserRole,
  UserRow,
} from './types';
