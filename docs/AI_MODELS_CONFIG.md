# LUGX Platform — AI Models & Hyperparameters Configuration

This document specifies the decoupled JSON configuration architecture for Gemini models, hyperparameters, and tier allocations across all AI operations in the LUGX platform.

---

## 1. Central Configuration File

* **File Location:** [`src/config/models.config.json`](file:///d:/Projects/lugx_merge_branch/src/config/models.config.json)
* **Imported by:** [`src/lib/ai/client.ts`](file:///d:/Projects/lugx_merge_branch/src/lib/ai/client.ts) and test suites.

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
    "temperature": 0.0 - 1.0,
    "topP": 0.0 - 1.0,
    "frequencyPenalty": 0.0 - 1.0,
    "presencePenalty": 0.0 - 1.0,
    "thinkingLevel": {
      "pro": "low",
      "ultra": "high"
    }
  }
}
```

---

## 3. Supported AI Operations & Primary / Fallback Model Matrix

| Operation Key | Description | Free Tier (Primary / Fallback) | Pro Tier (Primary / Fallback) | Ultra Tier (Primary / Fallback) |
| :--- | :--- | :--- | :--- | :--- |
| `correct` | Grammar & spelling correction | `gemini-3.7-flash` / `gemini-3.6-flash` | `gemini-3.7-flash` / `gemini-3.6-flash` | `gemini-3.7-flash` / `gemini-3.6-flash` |
| `improve` | Style & phrasing enhancement | `gemini-3.7-flash` / `gemini-3.6-flash` | `gemini-3.7-flash` / `gemini-3.6-flash` | `gemini-3.7-flash` / `gemini-3.6-flash` |
| `summarize` | Executive & concise summarization | `gemini-3.7-flash` / `gemini-3.6-flash` | `gemini-3.7-flash` / `gemini-3.6-flash` | `gemini-3.7-flash` / `gemini-3.6-flash` |
| `toPrompt` | Text-to-LLM system prompt generation | `null` (Disabled) | `gemini-3.7-flash` (Thinking: low) | `gemini-3.7-flash` (Thinking: high) |
| `translate` | High-fidelity translation | `gemini-3.7-flash` / `gemini-3.6-flash` | `gemini-3.7-flash` / `gemini-3.6-flash` | `gemini-3.7-flash` / `gemini-3.6-flash` |

---

## 4. How to Update Models

To change any model or adjust generation parameters (temperature, penalties, topP, thinkingLevel):
1. Edit [`src/config/models.config.json`](file:///d:/Projects/lugx_merge_branch/src/config/models.config.json).
2. Save the file.
3. The AI engine (`client.ts`) and Circuit Breaker automatically read the updated definitions at runtime without requiring code refactoring.
