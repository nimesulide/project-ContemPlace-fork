// ── Dashboard API Worker Env ────────────────────────────────────────────────

export interface CaptureServiceStub {
  capture(rawInput: string, source: string, options?: { imageUrl?: string; userId?: string }): Promise<ServiceCaptureResult>;
}

export interface ServiceCaptureResult {
  id: string;
  title: string;
  body: string;
  tags: string[];
  source_ref: string | null;
  corrections: string[] | null;
  entities: Array<{ name: string; type: string }>;
  links: Array<{ to_id: string; to_title: string; link_type: string }>;
  source: string;
  image_url: string | null;
}

export interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  SUPABASE_JWT_SECRET: string;
  DASHBOARD_API_KEY: string;
  CORS_ORIGIN: string;
  BACKUP_REPO: string;
  MCP_ENDPOINT: string;
  TELEGRAM_BOT_USERNAME: string;
  GITHUB_BACKUP_PAT?: string;
  CAPTURE_SERVICE?: CaptureServiceStub;
}

// ── API response types ──────────────────────────────────────────────────────

export interface StatsResponse {
  total_notes: number;
  total_links: number;
  total_clusters: number;
  unclustered_count: number;
  image_count: number;
  capture_rate_7d: number;
  oldest_note: string | null;
  newest_note: string | null;
  orphan_count: number;
  avg_links_per_note: number;
  gardener_last_run: string | null;
  backup_last_commit: string | null;
}

export interface ClusterCard {
  label: string;
  top_tags: string[];
  note_count: number;
  gravity: number;
  note_ids: string[];
  hub_notes: Array<{ id: string; title: string; link_count: number }>;
}

export interface ClustersResponse {
  resolution: number;
  available_resolutions: number[];
  clusters: ClusterCard[];
}

export interface ClusterDetailNote {
  id: string;
  title: string;
  tags: string[];
  image_url: string | null;
  created_at: string;
}

export interface ClusterDetailLink {
  from_id: string;
  to_id: string;
  link_type: string;
  confidence: number | null;
  created_by: string;
}

export interface ClusterDetailResponse {
  notes: ClusterDetailNote[];
  links: ClusterDetailLink[];
}

export interface RecentNote {
  id: string;
  title: string;
  tags: string[];
  source: string;
  image_url: string | null;
  created_at: string;
}

export interface ProfileResponse {
  user_id: string;
  display_name: string | null;
  email: string | null;
  plan: string;
  has_api_key: boolean;
  mcp_endpoint: string;
  telegram_connected: boolean;
  telegram_chat_id: number | null;
  created_at: string;
}

export interface Config {
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  supabaseJwtSecret: string;
  dashboardApiKey: string;
  corsOrigin: string;
  backupRepo: string;
  mcpEndpoint: string;
  telegramBotUsername: string;
  githubBackupPat: string | null;
}
