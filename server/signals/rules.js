/**
 * Signal rules.
 * Each rule evaluates current vs previous data and returns a result.
 *
 * evaluate(current, previous) returns:
 * { triggered, confidence, data, title, description }
 */

export const rules = [
  {
    id: 'traffic_drop_7day',
    connectorType: 'ga4',
    type: 'traffic_drop',
    severity: 'warning',
    name: 'Traffic Drop (7-day)',

    evaluate(current, previous) {
      const currSessions = current?.sessions ?? 0;
      const prevSessions = previous?.sessions ?? 0;

      if (prevSessions === 0) {
        return { triggered: false, confidence: 0, data: {}, title: '', description: '' };
      }

      const dropPct = ((prevSessions - currSessions) / prevSessions) * 100;
      const triggered = dropPct >= 20;

      return {
        triggered,
        confidence: triggered ? Math.min(0.95, 0.5 + (dropPct - 20) / 100) : 0,
        data: { currSessions, prevSessions, dropPct: Math.round(dropPct * 10) / 10 },
        title: `Traffic dropped ${Math.round(dropPct)}% week-over-week`,
        description: `Sessions fell from ${prevSessions} to ${currSessions} — a ${Math.round(dropPct)}% decrease. Investigate traffic sources and recent changes.`,
      };
    },
  },

  {
    id: 'ranking_drop_keyword',
    connectorType: 'gsc',
    type: 'ranking_drop',
    severity: 'warning',
    name: 'Keyword Ranking Drop',

    evaluate(current, previous) {
      if (!Array.isArray(current) || !Array.isArray(previous)) {
        return { triggered: false, confidence: 0, data: {}, title: '', description: '' };
      }

      const prevMap = new Map(previous.map(r => [r.query, r]));
      const dropped = [];

      for (const curr of current) {
        const prev = prevMap.get(curr.query);
        if (!prev) continue;
        const posChange = curr.position - prev.position; // positive = worse
        if (posChange >= 5) {
          dropped.push({
            query: curr.query,
            prevPosition: Math.round(prev.position * 10) / 10,
            currPosition: Math.round(curr.position * 10) / 10,
            change: Math.round(posChange * 10) / 10,
            currClicks: curr.clicks,
          });
        }
      }

      dropped.sort((a, b) => b.change - a.change);
      const triggered = dropped.length > 0;
      const worstDrop = dropped[0];

      return {
        triggered,
        confidence: triggered ? Math.min(0.9, 0.4 + dropped.length * 0.05) : 0,
        data: { droppedKeywords: dropped.slice(0, 10), totalDropped: dropped.length },
        title: triggered
          ? `${dropped.length} keyword${dropped.length > 1 ? 's' : ''} dropped in ranking`
          : '',
        description: triggered
          ? `"${worstDrop?.query}" dropped ${worstDrop?.change} positions (now position ${worstDrop?.currPosition}). ${dropped.length} keyword${dropped.length > 1 ? 's' : ''} affected.`
          : '',
      };
    },
  },

  {
    id: 'keyword_surge',
    connectorType: 'gsc',
    type: 'keyword_surge',
    severity: 'info',
    name: 'Keyword Surge Opportunity',

    evaluate(current, previous) {
      if (!Array.isArray(current) || !Array.isArray(previous)) {
        return { triggered: false, confidence: 0, data: {}, title: '', description: '' };
      }

      const prevMap = new Map(previous.map(r => [r.query, r]));
      const surging = [];

      for (const curr of current) {
        const prev = prevMap.get(curr.query);
        if (!prev || prev.impressions === 0) continue;

        const impressionGrowth = ((curr.impressions - prev.impressions) / prev.impressions) * 100;
        const posImproved = curr.position < prev.position; // lower number = better

        if (impressionGrowth >= 50 && posImproved) {
          surging.push({
            query: curr.query,
            prevImpressions: prev.impressions,
            currImpressions: curr.impressions,
            impressionGrowth: Math.round(impressionGrowth),
            prevPosition: Math.round(prev.position * 10) / 10,
            currPosition: Math.round(curr.position * 10) / 10,
            clicks: curr.clicks,
          });
        }
      }

      surging.sort((a, b) => b.impressionGrowth - a.impressionGrowth);
      const triggered = surging.length > 0;
      const best = surging[0];

      return {
        triggered,
        confidence: triggered ? Math.min(0.85, 0.5 + surging.length * 0.05) : 0,
        data: { surgingKeywords: surging.slice(0, 10), totalSurging: surging.length },
        title: triggered
          ? `${surging.length} keyword${surging.length > 1 ? 's' : ''} surging in visibility`
          : '',
        description: triggered
          ? `"${best?.query}" impressions up ${best?.impressionGrowth}% and ranking improved to position ${best?.currPosition}. Opportunity to capitalise.`
          : '',
      };
    },
  },

  {
    id: 'pagespeed_regression',
    connectorType: 'pagespeed',
    type: 'pagespeed_regression',
    severity: 'alert',
    name: 'PageSpeed Regression',

    evaluate(current, previous) {
      const currScore = current?.scores?.performance ?? null;
      const prevScore = previous?.scores?.performance ?? null;

      if (currScore === null || prevScore === null) {
        return { triggered: false, confidence: 0, data: {}, title: '', description: '' };
      }

      const drop = prevScore - currScore;
      const triggered = drop >= 10;

      return {
        triggered,
        confidence: triggered ? Math.min(0.95, 0.6 + (drop - 10) / 100) : 0,
        data: {
          currScore,
          prevScore,
          drop,
          strategy: current?.strategy ?? 'mobile',
          cwv: current?.cwv,
        },
        title: `PageSpeed score dropped ${drop} points (${prevScore} → ${currScore})`,
        description: `Performance score fell from ${prevScore} to ${currScore} on ${current?.strategy ?? 'mobile'}. Review recent changes and Core Web Vitals.`,
      };
    },
  },

  {
    id: 'cwv_lcp_failing',
    connectorType: 'pagespeed',
    type: 'cwv_lcp_failing',
    severity: 'alert',
    name: 'LCP Failing Core Web Vitals',

    evaluate(current, _previous) {
      const lcp = current?.cwv?.lcp ?? null;
      const strategy = current?.strategy ?? 'mobile';

      if (lcp === null || strategy !== 'mobile') {
        return { triggered: false, confidence: 0, data: {}, title: '', description: '' };
      }

      // Google threshold: > 2500ms = needs improvement, > 4000ms = poor
      const triggered = lcp > 2500;
      const poor = lcp > 4000;

      return {
        triggered,
        confidence: triggered ? (poor ? 0.95 : 0.8) : 0,
        data: { lcp, strategy, threshold: 2500, rating: poor ? 'poor' : 'needs improvement' },
        title: `LCP is ${Math.round(lcp)}ms — ${poor ? 'poor' : 'needs improvement'} (threshold: 2500ms)`,
        description: `Largest Contentful Paint of ${Math.round(lcp)}ms on mobile exceeds Google's 2500ms threshold. This impacts Core Web Vitals and search ranking.`,
      };
    },
  },

  {
    id: 'crawl_error_spike',
    connectorType: 'gsc',
    type: 'crawl_error_spike',
    severity: 'warning',
    name: 'Crawl Error Spike (Proxy)',

    evaluate(current, previous) {
      // Proxy detection: pages with 0 clicks and impressions dropped >30%
      if (!Array.isArray(current) || !Array.isArray(previous)) {
        return { triggered: false, confidence: 0, data: {}, title: '', description: '' };
      }

      const prevMap = new Map(previous.map(r => [r.query, r]));
      const zeroClickDrop = [];

      for (const curr of current) {
        if (curr.clicks !== 0) continue;
        const prev = prevMap.get(curr.query);
        if (!prev || prev.impressions === 0) continue;

        const impDrop = ((prev.impressions - curr.impressions) / prev.impressions) * 100;
        if (impDrop >= 30) {
          zeroClickDrop.push({
            query: curr.query,
            prevImpressions: prev.impressions,
            currImpressions: curr.impressions,
            impressionDrop: Math.round(impDrop),
          });
        }
      }

      zeroClickDrop.sort((a, b) => b.impressionDrop - a.impressionDrop);
      const triggered = zeroClickDrop.length >= 3; // Only signal if multiple pages affected

      return {
        triggered,
        confidence: triggered ? Math.min(0.75, 0.4 + zeroClickDrop.length * 0.03) : 0,
        data: { affectedPages: zeroClickDrop.slice(0, 10), totalAffected: zeroClickDrop.length },
        title: triggered
          ? `${zeroClickDrop.length} queries lost impressions — possible crawl issues`
          : '',
        description: triggered
          ? `${zeroClickDrop.length} zero-click queries saw impression drops ≥30%. This may indicate indexing or crawl issues.`
          : '',
      };
    },
  },

  {
    id: 'ctr_below_threshold',
    connectorType: 'gsc',
    type: 'ctr_below_threshold',
    severity: 'info',
    name: 'Low CTR on High-Impression Keywords',

    evaluate(current, _previous) {
      if (!Array.isArray(current)) {
        return { triggered: false, confidence: 0, data: {}, title: '', description: '' };
      }

      const lowCtr = current.filter(row =>
        row.impressions >= 1000 &&
        row.ctr < 0.02 // < 2%
      ).map(row => ({
        query: row.query,
        impressions: row.impressions,
        clicks: row.clicks,
        ctr: Math.round(row.ctr * 10000) / 100, // as percentage
        position: Math.round(row.position * 10) / 10,
      }));

      lowCtr.sort((a, b) => b.impressions - a.impressions);
      const triggered = lowCtr.length > 0;
      const worst = lowCtr[0];

      return {
        triggered,
        confidence: triggered ? Math.min(0.85, 0.5 + lowCtr.length * 0.05) : 0,
        data: { lowCtrKeywords: lowCtr.slice(0, 10), totalAffected: lowCtr.length },
        title: triggered
          ? `${lowCtr.length} high-impression keyword${lowCtr.length > 1 ? 's' : ''} with CTR < 2%`
          : '',
        description: triggered
          ? `"${worst?.query}" has ${worst?.impressions} impressions but only ${worst?.ctr}% CTR. Improving titles/descriptions could unlock significant clicks.`
          : '',
      };
    },
  },

  {
    id: 'cwv_cls_failing',
    connectorType: 'pagespeed',
    type: 'cwv_cls_failing',
    severity: 'alert',
    name: 'CLS Failing Core Web Vitals',

    evaluate(current, _previous) {
      const cls = current?.cwv?.cls ?? null;
      if (cls === null) return { triggered: false, confidence: 0, data: {}, title: '', description: '' };
      const triggered = cls > 0.1;
      const poor = cls > 0.25;
      return {
        triggered,
        confidence: triggered ? (poor ? 0.95 : 0.8) : 0,
        data: { cls, threshold: 0.1, rating: poor ? 'poor' : 'needs improvement' },
        title: `CLS is ${cls.toFixed(3)} — ${poor ? 'poor' : 'needs improvement'} (threshold: 0.1)`,
        description: `Cumulative Layout Shift of ${cls.toFixed(3)} exceeds Google's 0.1 threshold. Layout instability harms user experience and Core Web Vitals ranking.`,
      };
    },
  },

  {
    id: 'cwv_fid_failing',
    connectorType: 'pagespeed',
    type: 'cwv_fid_failing',
    severity: 'warning',
    name: 'FID/TBT Failing Core Web Vitals',

    evaluate(current, _previous) {
      const fid = current?.cwv?.fid ?? current?.cwv?.tbt ?? null;
      if (fid === null) return { triggered: false, confidence: 0, data: {}, title: '', description: '' };
      const triggered = fid > 100;
      const poor = fid > 300;
      return {
        triggered,
        confidence: triggered ? (poor ? 0.9 : 0.75) : 0,
        data: { fid_ms: fid, threshold: 100, rating: poor ? 'poor' : 'needs improvement' },
        title: `FID/TBT is ${Math.round(fid)}ms — ${poor ? 'poor' : 'needs improvement'} (threshold: 100ms)`,
        description: `First Input Delay / Total Blocking Time of ${Math.round(fid)}ms exceeds Google's 100ms threshold. Reduce main-thread JavaScript to improve interactivity.`,
      };
    },
  },

  {
    id: 'score_drop_mobile',
    connectorType: 'pagespeed',
    type: 'score_drop_mobile',
    severity: 'alert',
    name: 'Mobile Performance Score Below 50',

    evaluate(current, _previous) {
      const score = current?.scores?.performance ?? null;
      if (score === null) return { triggered: false, confidence: 0, data: {}, title: '', description: '' };
      const triggered = score < 50;
      const critical = score < 30;
      return {
        triggered,
        confidence: triggered ? (critical ? 0.95 : 0.85) : 0,
        data: { score, threshold: 50, rating: critical ? 'critical' : 'poor' },
        title: `Mobile performance score is ${score}/100 — ${critical ? 'critical' : 'poor'}`,
        description: `A mobile performance score of ${score} indicates serious issues that will hurt search ranking and user experience.`,
      };
    },
  },

  {
    id: 'opportunities_detected',
    connectorType: 'pagespeed',
    type: 'opportunities_detected',
    severity: 'info',
    name: 'PageSpeed Opportunities Detected',

    evaluate(current, _previous) {
      const opportunities = current?.opportunities ?? [];
      const highValue = opportunities.filter(o => (o.savingsMs ?? 0) > 500);
      const triggered = highValue.length > 0;
      const totalSavings = highValue.reduce((sum, o) => sum + (o.savingsMs ?? 0), 0);
      return {
        triggered,
        confidence: triggered ? Math.min(0.9, 0.5 + highValue.length * 0.1) : 0,
        data: { opportunities: highValue, totalSavingsMs: totalSavings, count: highValue.length },
        title: triggered
          ? `${highValue.length} PageSpeed opportunit${highValue.length > 1 ? 'ies' : 'y'} — ${Math.round(totalSavings / 100) / 10}s potential saving`
          : '',
        description: triggered
          ? `"${highValue[0]?.title}" could save ~${Math.round(highValue[0]?.savingsMs ?? 0)}ms. ${highValue.length} opportunit${highValue.length > 1 ? 'ies' : 'y'} with >500ms estimated savings.`
          : '',
      };
    },
  },

  {
    id: 'traffic_spike',
    connectorType: 'ga4',
    type: 'traffic_spike',
    severity: 'info',
    name: 'Traffic Spike',

    evaluate(current, previous) {
      const currSessions = current?.sessions ?? 0;
      const prevSessions = previous?.sessions ?? 0;
      if (prevSessions === 0) return { triggered: false, confidence: 0, data: {}, title: '', description: '' };
      const growthPct = ((currSessions - prevSessions) / prevSessions) * 100;
      const triggered = growthPct >= 50;
      return {
        triggered,
        confidence: triggered ? Math.min(0.9, 0.5 + (growthPct - 50) / 200) : 0,
        data: { currSessions, prevSessions, growthPct: Math.round(growthPct * 10) / 10 },
        title: `Traffic up ${Math.round(growthPct)}% week-over-week`,
        description: `Sessions grew from ${prevSessions} to ${currSessions} — a ${Math.round(growthPct)}% increase.`,
      };
    },
  },

  {
    id: 'conversion_drop',
    connectorType: 'ga4',
    type: 'conversion_drop',
    severity: 'alert',
    name: 'Conversion Drop',

    evaluate(current, previous) {
      const currConversions = current?.conversions ?? 0;
      const prevConversions = previous?.conversions ?? 0;
      if (prevConversions === 0) return { triggered: false, confidence: 0, data: {}, title: '', description: '' };
      const dropPct = ((prevConversions - currConversions) / prevConversions) * 100;
      const triggered = dropPct >= 25;
      return {
        triggered,
        confidence: triggered ? Math.min(0.95, 0.5 + (dropPct - 25) / 100) : 0,
        data: { currConversions, prevConversions, dropPct: Math.round(dropPct * 10) / 10 },
        title: `Conversions dropped ${Math.round(dropPct)}% week-over-week`,
        description: `Conversions fell from ${prevConversions} to ${currConversions}. Check funnel, landing pages, and recent changes.`,
      };
    },
  },

  {
    id: 'organic_traffic_drop',
    connectorType: 'ga4',
    type: 'organic_traffic_drop',
    severity: 'warning',
    name: 'Organic Traffic Drop',

    evaluate(current, previous) {
      const getOrganic = (data) => {
        if (!Array.isArray(data?.sources)) return null;
        const org = data.sources.find(s =>
          s.channel?.toLowerCase().includes('organic') || s.channel?.toLowerCase().includes('search')
        );
        return org?.sessions ?? null;
      };
      const currOrganic = getOrganic(current);
      const prevOrganic = getOrganic(previous);
      if (currOrganic === null || prevOrganic === null || prevOrganic === 0) {
        return { triggered: false, confidence: 0, data: {}, title: '', description: '' };
      }
      const dropPct = ((prevOrganic - currOrganic) / prevOrganic) * 100;
      const triggered = dropPct >= 20;
      return {
        triggered,
        confidence: triggered ? Math.min(0.9, 0.5 + (dropPct - 20) / 100) : 0,
        data: { currOrganic, prevOrganic, dropPct: Math.round(dropPct * 10) / 10 },
        title: `Organic search traffic down ${Math.round(dropPct)}%`,
        description: `Organic sessions dropped from ${prevOrganic} to ${currOrganic} — a ${Math.round(dropPct)}% decline. Check GSC for keyword ranking changes.`,
      };
    },
  },

  {
    id: 'top_page_traffic_drop',
    connectorType: 'gsc',
    type: 'top_page_traffic_drop',
    severity: 'warning',
    name: 'Top Page Traffic Drop',

    evaluate(current, previous) {
      if (!current?.current || !previous?.current) {
        return { triggered: false, confidence: 0, data: {}, title: '', description: '' };
      }
      const prevMap = new Map((previous.current ?? []).map(r => [r.query, r]));
      const top10 = [...prevMap.values()]
        .sort((a, b) => b.impressions - a.impressions)
        .slice(0, 10)
        .map(r => r.query);
      const currMap = new Map((current.current ?? []).map(r => [r.query, r]));
      const dropped = [];
      for (const query of top10) {
        const prev = prevMap.get(query);
        const curr = currMap.get(query);
        if (!prev || !curr || prev.clicks === 0) continue;
        const dropPct = ((prev.clicks - curr.clicks) / prev.clicks) * 100;
        if (dropPct >= 20) {
          dropped.push({ query, prevClicks: prev.clicks, currClicks: curr.clicks, dropPct: Math.round(dropPct) });
        }
      }
      dropped.sort((a, b) => b.dropPct - a.dropPct);
      const triggered = dropped.length > 0;
      return {
        triggered,
        confidence: triggered ? Math.min(0.85, 0.4 + dropped.length * 0.1) : 0,
        data: { droppedPages: dropped, totalDropped: dropped.length },
        title: triggered ? `${dropped.length} top-page${dropped.length > 1 ? 's' : ''} lost >20% clicks` : '',
        description: triggered
          ? `"${dropped[0]?.query}" lost ${dropped[0]?.dropPct}% of clicks (${dropped[0]?.prevClicks} → ${dropped[0]?.currClicks}).`
          : '',
      };
    },
  },

  {
    id: 'bounce_rate_spike',
    connectorType: 'ga4',
    type: 'bounce_rate_spike',
    severity: 'warning',
    name: 'Bounce Rate Spike',

    evaluate(current, previous) {
      const currRate = current?.bounceRate ?? null;
      const prevRate = previous?.bounceRate ?? null;

      if (currRate === null || prevRate === null) {
        return { triggered: false, confidence: 0, data: {}, title: '', description: '' };
      }

      // GA4 bounce rate is a decimal (0-1), convert to percentage points
      const currPct = currRate > 1 ? currRate : currRate * 100;
      const prevPct = prevRate > 1 ? prevRate : prevRate * 100;

      const increase = currPct - prevPct;
      const triggered = increase >= 15;

      return {
        triggered,
        confidence: triggered ? Math.min(0.9, 0.5 + (increase - 15) / 100) : 0,
        data: {
          currBounceRate: Math.round(currPct * 10) / 10,
          prevBounceRate: Math.round(prevPct * 10) / 10,
          increase: Math.round(increase * 10) / 10,
        },
        title: `Bounce rate increased by ${Math.round(increase)}pp (${Math.round(prevPct)}% → ${Math.round(currPct)}%)`,
        description: `Bounce rate climbed ${Math.round(increase)} percentage points week-over-week. Investigate landing page quality, page speed, and traffic source changes.`,
      };
    },
  },

  {
    id: 'shopify_revenue_drop',
    connectorType: 'shopify',
    type: 'shopify_revenue_drop',
    severity: 'alert',
    name: 'Shopify Revenue Drop',

    evaluate(current, previous) {
      const curr = current?.current?.revenue ?? 0;
      const prev = previous?.current?.revenue ?? 0;
      if (prev === 0) return { triggered: false, confidence: 0, data: {}, title: '', description: '' };
      const dropPct = ((prev - curr) / prev) * 100;
      const triggered = dropPct >= 20;
      return {
        triggered,
        confidence: triggered ? Math.min(0.95, 0.5 + (dropPct - 20) / 100) : 0,
        data: { currRevenue: curr, prevRevenue: prev, dropPct: Math.round(dropPct * 10) / 10 },
        title: triggered ? `Revenue down ${Math.round(dropPct)}% vs previous period` : '',
        description: triggered
          ? `Revenue fell from £${prev.toFixed(2)} to £${curr.toFixed(2)} — a ${Math.round(dropPct)}% drop.`
          : '',
      };
    },
  },

  {
    id: 'shopify_aov_drop',
    connectorType: 'shopify',
    type: 'shopify_aov_drop',
    severity: 'warning',
    name: 'Shopify AOV Drop',

    evaluate(current, previous) {
      const curr = current?.current?.aov ?? 0;
      const prev = previous?.current?.aov ?? 0;
      if (prev === 0) return { triggered: false, confidence: 0, data: {}, title: '', description: '' };
      const dropPct = ((prev - curr) / prev) * 100;
      const triggered = dropPct >= 15;
      return {
        triggered,
        confidence: triggered ? Math.min(0.85, 0.5 + (dropPct - 15) / 100) : 0,
        data: { currAov: curr, prevAov: prev, dropPct: Math.round(dropPct * 10) / 10 },
        title: triggered ? `Average order value down ${Math.round(dropPct)}%` : '',
        description: triggered
          ? `AOV dropped from £${prev.toFixed(2)} to £${curr.toFixed(2)}. Check discounts, product mix, and upsell performance.`
          : '',
      };
    },
  },

  {
    id: 'shopify_order_spike',
    connectorType: 'shopify',
    type: 'shopify_order_spike',
    severity: 'info',
    name: 'Shopify Order Spike',

    evaluate(current, previous) {
      const curr = current?.current?.orders ?? 0;
      const prev = previous?.current?.orders ?? 0;
      if (prev === 0) return { triggered: false, confidence: 0, data: {}, title: '', description: '' };
      const growthPct = ((curr - prev) / prev) * 100;
      const triggered = growthPct >= 50;
      return {
        triggered,
        confidence: triggered ? Math.min(0.9, 0.5 + (growthPct - 50) / 200) : 0,
        data: { currOrders: curr, prevOrders: prev, growthPct: Math.round(growthPct) },
        title: triggered ? `Order volume up ${Math.round(growthPct)}% vs previous period` : '',
        description: triggered
          ? `Orders grew from ${prev} to ${curr}. Check for viral traffic, promotions, or referral spikes.`
          : '',
      };
    },
  },

  {
    id: 'shopify_no_orders',
    connectorType: 'shopify',
    type: 'shopify_no_orders',
    severity: 'alert',
    name: 'No Shopify Orders Today',

    evaluate(current, _previous) {
      const daily = current?.current?.dailySales ?? [];
      if (daily.length === 0) return { triggered: false, confidence: 0, data: {}, title: '', description: '' };
      const today = new Date().toISOString().substring(0, 10);
      const todayEntry = daily.find(d => d.date === today);
      const triggered = !todayEntry || todayEntry.amount === 0;
      return {
        triggered,
        confidence: triggered ? 0.8 : 0,
        data: { date: today, orders: todayEntry?.amount ?? 0 },
        title: triggered ? `No revenue recorded today (${today})` : '',
        description: 'No orders processed today. Check store availability, payment gateways, and any recent changes.',
      };
    },
  },
];

/**
 * Get rules applicable to a given connector type.
 */
export function getRulesForConnector(connectorType) {
  return rules.filter(r => r.connectorType === connectorType);
}

/**
 * Get a rule by ID.
 */
export function getRuleById(id) {
  return rules.find(r => r.id === id) ?? null;
}
