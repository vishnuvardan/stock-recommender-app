import express from 'express';
import cors from 'cors';
import axios from 'axios';
import dotenv from 'dotenv';
import { GoogleGenAI } from '@google/genai';

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS for frontend integration
app.use(cors());
app.use(express.json());

// Initialize Google GenAI client
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Ordered list of models for fallback
const GEMINI_MODELS = [
  'gemini-3.5-flash',       // Primary stable target
  'gemini-3.1-flash-lite',  // High-efficiency alternative
  'gemini-2.5-flash',       // Highly responsive fallback
  'gemini-2.5-flash-lite',  // Core light fallback
  'gemini-3.1-flash',       // Next-gen flash alternative
  'gemini-3-flash',         // Tier 3 flash model
  'gemini-3.1-pro',         // High-reasoning backup
  'gemini-2.5-pro',         // Stable professional backup
  'gemini-3-pro',           // Alternate high-intelligence tier
  'gemini-3-deep-think'     // Ultimate deep analysis tier fallback
];

const SYSTEM_INSTRUCTION = `You are an expert Indian financial market macro analyst specializing in the NSE and BSE. Your task is to process 20 live market headlines. 

1. Filter and evaluate how each piece of news impacts India's economy or specific publicly listed Indian companies on the NSE/BSE. 
2. Categorize every relevant news item strictly into one of three classifications:
   - "Good news": Positive economic, sector, or company-specific catalysts.
   - "No change": Neutral news, general market noise, or items with no short-term impact.
   - "Bad news": Negative regulatory, earnings, macroeconomic, or company-specific headwinds.
3. Generate recommendations based on the classification:
   - For "Good news": Recommend a highly relevant Indian stock ticker (NSE/BSE) that will likely benefit, along with a concise summary explanation of why it can go up.
   - For "No change": Identify a related Indian stock/sector asset that matches the theme of the headline, but explicitly tag the recommendation action as "HOLD/MONITOR" with no directional target.
   - For "Bad news": Recommend a related Indian stock ticker likely to drop, along with a concise summary explanation of why it can go down.

Return STRICTLY a JSON object matching this structural schema:
{
  "disclaimer": "This analysis is purely for swing trading purposes. Market news has highly volatile short-term impacts that can reverse rapidly. We are NOT SEBI registered advisors. This output is an AI-generated text analysis and does NOT constitute formal financial advice. Use your own knowledge and due diligence before making any trade decisions. We hold zero liability for financial actions taken based on this tool.",
  "lastUpdated": "ISO Timestamp",
  "items": [
    {
      "headline": "Original news title",
      "summary": "Original news description",
      "classification": "Good news" | "No change" | "Bad news",
      "relatedStock": "NSE/BSE Ticker (e.g. RELIANCE, TCS, HDFCBANK, INFY, TATASTEEL). MUST be a valid Indian stock ticker. Do NOT recommend foreign stocks like TSLA, AAPL, NVDA.",
      "recommendationReason": "Concise 2-sentence rationale outlining the directional momentum or lack thereof."
    }
  ]
}`;

// Structured JSON output schema definition to prevent JSON parse errors
const RECOMMENDATION_SCHEMA = {
  type: "object",
  properties: {
    disclaimer: { type: "string" },
    lastUpdated: { type: "string" },
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          headline: { type: "string" },
          summary: { type: "string" },
          classification: { 
            type: "string", 
            enum: ["Good news", "No change", "Bad news"] 
          },
          relatedStock: { type: "string" },
          recommendationReason: { type: "string" }
        },
        required: ["headline", "summary", "classification", "relatedStock", "recommendationReason"]
      }
    }
  },
  required: ["disclaimer", "lastUpdated", "items"]
};

// Express Request Logger Middleware
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] Incoming Request: ${req.method} ${req.url}`);
  console.log(`[Headers]:`, JSON.stringify(req.headers));
  next();
});

app.get('/api/news', async (req, res) => {
  const startTime = Date.now();
  console.log(`[${new Date().toISOString()}] GET /api/news: Starting news retrieval...`);

  try {
    const finnhubToken = process.env.FINNHUB_API_KEY || 'd99jf91r01qssj13hm60d99jf91r01qssj13hm6g';
    const finnhubUrl = `https://finnhub.io/api/v1/news?category=general&token=${finnhubToken}`;

    console.log(`[${new Date().toISOString()}] Initiating Axios fetch to Finnhub news API...`);
    const fetchStart = Date.now();
    const newsResponse = await axios.get(finnhubUrl);
    console.log(`[${new Date().toISOString()}] Finnhub response received in ${Date.now() - fetchStart}ms. Status: ${newsResponse.status}`);

    if (!Array.isArray(newsResponse.data)) {
      console.error(`[${new Date().toISOString()}] Finnhub response data is not an array:`, newsResponse.data);
      throw new Error('Invalid response structure from Finnhub news API');
    }

    // Extract first 20 articles directly as-is
    const rawArticles = newsResponse.data.slice(0, 20);
    console.log(`[${new Date().toISOString()}] Mapped ${rawArticles.length} articles from Finnhub feed.`);

    // Map to clean format containing title, description, and original URL
    const cleanArticles = rawArticles.map((item, index) => {
      return {
        title: item.headline || 'No Headline',
        description: item.summary || 'No Summary Available',
        url: item.url || ''
      };
    });

    console.log(`[${new Date().toISOString()}] Successfully completed news retrieval in ${Date.now() - startTime}ms.`);
    return res.json({ items: cleanArticles });

  } catch (error) {
    console.error(`[${new Date().toISOString()}] Fatal Error fetching news:`, error);
    return res.status(500).json({
      error: 'An internal server error occurred while retrieving news.',
      message: error.message
    });
  }
});

