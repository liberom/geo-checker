module.exports = async function (req, res) {
  const key = req.query.key || (req.body && req.body.key);
  const targetUrl = req.query.url || (req.body && req.body.url);

  const validateLicense = (k) => {
    console.log('[License] Validating key:', k ? '***' + k.slice(-4) : 'null');
    if (!k || typeof k !== 'string') {
      console.log('[License] Invalid: missing or not a string');
      return { valid: false };
    }
    const parts = k.split('_');
    if (parts.length < 2) {
      console.log('[License] Invalid: missing underscore separator');
      return { valid: false };
    }
    const prefix = parts[0].toLowerCase();
    console.log('[License] Prefix:', prefix);
    const segmentsString = parts[1];
    const segments = segmentsString.split('-');
    console.log('[License] Segments count:', segments.length);
    if (segments.length !== 6) {
      console.log('[License] Invalid: expected 6 segments, got', segments.length);
      return { valid: false };
    }

    const expected = ['v', 'y', 'n', 'i', 'x'];
    for (let i = 0; i < 5; i++) {
      if (!segments[i] || segments[i].charAt(0).toLowerCase() !== expected[i]) {
        console.log(`[License] Invalid: segment ${i} does not start with '${expected[i]}'`);
        return { valid: false };
      }
    }
    console.log('[License] Segments validation passed');

    const expDateStr = segments[5];
    if (expDateStr.length !== 4) {
      console.log('[License] Invalid: expiration date must be 4 digits, got', expDateStr.length);
      return { valid: false };
    }
    const expMonth = parseInt(expDateStr.slice(0, 2), 10);
    const expYear = parseInt('20' + expDateStr.slice(2, 4), 10);
    console.log(`[License] Expiration date: ${expMonth}/${expYear}`);

    const now = new Date();
    const currMonth = now.getMonth() + 1;
    const currYear = now.getFullYear();
    console.log(`[License] Current date: ${currMonth}/${currYear}`);

    let expired = false;
    if (currYear > expYear || (currYear === expYear && currMonth > expMonth)) {
      expired = true;
    }
    console.log('[License] Expired:', expired);

    // Determine flags (extra parts after the second)
    const flags = parts.slice(2);
    console.log('[License] Flags:', flags);
    const isOwner = prefix === 'owner' || flags.includes('owner');
    const isMidMarket = prefix === 'mid';
    const isBig = prefix === 'big';
    const isSmb = prefix === 'smb';
    console.log('[License] Tier:', isOwner ? 'owner' : isMidMarket ? 'mid' : isBig ? 'big' : isSmb ? 'smb' : 'unknown');

    return { valid: true, expired, isOwner, isMidMarket, isBig, isSmb };
  };

  const license = validateLicense(key);
  console.log('[License] Result:', license);
  if (!license.valid) {
    console.log('[License] Invalid license structure, returning 401');
    return res.status(401).json({ error: 'Unauthorized: Invalid license structure' });
  }
  if (license.expired) {
    console.log('[License] License expired, returning 403');
    return res.status(403).json({ error: 'License Expired' });
  }
  console.log('[License] Valid license, proceeding');

  const isOwner = license.isOwner;
  const isMidMarket = license.isMidMarket;
  console.log('[License] isOwner:', isOwner, 'isMidMarket:', isMidMarket);

  if (!targetUrl) {
    console.log('[License] Missing target URL, returning 400');
    return res.status(400).json({ error: 'Missing target URL' });
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000);
    let htmlContent = '';

    try {
      const apiKey = process.env.SCRAPERAPI_KEY || '';
      // Owner tier gets full render for better probing
      const render = isOwner ? 'true' : 'false';
      const scraperUrl = `https://api.scraperapi.com/?api_key=${apiKey}&url=${encodeURIComponent(targetUrl)}&render=${render}`;

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

    // Quick text extraction
    const textContent = htmlContent
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
      .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 3000);

    // Generate discovery queries and brand name
    async function generateDiscoveryQueries(text) {
      const prompt = `Extract the brand name and generate 3 discovery queries based on the following website text. The queries should be typical search queries someone might use to find this brand or similar entities. Return a JSON object with keys "brand" (string) and "queries" (array of 3 strings).

Website text:
${text}

JSON:`;

      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://geo-checker-gold.vercel.app',
          'X-Title': 'Vynix Analyzer'
        },
        body: JSON.stringify({
          model: 'openai/gpt-4o-mini',
          messages: [
            { role: 'user', content: prompt }
          ],
          max_tokens: 300
        })
      });

      if (!response.ok) {
        const errText = await response.text();
        console.error('Query generation error:', errText);
        throw new Error('QUERY_GENERATION_FAILED');
      }

      const result = await response.json();
      const content = result.choices?.[0]?.message?.content;
      if (!content) {
        throw new Error('QUERY_GENERATION_NO_CONTENT');
      }
      // Extract JSON block (LLM may include conversational text around it)
      const jsonMatch = content.match(/\{[\s\S]*"brand"[\s\S]*"queries"[\s\S]*\}/i);
      if (!jsonMatch) {
        throw new Error('QUERY_GENERATION_NO_JSON');
      }
      const parsed = JSON.parse(jsonMatch[0]);
      return { brand: parsed.brand, queries: parsed.queries };
    }

    // Perform adversarial probing with given brand and queries
    async function performProbing(brand, queries, model) {
      const prompt = `You are an AI auditor. Based only on your internal training data, list the top entities for these queries. Does "${brand}" appear?

Queries:
${queries.map((q, i) => `${i+1}. ${q}`).join('\n')}

Evaluate the brand's presence: if not mentioned in training data, citationShare = 0%; if mentioned but with hallucinations/errors, citationShare = 50%; if cited accurately as a primary entity, citationShare = 100%.

Return your answer ONLY as a strict JSON format with exactly one key "citationShare" which is a percentage from 0 to 100.

Example: {"citationShare": 75}`;

      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://geo-checker-gold.vercel.app',
          'X-Title': 'Vynix Analyzer'
        },
        body: JSON.stringify({
          model: model,
          messages: [
            { role: 'user', content: prompt }
          ],
          max_tokens: 300
        })
      });

      if (!response.ok) {
        const errText = await response.text();
        console.error(`Probing error with model ${model}:`, errText);
        throw new Error(`PROBING_FAILED_${model}`);
      }

      const data = await response.json();
      const content = data.choices?.[0]?.message?.content;
      if (!content) {
        throw new Error(`PROBING_NO_CONTENT_${model}`);
      }
      // Extract JSON block (LLM may wrap in markdown or conversational text)
      let jsonStr = content.replace(/```json/g, '').replace(/```/g, '').trim();
      const jsonMatch = jsonStr.match(/\{[\s\S]*?"citationShare"[\s\S]*?\}/i);
      if (!jsonMatch) {
        throw new Error(`PARSE_ERROR_${model}`);
      }
      const parsed = JSON.parse(jsonMatch[0]);
      const share = Number(parsed.citationShare);
      if (isNaN(share)) {
        throw new Error(`PARSE_ERROR_INVALID_NUMBER_${model}`);
      }
      return Math.min(100, Math.max(0, share));
    }

    // Generate queries first
    let brand, queries;
    try {
      // If textContent is too short, derive brand from URL hostname
      if (textContent.length < 10) {
        let hostname;
        try {
          hostname = new URL(targetUrl).hostname.replace(/^www\./, '');
        } catch (e) {
          hostname = 'unknown-domain.com';
        }
        brand = hostname;
        queries = [
          `Top ${brand} competitors`,
          `Who is the founder of ${brand}?`,
          `${brand} reviews and reputation`
        ];
      } else {
        const result = await generateDiscoveryQueries(textContent);
        brand = result.brand && result.brand.trim();
        queries = result.queries;
        // Fallback for brand extraction
        if (!brand) {
          // Try to extract brand from textContent (first capitalized multi-word sequence)
          const match = textContent.match(/[A-Z][a-zA-Z0-9]+(?:\s+[A-Z][a-zA-Z0-9]+)*/);
          brand = match ? match[0] : 'Unknown Brand';
        }
        // Ensure queries is an array of 3 strings
        if (!Array.isArray(queries) || queries.length < 3) {
          queries = [
            `Top ${brand} competitors`,
            `Who is the founder of ${brand}?`,
            `${brand} reviews and reputation`
          ];
        }
      }
    } catch (err) {
      console.error('Failed to generate discovery queries:', err);
      // Return error with parsingError flag
      return res.status(500).json({ error: 'Query generation failed', parsingError: true });
    }

    // Determine which model(s) to use
    let models;
    if (isOwner) {
      models = ['xiaomi/mimo-v2-flash', 'minimax/minimax-m2.5', 'openai/gpt-4o-mini'];
    } else {
      models = ['minimax/minimax-m2.7']; // default model for non-owner tiers
    }

    // Perform probing with each model in parallel
    const probingPromises = models.map(model => 
      performProbing(brand, queries, model)
        .then(share => ({ success: true, share }))
        .catch(err => {
          console.error(`Probing failed for model ${model}:`, err);
          return { success: false, share: null };
        })
    );
    
    const results = await Promise.all(probingPromises);
    const citationShares = results.map(r => r.share);

    // Compute final citation share
    let citationShare;
    let parsingError = false;
    const validShares = citationShares.filter(s => s !== null);
    if (validShares.length === 0) {
      citationShare = 0;
      parsingError = true;
    } else {
      citationShare = Math.round(validShares.reduce((a, b) => a + b, 0) / validShares.length);
    }

    // Return result
    res.status(200).json({ citationShare, parsingError });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};
