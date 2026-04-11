import fetch from 'node-fetch';

const API_VERSION = '2024-10';

function shopifyFetch(credentials, path, body = null) {
  const { shopDomain, accessToken } = credentials;
  if (!shopDomain || !accessToken) throw new Error('shopDomain and accessToken are required.');

  const url = `https://${shopDomain}/admin/api/${API_VERSION}${path}`;
  const options = {
    method: body ? 'POST' : 'GET',
    headers: {
      'X-Shopify-Access-Token': accessToken,
      'Content-Type': 'application/json',
    },
  };
  if (body) options.body = JSON.stringify(body);
  return fetch(url, options);
}

function dateString(daysAgo) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString();
}

/**
 * Fetch orders for a date range, paginating through all results.
 */
async function fetchOrders(credentials, daysAgo = 120) {
  const since = dateString(daysAgo);
  const orders = [];
  let url = `/orders.json?status=any&processed_at_min=${encodeURIComponent(since)}&limit=250&fields=id,name,created_at,processed_at,total_price,subtotal_price,total_tax,financial_status,fulfillment_status,line_items,customer,source_name,cancel_reason,email`;

  while (url) {
    const res = await shopifyFetch(credentials, url);
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Shopify orders error ${res.status}: ${err.substring(0, 300)}`);
    }
    const data = await res.json();
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
async function fetchProducts(credentials) {
  const products = [];
  let url = `/products.json?status=active&limit=250&fields=id,title,handle,status,variants,images,product_type,tags,created_at,updated_at`;

  while (url) {
    const res = await shopifyFetch(credentials, url);
    if (!res.ok) break;
    const data = await res.json();
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
async function fetchCustomers(credentials) {
  const res = await shopifyFetch(credentials, `/customers.json?limit=250&fields=id,email,first_name,last_name,orders_count,total_spent,created_at,tags`);
  if (!res.ok) return [];
  const data = await res.json();
  return data.customers ?? [];
}

/**
 * Build analytics summary from orders array.
 */
// Returns the best date string to use as the "order date".
// processed_at = when payment was captured (the real transaction date).
// Falls back to created_at if processed_at is missing.
function orderDate(order) {
  const ts = order.processed_at || order.created_at;
  return ts ? ts.substring(0, 10) : null;
}

// Orders that should count toward revenue: not cancelled, not voided, not fully refunded.
function isCountableOrder(order) {
  if (order.cancel_reason !== null && order.cancel_reason !== undefined) return false;
  const fs = order.financial_status;
  if (fs === 'voided' || fs === 'refunded') return false;
  return true;
}

function buildSummary(allOrders, periodLabel) {
  // Only count orders that represent real revenue
  const orders = allOrders.filter(isCountableOrder);

  let revenue = 0;
  const productSales = {};
  const dailySales = {};
  const dailyOrderCounts = {};

  for (const order of orders) {
    const day = orderDate(order);
    if (!day) continue;
    const amount = parseFloat(order.total_price || 0);
    revenue += amount;
    dailySales[day] = (dailySales[day] ?? 0) + amount;
    dailyOrderCounts[day] = (dailyOrderCounts[day] ?? 0) + 1;

    for (const item of order.line_items ?? []) {
      const key = item.title;
      if (!productSales[key]) productSales[key] = { title: key, quantity: 0, revenue: 0 };
      productSales[key].quantity += item.quantity;
      productSales[key].revenue += parseFloat(item.price ?? 0) * item.quantity;
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
  id: 'shopify',
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

  async healthCheck(credentials) {
    try {
      const res = await shopifyFetch(credentials, '/shop.json');
      if (!res.ok) {
        const err = await res.text();
        return { ok: false, error: `Shopify API error ${res.status}: ${err.substring(0, 200)}` };
      }
      const data = await res.json();
      return {
        ok: true,
        details: {
          shop: data.shop?.name,
          domain: data.shop?.domain,
          plan: data.shop?.plan_name,
        },
      };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },

  async fetch(dataType, credentials, params) {
    const days = params?.days ?? 120;

    const [allOrders, products, customers] = await Promise.all([
      fetchOrders(credentials, days),
      fetchProducts(credentials),
      fetchCustomers(credentials),
    ]);

    const current = buildSummary(allOrders, `last ${days} days`);

    // All orders sorted newest-first by processed_at (real transaction date).
    // Includes cancelled/voided so they show in the orders tab (marked with financial_status).
    const recentOrders = [...allOrders]
      .sort((a, b) => new Date(b.processed_at || b.created_at) - new Date(a.processed_at || a.created_at))
      .map(o => ({
        id: o.id,
        name: o.name,
        // Use processed_at as the canonical order date; fall back to created_at
        created_at: o.processed_at || o.created_at,
        total_price: parseFloat(o.total_price || 0),
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
              price: parseFloat(i.price ?? 0),
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
        price: parseFloat(p.variants?.[0]?.price ?? 0),
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
      total_spent: parseFloat(c.total_spent || 0),
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
          price: parseFloat(v.price ?? 0),
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

  extractMetrics(data, runAt) {
    const metrics = [];
    const c = data.current;
    if (!c) return metrics;

    // Core numeric metrics — use plain names matching ConnectorDataPage expectations
    metrics.push(
      { name: 'revenue',          value: c.revenue,              data: null },
      { name: 'orders',           value: c.orders,               data: null },
      { name: 'aov',              value: c.aov,                  data: null },
      { name: 'customers',        value: data.customerCount ?? 0, data: null },
      // Rich array data for tab components
      { name: 'top_products_data',    value: c.topProducts?.length ?? 0,     data: c.topProducts },
      { name: 'daily_revenue',        value: null,                           data: c.dailySales },
      { name: 'orders_daily',         value: null,                           data: c.dailyOrders },
      { name: 'recent_orders_data',   value: data.recentOrders?.length ?? 0, data: data.recentOrders },
      { name: 'products_data',        value: data.productCount ?? 0,         data: data.productsSummary },
      { name: 'customers_data',       value: data.customerCount ?? 0,        data: data.customersSummary },
      { name: 'inventory_data',       value: data.inventoryData?.length ?? 0, data: data.inventoryData },
    );

    return metrics;
  },

  async getAuthUrl() { throw new Error('Shopify uses API key authentication, not OAuth.'); },
  async exchangeCode() { throw new Error('Shopify uses API key authentication, not OAuth.'); },
  async refreshToken() { throw new Error('Shopify uses API key authentication, not OAuth.'); },
};

export default connector;
