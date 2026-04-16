import fetch from 'node-fetch';

type Creds = Record<string, string | undefined>;

const API_VERSION = '2024-10';

function shopifyFetch(
  credentials: Creds,
  path: string,
  body: unknown = null,
  method: string | null = null,
): ReturnType<typeof fetch> {
  const { shopDomain, accessToken } = credentials;
  if (!shopDomain || !accessToken) throw new Error('shopDomain and accessToken are required.');

  const url = `https://${shopDomain}/admin/api/${API_VERSION}${path}`;
  const options: {
    method: string;
    headers: Record<string, string>;
    body?: string;
  } = {
    method: method ?? (body ? 'POST' : 'GET'),
    headers: {
      'X-Shopify-Access-Token': accessToken,
      'Content-Type': 'application/json',
    },
  };
  if (body) options.body = JSON.stringify(body);
  return fetch(url, options);
}

function dateString(daysAgo: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString();
}

interface ShopifyOrder {
  id: number;
  name: string;
  created_at: string;
  processed_at?: string;
  total_price: string;
  subtotal_price?: string;
  total_tax?: string;
  financial_status: string;
  fulfillment_status: string | null;
  line_items?: Array<{ title: string; quantity: number; price: string }>;
  customer?: { id: number; first_name?: string; last_name?: string };
  source_name?: string;
  cancel_reason?: string | null;
  email?: string;
}

interface ShopifyVariant {
  title: string;
  price: string;
  sku?: string;
  inventory_quantity?: number;
  inventory_management?: string;
}

interface ShopifyProduct {
  id: number;
  title: string;
  handle: string;
  status: string;
  variants?: ShopifyVariant[];
  images?: Array<{ src: string }>;
  product_type?: string;
  tags?: string;
  created_at: string;
  updated_at: string;
}

interface ShopifyCustomer {
  id: number;
  email: string;
  first_name?: string;
  last_name?: string;
  orders_count: number;
  total_spent: string;
  created_at: string;
  tags?: string;
}

/**
 * Fetch orders for a date range, paginating through all results.
 */
