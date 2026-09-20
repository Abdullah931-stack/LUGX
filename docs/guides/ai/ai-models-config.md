# LUGX Platform — AI Models & Hyperparameters Configuration

This document specifies the decoupled JSON configuration architecture for Gemini models, hyperparameters, and tier allocations across all AI operations in the LUGX platform.

---

## 1. Central Configuration File

* **File Location:** [`src/config/models.config.json`](../../../src/config/models.config.json)
* **Imported by:** [`src/lib/ai/client.ts`](../../../src/lib/ai/client.ts) and test suites.

---

## 2. Configuration Schema

```json
{
  "operation_name": {
    "free": "primary-model-identifier or null",
    "pro": "primary-model-identifier",
    "ultra": "primary-model-identifier",
    "fallback": {
      "free": "fallback-model-identifier",
      "pro": "fallback-model-identifier",
      "ultra": "fallback-model-identifier"
    },
    "secondaryFallback": {
      "free": "secondary-fallback-model-identifier",
      "pro": "secondary-fallback-model-identifier",
      "ultra": "secondary-fallback-model-identifier"
    },
    "tertiaryFallback": {
      "free": "tertiary-fallback-model-identifier",
      "pro": "tertiary-fallback-model-identifier",
      "ultra": "tertiary-fallback-model-identifier"
    },
    "temperature": 0.0 - 1.0,
    "topP": 0.0 - 1.0,
    "frequencyPenalty": 0.0 - 1.0,
    "presencePenalty": 0.0 - 1.0,
    "thinkingLevel": {
      "pro": "medium",
      "ultra": "high"
    }
  }
}
```

---

## 3. Supported AI Operations & Cascading Model Fallback Matrix

| Operation Key | Description | Primary Model | Fallback #1 | Fallback #2 (Secondary) | Fallback #3 (Emergency) |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `correct` | Grammar & spelling correction | `gemini-3.7-flash` | `gemini-3.6-flash` | `gemini-3.5-flash-lite` | `gemini-3.1-flash-lite` |
| `improve` | Style & phrasing enhancement | `gemini-3.7-flash` | `gemini-3.6-flash` | `gemini-3.5-flash-lite` | `gemini-3.1-flash-lite` |
| `summarize` | Executive & concise summarization | `gemini-3.7-flash` | `gemini-3.6-flash` | `gemini-3.5-flash-lite` | `gemini-3.1-flash-lite` |
| `toPrompt` | Text-to-LLM prompt generation | `gemini-3.7-flash` (Pro/Ultra) | `gemini-3.6-flash` | `gemini-3.5-flash-lite` | `gemini-3.1-flash-lite` |
| `translate` | High-fidelity translation | `gemini-3.7-flash` | `gemini-3.6-flash` | `gemini-3.5-flash-lite` | `gemini-3.1-flash-lite` |

---

## 4. How to Update Models

To change any model or adjust generation parameters (temperature, penalties, topP, thinkingLevel):
1. Edit [`src/config/models.config.json`](../../../src/config/models.config.json).
2. Save the file.
3. The AI engine (`client.ts`) and Circuit Breaker automatically read the updated definitions at runtime without requiring code refactoring.
