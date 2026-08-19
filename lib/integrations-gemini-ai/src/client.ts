import { GoogleGenAI } from "@google/genai";

let client: GoogleGenAI | null = null;

/** Initialize Gemini only when an OCR request is made. */
export function getAi(): GoogleGenAI {
  if (client) return client;
  const baseUrl = process.env.AI_INTEGRATIONS_GEMINI_BASE_URL;
  const apiKey = process.env.AI_INTEGRATIONS_GEMINI_API_KEY;
  if (!baseUrl || !apiKey) {
    throw new Error(
      "Gemini OCR is not configured; set AI_INTEGRATIONS_GEMINI_BASE_URL and AI_INTEGRATIONS_GEMINI_API_KEY",
    );
  }
  client = new GoogleGenAI({
    apiKey,
    httpOptions: {
      apiVersion: "",
      baseUrl,
      timeout: 45_000,
      retryOptions: { attempts: 2 },
    },
  });
  return client;
}
