# LUGX Platform — AI Models & Hyperparameters Configuration

This document specifies the decoupled JSON configuration architecture for Gemini models, hyperparameters, and tier allocations across all AI operations in the LUGX platform.

---

## 1. Central Configuration File

* **File Location:** [`src/config/models.config.json`](file:///d:/Projects/lugx_merge_branch/src/config/models.config.json)
* **Imported by:** [`src/lib/ai/client.ts`](file:///d:/Projects/lugx_merge_branch/src/lib/ai/client.ts) and testing suites.

---

## 2. Configuration Schema

```json
{
  "operation_name": {
    "free": "model-identifier or null",
    "pro": "model-identifier",
    "ultra": "model-identifier",
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

## 3. Supported AI Operations

| Operation Key | Description | Free Tier Default | Pro / Ultra Default |
| :--- | :--- | :--- | :--- |
| `correct` | Grammar & spelling correction | `gemini-2.5-flash-lite` | `gemini-flash-lite-latest` |
| `improve` | Style & phrasing enhancement | `gemini-2.5-flash-lite` | `gemini-3-flash-preview` |
| `summarize` | Executive & concise summarization | `gemini-2.5-flash-lite` | `gemini-2.5-flash-lite` |
| `toPrompt` | Text-to-LLM system prompt generation | `null` (Disabled) | `gemini-3-flash-preview` (with Thinking Budget) |
| `translate` | High-fidelity translation | `gemini-2.5-flash-lite` | `gemini-3-flash-preview` |

---

## 4. How to Update Models

To change any model or adjust generation parameters (temperature, penalties, topP):
1. Edit [`src/config/models.config.json`](file:///d:/Projects/lugx_merge_branch/src/config/models.config.json).
2. Save the file.
3. The AI engine (`client.ts`) instantly picks up the new configuration without requiring code refactoring.
