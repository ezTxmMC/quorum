// Vorlagen für OpenAI-kompatible Dienste: Basis-URL und Hinweis; Modelle werden über „Verbindung testen“ per /models geladen.
export interface ApiPreset { name: string; baseUrl: string; local?: boolean; note?: string }

export const API_PRESETS: ApiPreset[] = [
  { name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1' },
  { name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1' },
  { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1' },
  { name: 'Mistral', baseUrl: 'https://api.mistral.ai/v1' },
  { name: 'xAI', baseUrl: 'https://api.x.ai/v1' },
  { name: 'Cerebras', baseUrl: 'https://api.cerebras.ai/v1' },
  { name: 'Together', baseUrl: 'https://api.together.xyz/v1' },
  { name: 'Fireworks', baseUrl: 'https://api.fireworks.ai/inference/v1' },
  { name: 'Google Gemini (OpenAI-kompatibel)', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai' },
  { name: 'Moonshot (Kimi)', baseUrl: 'https://api.moonshot.ai/v1' },
  { name: 'LM Studio', baseUrl: 'http://127.0.0.1:1234/v1', local: true },
  { name: 'llama.cpp server', baseUrl: 'http://127.0.0.1:8080/v1', local: true },
  { name: 'vLLM', baseUrl: 'http://127.0.0.1:8000/v1', local: true },
  { name: 'Jan', baseUrl: 'http://127.0.0.1:1337/v1', local: true },
  { name: 'KoboldCpp', baseUrl: 'http://127.0.0.1:5001/v1', local: true },
];

/** Typische lokale Server, die beim Suchen auf 127.0.0.1 abgefragt werden (nur GET /models, ohne Zugangsdaten). */
export const LOCAL_PROBES: { name: string; port: number; path: string }[] = [
  { name: 'LM Studio', port: 1234, path: '/v1' },
  { name: 'llama.cpp server / LocalAI / mlx-lm', port: 8080, path: '/v1' },
  { name: 'vLLM', port: 8000, path: '/v1' },
  { name: 'Jan', port: 1337, path: '/v1' },
  { name: 'KoboldCpp', port: 5001, path: '/v1' },
  { name: 'TabbyAPI / text-generation-webui', port: 5000, path: '/v1' },
  { name: 'Lemonade', port: 13305, path: '/v1' },
  { name: 'Docker Model Runner', port: 12434, path: '/engines/v1' },
];