app.post('/api/recommendations', async (req, res) => {
  const startTime = Date.now();
  console.log(`[${new Date().toISOString()}] POST /api/recommendations: Starting processing pipeline...`);

  try {
    const { articles } = req.body;
    if (!Array.isArray(articles) || articles.length === 0) {
      console.warn(`[${new Date().toISOString()}] Request validation failed: articles array is missing or empty.`);
      return res.status(400).json({
        error: 'Invalid request body. An array of "articles" is required.'
      });
    }

    // Map to clean format for prompt inputs
    const cleanArticles = articles.slice(0, 20).map((item, index) => {
      console.log(`  [Payload Article #${index + 1}] Title: "${item.title || 'No Headline'}"`);
      return {
        title: item.title || 'No Headline',
        description: item.description || 'No Summary Available'
      };
    });

    const promptArticles = cleanArticles.map(a => ({ title: a.title, description: a.description }));
    const userPrompt = `Here are the latest 20 live news headlines. Evaluate and categorize them based on the system instructions. Focus strictly on NSE/BSE stock recommendations. Current date: ${new Date().toISOString()}.\n\nArticles:\n${JSON.stringify(promptArticles, null, 2)}`;

    let geminiResponseText = null;
    let successfulModel = null;
    const errorsList = [];

    console.log(`[${new Date().toISOString()}] Beginning Gemini fallback loop across ${GEMINI_MODELS.length} candidate models...`);

    // Fallback loop over models
    for (let i = 0; i < GEMINI_MODELS.length; i++) {
      const model = GEMINI_MODELS[i];
      const modelStartTime = Date.now();
      try {
        console.log(`[${new Date().toISOString()}] [Attempt #${i + 1}/${GEMINI_MODELS.length}] Sending payload to model: "${model}"...`);
        console.log(`  [Config]: responseMimeType="application/json", systemInstruction length=${SYSTEM_INSTRUCTION.length} chars, prompt length=${userPrompt.length} chars`);

        const response = await ai.models.generateContent({
          model: model,
          contents: userPrompt,
          config: {
            systemInstruction: SYSTEM_INSTRUCTION,
            responseMimeType: 'application/json',
            responseSchema: RECOMMENDATION_SCHEMA
          }
        });

        if (response && response.text) {
          geminiResponseText = response.text;
          successfulModel = model;
          console.log(`[${new Date().toISOString()}] SUCCESS with model "${model}" in ${Date.now() - modelStartTime}ms. Response length: ${geminiResponseText.length} characters.`);
          break;
        } else {
          console.warn(`[${new Date().toISOString()}] Model "${model}" completed execution but returned empty response text.`);
          errorsList.push({ model, error: 'Empty text response received' });
        }
      } catch (error) {
        console.warn(`[${new Date().toISOString()}] Model "${model}" FAILED after ${Date.now() - modelStartTime}ms:`, error.message);
        if (error.stack) {
          console.warn(`  [Stack Trace]:`, error.stack);
        }
        errorsList.push({ model, error: error.message });
      }
    }

    // If all models failed, throw fallback exhaustion error
    if (!geminiResponseText) {
      console.error(`[${new Date().toISOString()}] FATAL: Complete Gemini fallback exhaustion. All ${GEMINI_MODELS.length} models failed. Details:`, JSON.stringify(errorsList, null, 2));
      return res.status(502).json({
        error: 'Complete Gemini fallback exhaustion. All attempted models failed.',
        details: errorsList
      });
    }

    // Parse the JSON returned by Gemini
    console.log(`[${new Date().toISOString()}] Attempting to parse response text from Gemini...`);
    let recommendationData;
    try {
      recommendationData = JSON.parse(geminiResponseText);
      console.log(`[${new Date().toISOString()}] Successfully parsed Gemini JSON payload.`);
    } catch (parseError) {
      console.error(`[${new Date().toISOString()}] JSON Parse Error. Succeeded model: "${successfulModel}". Raw text returned was:`);
      console.error(geminiResponseText);
      console.error(parseError);
      return res.status(500).json({
        error: 'Invalid JSON structure returned by Gemini AI.',
        rawResponse: geminiResponseText
      });
    }

    // Log metrics on classifications
    if (recommendationData && Array.isArray(recommendationData.items)) {
      const good = recommendationData.items.filter(item => item.classification === 'Good news').length;
      const bad = recommendationData.items.filter(item => item.classification === 'Bad news').length;
      const neutral = recommendationData.items.filter(item => item.classification === 'No change').length;
      console.log(`[${new Date().toISOString()}] Recommendation Metrics -> Total: ${recommendationData.items.length} items | Bullish: ${good} | Bearish: ${bad} | Neutral: ${neutral}`);
    }

    // Attach metadata about which model succeeded for verification
    recommendationData.processedByModel = successfulModel;

    console.log(`[${new Date().toISOString()}] Completed request successfully. Pipeline time: ${Date.now() - startTime}ms.`);
    return res.json(recommendationData);

  } catch (error) {
    console.error(`[${new Date().toISOString()}] Fatal Error handling recommendations request:`, error);
    return res.status(500).json({
      error: 'An internal server error occurred while processing recommendations.',
      message: error.message
    });
  }
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  console.log(`Active environment port configuration: ${process.env.PORT || 'Default 3000'}`);
});

export default app;
