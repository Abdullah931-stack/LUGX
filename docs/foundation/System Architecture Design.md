> **Translation Notice:** This document was originally authored in Arabic and has been
> translated into English while preserving its complete content and all original details.
> It remains part of the immutable founding design record (`docs/foundation/`) and does
> **not** describe current system behavior.

### Identity & Access Management Ecosystem

**Core Advantages:**
Establishing an advanced authentication system grounded in automated retention of user
data and its integration with user profiles, guaranteeing data synchronization across
cloud environments (Cloud Synchronization) and easing location-independent access via
personal accounts. Trusted authentication protocols must be supported, including email
and third-party integrations via Supabase Auth.

---

### Data Architecture Infrastructure

**Core Advantages:**
The system requires integrating an advanced authentication protocol with the database to
efficiently manage customer records, accounts, and digital identifiers (User IDs). The
design guarantees an exclusive binding between each user and their personal data, with
strict isolation policies preventing unauthorized access outside the permission scope,
in addition to automated tracking of subscriptions and their associated operational data.

*Technical note:* A **Multi-Database Architecture** model is adopted to raise performance
efficiency by dedicating databases to specific technical tasks — such as using **Redis**
(via Upstash) for API key rotation management, and employing specialized databases for
file and structured-data storage.

---

### Automated Payment & Billing Ecosystem

**Core Advantages:**
Providing an integrated payment environment for subscription management that updates
service levels (Subscription Tiers) automatically upon transaction confirmation. This is
achieved through integration with reputable external payment gateways supporting multiple
options, committed to providing the following payment channels: PayPal, credit cards
(Visa), plus Apple Pay and Google Pay.

---

### Technical Foundation & Artificial Intelligence Management

**Intelligent Key Rotation System:**
The project adopts a sophisticated system for managing API keys using **Redis** (via
Upstash) to ensure service continuity and efficiency:
*   **Load distribution:** Keys rotate automatically; each key is allocated a fixed
    number of requests (e.g., 20 requests as an environment variable) before moving to
    the next key.
*   **Interference prevention:** Redis usage guarantees accurate counting and prevents
    overlapping concurrent requests.
*   **Intelligent error handling:** The key is force-switched immediately upon technical
    error codes (such as quota exhaustion, invalid request, or server error).

**Key Rotation Mechanism Diagram:**
```
┌─────────────────────────────────────────────────────┐
│                  Key Rotation System                │
├─────────────────────────────────────────────────────┤
│  Key Pool: [key1, key2, key3, ... ]                 │
│                                                     │
│  ┌──────────┐    ┌──────────┐    ┌──────────┐       │
│  │  Key 1   │───▶│  Key 2   │───▶│  Key 3   │──▶... │
│  │ (20 req) │    │ (20 req) │    │ (20 req) │       │
│  └──────────┘    └──────────┘    └──────────┘       │
│       ▲                                    │        │
│       └────────────────────────────────────┘        │
│                  (Circular Rotation)                │
├─────────────────────────────────────────────────────┤
│  Redis State:                                       │
│  - current_key_index: Current index                 │
│  - usage_count_N: Per-key usage counter             │
└─────────────────────────────────────────────────────┘
```

---

### Approved Technology Stack
```
┌─────────────────────────────────────────────────┐
│  Vercel (Frontend + Edge Functions)            │
│  + Neon (PostgreSQL Database)                  │
│  + Drizzle ORM (Query Layer)                   │
│  + Supabase Auth (Authentication)              │  
│  + Supabase Storage (File Management)          │  
│  + Upstash Redis (Key Rotation)                │
└─────────────────────────────────────────────────┘
```

### Decision Implementation Roadmap

**Phase One: Structural Foundation**
1. Launch the Vercel project based on Next.js 15.
2. Connect the Neon database through Vercel integrations.
3. Configure Drizzle ORM with the Neon Serverless engine.
4. Build the initial schema for users, files, and subscriptions.

**Phase Two: Authentication Engineering**
1. Activate the Supabase Auth module (independently of the database).
2. Configure the Google OAuth provider.
3. Integrate JWT tokens with row-level security protocols in Neon.
4. Develop a custom authentication interface using the Shadcn UI library.

**Phase Three: File Governance**
1. Activate the Supabase Storage module.
2. Initialize storage buckets isolated per user.
3. Implement PDF file processing for text extraction.
4. Link files to the Neon database via foreign keys.

**Phase Four: The Rotation Operating System**
1. Set up the Upstash Redis environment.
2. Implement the key rotation system per the reference document.
3. Test error-handling resilience (Rate Limit, Invalid Request).
4. Continuously monitor rotation operation performance.

---

### Residual Risks Analysis

1. **Hybrid Integration Complexity (Neon & Supabase Auth):**
Since Supabase Auth issues JWTs containing UUID identifiers, data-shape consistency in
the Neon schema must be guaranteed.
**Corrective action:** adopt UUID as the primary identifier in Neon instead of serial IDs.

2. **Realtime Concurrency Constraints (Realtime Subscriptions):**
Supabase Realtime features are limited to its own databases; this necessitates
alternative solutions for live updates (such as file synchronization).
**Corrective action:** apply periodic Polling at intervals (5–10 seconds) to ensure data
consistency.

---

### Critical Strategic & Technical Blind-Spots Report

This report monitors four fundamental gaps (legal, technical, and operational) whose
neglect could cause operational paralysis or severe financial and legal consequences.

***

**1. Session Token Hijacking in Cloud Environments**
*   **Security challenge:** session-token theft is a growing threat due to its ability to
    bypass two-factor authentication (2FA).
*   **Technical flaw:** relying on cookies without verifying device fingerprint or
    geolocation legitimizes unauthorized access.
*   **Binding protocol:**
    *   **Token Binding:** generate a unique digital fingerprint (Device Fingerprint)
        per session.
    *   **Cross-verification:** match the device fingerprint against records stored in
        Redis before processing sensitive requests.

**2. Denial-of-Service Attacks & Resource Exhaustion (DDoS & Resource Exhaustion)**
*   **Defensive gap:** absence of protections against API-key exhaustion via intensive
    requests.
*   **Engineering solution:**
    *   **Multi-level Rate Limiting:** enforce constraints at IP, digital identity, and
        operation-type levels.
    *   **Web Application Firewalls (WAF):** activate filtering layers via Cloudflare or
        Vercel WAF.

**3. API Key Exposure Risks**
*   **Architectural mistake:** using environment variables client-side exposes sensitive
    keys.
*   **Absolute security principle:** permanently bar browser access to keys and confine
    AI request processing to the server side with periodic key rotation.

***

### Operational & Financial Risks

**4. Absence of Usage Quota Governance**
*   **Financial gap:** risk of a single user consuming resources exceeding their
    subscription revenue value.
*   **Control mechanism:**
    *   **Proactive cost estimation:** compute data volume before execution and compare
        it against the available balance.
    *   **Consumption transparency:** provide visual indicators encouraging users to
        upgrade their plan.


***

### Immediate Action Plan
1. **Legal review:** immediately draft Data Processing Agreements (DPA) and terms of service.
2. **Architectural hardening:** move sensitive operations server-side and activate "Rate Limiting" protocols.
3. **Cost governance:** build a Usage Tracker system wired directly into the billing ecosystem.

