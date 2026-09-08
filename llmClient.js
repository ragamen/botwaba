// llmClient.js
// Cliente unificado con failover automático:
// Primario: Ollama Cloud (glm-5.3-flash:cloud)
// Secundario/Fallback: OpenRouter (z-ai/glm-5.3-flash)
'use strict';

const OLLAMA_DEFAULT_KEY = '0ae046c5630a4258b0fc1f52c8a353b0.5b8py6AnO6krNwHmqkKoH7-L';

/**
 * Limpia posibles etiquetas <think>...</think> de modelos con razonamiento
 */
function cleanThinking(text) {
  if (!text) return '';
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

/**
 * Ejecuta una llamada de chat completion probando primero Ollama Cloud
 * y conmutando automáticamente a OpenRouter si Ollama falla o expira el timeout.
 *
 * @param {Object} params
 * @param {Array} params.messages Arreglo de mensajes [{role, content}]
 * @param {Object} [params.response_format] Formato de respuesta, ej: { type: 'json_object' }
 * @param {number} [params.temperature]
 * @param {number} [params.timeoutMs=25000] Timeout en milisegundos para Ollama antes de conmutar
 * @returns {Promise<{ content: string, usage: Object|null, model: string, provider: 'ollama'|'openrouter' }>}
 */
async function callLlmChat({ messages, response_format, temperature, timeoutMs = 25000 }) {
  const ollamaKey = process.env.OLLAMA_API_KEY || OLLAMA_DEFAULT_KEY;
  const ollamaBaseUrl = process.env.OLLAMA_BASE_URL || 'https://ollama.com/v1';
  const ollamaModel = process.env.OLLAMA_MODEL || 'glm-5.3-flash:cloud';

  const openRouterKey = process.env.OPENROUTER_API_KEY;
  const openRouterModel = process.env.OPENROUTER_FALLBACK_MODEL || 'z-ai/glm-5.3-flash';

  // 1. INTENTO PRIMARIO: Ollama Cloud (glm-5.3-flash:cloud)
  if (ollamaKey) {
    try {
      console.log(`[LLM] 🟢 Intentando proveedor primario: Ollama Cloud (${ollamaModel})...`);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      const requestBody = {
        model: ollamaModel,
        messages,
        stream: false
      };
      if (response_format) requestBody.response_format = response_format;
      if (typeof temperature === 'number') requestBody.temperature = temperature;

      const res = await fetch(`${ollamaBaseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${ollamaKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal
      });
      clearTimeout(timer);

      if (res.ok) {
        const data = await res.json();
        let content = data.choices?.[0]?.message?.content || '';
        content = cleanThinking(content);
        console.log(`[LLM] ✅ Respuesta exitosa de Ollama Cloud (${ollamaModel})`);
        return {
          content,
          usage: data.usage || null,
          model: ollamaModel,
          provider: 'ollama'
        };
      } else {
        const errText = await res.text();
        console.warn(`[LLM] ⚠️ Ollama Cloud devolvió error ${res.status}: ${errText.substring(0, 200)}. Activando fallback a OpenRouter...`);
      }
    } catch (err) {
      console.warn(`[LLM] ⚠️ Error / Timeout en Ollama Cloud: ${err.message}. Activando fallback a OpenRouter...`);
    }
  } else {
    console.warn(`[LLM] ⚠️ No hay OLLAMA_API_KEY configurada. Pasando directo a OpenRouter.`);
  }

  // 2. INTENTO SECUNDARIO (FALLBACK): OpenRouter (z-ai/glm-5.3-flash)
  console.log(`[LLM] 🔄 Ejecutando Fallback: OpenRouter (${openRouterModel})...`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const openRouterPayload = {
    model: openRouterModel,
    messages
  };
  if (response_format) openRouterPayload.response_format = response_format;
  if (typeof temperature === 'number') openRouterPayload.temperature = temperature;

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${openRouterKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(openRouterPayload),
    signal: controller.signal
  });
  clearTimeout(timer);

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Fallback OpenRouter (${res.status}): ${errText.substring(0, 200)}`);
  }

  const data = await res.json();
  let content = data.choices?.[0]?.message?.content || '';
  content = cleanThinking(content);
  console.log(`[LLM] ✅ Respuesta exitosa de Fallback OpenRouter (${openRouterModel})`);

  return {
    content,
    usage: data.usage || null,
    model: openRouterModel,
    provider: 'openrouter'
  };
}

module.exports = {
  callLlmChat,
  cleanThinking
};
