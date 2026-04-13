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
    const fetchSite = async (urlStr, charLimit) => {
      let htmlContent = '';
      let fetchSuccess = false;

      // 1. Primary: Direct Fetch Spoofing
      try {
        const directUrl = new URL(urlStr).toString();
        const directCall = await fetch(directUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36 Vynix/1.0' }
        });
        if (directCall.ok) {
          htmlContent = await directCall.text();
          if (htmlContent && htmlContent.length >= 250) fetchSuccess = true;
        }
      } catch (err) {}

      // 2. Fallback: Proxy Fetch
      if (!fetchSuccess) {
        try {
          const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(urlStr)}`;
          const siteCall = await fetch(proxyUrl);
          if (siteCall.ok) {
            const proxyData = await siteCall.json();
            htmlContent = proxyData.contents || '';
          }
        } catch (err) {}
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
      const seoMetaStr = `[META TITLE]: ${title}\n[META DESCRIPTION]: ${description}\n[H1 TAGS]: ${h1Matches.join(' | ')}\n[IMAGE ALTS]: ${altMatches.slice(0, 10).join(' | ')}\n\n[PAGE TEXT]:\n`;

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
      targetText = manualText.substring(0, 6000);
    } else {
      const limit = competitorUrl ? 3500 : 6000;
      targetText = await fetchSite(targetUrl, limit);
      if (competitorUrl) compText = await fetchSite(competitorUrl, limit);
    }

    let systemPrompt = '';
    let userPrompt = '';

    if (competitorUrl && isMidMarket) {
      systemPrompt = `You are a highly aggressive SEO, AEO, and GEO gap-analysis auditor.
First, provide 3 paragraphs identifying specific 'Semantic Gaps' where the Target is missing technical authority and exactly why the Competitor is more likely to be cited by Gemini or AI Answer Engines.
Finally, output a strict JSON block exactly in this multi-site format:
{
  "target": { "seo": { "meta": 80, "headers": 70, "mobile": 90 }, "aeo": { "directness": 60, "schema": 50 }, "geo": { "citability": 65, "authority": 70 } },
  "competitor": { "seo": { "meta": 85, "headers": 80, "mobile": 95 }, "aeo": { "directness": 75, "schema": 60 }, "geo": { "citability": 90, "authority": 85 } },
  "priorities": [
    "Strategic Action Plan 1...",
    "Strategic Action Plan 2...",
    "Strategic Action Plan 3..."
  ]
}`;
      userPrompt = `Analyze and compare these two websites:\n\n=== TARGET [${targetUrl}] ===\n${targetText}\n\n=== COMPETITOR [${competitorUrl}] ===\n${compText}`;
    } else if (isMidMarket) {
      systemPrompt = `You are a highly aggressive SEO, AEO, and GEO auditor.
First, provide 3 paragraphs identifying specific 'Semantic Gaps' where the site is missing technical authority and exactly why it might be ignored by Answer Engines.
Finally, output a strict JSON block containing granular scores (0-100) and your 'Top 3 Strategic Action Plan' exactly in this format:
{
  "seo": { "meta": 80, "headers": 70, "mobile": 90 },
  "aeo": { "directness": 60, "schema": 50 },
  "geo": { "citability": 65, "authority": 70 },
  "priorities": [
    "Strategic Action Plan 1...",
    "Strategic Action Plan 2...",
    "Strategic Action Plan 3..."
  ]
}`;
      userPrompt = `Analyze this website content:\n\n${targetText}`;
    } else {
      systemPrompt = `You are an expert SEO, AEO (Answer Engine Optimization), and GEO (Generative Engine Optimization) auditor.
First, provide 3 paragraphs of verbal analysis regarding the SEO, AEO, and GEO potential of the content.
Finally, output a strict JSON block containing granular scores (0-100) and your top 3 specific, actionable priorities exactly in this format:
{
  "seo": { "meta": 80, "headers": 70, "mobile": 90 },
  "aeo": { "directness": 60, "schema": 50 },
  "geo": { "citability": 65, "authority": 70 },
  "priorities": [
    "Fix missing primary H1 tags to establish clear information hierarchy...",
    "Inject schema.org FAQ modules to assist Answer Engine extraction...",
    "Increase brand citability by acquiring digital PR links..."
  ]
}`;
      userPrompt = `Analyze this website content:\n\n${targetText}`;
    }

    const isRetry = req.query.retry === 'true' || (req.body && req.body.retry === 'true');
    if (isRetry) {
      systemPrompt += `\n\nCRITICAL INSTRUCTION: You MUST include the final JSON block exactly as requested. Failure to do so will break the application. Output the JSON and ONLY the JSON at the very end. DO NOT wrap the JSON in markdown formatting (like \`\`\`json). Just return the raw JSON braces.`;
    }

    // 2. Call OpenRouter API with Stream
    const orReq = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'qwen/qwen3.5-9b',
        stream: true,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ]
      })
    });

    if (!orReq.ok) {
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
