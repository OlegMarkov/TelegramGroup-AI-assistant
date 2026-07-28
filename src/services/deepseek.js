const axios = require('axios');
const config = require('../config');
const logger = require('../utils/logger');

const client = axios.create({
  baseURL: config.deepseek.baseUrl,
  headers: {
    Authorization: `Bearer ${config.deepseek.apiKey}`,
    'Content-Type': 'application/json',
  },
  timeout: 30000,
});

async function chatCompletion(messages, { temperature = 0.5, maxTokens = 800 } = {}) {
  try {
    const { data } = await client.post('/chat/completions', {
      model: config.deepseek.model,
      messages,
      temperature,
      max_tokens: maxTokens,
    });
    return data.choices[0].message.content.trim();
  } catch (error) {
    logger.error('DeepSeek API request failed', {
      message: error.message,
      response: error.response && error.response.data,
    });
    throw new Error('Failed to get a response from DeepSeek');
  }
}

async function summarize(text, { language = 'the same language as the input' } = {}) {
  return chatCompletion([
    {
      role: 'system',
      content: `You are a concise assistant that summarizes content in ${language}. Produce a short bullet-point summary highlighting only the key facts.`,
    },
    { role: 'user', content: text },
  ]);
}

module.exports = { chatCompletion, summarize };