async function fetchOrders(credentials: Creds, daysAgo = 120): Promise<ShopifyOrder[]> {
  const since = dateString(daysAgo);
  const orders: ShopifyOrder[] = [];
  let url: string | null = `/orders.json?status=any&processed_at_min=${encodeURIComponent(since)}&limit=250&fields=id,name,created_at,processed_at,total_price,subtotal_price,total_tax,financial_status,fulfillment_status,line_items,customer,source_name,cancel_reason,email`;

  while (url) {
    const res = await shopifyFetch(credentials, url);
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Shopify orders error ${res.status}: ${err.substring(0, 300)}`);
    }
    const data = await res.json() as { orders?: ShopifyOrder[] };
    orders.push(...(data.orders ?? []));

    // Shopify pagination via Link header
    const linkHeader = res.headers.get('link');
    const nextMatch = linkHeader?.match(/<[^>]+\/orders\.json([^>]*)>;\s*rel="next"/);
    url = nextMatch ? `/orders.json${nextMatch[1]}` : null;
  }

  return orders;
}

/**
 * Fetch products with variant/inventory data.
 */
async function fetchProducts(credentials: Creds): Promise<ShopifyProduct[]> {
  const products: ShopifyProduct[] = [];
  let url: string | null = `/products.json?status=active&limit=250&fields=id,title,handle,status,variants,images,product_type,tags,created_at,updated_at`;

  while (url) {
    const res = await shopifyFetch(credentials, url);
    if (!res.ok) break;
    const data = await res.json() as { products?: ShopifyProduct[] };
    products.push(...(data.products ?? []));

    const linkHeader = res.headers.get('link');
    const nextMatch = linkHeader?.match(/<[^>]+\/products\.json([^>]*)>;\s*rel="next"/);
    url = nextMatch ? `/products.json${nextMatch[1]}` : null;
  }

  return products;
}

/**
 * Fetch customers (most recent 250 for overview).
 */
async function fetchCustomers(credentials: Creds): Promise<ShopifyCustomer[]> {
  const res = await shopifyFetch(credentials, `/customers.json?limit=250&fields=id,email,first_name,last_name,orders_count,total_spent,created_at,tags`);
  if (!res.ok) return [];
  const data = await res.json() as { customers?: ShopifyCustomer[] };
  return data.customers ?? [];
}

/**
 * Build analytics summary from orders array.
 */
// Returns the best date string to use as the "order date".
// processed_at = when payment was captured (the real transaction date).
// Falls back to created_at if processed_at is missing.
function orderDate(order: ShopifyOrder): string | null {
  const ts = order.processed_at || order.created_at;
  return ts ? ts.substring(0, 10) : null;
}

// Orders that should count toward revenue: not cancelled, not voided, not fully refunded.
function isCountableOrder(order: ShopifyOrder): boolean {
  if (order.cancel_reason !== null && order.cancel_reason !== undefined) return false;
  const fs = order.financial_status;
  if (fs === 'voided' || fs === 'refunded') return false;
  return true;
}

interface DailySaleEntry { date: string; amount: number }
interface DailyOrderEntry { date: string; count: number }
interface ProductSaleEntry { title: string; quantity: number; revenue: number }

interface Summary {
  period: string;
  orders: number;
  revenue: number;
  aov: number;
  topProducts: ProductSaleEntry[];
  dailySales: DailySaleEntry[];
  dailyOrders: DailyOrderEntry[];
}

function buildSummary(allOrders: ShopifyOrder[], periodLabel: string): Summary {
  // Only count orders that represent real revenue
  const orders = allOrders.filter(isCountableOrder);

  let revenue = 0;
  const productSales: Record<string, ProductSaleEntry> = {};
  const dailySales: Record<string, number> = {};
  const dailyOrderCounts: Record<string, number> = {};

  for (const order of orders) {
    const day = orderDate(order);
    if (!day) continue;
    const amount = parseFloat(order.total_price || '0');
    revenue += amount;
    dailySales[day] = (dailySales[day] ?? 0) + amount;
    dailyOrderCounts[day] = (dailyOrderCounts[day] ?? 0) + 1;

    for (const item of order.line_items ?? []) {
      const key = item.title;
      if (!productSales[key]) productSales[key] = { title: key, quantity: 0, revenue: 0 };
      productSales[key].quantity += item.quantity;
      productSales[key].revenue += parseFloat(item.price ?? '0') * item.quantity;
    }
  }

  const aov = orders.length > 0 ? revenue / orders.length : 0;
  const topProducts = Object.values(productSales)
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 20);

  const dailyArray = Object.entries(dailySales)
    .map(([date, amount]) => ({ date, amount: Math.round(amount * 100) / 100 }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const dailyOrdersArray = Object.entries(dailyOrderCounts)
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return {
    period: periodLabel,
    orders: orders.length,
    revenue: Math.round(revenue * 100) / 100,
    aov: Math.round(aov * 100) / 100,
    topProducts,
    dailySales: dailyArray,
    dailyOrders: dailyOrdersArray,
  };
}

const connector = {
  id: 'shopify' as const,
  name: 'Shopify',
  category: 'ecommerce',
  authType: 'apikey',
  icon: 'shopping-bag',

  capabilities: {
    read: true,
    write: false,
    webhooks: false,
    pollingIntervalMinutes: 360, // every 6 hours
  },

  signalTypes: [
    'shopify_revenue_drop', 'shopify_aov_drop', 'shopify_order_spike',
    'shopify_no_orders', 'shopify_refund_spike',
  ],

  async healthCheck(credentials: Creds): Promise<{ ok: boolean; error?: string; details?: unknown }> {
    try {
      const res = await shopifyFetch(credentials, '/shop.json');
      if (!res.ok) {
        const err = await res.text();
        return { ok: false, error: `Shopify API error ${res.status}: ${err.substring(0, 200)}` };
      }
      const data = await res.json() as { shop?: { name?: string; domain?: string; plan_name?: string } };
      return {
        ok: true,
        details: {
          shop: data.shop?.name,
          domain: data.shop?.domain,
          plan: data.shop?.plan_name,
        },
      };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },

  async fetch(dataType: string, credentials: Creds, params?: Record<string, unknown>): Promise<unknown> {
    const days = (params?.days as number | undefined) ?? 120;

    const [allOrders, products, customers] = await Promise.all([
      fetchOrders(credentials, days),
      fetchProducts(credentials),
      fetchCustomers(credentials),
    ]);

    const current = buildSummary(allOrders, `last ${days} days`);

    // All orders sorted newest-first by processed_at (real transaction date).
    // Includes cancelled/voided so they show in the orders tab (marked with financial_status).
    const recentOrders = [...allOrders]
      .sort((a, b) => new Date(b.processed_at || b.created_at).getTime() - new Date(a.processed_at || a.created_at).getTime())
      .map(o => ({
        id: o.id,
        name: o.name,
        // Use processed_at as the canonical order date; fall back to created_at
        created_at: o.processed_at || o.created_at,
        total_price: parseFloat(o.total_price || '0'),
        financial_status: o.financial_status,
        fulfillment_status: o.fulfillment_status,
        cancel_reason: o.cancel_reason ?? null,
        customer: o.customer ? `${o.customer.first_name || ''} ${o.customer.last_name || ''}`.trim() || o.email || 'Guest' : o.email || 'Guest',
        customer_id: o.customer?.id ?? null,
        item_count: (o.line_items ?? []).reduce((s, i) => s + i.quantity, 0),
        items: isCountableOrder(o)
          ? (o.line_items ?? []).map(i => ({
              title: i.title,
              quantity: i.quantity,
              price: parseFloat(i.price ?? '0'),
            }))
          : [], // don't count cancelled/voided order items toward top products
      }));

    // Products summary for Products tab — only count tracked inventory
    const productsSummary = products.slice(0, 200).map(p => {
      const trackedVariants = (p.variants ?? []).filter(v => v.inventory_management && v.inventory_management !== 'none');
      const tracked = trackedVariants.length > 0;
      return {
        id: p.id,
        title: p.title,
        handle: p.handle,
        product_type: p.product_type,
        tags: p.tags,
        status: p.status,
        variant_count: (p.variants ?? []).length,
        inventory: tracked ? trackedVariants.reduce((s, v) => s + (v.inventory_quantity ?? 0), 0) : null,
        tracked,
        price: parseFloat(p.variants?.[0]?.price ?? '0'),
        image: p.images?.[0]?.src ?? null,
        created_at: p.created_at,
        updated_at: p.updated_at,
      };
    });

    // Customers summary for Customers tab
    const customersSummary = customers.slice(0, 100).map(c => ({
      id: c.id,
      name: `${c.first_name || ''} ${c.last_name || ''}`.trim() || c.email,
      email: c.email,
      orders_count: c.orders_count,
      total_spent: parseFloat(c.total_spent || '0'),
      created_at: c.created_at,
      tags: c.tags,
    }));

    // Inventory data — only variants with inventory tracking enabled, sorted by stock asc
    const inventoryData = products.flatMap(p =>
      (p.variants ?? [])
        .filter(v => v.inventory_management && v.inventory_management !== 'none')
        .map(v => ({
          product_title: p.title,
          variant_title: v.title !== 'Default Title' ? v.title : null,
          sku: v.sku || null,
          inventory: v.inventory_quantity ?? 0,
          price: parseFloat(v.price ?? '0'),
        }))
    ).sort((a, b) => a.inventory - b.inventory).slice(0, 200);

    return {
      current,
      productCount: products.length,
      customerCount: customers.length,
      recentOrders,
      productsSummary,
      customersSummary,
      inventoryData,
      fetchedAt: new Date().toISOString(),
    };
  },

  extractMetrics(data: unknown, _runAt?: string): Array<{ name: string; value: number | null; data: unknown }> {
    const metrics: Array<{ name: string; value: number | null; data: unknown }> = [];
    const d = data as {
      current?: Summary;
      customerCount?: number;
      recentOrders?: unknown[];
      productCount?: number;
      productsSummary?: unknown[];
      customersSummary?: unknown[];
      inventoryData?: unknown[];
    };
    const c = d.current;
    if (!c) return metrics;

    // Core numeric metrics — use plain names matching ConnectorDataPage expectations
    metrics.push(
      { name: 'revenue',          value: c.revenue,              data: null },
      { name: 'orders',           value: c.orders,               data: null },
      { name: 'aov',              value: c.aov,                  data: null },
      { name: 'customers',        value: d.customerCount ?? 0,   data: null },
      // Rich array data for tab components
      { name: 'top_products_data',    value: c.topProducts?.length ?? 0,      data: c.topProducts },
      { name: 'daily_revenue',        value: null,                            data: c.dailySales },
      { name: 'orders_daily',         value: null,                            data: c.dailyOrders },
      { name: 'recent_orders_data',   value: d.recentOrders?.length ?? 0,    data: d.recentOrders },
      { name: 'products_data',        value: d.productCount ?? 0,            data: d.productsSummary },
      { name: 'customers_data',       value: d.customerCount ?? 0,           data: d.customersSummary },
      { name: 'inventory_data',       value: d.inventoryData?.length ?? 0,   data: d.inventoryData },
    );

    return metrics;
  },

  // ─── WRITE METHODS (gated behind task approval) ───────────────────────────

  async createProduct(credentials: Creds, _config: unknown, productData: Record<string, unknown>): Promise<unknown> {
    const res = await shopifyFetch(credentials, '/products.json', {
      product: { ...productData, status: 'draft', published: false },
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as { errors?: unknown };
      throw new Error(`Shopify createProduct failed: ${JSON.stringify(err.errors ?? err)}`);
    }
    return res.json();
  },

  async updateProduct(credentials: Creds, _config: unknown, productId: number | string, updates: Record<string, unknown>): Promise<unknown> {
    const url = `/products/${productId}.json`;
    const res = await shopifyFetch(credentials, url, { product: { id: productId, ...updates } });
    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as { errors?: unknown };
      throw new Error(`Shopify updateProduct failed: ${JSON.stringify(err.errors ?? err)}`);
    }
    return res.json();
  },

  async updateProductDescription(credentials: Creds, config: unknown, productId: number | string, bodyHtml: string): Promise<unknown> {
    return connector.updateProduct(credentials, config, productId, { body_html: bodyHtml });
  },

  async fetchProduct(credentials: Creds, _config: unknown, productId: number | string): Promise<unknown> {
    const res = await shopifyFetch(credentials, `/products/${productId}.json`);
    if (!res.ok) throw new Error(`Shopify fetchProduct ${productId} failed (${res.status})`);
    const data = await res.json() as { product: unknown };
    return data.product;
  },

  async createPage(credentials: Creds, _config: unknown, pageData: Record<string, unknown>): Promise<unknown> {
    const res = await shopifyFetch(credentials, '/pages.json', {
      page: { ...pageData, published: false },
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as { errors?: unknown };
      throw new Error(`Shopify createPage failed: ${JSON.stringify(err.errors ?? err)}`);
    }
    return res.json();
  },

  async updatePage(credentials: Creds, _config: unknown, pageId: number | string, updates: Record<string, unknown>): Promise<unknown> {
    const res = await shopifyFetch(credentials, `/pages/${pageId}.json`, {
      page: { id: pageId, ...updates },
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as { errors?: unknown };
      throw new Error(`Shopify updatePage failed: ${JSON.stringify(err.errors ?? err)}`);
    }
    return res.json();
  },

  async createBlogPost(credentials: Creds, _config: unknown, blogId: number | string, postData: Record<string, unknown>): Promise<unknown> {
    const res = await shopifyFetch(credentials, `/blogs/${blogId}/articles.json`, {
      article: { ...postData, published: false },
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as { errors?: unknown };
      throw new Error(`Shopify createBlogPost failed: ${JSON.stringify(err.errors ?? err)}`);
    }
    return res.json();
  },

  // ─── COLLECTIONS ───────────────────────────────────────────────────────────

  async fetchCollections(credentials: Creds): Promise<unknown[]> {
    const res = await shopifyFetch(credentials, '/custom_collections.json?limit=50');
    if (!res.ok) return [];
    const data = await res.json() as { custom_collections?: unknown[] };
    return data.custom_collections ?? [];
  },

  async updateCollectionDescription(credentials: Creds, _config: unknown, collectionId: number | string, bodyHtml: string): Promise<unknown> {
    const res = await shopifyFetch(credentials, `/custom_collections/${collectionId}.json`, {
      custom_collection: { id: collectionId, body_html: bodyHtml },
    });
    if (!res.ok) throw new Error(`Shopify updateCollection ${collectionId} failed (${res.status})`);
    return res.json();
  },

  // ─── PRODUCT TAGS ────────────────────────────────────────────────────────

  async updateProductTags(credentials: Creds, config: unknown, productId: number | string, addTags: string[] = [], removeTags: string[] = []): Promise<unknown> {
    const product = await connector.fetchProduct(credentials, config, productId) as { tags?: string };
    const currentTags = (product.tags ?? '').split(', ').filter(Boolean);
    const newTags = [
      ...currentTags.filter((t) => !removeTags.includes(t)),
      ...addTags.filter((t) => !currentTags.includes(t)),
    ];
    return connector.updateProduct(credentials, config, productId, { tags: newTags.join(', ') });
  },

  // ─── THEME FILE ACCESS ────────────────────────────────────────────────────

  async getActiveThemeId(credentials: Creds): Promise<number> {
    const res = await shopifyFetch(credentials, '/themes.json?role=main');
    if (!res.ok) throw new Error(`Shopify themes list failed (${res.status})`);
    const data = await res.json() as { themes?: Array<{ id: number; role: string }> };
    const main = (data.themes ?? []).find(t => t.role === 'main');
    if (!main) throw new Error('No active (main) theme found in Shopify store.');
    return main.id;
  },

  async readThemeFile(credentials: Creds, themeId: number | string, fileKey: string): Promise<{
    key: string;
    value: string | null;
    attachment: string | null;
    content_type: string | null;
    size: number | null;
    updated_at: string | null;
  }> {
    const res = await shopifyFetch(credentials, `/themes/${themeId}/assets.json?asset[key]=${encodeURIComponent(fileKey)}`);
    if (!res.ok) {
      const err = await res.text().catch(() => '');
      throw new Error(`Shopify readThemeFile "${fileKey}" failed (${res.status}): ${err.slice(0, 200)}`);
    }
    const data = await res.json() as { asset?: { key: string; value?: string; attachment?: string; content_type?: string; size?: number; updated_at?: string } };
    const asset = data.asset;
    if (!asset) throw new Error(`Shopify readThemeFile: no asset returned for "${fileKey}"`);
    return {
      key: asset.key,
      value: asset.value ?? null,
      attachment: asset.attachment ?? null,
      content_type: asset.content_type ?? null,
      size: asset.size ?? null,
      updated_at: asset.updated_at ?? null,
    };
  },

  async writeThemeFile(credentials: Creds, themeId: number | string, fileKey: string, content: string): Promise<unknown> {
    const res = await shopifyFetch(credentials, `/themes/${themeId}/assets.json`, {
      asset: { key: fileKey, value: content },
    }, 'PUT');
    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as { errors?: unknown };
      throw new Error(`Shopify writeThemeFile "${fileKey}" failed (${res.status}): ${JSON.stringify(err.errors ?? err)}`);
    }
    const data = await res.json() as { asset: unknown };
    return data.asset;
  },

  async deleteProduct(credentials: Creds, _config: unknown, productId: number | string): Promise<{ deleted: boolean }> {
    const url = `https://${credentials.shopDomain}/admin/api/${API_VERSION}/products/${productId}.json`;
    const res = await fetch(url, {
      method: 'DELETE',
      headers: { 'X-Shopify-Access-Token': credentials.accessToken! },
    });
    if (!res.ok) throw new Error(`Shopify deleteProduct ${productId} failed (${res.status})`);
    return { deleted: true };
  },

  async getAuthUrl(): Promise<string> { throw new Error('Shopify uses API key authentication, not OAuth.'); },
  async exchangeCode(): Promise<{ accessToken: string }> { throw new Error('Shopify uses API key authentication, not OAuth.'); },
  async refreshToken(): Promise<{ accessToken: string }> { throw new Error('Shopify uses API key authentication, not OAuth.'); },
};

export default connector;
