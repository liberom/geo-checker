module.exports = async function (req, res) {
  const key = req.query.key || (req.body && req.body.key);
  const targetUrl = req.query.url || (req.body && req.body.url);

  if (key !== process.env.MY_SECRET_ACCESS_STRING) {
    return res.status(401).json({ error: 'Unauthorized: Invalid access key' });
  }

  if (!targetUrl) {
    return res.status(400).json({ error: 'Missing target URL' });
  }

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  try {
    // 1. Fetch site text via proxy using AllOrigins
    const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(targetUrl)}`;
    const siteCall = await fetch(proxyUrl);
    
    if (!siteCall.ok) {
      throw new Error('Failed to fetch target URL via proxy');
    }
    
    const proxyData = await siteCall.json();
    const htmlContent = proxyData.contents || '';
    
    // Quick extraction of text from HTML to optimize tokens
    const textContent = htmlContent
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
      .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 8000); // 8k chars approx 2k tokens

    const systemPrompt = `You are an expert SEO, AEO (Answer Engine Optimization), and GEO (Generative Engine Optimization) auditor.
First, provide 3 paragraphs of verbal analysis regarding the SEO, AEO, and GEO potential of the content.
Finally, output a strict JSON block containing granular scores (0-100) exactly in this format:
{
  "seo": { "meta": 80, "headers": 70, "mobile": 90 },
  "aeo": { "directness": 60, "schema": 50 },
  "geo": { "citability": 65, "authority": 70 }
}`;

    // 2. Call OpenRouter API with Stream
    const orReq = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'qwen/qwen-2.5-7b-instruct',
        stream: true,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Analyze this website content:\n\n${textContent}` }
        ]
      })
    });

    if (!orReq.ok) {
        throw new Error(`OpenRouter API error: ${orReq.statusText}`);
    }

    // Pipe the response stream to the client
    const reader = orReq.body.getReader();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
    
    res.end();
  } catch (error) {
    // Send standard SSE error chunk if something fails
    res.write(`data: {"error": "${error.message}"}\n\n`);
    res.end();
  }
};
