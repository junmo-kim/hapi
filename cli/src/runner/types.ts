/**
 * Runner-specific types (not related to API/server communication)
 */

import { Metadata } from '@/api/types';
import { ChildProcess } from 'child_process';

/**
 * Session tracking for runner
 */
export interface TrackedSession {
  startedBy: 'runner' | string;
  happySessionId?: string;
  happySessionMetadataFromLocalWebhook?: Metadata;
  pid: number;
  childProcess?: ChildProcess;
  /** Set when the session is hosted by the Session Worker process */
  workerManaged?: boolean;
  error?: string;
  directoryCreated?: boolean;
  message?: string;
}