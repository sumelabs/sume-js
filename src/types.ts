export enum JobStatus {
  QUEUED = 'queued',
  IN_PROGRESS = 'in_progress',
  COMPLETED = 'completed',
  FAILED = 'failed',
  NSFW = 'nsfw',
  CANCELED = 'canceled',
}

export interface Artifact {
  id: string;
  type: 'image' | 'video' | 'audio' | (string & {});
  url: string;
  content_type?: string | null;
  public_artifact_id?: string | null;
  visibility?: string;
  size_bytes?: number | null;
  width?: number | null;
  height?: number | null;
  duration_ms?: number | null;
  checksum_sha256?: string | null;
}

export interface JobError {
  code: string;
  message: string;
  category?: string;
  stage?: string;
  retryable?: boolean;
  retry_after_seconds?: number | null;
  public_reason?: string;
  next_action?: string;
  details?: Record<string, unknown>;
}

export interface WebhookPayload {
  url: string;
}

export interface UploadResponse {
  public_url: string;
  upload_url: string;
  upload_method: string;
  upload_headers: Record<string, string>;
  content_type: string;
  expires_at: string;
  asset_id: string;
}

export type WebhookEventType = 'job.completed' | 'job.failed' | 'job.canceled';

export interface WebhookEvent {
  event: WebhookEventType;
  request_id: string;
  job_id: string;
  status: 'OK' | 'ERROR';
  payload?: {
    artifacts: Artifact[];
  };
  error?: JobError;
}
