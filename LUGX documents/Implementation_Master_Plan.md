# LUGX Platform - Implementation Master Plan

## Overview

**LUGX** is a cloud-based AI-powered text editing SaaS platform with the following core capabilities:
- **AI Functions**: Correct, Improve, Summarize, Translate, ToPrompt (paid only)
- **File Management**: PDF/TXT/MD import, cloud storage, nested folders
- **Subscription Tiers**: Free, Pro ($12/month), Ultra ($120/month)
- **Design Philosophy**: "Quiet Luxury" - dark mode, Zinc palette, Electric Indigo accents

---

## Document Analysis Summary

### Consistency Check ✅

| Document | Status | Notes |
|----------|--------|-------|
| System Architecture | ✅ | Tech stack aligned with Project Structure |
| Project Structure | ✅ | Next.js 15 App Router pattern confirmed |
| UI/UX Guidelines | ✅ | Tailwind + shadcn/ui compatible |
| PRD | ✅ | Features map to architecture |
| Subscription Plans | ✅ | Quotas defined for all tiers |
| AI Key Document | ✅ | Models & params specified per feature |
| Prompt Files (5) | ✅ | System prompts ready for integration |

### Key Technical Decisions Extracted

```
Frontend: Next.js 15 → Vercel Edge Functions
    ├── Supabase Auth (Authentication)
    ├── Neon PostgreSQL + Drizzle ORM (Database)
    ├── Upstash Redis (Key Rotation)
    ├── Supabase Storage (Files)
    └── Gemini AI API (AI Processing)
```

---

## Proposed Changes

### Component 1: Project Foundation
- **package.json**: Next.js 15, React 19, TypeScript, all dependencies
- **next.config.mjs**: App Router config
- **tailwind.config.ts**: Zinc palette, custom fonts
- **drizzle.config.ts**: Neon connection

### Component 2: Database Schema
```typescript
// Tables: users, files, subscriptions, usage
users: { id: uuid, email, displayName, tier, createdAt }
files: { id, userId, title, content, parentFolderId, isFolder }
subscriptions: { id, userId, stripeCustomerId, tier, status }
usage: { id, userId, date, correctWords, improveWords, translateWords, summarizeCount, toPromptCount }
```

### Component 3: Authentication Layer
- Supabase client (server & client)
- Google OAuth
- Middleware route protection

### Component 4: AI Integration
- Redis key rotation (20 requests per key)
- Gemini client with dynamic key
- System prompts (LPE, SEE, DCE, DSE, LBE)
- Server Actions for all AI operations

### Component 5: Tier Configuration
| Tier | Correct/Improve/Translate | Summarize | ToPrompt |
|------|--------------------------|-----------|----------|
| Free | 2,000 words/week | 500 words, 1/day | Hidden |
| Pro | 20,000 words/day | 5,000 words, 5/day | 10/day |
| Ultra | 250,000 words/day | 30,000 words, 50/day | 500/day |

### Component 6: UI Design System
- `bg-zinc-950` base background
- `indigo-500` AI accent with glow
- Geist Sans + IBM Plex Sans Arabic
- 300-500ms ease-out transitions

### Component 7: Core Pages
- Dashboard (subscription cards)
- Workspace (editor + sidebar)
- Account (profile + settings)

### Component 8: Editor Components
- TipTap borderless editor
- AI floating menu
- Auto-save with word count

### Component 9: File Management
- PDF text extraction
- Drag & drop file tree
- Export to MD/TXT/PDF

### Component 10: Payment Integration
- Stripe webhooks
- Subscription management

---

## File Creation Order

1. package.json → next.config.mjs → tailwind.config.ts
2. drizzle.config.ts → src/lib/db/*
3. src/lib/supabase/* → src/lib/redis.ts
4. src/lib/ai/* → src/config/*
5. src/middleware.ts → src/server/actions/*
6. src/app/globals.css → src/components/ui/*
7. src/app/layout.tsx → all pages
8. src/components/editor/* → src/components/ai/*
9. src/app/api/webhooks/*

---

## Verification Plan

### Automated Tests
1. Key rotation after 20 requests
2. Quota validation per tier
3. AI operations with mock responses
4. Database schema validation

### Browser Tests
1. Authentication flow (Google OAuth)
2. Editor functionality
3. AI tool interactions

### Manual Verification
- [ ] UI/UX compliance (Zinc colors, Indigo accents)
- [ ] RTL support
- [ ] Stripe payment flow

---

## Estimated Time: 25-35 hours
