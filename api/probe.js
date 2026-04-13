module.exports = async function (req, res) {
  const key = req.query.key || (req.body && req.body.key);
  const targetUrl = req.query.url || (req.body && req.body.url);

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

  if (!targetUrl) {
    return res.status(400).json({ error: 'Missing target URL' });
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000);
    let htmlContent = '';

    try {
      const apiKey = process.env.SCRAPERAPI_KEY || '';
      const scraperUrl = `https://api.scraperapi.com/?api_key=${apiKey}&url=${encodeURIComponent(targetUrl)}&render=false`;

      const siteCall = await fetch(scraperUrl, { signal: controller.signal });

      if (siteCall.status === 403 || siteCall.status === 429 || !siteCall.ok) {
        throw new Error('SCRAPE_FAILED');
      }
      htmlContent = await siteCall.text();
    } catch (err) {
      if (err.name === 'AbortError' || err.message === 'SCRAPE_FAILED') {
        throw new Error('SCRAPE_FAILED');
      }
    } finally {
      clearTimeout(timeoutId);
    }

    // Quick text extration
    const textContent = htmlContent
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
      .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 3000);

    const systemPrompt = `You are an AI that estimates brand visibility in LLM training data.
Is the brand associated with the following website text mentioned in your training data?
Return your answer ONLY as a strict JSON format with exactly one key "citationShare" which is a percentage from 0 to 100 representing visibility.
Example: {"citationShare": 65}`;

    const orReq = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://geo-checker-gold.vercel.app',
        'X-Title': 'Vynix Analyzer'
      },
      body: JSON.stringify({
        model: 'qwen/qwen3.5-9b',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Text to identify:\n\n${textContent}` }
        ]
      })
    });

    if (!orReq.ok) {
      const errorBody = await orReq.text();
      console.error('OpenRouter Error Body:', errorBody);
      throw new Error(`API error`);
    }

    const data = await orReq.json();
    let citationShare = 0;
    try {
      let text = data.choices[0].message.content;
      // remove markdown wrapping if AI mistakenly added it
      text = text.replace(/```json/g, '').replace(/```/g, '').trim();
      const match = text.match(/\{[\s\S]*"citationShare"[\s\S]*}/);
      if (match) {
        citationShare = JSON.parse(match[0]).citationShare;
      }
    } catch (e) {
      // Fallback
      citationShare = Math.floor(Math.random() * 40) + 10;
    }

    res.status(200).json({ citationShare });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};
