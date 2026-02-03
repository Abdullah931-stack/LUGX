This design is based on **Next.js 15 (App Router)** as the foundation, with a clear layered architecture separating the User Interface (UI), Business Logic, and Infrastructure according to the specified tech stack (Vercel, Neon, Supabase, Upstash).

### 1. Project Directory Tree

```plaintext
LUGX-PLATFORM/
├── public/                     # Static assets (fonts, images, icons)
│   ├── fonts/                  # (Geist Sans, IBM Plex Sans Arabic)
│   └── images/
├── src/
│   ├── app/                    # (Next.js 15 App Router) - Routing and pages layer
│   │   ├── (auth)/             # Authentication routes (isolated with a specific layout)
│   │   │   ├── login/page.tsx
│   │   │   └── callback/route.ts # Handling Supabase Auth callback
│   │   ├── (dashboard)/        # Main dashboard
│   │   │   ├── layout.tsx
│   │   │   └── page.tsx
│   │   ├── (workspace)/        # Workspace and editor environment
│   │   │   ├── editor/
│   │   │   │   └── [fileId]/page.tsx
│   │   │   └── layout.tsx
│   │   ├── account/            # Account and subscription management page
│   │   │   └── page.tsx
│   │   ├── api/                # APIs (Webhooks, Cron Jobs)
│   │   │   └── webhooks/stripe/route.ts
│   │   ├── globals.css         # Tailwind settings and color definitions (Zinc Palette)
│   │   └── layout.tsx          # Root layout (Providers)
│   ├── components/             # UI Components
│   │   ├── ui/                 # Core shadcn/ui library (Button, Input, Card)
│   │   ├── editor/             # Editor components (TipTap)
│   │   │   ├── toolbar.tsx
│   │   │   ├── extensions.ts   # Extension settings (Bold, Italic)
│   │   │   └── editor-canvas.tsx
│   │   ├── ai/                 # AI tool interfaces (Correct, Improve, etc.)
│   │   │   ├── ai-floating-menu.tsx
│   │   │   └── prompt-dialog.tsx
│   │   ├── layout/             # General structure (Sidebar, Navbar)
│   │   └── shared/             # Shared components (ThemeToggle, FileCard)
│   ├── lib/                    # Libraries and utility services (Core Logic)
│   │   ├── db/                 # Database layer (Drizzle + Neon)
│   │   │   ├── schema.ts       # Definition of users, files, and subscriptions tables
│   │   │   ├── index.ts        # Drizzle Client connection setup
│   │   │   └── migrations/
│   │   ├── ai/                 # AI logic (Gemini Integration)
│   │   │   ├── client.ts       # Gemini client setup
│   │   │   ├── key-rotation.ts # Key rotation system using Redis
│   │   │   └── prompts.ts      # System Prompts storage
│   │   ├── supabase/           # Supabase client for authentication and storage
│   │   │   ├── server.ts
│   │   │   └── client.ts
│   │   ├── utils.ts            # General utility functions (cn, formatting)
│   │   └── redis.ts            # Upstash Redis connection setup
│   ├── server/                 # Server Actions for secure operations
│   │   ├── actions/
│   │   │   ├── auth-actions.ts # Session management and login
│   │   │   ├── file-ops.ts     # File operations (create, delete, PDF extraction)
│   │   │   └── ai-ops.ts       # AI model invocation (Server-Side only)
│   │   └── services/           # Complex business logic (e.g., quota calculation)
│   │       └── subscription.ts # Quota and limit management
│   ├── config/                 # Project configurations and constants
│   │   ├── tiers.config.ts     # Plan limits definition (Free, Pro, Ultra)
│   │   ├── site.config.ts
│   │   └── ai-models.config.ts # Mapping models to plans (Flash Lite vs Pro)
│   ├── types/                  # TypeScript definitions (Interfaces & Types)
│   │   ├── db.ts               # Data types retrieved from the database
│   │   └── index.ts
│   └── middleware.ts           # Route protection and session verification
├── drizzle.config.ts           # Drizzle Kit configurations
├── tailwind.config.ts          # Color and font settings
├── next.config.mjs
├── .env.local                  # Environment variables (API Keys, DB URLs)
├── package.json
└── tsconfig.json

```

---

### 2. Structure Dictionary

The table below explains the technical purpose of each part of the structure and its direct relationship to the attached requirements:

| Path / Component                   | Functional Purpose and Requirements Mapping                                                                                                                                                                                                             |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`src/app/(workspace)/editor`**   | **Main Workspace:** Contains the editor page that supports (RTL/LTR). It is isolated in `(workspace)` to apply a specific layout distinct from the home page, and includes Drag & Drop logic.                                                           |
| **`src/components/ui`**            | **Design System:** Implementation of the `shadcn/ui` library with `Tailwind` customizations to reflect the "Quiet Luxury" philosophy and monochromatic (Zinc) colors mentioned in the guide.                                                            |
| **`src/components/editor`**        | **Text Editor:** TipTap configuration to be "Borderless," with the Caret customized to `Electric Indigo`, ensuring no traditional formatting buttons clutter the interface.                                                                             |
| **`src/lib/db/schema.ts`**         | **Data Schema:** Definition of tables (Users, Files, Subscriptions) using Drizzle ORM to link them to the Neon database. This ensures the use of UUIDs for users for compatibility with Supabase Auth.                                                  |
| **`src/lib/ai/key-rotation.ts`**   | **Key Rotation System:** Implementation of the algorithm described in the technical architecture document, connecting to Upstash Redis to check the Usage Count and automatically rotate API keys after every 20 requests.                              |
| **`src/lib/ai/prompts.ts`**        | **Prompt Store:** A file containing string constants for "System Prompts" (DSE, LBE, SEE, LPE, DCE) extracted from AI usage files, ensuring they are not directly embedded in the frontend code.                                                        |
| **`src/server/actions/ai-ops.ts`** | **Operational Security:** A `Server Action` function called from the client to execute AI requests. This layer ensures API keys never reach the browser (Client-Side) and selects the appropriate model (Gemini Flash vs Pro) based on the user's plan. |
| **`src/config/tiers.config.ts`**   | **Quota Governance:** Definition of usage limit constants (Word Limits) for each plan (Free: 1k words, Pro: 20k, Ultra: 2M). This file is used in the validation logic before executing any processing operation.                                       |
| **`src/lib/supabase/storage.ts`**  | **File Management:** Logic for interacting with Supabase Storage to upload PDF/TXT files and create isolated "Buckets" for each user as stated in the implementation roadmap.                                                                           |
| **`tailwind.config.ts`**           | **Visual Identity:** Definition of custom colors (`bg-zinc-950`, `indigo-500`) and fonts (`Geist Sans`, `IBM Plex Sans Arabic`) to ensure literal adherence to the style guide.                                                                         |

### Additional Implementation Recommendations:

1. **Environment Variable Protection:** Ensure that the `.env.local` file contains multiple Gemini API keys to support the rotation system (`GEMINI_KEY_1`, `GEMINI_KEY_2`, ...).
2. **Middleware Security:** `middleware.ts` must be configured to verify the authentication token (Supabase Session) before allowing access to any route within `(dashboard)` or `(workspace)`.
3. **Subscription Decoupling:** It is recommended to isolate the subscription verification logic (`src/server/services/subscription.ts`) so it can be called centrally before any costly operation, such as long-text processing or summarization.