> **Translation Notice:** This document was originally authored in Arabic and has been
> translated into English while preserving its complete content and all original details.
> It remains part of the immutable founding design record (`docs/foundation/`) and does
> **not** describe current system behavior.

# AI Key Document  Core Capability Pillars & Operating Parameters

The core capabilities of the artificial intelligence ecosystem revolve around five
structural pillars, detailed below with their technical specifications and operational
parameters:

**First: The Correct Function**
This function relies on a dual technical architecture: the `gemini-2.0-flash-lite`
model serves as the primary pillar for Free-plan users, while `gemini-flash-lite-latest`
is allocated to advanced tiers (Ultra & Pro). Operations are activated through the
reference system prompt in [[correct]], with technical parameters set at Temperature
0.1 and Top-p 0.75 to achieve the highest levels of linguistic precision.

**Second: The Improve Function**
The text-enhancement feature rests on advanced processing engines: `Gemini 2.5
Flash-Lite` is employed within the free tier, while performance for tiers (Ultra & Pro)
relies on `Gemini-3-flash-preview`. Its operating protocol is invoked from [[improve]],
with a technical configuration comprising Temperature 0.7, Top-p 0.95, Frequency Penalty
0.2, and Presence Penalty 0.5, fostering creative expansion of the text.

**Third: The Summarize Function**
The text-condensation feature adopts `Gemini 2.5 Flash-Lite` as the unified technical
standard across all available plans, referring to the system prompt in [[summarize]].
Precise operating settings are allocated to this function: Temperature 0.2, Top-p 0.80,
Frequency Penalty 0.6, and Presence Penalty 0.3, ensuring concise, information-focused
summaries.

**Fourth: The To Prompt Feature**
This function is a technical exclusivity for paid subscribers (Ultra & Pro), relying
entirely on the capabilities of `Gemini-3-flash-preview`. Its prompting system is
available in [[toPrompt]], calibrated at Temperature 0.4, Top-p 0.90, Frequency Penalty
0.5, and Presence Penalty 0.4, achieving the optimal balance between structure and
innovation in command generation.

**Fifth: The Translate Function**
Language-transfer capability is realized through a two-model integration: `Gemini 2.5
Flash-Lite` is used in the Free plan, and `Gemini-3-flash-preview` is dedicated to the
professional tiers (Ultra & Pro). The system prompt is sourced from [[translate]], with
a technical configuration of Temperature 0.3, Top-p 0.85, Frequency Penalty 0.3, and
Presence Penalty 0.2, ensuring linguistic fluency and cross-language fidelity of meaning.
