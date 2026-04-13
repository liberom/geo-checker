module.exports = async function (req, res) {
  const key = req.query.key || (req.body && req.body.key);
  const targetUrl = req.query.url || (req.body && req.body.url);
  const competitorUrl = req.query.competitorUrl || (req.body && req.body.competitorUrl);
  const manualText = req.body && req.body.manualText;

  const validateLicense = (k) => {
    if (!k || typeof k !== 'string') return { valid: false };
    const parts = k.split('_');
    if (parts.length < 2) return { valid: false };
    const prefix = parts[0].toLowerCase();
    const segments = parts[1].split('-');
    if (segments.length !== 6) return { valid: false };

    const expected = ['v', 'y', 'n', 'i', 'x'];
    for (let i = 0; i < 5; i++) {
      if (!segments[i] || segments[i].charAt(0).toLowerCase() !== expected[i]) {
        return { valid: false };
      }
    }

    const expDateStr = segments[5];
    if (expDateStr.length !== 4) return { valid: false };
    const expMonth = parseInt(expDateStr.slice(0, 2), 10);
    const expYear = parseInt('20' + expDateStr.slice(2, 4), 10);

    const now = new Date();
    const currMonth = now.getMonth() + 1;
    const currYear = now.getFullYear();

    let expired = false;
    if (currYear > expYear || (currYear === expYear && currMonth > expMonth)) {
      expired = true;
    }

    return { valid: true, expired, isMidMarket: prefix === 'mid' };
  };

  const license = validateLicense(key);
  if (!license.valid) {
    return res.status(401).json({ error: 'Unauthorized: Invalid license structure' });
  }
  if (license.expired) {
    return res.status(403).json({ error: 'License Expired' });
  }

  const isMidMarket = license.isMidMarket;

  if (!targetUrl) {
    return res.status(400).json({ error: 'Missing target URL' });
  }

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  try {
    const fetchSite = async (urlStr, charLimit, isTarget = true) => {
      let htmlContent = '';

      const renderFlag = isTarget || isMidMarket ? 'true' : 'false';
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 60000);

      try {
        const scraperUrl = `https://api.scraperapi.com/?api_key=${process.env.SCRAPERAPI_KEY || ''}&url=${encodeURIComponent(urlStr)}&render=${renderFlag}`;

        const siteCall = await fetch(scraperUrl, { signal: controller.signal });

        if (siteCall.status === 403 || siteCall.status === 429) {
          throw new Error('SCRAPE_FAILED');
        }

        if (siteCall.ok) {
          htmlContent = await siteCall.text();
        } else {
          throw new Error('SCRAPE_FAILED');
        }
      } catch (err) {
        if (err.name === 'AbortError' || err.message === 'SCRAPE_FAILED') {
          throw new Error('SCRAPE_FAILED');
        }
      } finally {
        clearTimeout(timeoutId);
      }

      if (!htmlContent || htmlContent.length < 250) {
        throw new Error('SCRAPE_FAILED');
      }

      const titleMatch = htmlContent.match(/<title[^>]*>([^<]+)<\/title>/i);
      const title = titleMatch ? titleMatch[1].trim() : 'No Title Found';
      const descMatch = htmlContent.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["'][^>]*>/i)
        || htmlContent.match(/<meta[^>]*content=["']([^"']+)["'][^>]*name=["']description["'][^>]*>/i);
      const description = descMatch ? descMatch[1].trim() : 'No Meta Description Found';
      const h1Matches = [...htmlContent.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/gi)].map(m => m[1].replace(/<[^>]+>/g, '').trim()).filter(Boolean);
      const altMatches = [...htmlContent.matchAll(/<img[^>]*alt=["']([^"']+)["'][^>]*>/gi)].map(m => m[1].trim()).filter(Boolean);
      
      const structuredDataMatches = [...htmlContent.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
      let schemaStr = '';
      if (structuredDataMatches.length > 0) {
        schemaStr = '==== START TECHNICAL SCHEMA ====\n' + structuredDataMatches.map(m => m[1].trim()).join('\n---\n') + '\n==== END TECHNICAL SCHEMA ====\n\n';
      }
      
      const seoMetaStr = `[META TITLE]: ${title}\n[META DESCRIPTION]: ${description}\n[H1 TAGS]: ${h1Matches.join(' | ')}\n[IMAGE ALTS]: ${altMatches.slice(0, 10).join(' | ')}\n\n${schemaStr}[PAGE TEXT]:\n`;

      let textContent = htmlContent
        .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
        .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

      return (seoMetaStr + textContent).slice(0, charLimit);
    };

    let targetText = '';
    let compText = '';

    if (manualText) {
      targetText = manualText.substring(0, 5000);
    } else {
      const limit = competitorUrl ? 2500 : 5000;
      targetText = await fetchSite(targetUrl, limit, true);
      if (competitorUrl) compText = await fetchSite(competitorUrl, limit, false);
    }

    let systemPrompt = '';
    let userPrompt = '';

    if (competitorUrl && isMidMarket) {
      systemPrompt = `You are a world-class SEO, AEO, and GEO strategic consultant. This is a $3,000/month premium engagement. Your deliverable is a 10-item Comprehensive Action Plan that demonstrates enterprise-grade expertise.

FIRST: Cross-reference the TECHNICAL SCHEMA block (delimited by ==== START TECHNICAL SCHEMA ==== and ==== END TECHNICAL SCHEMA ====). You MUST check this block before auditing. If a schema type (e.g., FAQPage, LocalBusiness, Organization, Product) is present in that block, you are STRICTLY FORBIDDEN from flagging it as a "Missing Gap" in your analysis. Only flag schema elements that are ACTUALLY ABSENT from the TECHNICAL SCHEMA block.

Provide 3 paragraphs of strategic analysis identifying Semantic Gaps and competitive positioning for AI citation.

FINALLY: Output a strict JSON block with 10 Comprehensive Action Items categorized into these EXACT buckets:
{
  "target": { "seo": { "meta": 80, "headers": 70, "mobile": 90 }, "aeo": { "directness": 60, "schema": 50 }, "geo": { "citability": 65, "authority": 70 } },
  "competitor": { "seo": { "meta": 85, "headers": 80, "mobile": 95 }, "aeo": { "directness": 75, "schema": 60 }, "geo": { "citability": 90, "authority": 85 } },
  "priorities": {
    "immediateTechnicalFixes": [
      "Technical fix 1...",
      "Technical fix 2...",
      "Technical fix 3..."
    ],
    "answerEngineOptimization": [
      "AEO action 1...",
      "AEO action 2...",
      "AEO action 3..."
    ],
    "localAuthorityGEO": [
      "GEO action 1...",
      "GEO action 2..."
    ],
    "quickWins": [
      "Quick win 1...",
      "Quick win 2..."
    ]
  }
}`;
      userPrompt = `Analyze and compare these two websites:\n\n=== TARGET [${targetUrl}] ===\n${targetText}\n\n=== COMPETITOR [${competitorUrl}] ===\n${compText}`;
    } else if (isMidMarket) {
      systemPrompt = `You are a world-class SEO, AEO, and GEO strategic consultant. This is a $3,000/month premium engagement. Your deliverable is a 10-item Comprehensive Action Plan that demonstrates enterprise-grade expertise.

FIRST: Cross-reference the TECHNICAL SCHEMA block (delimited by ==== START TECHNICAL SCHEMA ==== and ==== END TECHNICAL SCHEMA ====). You MUST check this block before auditing. If a schema type (e.g., FAQPage, LocalBusiness, Organization, Product) is present in that block, you are STRICTLY FORBIDDEN from flagging it as a "Missing Gap" in your analysis. Only flag schema elements that are ACTUALLY ABSENT from the TECHNICAL SCHEMA block.

Provide 3 paragraphs of strategic analysis identifying Semantic Gaps and Answer Engine positioning.

FINALLY: Output a strict JSON block with 10 Comprehensive Action Items categorized into these EXACT buckets:
{
  "seo": { "meta": 80, "headers": 70, "mobile": 90 },
  "aeo": { "directness": 60, "schema": 50 },
  "geo": { "citability": 65, "authority": 70 },
  "priorities": {
    "immediateTechnicalFixes": [
      "Technical fix 1...",
      "Technical fix 2...",
      "Technical fix 3..."
    ],
    "answerEngineOptimization": [
      "AEO action 1...",
      "AEO action 2...",
      "AEO action 3..."
    ],
    "localAuthorityGEO": [
      "GEO action 1...",
      "GEO action 2..."
    ],
    "quickWins": [
      "Quick win 1...",
      "Quick win 2..."
    ]
  }
}`;
      userPrompt = `Analyze this website content:\n\n${targetText}`;
    } else {
      systemPrompt = `You are a world-class SEO, AEO, and GEO strategic consultant. This is a $3,000/month premium engagement. Your deliverable is a 10-item Comprehensive Action Plan that demonstrates enterprise-grade expertise.

FIRST: Cross-reference the TECHNICAL SCHEMA block (delimited by ==== START TECHNICAL SCHEMA ==== and ==== END TECHNICAL SCHEMA ====). You MUST check this block before auditing. If a schema type (e.g., FAQPage, LocalBusiness, Organization, Product) is present in that block, you are STRICTLY FORBIDDEN from flagging it as a "Missing Gap" in your analysis. Only flag schema elements that are ACTUALLY ABSENT from the TECHNICAL SCHEMA block.

Provide 3 paragraphs of strategic analysis regarding SEO, AEO, and GEO potential.

FINALLY: Output a strict JSON block with 10 Comprehensive Action Items categorized into these EXACT buckets:
{
  "seo": { "meta": 80, "headers": 70, "mobile": 90 },
  "aeo": { "directness": 60, "schema": 50 },
  "geo": { "citability": 65, "authority": 70 },
  "priorities": {
    "immediateTechnicalFixes": [
      "Technical fix 1...",
      "Technical fix 2...",
      "Technical fix 3..."
    ],
    "answerEngineOptimization": [
      "AEO action 1...",
      "AEO action 2...",
      "AEO action 3..."
    ],
    "localAuthorityGEO": [
      "GEO action 1...",
      "GEO action 2..."
    ],
    "quickWins": [
      "Quick win 1...",
      "Quick win 2..."
    ]
  }
}`;
      userPrompt = `Analyze this website content:\n\n${targetText}`;
    }

    const isRetry = req.query.retry === 'true' || (req.body && req.body.retry === 'true');
    if (isRetry) {
      systemPrompt += `\n\nCRITICAL INSTRUCTION: You MUST include the final JSON block exactly as requested. Failure to do so will break the application. Output the JSON and ONLY the JSON at the very end. DO NOT wrap the JSON in markdown formatting (like \`\`\`json). Just return the raw JSON braces.`;
    }

    // 2. Call OpenRouter API with Stream
    let orReq = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://geo-checker-gold.vercel.app',
        'X-Title': 'Vynix Analyzer'
      },
      body: JSON.stringify({
        model: 'minimax/minimax-m2.7',
        stream: true,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ]
      })
    });

    if (!orReq.ok) {
      const errorBody = await orReq.text();
      console.error('OpenRouter Error Body:', errorBody);
      throw new Error(`OpenRouter API error: ${orReq.statusText}`);
    }

    // Pipe the response stream to the client explicitly mapped as a decoded string
    const reader = orReq.body.getReader();
    const decoder = new TextDecoder('utf-8');

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      res.write(chunk); // Output guaranteed string maintaining standard SSE format (data: ...\n\n) from OpenRouter
    }

    res.write('data: [DONE]\n\n');
    res.end();
  } catch (error) {
    if (error.message === 'SCRAPE_FAILED') {
      res.write(`data: {"error": "SCRAPE_FAILED", "message": "Security Shield Detected"}\n\n`);
    } else {
      res.write(`data: {"error": "${error.message}"}\n\n`);
    }
    res.end();
  }
};
