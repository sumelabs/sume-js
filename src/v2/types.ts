import { Artifact, JobError } from '../types';

export interface ImageGenerateInput {
  model: string;
  prompt: string;
  image_urls?: string[];
  aspect_ratio?: string;
  image_size?: string | { width: number; height: number };
  quality?: string;
  resolution?: string;
  num_images?: number;
  output_format?: 'png' | 'jpeg' | 'webp';
  mask_url?: string;
  metadata?: Record<string, unknown>;
  [field: string]: unknown;
}

export interface VideoGenerateInput {
  model: string;
  prompt?: string;
  duration?: number;
  resolution?: string;
  aspect_ratio?: string;
  image_url?: string;
  end_image_url?: string;
  video_url?: string;
  audio_url?: string;
  reference_image_urls?: string[];
  reference_video_urls?: string[];
  reference_audio_urls?: string[];
  generate_audio?: boolean;
  metadata?: Record<string, unknown>;
  [field: string]: unknown;
}

export interface EndpointInputMap {
  '/v1/image-router/generate': ImageGenerateInput;
  '/v1/video-router/generate': VideoGenerateInput;
}

export type EndpointInput<TEndpoint extends keyof EndpointInputMap> = EndpointInputMap[TEndpoint];

export type V2RequestStatus = 'queued' | 'in_progress' | 'completed' | 'failed' | 'canceled';

export interface V2Image {
  url: string;
}

export interface V2Video {
  url: string;
}

export interface V2Response {
  status: V2RequestStatus;
  request_id: string;
  status_url: string;
  cancel_url: string | null;
  result_url: string;
  images?: V2Image[];
  video?: V2Video;
  artifacts?: Artifact[];
  error?: JobError | null;
}
