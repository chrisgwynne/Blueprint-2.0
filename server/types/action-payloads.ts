// ─── Task action types and their payload shapes ───────────────────────────────
// Source of truth: server/tasks/executor.js switch (task.action_type)

export type ActionType =
  | 'github_issue'
  | 'github_pr'
  | 'investigation'
  | 'content_draft'
  | 'meta_update'
  | 'shopify_product_create'
  | 'shopify_product_update'
  | 'shopify_description_update'
  | 'shopify_meta_update'
  | 'shopify_page_create'
  | 'shopify_page_update'
  | 'shopify_blog_post_create'
  | 'shopify_collection_update'
  | 'shopify_tag_update'
  | 'shopify_theme_edit'
  | 'hire_agent'
  | 'wix_seo_update'
  | 'server_file_write'
  | 'server_file_rollback'
  | 'gbp_update'
  | 'klaviyo_flow_update'
  | 'meta_ads_update'
  | 'connect_connector'
  | 'research_connector';

// ── Per-action payload interfaces ─────────────────────────────────────────────

export interface GithubIssuePayload {
  owner?: string;
  repo?: string;
  title?: string;
  body?: string;
  labels?: string[];
}

export interface GithubPRPayload {
  owner?: string;
  repo?: string;
  title?: string;
  body?: string;
  head: string;
  base?: string;
  draft?: boolean;
}

export interface InvestigationPayload {
  metric_name?: string;
  question?: string;
  signal_id?: string;
  context?: string;
}

export interface ContentDraftPayload {
  content_type?: string;
  topic?: string;
  target_url?: string;
  outline?: string;
  word_count?: number;
  keywords?: string[];
}

export interface MetaUpdatePayload {
  entity_type?: string;
  entity_id?: string;
  meta_title?: string;
  meta_description?: string;
  url?: string;
}

export interface ShopifyProductCreatePayload {
  title?: string;
  description?: string;
  body_html?: string;
  product_type?: string;
  tags?: string[] | string;
  price?: string;
  variants?: Array<{ price?: string; [key: string]: unknown }>;
  vendor?: string;
  status?: 'active' | 'draft' | 'archived';
}

export interface ShopifyProductUpdatePayload {
  product_id: string;
  title?: string;
  new_description?: string;
  body_html?: string;
  tags?: string[] | string;
  updates?: Record<string, unknown>;
}

export interface ShopifyPageCreatePayload {
  title?: string;
  body_html?: string;
  handle?: string;
}

export interface ShopifyPageUpdatePayload {
  page_id: string;
  title?: string;
  body_html?: string;
  updates?: Record<string, unknown>;
}

export interface ShopifyBlogPostCreatePayload {
  blog_id: string;
  title?: string;
  body_html?: string;
  author?: string;
  tags?: string;
  published?: boolean;
}

export interface ShopifyCollectionUpdatePayload {
  collection_id: string;
  new_description?: string;
}

export interface ShopifyTagUpdatePayload {
  product_id: string;
  add_tags?: string[];
  remove_tags?: string[];
}

export interface ShopifyThemeEditPayload {
  file_key: string;
  new_content: string;
  theme_id?: string;
}

export interface HireAgentPayload {
  template_id: string;
  profile_overrides?: Record<string, unknown>;
}

export interface WixSeoUpdatePayload {
  page_id?: string;
  url?: string;
  title?: string;
  description?: string;
  meta_title?: string;
  meta_description?: string;
}

export interface ServerFileWritePayload {
  path: string;
  content: string;
  encoding?: string;
  description?: string;
}

export interface ServerFileRollbackPayload {
  path: string;
  previous_content: string;
  snapshot_id?: string;
}

export interface GbpUpdatePayload {
  field?: string;
  value?: string;
  updates?: Record<string, unknown>;
  description?: string;
  categories?: string[];
  hours?: Record<string, unknown>;
}

export interface KlaviyoFlowUpdatePayload {
  flow_id: string;
  updates?: Record<string, unknown>;
  action?: string;
}

export interface MetaAdsUpdatePayload {
  campaign_id?: string;
  ad_set_id?: string;
  ad_id?: string;
  updates?: Record<string, unknown>;
  action?: string;
  budget?: number;
}

export interface ConnectConnectorPayload {
  connector_type: string;
  connector_name?: string;
  description?: string;
  config?: Record<string, unknown>;
}

export interface ResearchConnectorPayload {
  description: string;
  connector_type?: string;
  context?: string;
}

// ── Discriminated union ───────────────────────────────────────────────────────

export type ActionPayload =
  | { action_type: 'github_issue'; action_payload: GithubIssuePayload }
  | { action_type: 'github_pr'; action_payload: GithubPRPayload }
  | { action_type: 'investigation'; action_payload: InvestigationPayload }
  | { action_type: 'content_draft'; action_payload: ContentDraftPayload }
  | { action_type: 'meta_update'; action_payload: MetaUpdatePayload }
  | { action_type: 'shopify_product_create'; action_payload: ShopifyProductCreatePayload }
  | { action_type: 'shopify_product_update' | 'shopify_description_update' | 'shopify_meta_update'; action_payload: ShopifyProductUpdatePayload }
  | { action_type: 'shopify_page_create'; action_payload: ShopifyPageCreatePayload }
  | { action_type: 'shopify_page_update'; action_payload: ShopifyPageUpdatePayload }
  | { action_type: 'shopify_blog_post_create'; action_payload: ShopifyBlogPostCreatePayload }
  | { action_type: 'shopify_collection_update'; action_payload: ShopifyCollectionUpdatePayload }
  | { action_type: 'shopify_tag_update'; action_payload: ShopifyTagUpdatePayload }
  | { action_type: 'shopify_theme_edit'; action_payload: ShopifyThemeEditPayload }
  | { action_type: 'hire_agent'; action_payload: HireAgentPayload }
  | { action_type: 'wix_seo_update'; action_payload: WixSeoUpdatePayload }
  | { action_type: 'server_file_write'; action_payload: ServerFileWritePayload }
  | { action_type: 'server_file_rollback'; action_payload: ServerFileRollbackPayload }
  | { action_type: 'gbp_update'; action_payload: GbpUpdatePayload }
  | { action_type: 'klaviyo_flow_update'; action_payload: KlaviyoFlowUpdatePayload }
  | { action_type: 'meta_ads_update'; action_payload: MetaAdsUpdatePayload }
  | { action_type: 'connect_connector'; action_payload: ConnectConnectorPayload }
  | { action_type: 'research_connector'; action_payload: ResearchConnectorPayload };
