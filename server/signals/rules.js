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

  // ─── UPTIME ROBOT ───────────────────────────────────────────────────────────

  {
    id: 'monitor_down',
    connectorType: 'uptimerobot',
    type: 'monitor_down',
    severity: 'critical',
    name: 'Monitor Down',
    evaluate(current) {
      const monitors = current?.monitors ?? [];
      const down = monitors.filter(m => m?.status === 9);
      if (down.length === 0) return { triggered: false, confidence: 0, data: {}, title: '', description: '' };
      const names = down.map(m => m.friendly_name).filter(Boolean);
      return {
        triggered: true,
        confidence: 1.0,
        data: { count: down.length, monitors: names },
        title: down.length === 1 ? `${names[0]} is DOWN` : `${down.length} monitors are DOWN`,
        description: `The following monitors are reporting hard down: ${names.join(', ')}. Investigate immediately.`,
      };
    },
  },

  {
    id: 'monitor_seems_down',
    connectorType: 'uptimerobot',
    type: 'monitor_seems_down',
    severity: 'alert',
    name: 'Monitor Seems Down',
    evaluate(current) {
      const monitors = current?.monitors ?? [];
      const seems = monitors.filter(m => m?.status === 8);
      if (seems.length === 0) return { triggered: false, confidence: 0, data: {}, title: '', description: '' };
      const names = seems.map(m => m.friendly_name).filter(Boolean);
      return {
        triggered: true,
        confidence: 0.85,
        data: { count: seems.length, monitors: names },
        title: `${seems.length} monitor${seems.length > 1 ? 's' : ''} reporting "seems down"`,
        description: `Pre-confirmation status — UptimeRobot is rechecking. Likely transient but watch closely: ${names.join(', ')}.`,
      };
    },
  },

  {
    id: 'uptime_below_threshold',
    connectorType: 'uptimerobot',
    type: 'uptime_drop',
    severity: 'warning',
    name: 'Uptime Below Threshold',
    evaluate(current) {
      const monitors = current?.monitors ?? [];
      if (monitors.length === 0) return { triggered: false, confidence: 0, data: {}, title: '', description: '' };
      const below = monitors
        .map(m => {
          const ratio = parseFloat(String(m.custom_uptime_ratio ?? '').split('-').pop());
          return isNaN(ratio) ? null : { name: m.friendly_name, ratio };
        })
        .filter(x => x && x.ratio < 99.5);
      if (below.length === 0) return { triggered: false, confidence: 0, data: {}, title: '', description: '' };
      return {
        triggered: true,
        confidence: 0.95,
        data: { monitors: below },
        title: `${below.length} monitor${below.length > 1 ? 's' : ''} below 99.5% uptime (30-day)`,
        description: below.map(b => `${b.name}: ${b.ratio}%`).join(', '),
      };
    },
  },

  {
    id: 'uptimerobot_response_time_spike',
    connectorType: 'uptimerobot',
    type: 'response_time_spike',
    severity: 'warning',
    name: 'Response Time Spike',
    evaluate(current, previous) {
      const currMons = current?.monitors ?? [];
      const prevMons = previous?.monitors ?? [];
      if (currMons.length === 0 || prevMons.length === 0) return { triggered: false, confidence: 0, data: {}, title: '', description: '' };
      const prevById = new Map(prevMons.map(m => [m.id, m]));
      const spiked = [];
      for (const m of currMons) {
        const curr = m.response_times?.[0]?.value ?? 0;
        const prev = prevById.get(m.id)?.response_times?.[0]?.value ?? 0;
        if (prev > 0 && curr > prev * 1.5 && curr > 500) {
          spiked.push({ name: m.friendly_name, prev_ms: prev, curr_ms: curr });
        }
      }
      if (spiked.length === 0) return { triggered: false, confidence: 0, data: {}, title: '', description: '' };
      return {
        triggered: true,
        confidence: 0.8,
        data: { monitors: spiked },
        title: `${spiked.length} monitor${spiked.length > 1 ? 's' : ''} showing response time spike`,
        description: spiked.map(s => `${s.name}: ${s.prev_ms}ms → ${s.curr_ms}ms`).join(', '),
      };
    },
  },

  // ─── TODOIST ────────────────────────────────────────────────────────────────

  {
    id: 'high_priority_overdue',
    connectorType: 'todoist',
    type: 'high_priority_overdue',
    severity: 'alert',
    name: 'High-Priority Tasks Overdue',
    evaluate(current) {
      const overdue = current?.overdue_tasks ?? [];
      const p1 = overdue.filter(t => t.priority === 4);
      if (p1.length === 0) return { triggered: false, confidence: 0, data: {}, title: '', description: '' };
      return {
        triggered: true,
        confidence: 1.0,
        data: { count: p1.length, tasks: p1.slice(0, 10).map(t => t.content) },
        title: `${p1.length} priority-1 task${p1.length > 1 ? 's are' : ' is'} overdue`,
        description: p1.slice(0, 5).map(t => `• ${t.content}`).join('\n'),
      };
    },
  },

  {
    id: 'overdue_tasks_spike',
    connectorType: 'todoist',
    type: 'overdue_spike',
    severity: 'warning',
    name: 'Overdue Tasks Spike',
    evaluate(current, previous) {
      const curr = current?.tasks_overdue ?? 0;
      const prev = previous?.tasks_overdue ?? 0;
      const increase = curr - prev;
      if (increase < 3) return { triggered: false, confidence: 0, data: {}, title: '', description: '' };
      return {
        triggered: true,
        confidence: 0.85,
        data: { current: curr, previous: prev, increase },
        title: `Overdue tasks jumped from ${prev} to ${curr}`,
        description: `${increase} new tasks have become overdue since last check.`,
      };
    },
  },

  {
    id: 'tasks_completed_drop',
    connectorType: 'todoist',
    type: 'productivity_drop',
    severity: 'info',
    name: 'Completion Velocity Drop',
    evaluate(current, previous) {
      const curr = current?.tasks_completed_7d ?? 0;
      const prev = previous?.tasks_completed_7d ?? 0;
      if (prev === 0 || prev - curr <= 5) return { triggered: false, confidence: 0, data: {}, title: '', description: '' };
      return {
        triggered: true,
        confidence: 0.75,
        data: { current: curr, previous: prev },
        title: `Task completion dropped ${prev - curr} this week`,
        description: `Last week you completed ${prev} tasks; this week ${curr}. Investigate if this is intentional capacity reduction or a focus issue.`,
      };
    },
  },

  // ─── BREVO ──────────────────────────────────────────────────────────────────

  {
    id: 'open_rate_drop',
    connectorType: 'brevo',
    type: 'open_rate_drop',
    severity: 'warning',
    name: 'Email Open Rate Drop',
    evaluate(current, previous) {
      const currOpen = current?.avg_open_rate;
      const prevOpen = previous?.avg_open_rate;
      if (!currOpen || !prevOpen) return { triggered: false, confidence: 0, data: {}, title: '', description: '' };
      const drop = prevOpen - currOpen;
      if (drop < 5) return { triggered: false, confidence: 0, data: {}, title: '', description: '' };
      return {
        triggered: true,
        confidence: 0.8,
        data: { from: prevOpen, to: currOpen, drop },
        title: `Email open rate fell ${drop.toFixed(1)}% (${prevOpen.toFixed(1)}% → ${currOpen.toFixed(1)}%)`,
        description: 'Recent campaigns are getting fewer opens. Review subject lines, send time, and list hygiene.',
      };
    },
  },

  {
    id: 'unsubscribe_spike',
    connectorType: 'brevo',
    type: 'unsubscribe_spike',
    severity: 'alert',
    name: 'Unsubscribe Spike',
    evaluate(current) {
      const rate = current?.avg_unsubscribe_rate ?? 0;
      if (rate <= 0.5) return { triggered: false, confidence: 0, data: {}, title: '', description: '' };
      return {
        triggered: true,
        confidence: 0.9,
        data: { rate },
        title: `Unsubscribe rate at ${rate.toFixed(2)}% (above 0.5% threshold)`,
        description: 'Recent campaigns are losing subscribers above expected rate. Review content relevance and frequency.',
      };
    },
  },

  {
    id: 'bounce_rate_high',
    connectorType: 'brevo',
    type: 'bounce_rate_high',
    severity: 'alert',
    name: 'Email Bounce Rate High',
    evaluate(current) {
      const rate = current?.avg_bounce_rate ?? 0;
      if (rate <= 2) return { triggered: false, confidence: 0, data: {}, title: '', description: '' };
      return {
        triggered: true,
        confidence: 0.95,
        data: { rate },
        title: `Email bounce rate at ${rate.toFixed(1)}% (above 2% threshold)`,
        description: 'High bounce rates damage sender reputation. Clean your list and verify recent imports.',
      };
    },
  },

  // ─── STANNP ─────────────────────────────────────────────────────────────────

  {
    id: 'low_campaign_balance',
    connectorType: 'stannp',
    type: 'low_balance',
    severity: 'warning',
    name: 'Low Stannp Balance',
    evaluate(current) {
      const balance = current?.account_balance ?? 0;
      if (balance >= 50) return { triggered: false, confidence: 0, data: {}, title: '', description: '' };
      return {
        triggered: true,
        confidence: 1.0,
        data: { balance },
        title: `Stannp balance low: £${balance.toFixed(2)} remaining`,
        description: 'Top up before scheduling new direct mail campaigns to avoid send failures.',
      };
    },
  },

  {
    id: 'stannp_campaign_failed',
    connectorType: 'stannp',
    type: 'campaign_failed',
    severity: 'alert',
    name: 'Stannp Campaign Failed',
    evaluate(current) {
      const failed = (current?.campaigns ?? []).filter(c => c.status === 'failed');
      if (failed.length === 0) return { triggered: false, confidence: 0, data: {}, title: '', description: '' };
      return {
        triggered: true,
        confidence: 1.0,
        data: { count: failed.length, campaigns: failed.map(c => c.name) },
        title: `${failed.length} Stannp campaign${failed.length > 1 ? 's' : ''} failed`,
        description: failed.map(c => `${c.name} (#${c.id})`).join(', '),
      };
    },
  },

  {
    id: 'stannp_delivery_rate_drop',
    connectorType: 'stannp',
    type: 'delivery_drop',
    severity: 'warning',
    name: 'Delivery Rate Drop',
    evaluate(current, previous) {
      const curr = current?.avg_delivery_rate;
      const prev = previous?.avg_delivery_rate;
      if (!curr || !prev || prev - curr < 0.05) return { triggered: false, confidence: 0, data: {}, title: '', description: '' };
      return {
        triggered: true,
        confidence: 0.8,
        data: { from: prev, to: curr },
        title: `Direct mail delivery rate dropped from ${(prev * 100).toFixed(1)}% to ${(curr * 100).toFixed(1)}%`,
        description: 'Investigate address quality and recent recipient list imports.',
      };
    },
  },

  // ─── WORDPRESS ──────────────────────────────────────────────────────────────

  {
    id: 'wp_plugin_update_available',
    connectorType: 'wordpress',
    type: 'plugin_update',
    severity: 'warning',
    name: 'Plugin Updates Available',
    evaluate(current) {
      const count = current?.plugins_update_available ?? 0;
      if (count === 0) return { triggered: false, confidence: 0, data: {}, title: '', description: '' };
      return {
        triggered: true,
        confidence: 1.0,
        data: { count, plugins: current.plugins_needing_update ?? [] },
        title: `${count} WordPress plugin${count > 1 ? 's need' : ' needs'} updating`,
        description: 'Outdated plugins are a security risk. Schedule a maintenance window to update.',
      };
    },
  },

  {
    id: 'wp_posts_published_drop',
    connectorType: 'wordpress',
    type: 'content_drop',
    severity: 'info',
    name: 'Publishing Velocity Drop',
    evaluate(current, previous) {
      const curr = current?.posts_published_30d ?? 0;
      const prev = previous?.posts_published_30d ?? 0;
      if (prev === 0 || prev - curr <= 3) return { triggered: false, confidence: 0, data: {}, title: '', description: '' };
      return {
        triggered: true,
        confidence: 0.75,
        data: { current: curr, previous: prev },
        title: `Publishing dropped from ${prev} to ${curr} posts (last 30 days)`,
        description: 'Content cadence has slowed. Consider whether this is intentional or a backlog issue.',
      };
    },
  },

  {
    id: 'wp_comments_spam_spike',
    connectorType: 'wordpress',
    type: 'spam_spike',
    severity: 'info',
    name: 'Comment Spam Spike',
    evaluate(current, previous) {
      const curr = current?.comments_spam ?? 0;
      const prev = previous?.comments_spam ?? 0;
      if (curr - prev <= 20) return { triggered: false, confidence: 0, data: {}, title: '', description: '' };
      return {
        triggered: true,
        confidence: 0.8,
        data: { count: curr, increase: curr - prev },
        title: `${curr - prev} new spam comments`,
        description: 'Spam queue growing fast. Review filter rules or enable a stronger anti-spam plugin.',
      };
    },
  },

  {
    id: 'wp_drafts_piling_up',
    connectorType: 'wordpress',
    type: 'drafts_piling',
    severity: 'info',
    name: 'Drafts Piling Up',
    evaluate(current) {
      const drafts = current?.posts_draft ?? 0;
      if (drafts <= 10) return { triggered: false, confidence: 0, data: {}, title: '', description: '' };
      return {
        triggered: true,
        confidence: 0.7,
        data: { count: drafts },
        title: `${drafts} draft posts unpublished`,
        description: 'A growing draft backlog suggests stalled content. Review and either publish, schedule, or archive.',
      };
    },
  },

  // ─── KIRBY ──────────────────────────────────────────────────────────────────

  {
    id: 'kirby_drafts_piling',
    connectorType: 'kirby',
    type: 'kirby_drafts',
    severity: 'info',
    name: 'Kirby Drafts Piling Up',
    evaluate(current) {
      const drafts = current?.draft_pages ?? 0;
      if (drafts <= 5) return { triggered: false, confidence: 0, data: {}, title: '', description: '' };
      return {
        triggered: true,
        confidence: 0.8,
        data: { count: drafts },
        title: `${drafts} unpublished Kirby pages`,
        description: 'Draft pages are accumulating in the Panel. Review and publish or archive.',
      };
    },
  },

  {
    id: 'kirby_missing_meta',
    connectorType: 'kirby',
    type: 'missing_meta',
    severity: 'warning',
    name: 'Kirby Pages Missing Meta',
    evaluate(current) {
      const count = current?.pages_missing_meta ?? 0;
      if (count === 0) return { triggered: false, confidence: 0, data: {}, title: '', description: '' };
      return {
        triggered: true,
        confidence: 1.0,
        data: { count },
        title: `${count} Kirby page${count > 1 ? 's' : ''} missing meta title or description`,
        description: 'Pages without meta tags hurt SEO. Add them before they accumulate further.',
      };
    },
  },

  {
    id: 'kirby_stale_content',
    connectorType: 'kirby',
    type: 'stale_content',
    severity: 'info',
    name: 'Kirby Stale Content',
    evaluate(current) {
      const stale = current?.pages_not_updated_90d ?? 0;
      if (stale <= 10) return { triggered: false, confidence: 0, data: {}, title: '', description: '' };
      return {
        triggered: true,
        confidence: 0.7,
        data: { count: stale },
        title: `${stale} Kirby pages not updated in 90+ days`,
        description: 'Stale content can hurt SEO and engagement. Identify high-traffic stale pages first.',
      };
    },
  },

  // ─── GOOGLE BUSINESS PROFILE ────────────────────────────────────────────────

  {
    id: 'gbp_rating_drop',
    connectorType: 'gbp',
    type: 'rating_drop',
    severity: 'alert',
    name: 'GBP Rating Drop',
    evaluate(current, previous) {
      const curr = current?.['gbp.avg_rating'] ?? current?.avg_rating;
      const prev = previous?.['gbp.avg_rating'] ?? previous?.avg_rating;
      if (curr == null || prev == null) return { triggered: false, confidence: 0, data: {}, title: '', description: '' };
      const drop = prev - curr;
      if (drop < 0.2) return { triggered: false, confidence: 0, data: {}, title: '', description: '' };
      return {
        triggered: true,
        confidence: Math.min(0.95, drop * 2),
        data: { from: prev, to: curr, drop: Math.round(drop * 100) / 100 },
        title: `Average rating fell from ${prev.toFixed(2)} to ${curr.toFixed(2)}`,
        description: 'Customer rating has dropped meaningfully. Review recent low-star reviews and respond.',
      };
    },
  },

  {
    id: 'gbp_negative_review',
    connectorType: 'gbp',
    type: 'negative_review',
    severity: 'alert',
    name: 'New Negative Review',
    evaluate(current, previous) {
      const currNeg = (current?.reviews_1star ?? 0) + (current?.reviews_2star ?? 0);
      const prevNeg = (previous?.reviews_1star ?? 0) + (previous?.reviews_2star ?? 0);
      const newNeg = currNeg - prevNeg;
      if (newNeg <= 0) return { triggered: false, confidence: 0, data: {}, title: '', description: '' };
      return {
        triggered: true,
        confidence: 1.0,
        data: { new_count: newNeg, total: currNeg },
        title: `${newNeg} new 1-2 star review${newNeg > 1 ? 's' : ''}`,
        description: 'A new negative review was posted. Respond quickly and consider offering remediation.',
      };
    },
  },

  {
    id: 'gbp_review_unanswered',
    connectorType: 'gbp',
    type: 'review_unanswered',
    severity: 'warning',
    name: 'Unanswered Reviews',
    evaluate(current) {
      const count = current?.unanswered_reviews ?? 0;
      if (count === 0) return { triggered: false, confidence: 0, data: {}, title: '', description: '' };
      return {
        triggered: true,
        confidence: 1.0,
        data: { count },
        title: `${count} review${count > 1 ? 's' : ''} awaiting response`,
        description: 'Responding to reviews (especially negative ones) signals an engaged business and improves trust.',
      };
    },
  },

  {
    id: 'gbp_views_drop',
    connectorType: 'gbp',
    type: 'views_drop',
    severity: 'warning',
    name: 'GBP Views Drop',
    evaluate(current, previous) {
      const curr = current?.views_total ?? 0;
      const prev = previous?.views_total ?? 0;
      if (prev === 0) return { triggered: false, confidence: 0, data: {}, title: '', description: '' };
      const dropPct = (prev - curr) / prev;
      if (dropPct < 0.2) return { triggered: false, confidence: 0, data: {}, title: '', description: '' };
      return {
        triggered: true,
        confidence: Math.min(0.9, dropPct),
        data: { from: prev, to: curr, dropPct: Math.round(dropPct * 100) },
        title: `Profile views down ${Math.round(dropPct * 100)}%`,
        description: 'Maps + Search views are dropping. Check listing accuracy, photos, and recent posts.',
      };
    },
  },

  {
    id: 'gbp_calls_drop',
    connectorType: 'gbp',
    type: 'calls_drop',
    severity: 'warning',
    name: 'Phone Calls Drop',
    evaluate(current, previous) {
      const curr = current?.actions_phone ?? 0;
      const prev = previous?.actions_phone ?? 0;
      if (prev < 5) return { triggered: false, confidence: 0, data: {}, title: '', description: '' };
      const dropPct = (prev - curr) / prev;
      if (dropPct < 0.25) return { triggered: false, confidence: 0, data: {}, title: '', description: '' };
      return {
        triggered: true,
        confidence: 0.8,
        data: { from: prev, to: curr },
        title: `Phone calls from GBP fell ${Math.round(dropPct * 100)}%`,
        description: 'Call volume from your business profile has dropped. Verify phone number is correct and visible.',
      };
    },
  },

  {
    id: 'gbp_search_drop',
    connectorType: 'gbp',
    type: 'search_drop',
    severity: 'warning',
    name: 'GBP Search Queries Drop',
    evaluate(current, previous) {
      const curr = current?.queries_total ?? 0;
      const prev = previous?.queries_total ?? 0;
      if (prev === 0) return { triggered: false, confidence: 0, data: {}, title: '', description: '' };
      const dropPct = (prev - curr) / prev;
      if (dropPct < 0.2) return { triggered: false, confidence: 0, data: {}, title: '', description: '' };
      return {
        triggered: true,
        confidence: Math.min(0.9, dropPct),
        data: { from: prev, to: curr, dropPct: Math.round(dropPct * 100) },
        title: `Search queries finding your business down ${Math.round(dropPct * 100)}%`,
        description: 'Fewer searches are surfacing your business. Review categories, services, and posting cadence.',
      };
    },
  },

  {
    id: 'gbp_no_recent_posts',
    connectorType: 'gbp',
    type: 'posting_lapse',
    severity: 'info',
    name: 'No Recent GBP Posts',
    evaluate(current) {
      const days = current?.days_since_post ?? 999;
      if (days <= 14) return { triggered: false, confidence: 0, data: {}, title: '', description: '' };
      return {
        triggered: true,
        confidence: 0.9,
        data: { days_since_post: days },
        title: `No GBP posts in ${days} days`,
        description: 'Regular posts (offers, events, news) keep your profile active and improve visibility.',
      };
    },
  },

  {
    id: 'gbp_unanswered_questions',
    connectorType: 'gbp',
    type: 'unanswered_questions',
    severity: 'info',
    name: 'Unanswered GBP Questions',
    evaluate(current) {
      const count = current?.unanswered_qa ?? 0;
      if (count === 0) return { triggered: false, confidence: 0, data: {}, title: '', description: '' };
      return {
        triggered: true,
        confidence: 1.0,
        data: { count },
        title: `${count} unanswered question${count > 1 ? 's' : ''} on your GBP listing`,
        description: 'Customers and prospects are waiting for answers. Reply to claim authoritative voice.',
      };
    },
  },

  // ─── STRIPE ─────────────────────────────────────────────────────────────────

  {
    id: 'stripe_mrr_drop',
    connectorType: 'stripe',
    type: 'mrr_drop',
    severity: 'alert',
    name: 'Stripe MRR Drop',
    evaluate(current, previous) {
      const curr = current?.mrr ?? 0;
      const prev = previous?.mrr ?? 0;
      if (prev === 0) return { triggered: false, confidence: 0, data: {}, title: '', description: '' };
      const dropPct = (prev - curr) / prev;
      if (dropPct < 0.05) return { triggered: false, confidence: 0, data: {}, title: '', description: '' };
      return {
        triggered: true,
        confidence: 0.9,
        data: { from: prev, to: curr, dropPct: Math.round(dropPct * 100) },
        title: `MRR fell ${Math.round(dropPct * 100)}% (£${prev.toFixed(2)} → £${curr.toFixed(2)})`,
        description: 'Monthly recurring revenue is shrinking. Check for cancellations, downgrades, and failed payments.',
      };
    },
  },

  {
    id: 'stripe_failed_payments',
    connectorType: 'stripe',
    type: 'failed_payments',
    severity: 'alert',
    name: 'Stripe Failed Payments',
    evaluate(current) {
      const count = current?.failed_payments_30d ?? 0;
      if (count <= 3) return { triggered: false, confidence: 0, data: {}, title: '', description: '' };
      return {
        triggered: true,
        confidence: 1.0,
        data: { count },
        title: `${count} failed payments in the last 30 days`,
        description: 'Payment failures hurt revenue and retention. Set up smart retries and dunning emails.',
      };
    },
  },

  {
    id: 'stripe_refund_spike',
    connectorType: 'stripe',
    type: 'refund_spike',
    severity: 'warning',
    name: 'Stripe Refund Spike',
    evaluate(current) {
      const rate = current?.refund_rate ?? 0;
      if (rate <= 5) return { triggered: false, confidence: 0, data: {}, title: '', description: '' };
      return {
        triggered: true,
        confidence: 0.9,
        data: { rate: Math.round(rate * 10) / 10 },
        title: `Refund rate at ${rate.toFixed(1)}% (above 5% threshold)`,
        description: 'Refunds are climbing. Investigate product issues, fulfilment, or customer-experience problems.',
      };
    },
  },

  {
    id: 'stripe_revenue_drop',
    connectorType: 'stripe',
    type: 'revenue_drop',
    severity: 'warning',
    name: 'Stripe Revenue Drop',
    evaluate(current, previous) {
      const curr = current?.revenue_30d ?? 0;
      const prev = previous?.revenue_30d ?? 0;
      if (prev === 0) return { triggered: false, confidence: 0, data: {}, title: '', description: '' };
      const dropPct = (prev - curr) / prev;
      if (dropPct < 0.1) return { triggered: false, confidence: 0, data: {}, title: '', description: '' };
      return {
        triggered: true,
        confidence: 0.85,
        data: { from: prev, to: curr, dropPct: Math.round(dropPct * 100) },
        title: `30-day revenue down ${Math.round(dropPct * 100)}%`,
        description: 'Stripe gross revenue is declining vs the previous period. Drill into channel and product mix.',
      };
    },
  },

  // ─── GITHUB ─────────────────────────────────────────────────────────────────

  {
    id: 'github_open_prs_growing',
    connectorType: 'github',
    type: 'pr_backlog',
    severity: 'info',
    name: 'GitHub PR Backlog Growing',
    evaluate(current) {
      const count = current?.open_prs_total ?? 0;
      if (count <= 10) return { triggered: false, confidence: 0, data: {}, title: '', description: '' };
      return {
        triggered: true,
        confidence: 0.8,
        data: { count },
        title: `${count} open pull requests`,
        description: 'PR backlog is growing. Prioritise reviews to unblock contributors and ship faster.',
      };
    },
  },

  {
    id: 'github_stale_prs',
    connectorType: 'github',
    type: 'stale_prs',
    severity: 'warning',
    name: 'Stale Pull Requests',
    evaluate(current) {
      const count = current?.stale_prs_count ?? 0;
      if (count === 0) return { triggered: false, confidence: 0, data: {}, title: '', description: '' };
      return {
        triggered: true,
        confidence: 0.9,
        data: { count },
        title: `${count} pull request${count > 1 ? 's' : ''} open >14 days`,
        description: 'Stale PRs collect merge conflicts and lose context. Review or close.',
      };
    },
  },

  {
    id: 'github_failing_checks',
    connectorType: 'github',
    type: 'ci_failing',
    severity: 'alert',
    name: 'Failing CI Checks',
    evaluate(current) {
      const count = current?.failing_checks_count ?? 0;
      if (count === 0) return { triggered: false, confidence: 0, data: {}, title: '', description: '' };
      return {
        triggered: true,
        confidence: 1.0,
        data: { count },
        title: `CI failing on ${count} repo${count > 1 ? 's' : ''}`,
        description: 'Default branch builds are failing. Fix before merging more changes.',
      };
    },
  },

  {
    id: 'github_blueprint_pr_pending',
    connectorType: 'github',
    type: 'blueprint_pr',
    severity: 'info',
    name: 'Blueprint PR Pending Review',
    evaluate(current) {
      const count = current?.blueprint_prs_open ?? 0;
      if (count === 0) return { triggered: false, confidence: 0, data: {}, title: '', description: '' };
      const titles = (current?.blueprint_prs_data ?? []).map(p => p.title);
      return {
        triggered: true,
        confidence: 1.0,
        data: { count, titles },
        title: `${count} Blueprint-created PR${count > 1 ? 's' : ''} awaiting review`,
        description: titles.slice(0, 5).map(t => `• ${t}`).join('\n'),
      };
    },
  },

  // ─── GOOGLE ADS ─────────────────────────────────────────────────────────────

  {
    id: 'google_ads_roas_drop',
    connectorType: 'google-ads',
    type: 'roas_drop',
    severity: 'alert',
    name: 'Google Ads ROAS Drop',
    evaluate(current, previous) {
      const curr = current?.roas;
      const prev = previous?.roas;
      if (!curr || !prev || prev === 0) return { triggered: false, confidence: 0, data: {}, title: '', description: '' };
      const dropPct = (prev - curr) / prev;
      if (dropPct < 0.2) return { triggered: false, confidence: 0, data: {}, title: '', description: '' };
      return {
        triggered: true,
        confidence: 0.85,
        data: { from: prev, to: curr, dropPct: Math.round(dropPct * 100) },
        title: `ROAS dropped ${Math.round(dropPct * 100)}% (${prev.toFixed(2)}x → ${curr.toFixed(2)}x)`,
        description: 'Return on ad spend is falling. Check landing pages, audience targeting, and recent creative changes.',
      };
    },
  },

  {
    id: 'google_ads_spend_spike',
    connectorType: 'google-ads',
    type: 'spend_spike',
    severity: 'warning',
    name: 'Google Ads Spend Spike',
    evaluate(current, previous) {
      const curr = current?.total_spend_30d ?? 0;
      const prev = previous?.total_spend_30d ?? 0;
      if (prev === 0) return { triggered: false, confidence: 0, data: {}, title: '', description: '' };
      const increase = (curr - prev) / prev;
      if (increase < 0.25) return { triggered: false, confidence: 0, data: {}, title: '', description: '' };
      return {
        triggered: true,
        confidence: 0.9,
        data: { from: prev, to: curr, increasePct: Math.round(increase * 100) },
        title: `Ad spend up ${Math.round(increase * 100)}% (£${prev.toFixed(2)} → £${curr.toFixed(2)})`,
        description: 'Spend has jumped significantly. Verify this matches a deliberate budget change.',
      };
    },
  },

  {
    id: 'google_ads_cpa_increase',
    connectorType: 'google-ads',
    type: 'cpa_increase',
    severity: 'warning',
    name: 'Google Ads CPA Increase',
    evaluate(current, previous) {
      const curr = current?.cpa;
      const prev = previous?.cpa;
      if (!curr || !prev || prev === 0) return { triggered: false, confidence: 0, data: {}, title: '', description: '' };
      const increase = (curr - prev) / prev;
      if (increase < 0.3) return { triggered: false, confidence: 0, data: {}, title: '', description: '' };
      return {
        triggered: true,
        confidence: 0.8,
        data: { from: prev, to: curr, increasePct: Math.round(increase * 100) },
        title: `CPA up ${Math.round(increase * 100)}% (£${prev.toFixed(2)} → £${curr.toFixed(2)})`,
        description: 'Cost per acquisition rising. Audit underperforming campaigns and ad groups.',
      };
    },
  },

  {
    id: 'google_ads_impression_share_drop',
    connectorType: 'google-ads',
    type: 'impression_share_drop',
    severity: 'warning',
    name: 'Impression Share Drop',
    evaluate(current, previous) {
      const curr = current?.impression_share;
      const prev = previous?.impression_share;
      if (curr == null || prev == null) return { triggered: false, confidence: 0, data: {}, title: '', description: '' };
      const drop = prev - curr;
      if (drop < 0.1) return { triggered: false, confidence: 0, data: {}, title: '', description: '' };
      return {
        triggered: true,
        confidence: 0.8,
        data: { from: prev, to: curr },
        title: `Impression share dropped ${(drop * 100).toFixed(1)}%`,
        description: 'You are losing visibility in auctions. Possible causes: budget caps, bid lowering, or new competition.',
      };
    },
  },

  // ─── Meta Ads rules ────────────────────────────────────────────────────────
  // Rules receive raw fetch payload { account, campaigns, previous }.
  // `flattenMeta` extracts the flat fields needed for comparisons.

  {
    id: 'meta_roas_drop',
    connectorType: 'meta-ads',
    type: 'anomaly',
    severity: 'alert',
    name: 'Meta Ads ROAS Drop',
    evaluate(current) {
      const curr = flattenMeta(current);
      const prev = flattenMetaPrev(current);
      if (!prev || !prev.roas || prev.roas === 0) {
        return { triggered: false, confidence: 0, data: {}, title: '', description: '' };
      }
      const drop = (prev.roas - curr.roas) / prev.roas;
      const triggered = drop > 0.2;
      return {
        triggered,
        confidence: triggered ? Math.min(drop, 1) : 0,
        data: {
          from: +prev.roas.toFixed(2),
          to: +curr.roas.toFixed(2),
          drop_pct: +(drop * 100).toFixed(1),
        },
        title: triggered
          ? `Meta Ads ROAS dropped ${(drop * 100).toFixed(0)}%`
          : '',
        description: triggered
          ? `ROAS fell from ${prev.roas.toFixed(2)}x to ${curr.roas.toFixed(2)}x vs the previous 30-day period. Review audience targeting, creative fatigue, or bid strategy.`
          : '',
      };
    },
  },

  {
    id: 'meta_cpm_spike',
    connectorType: 'meta-ads',
    type: 'anomaly',
    severity: 'warning',
    name: 'Meta CPM Spike',
    evaluate(current) {
      const curr = flattenMeta(current);
      const prev = flattenMetaPrev(current);
      if (!prev || !prev.cpm || prev.cpm === 0) {
        return { triggered: false, confidence: 0, data: {}, title: '', description: '' };
      }
      const increase = (curr.cpm - prev.cpm) / prev.cpm;
      const triggered = increase > 0.3;
      return {
        triggered,
        confidence: triggered ? Math.min(increase, 1) : 0,
        data: {
          from: +prev.cpm.toFixed(2),
          to: +curr.cpm.toFixed(2),
          increase_pct: +(increase * 100).toFixed(1),
        },
        title: triggered
          ? `Meta CPM up ${(increase * 100).toFixed(0)}%`
          : '',
        description: triggered
          ? `CPM rose from £${prev.cpm.toFixed(2)} to £${curr.cpm.toFixed(2)}. Audience saturation or higher auction competition likely.`
          : '',
      };
    },
  },

  {
    id: 'meta_spend_spike',
    connectorType: 'meta-ads',
    type: 'anomaly',
    severity: 'warning',
    name: 'Meta Spend Spike',
    evaluate(current) {
      const curr = flattenMeta(current);
      const prev = flattenMetaPrev(current);
      if (!prev || !prev.spend_30d || prev.spend_30d === 0) {
        return { triggered: false, confidence: 0, data: {}, title: '', description: '' };
      }
      const increase = (curr.spend_30d - prev.spend_30d) / prev.spend_30d;
      const triggered = increase > 0.25;
      return {
        triggered,
        confidence: triggered ? 0.9 : 0,
        data: {
          from: +prev.spend_30d.toFixed(2),
          to: +curr.spend_30d.toFixed(2),
          increase_pct: +(increase * 100).toFixed(1),
        },
        title: triggered ? `Meta spend up ${(increase * 100).toFixed(0)}%` : '',
        description: triggered
          ? `Spend rose from £${prev.spend_30d.toFixed(2)} to £${curr.spend_30d.toFixed(2)} vs the previous 30-day window.`
          : '',
      };
    },
  },

  {
    id: 'meta_frequency_high',
    connectorType: 'meta-ads',
    type: 'risk',
    severity: 'warning',
    name: 'Ad Frequency Too High',
    evaluate(current) {
      const curr = flattenMeta(current);
      const triggered = curr.frequency > 3.5;
      return {
        triggered,
        confidence: triggered ? 0.85 : 0,
        data: {
          frequency: +curr.frequency.toFixed(2),
          note: 'Audiences seeing ads too often — expect rising CPM and falling CTR',
        },
        title: triggered
          ? `Ad frequency at ${curr.frequency.toFixed(2)}`
          : '',
        description: triggered
          ? `Each person in the audience has now seen the ad ${curr.frequency.toFixed(2)} times on average. Rotate creative or expand the audience.`
          : '',
      };
    },
  },

  {
    id: 'meta_roas_below_threshold',
    connectorType: 'meta-ads',
    type: 'risk',
    severity: 'alert',
    name: 'Meta ROAS Below 1x',
    evaluate(current) {
      const curr = flattenMeta(current);
      const triggered = curr.spend_30d > 50 && curr.roas > 0 && curr.roas < 1;
      return {
        triggered,
        confidence: triggered ? 1.0 : 0,
        data: {
          roas: +curr.roas.toFixed(2),
          spend: +curr.spend_30d.toFixed(2),
          note: 'Spending more than earning — immediate review needed',
        },
        title: triggered ? `Meta ROAS below 1x (${curr.roas.toFixed(2)}x)` : '',
        description: triggered
          ? `ROAS is ${curr.roas.toFixed(2)}x on £${curr.spend_30d.toFixed(2)} spend. Campaigns are losing money — pause or restructure.`
          : '',
      };
    },
  },

  {
    id: 'meta_ctr_drop',
    connectorType: 'meta-ads',
    type: 'anomaly',
    severity: 'info',
    name: 'Meta CTR Drop',
    evaluate(current) {
      const curr = flattenMeta(current);
      const prev = flattenMetaPrev(current);
      if (!prev || !prev.ctr || prev.ctr === 0) {
        return { triggered: false, confidence: 0, data: {}, title: '', description: '' };
      }
      const drop = (prev.ctr - curr.ctr) / prev.ctr;
      const triggered = drop > 0.25;
      return {
        triggered,
        confidence: triggered ? 0.8 : 0,
        data: {
          from: +(prev.ctr * 100).toFixed(2) + '%',
          to: +(curr.ctr * 100).toFixed(2) + '%',
        },
        title: triggered ? `Meta CTR dropped ${(drop * 100).toFixed(0)}%` : '',
        description: triggered
          ? `CTR fell from ${(prev.ctr * 100).toFixed(2)}% to ${(curr.ctr * 100).toFixed(2)}%. Creative fatigue is the most common cause.`
          : '',
      };
    },
  },

  {
    id: 'google_ads_low_quality_scores',
    connectorType: 'google-ads',
    type: 'quality_score_drop',
    severity: 'info',
    name: 'Low Quality Score Keywords',
    evaluate(current) {
      const keywords = current?.keywords_data ?? [];
      const lowQS = keywords.filter(k => (k.quality_score ?? 10) < 5 && (k.cost_micros ?? 0) > 1_000_000);
      if (lowQS.length <= 3) return { triggered: false, confidence: 0, data: {}, title: '', description: '' };
      return {
        triggered: true,
        confidence: 0.8,
        data: { count: lowQS.length, keywords: lowQS.slice(0, 10).map(k => k.text) },
        title: `${lowQS.length} keywords with quality score below 5`,
        description: 'Low quality scores increase costs. Improve landing page relevance and ad copy.',
      };
    },
  },
];

