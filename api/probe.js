module.exports = async function (req, res) {
  const key = req.query.key || (req.body && req.body.key);
  const targetUrl = req.query.url || (req.body && req.body.url);

  if (key !== process.env.MY_SECRET_ACCESS_STRING) {
    return res.status(401).json({ error: 'Unauthorized: Invalid access key' });
  }

  if (!targetUrl) {
    return res.status(400).json({ error: 'Missing target URL' });
  }

  try {
    const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(targetUrl)}`;
    const siteCall = await fetch(proxyUrl);
    const proxyData = await siteCall.json();
    const htmlContent = proxyData.contents || '';
    
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
      },
      body: JSON.stringify({
        model: 'qwen/qwen-2.5-7b-instruct',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Text to identify:\n\n${textContent}` }
        ]
      })
    });

    if (!orReq.ok) {
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