// ─── Meta Ads helpers ────────────────────────────────────────────────────────

function _num(v) {
  if (v === null || v === undefined || v === '') return 0;
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

function _getAction(arr, type) {
  if (!Array.isArray(arr)) return 0;
  return _num(arr.find(a => a.action_type === type)?.value);
}

/**
 * Flatten Meta Ads fetch payload to a comparable shape.
 * Handles both raw fetch result (`{account, campaigns, previous}`) and
 * already-flat shapes (defensive against future callers).
 */
export function flattenMeta(payload) {
  if (!payload || typeof payload !== 'object') {
    return { roas: 0, cpm: 0, cpc: 0, ctr: 0, spend_30d: 0, frequency: 0 };
  }

  // Already flat — preserve existing numeric fields
  if ('roas' in payload || 'spend_30d' in payload) {
    return {
      roas: _num(payload.roas),
      cpm: _num(payload.cpm),
      cpc: _num(payload.cpc),
      ctr: _num(payload.ctr),
      spend_30d: _num(payload.spend_30d ?? payload.spend),
      frequency: _num(payload.frequency),
    };
  }

  const current = payload.account?.data?.[0] ?? {};
  const spend = _num(current.spend);
  const revenue = _getAction(current.action_values, 'purchase');
  return {
    roas: spend > 0 ? revenue / spend : 0,
    cpm: _num(current.cpm),
    cpc: _num(current.cpc),
    ctr: _num(current.ctr),
    spend_30d: spend,
    frequency: _num(current.frequency),
  };
}

export function flattenMetaPrev(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const prev = payload.previous?.data?.[0];
  if (!prev) return null;
  const spend = _num(prev.spend);
  const revenue = _getAction(prev.action_values, 'purchase');
  return {
    roas: spend > 0 ? revenue / spend : 0,
    cpm: _num(prev.cpm),
    cpc: _num(prev.cpc),
    ctr: _num(prev.ctr),
    spend_30d: spend,
    frequency: _num(prev.frequency),
  };
}

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
