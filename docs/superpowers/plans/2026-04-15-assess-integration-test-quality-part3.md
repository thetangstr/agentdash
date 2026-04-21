## Task 6: Wire Routes into App

**Files:**
- Modify: `server/src/app.ts` (add import + `api.use`)

- [ ] **Step 1: Add import**

In `server/src/app.ts`, after line 39 (`import { onboardingRoutes } from "./routes/onboarding.js";`), add:

```typescript
import { assessRoutes } from "./routes/assess.js";
```

- [ ] **Step 2: Add route registration**

After `api.use(onboardingRoutes(db));` (line 196), add:

```typescript
  // AgentDash: Agent Readiness Assessment
  api.use(assessRoutes(db));
```

- [ ] **Step 3: Typecheck**

```bash
pnpm -r typecheck
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add server/src/app.ts
git commit -m "feat(assess): wire assess routes into Express app"
```

---

## Task 7: UI API Client

**Files:**
- Create: `ui/src/api/assess.ts`

- [ ] **Step 1: Create the API client**

Create `ui/src/api/assess.ts`:

```typescript
// AgentDash: Assess API client
import { api } from "./client";

export interface ResearchResult {
  companyName: string;
  suggestedIndustry: string;
  summary: string;
  webContent: string;
  allIndustries: string[];
}

export interface InterviewResponse {
  question: string;
  options: string[];
  insights: Array<{ label: string; value: string; icon: string }>;
  clarityScore: number;
  done: boolean;
  thinkingSummary?: string;
}

export interface StoredAssessment {
  markdown: string;
  jumpstart: string | null;
  assessmentInput: Record<string, unknown> | null;
}

export const assessApi = {
  research: (companyId: string, companyUrl: string, companyName: string) =>
    api.post<ResearchResult>(`/companies/${companyId}/assess/research`, { companyUrl, companyName }),

  interview: (companyId: string, body: {
    conversationHistory: Array<{ role: "assistant" | "user"; content: string }>;
    companyWebContent?: string;
    industry: string;
    industrySlug: string;
    formSummary: string;
    selectedFunctions: string[];
  }) => api.post<InterviewResponse>(`/companies/${companyId}/assess/interview`, body),

  runAssessment: async (companyId: string, body: Record<string, unknown>): Promise<ReadableStream<Uint8Array>> => {
    const res = await fetch(`/api/companies/${companyId}/assess`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Assessment failed: ${res.status}`);
    return res.body!;
  },

  getAssessment: (companyId: string) =>
    api.get<StoredAssessment>(`/companies/${companyId}/assess`),
};
```

- [ ] **Step 2: Typecheck**

```bash
pnpm -r typecheck
```

- [ ] **Step 3: Commit**

```bash
git add ui/src/api/assess.ts
git commit -m "feat(assess): add UI API client for assess endpoints"
```

---

## Task 8: AssessPage UI

**Files:**
- Create: `ui/src/pages/AssessPage.tsx`

- [ ] **Step 1: Create the AssessPage component**

Create `ui/src/pages/AssessPage.tsx`. This is the largest single file. Port the 6-phase flow from `/tmp/agent-marketing-research/src/app/assess/page.tsx`, adapting:
- Next.js `"use client"` → plain React component
- Fetch calls → `assessApi` client from `ui/src/api/assess.ts`
- `useRouter()` → `useNavigate()` from react-router
- Tailwind dark theme → AgentDash teal accent theme (use CSS variables `--accent`, `--bg-card`, `--border`, `--text-primary`)
- Add `useCompany()` hook to get `selectedCompanyId`

Key phases to implement:
1. **Start**: company name + URL input, "Research" button
2. **Confirm**: auto-detected industry dropdown, scope selection
3. **Form** (3 steps): Operations, Functions, Goals — multi-select chips, dropdowns, textareas
4. **Deep Dive**: chat Q&A with option chips + custom input, clarity ring sidebar
5. **Generating**: stream display with progress
6. **Report**: rendered markdown with Print/Copy actions

Use the research app as reference but write to match AgentDash UI conventions (Tailwind classes matching existing pages like `Dashboard.tsx`, `OnboardingWizardPage.tsx`).

- [ ] **Step 2: Typecheck**

```bash
pnpm -r typecheck
```

- [ ] **Step 3: Commit**

```bash
git add ui/src/pages/AssessPage.tsx
git commit -m "feat(assess): add standalone AssessPage with 6-phase flow"
```

---

## Task 9: AssessHistoryPage UI

**Files:**
- Create: `ui/src/pages/AssessHistoryPage.tsx`

- [ ] **Step 1: Create the history page**

Create `ui/src/pages/AssessHistoryPage.tsx`:

```typescript
import { useCompany } from "../context/CompanyContext";
import { useQuery } from "@tanstack/react-query";
import { assessApi } from "../api/assess";
import { queryKeys } from "../lib/queryKeys";
import { useNavigate } from "../lib/router";

export function AssessHistoryPage() {
  const { selectedCompanyId } = useCompany();
  const navigate = useNavigate();

  const { data, isLoading } = useQuery({
    queryKey: [...queryKeys.agentResearch.all(selectedCompanyId!), "assessment"],
    queryFn: () => assessApi.getAssessment(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  if (isLoading) return <div className="p-6 text-sm text-muted-foreground">Loading...</div>;

  if (!data) {
    return (
      <div className="mx-auto max-w-xl py-16 text-center">
        <h2 className="text-lg font-semibold">No assessments yet</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Run your first Agent Readiness Assessment to see results here.
        </p>
        <button
          className="mt-4 rounded-md bg-accent px-4 py-2 text-sm font-medium text-white"
          onClick={() => navigate("../assess")}
        >
          Start Assessment
        </button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl p-6">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold">Assessment Results</h1>
        <button
          className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white"
          onClick={() => navigate("../assess")}
        >
          New Assessment
        </button>
      </div>
      <div className="prose prose-sm max-w-none rounded-lg border border-border bg-card p-6">
        <div dangerouslySetInnerHTML={{ __html: simpleMarkdownToHtml(data.markdown) }} />
      </div>
      {data.jumpstart && (
        <details className="mt-4 rounded-lg border border-border bg-card p-4">
          <summary className="cursor-pointer text-sm font-medium">Jumpstart File</summary>
          <pre className="mt-2 overflow-x-auto whitespace-pre-wrap text-xs text-muted-foreground">
            {data.jumpstart}
          </pre>
        </details>
      )}
    </div>
  );
}

function simpleMarkdownToHtml(md: string): string {
  return md
    .replace(/^### (.+)$/gm, "<h3>$1</h3>")
    .replace(/^## (.+)$/gm, "<h2>$1</h2>")
    .replace(/^# (.+)$/gm, "<h1>$1</h1>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/^- (.+)$/gm, "<li>$1</li>")
    .replace(/\n\n/g, "</p><p>")
    .replace(/\n/g, "<br/>");
}
```

- [ ] **Step 2: Typecheck**

```bash
pnpm -r typecheck
```

- [ ] **Step 3: Commit**

```bash
git add ui/src/pages/AssessHistoryPage.tsx
git commit -m "feat(assess): add assessment history page"
```

---

## Task 10: Wire UI Routes + Sidebar Nav

**Files:**
- Modify: `ui/src/App.tsx`
- Modify: `ui/src/components/Sidebar.tsx`

- [ ] **Step 1: Add imports to App.tsx**

At the top of `ui/src/App.tsx`, add with the other page imports:

```typescript
import { AssessPage } from "./pages/AssessPage";
import { AssessHistoryPage } from "./pages/AssessHistoryPage";
```

- [ ] **Step 2: Add routes in boardRoutes()**

In the `boardRoutes()` function, after `<Route path="setup-wizard" element={<SetupWizard />} />` (around line 216), add:

```typescript
      <Route path="assess" element={<AssessPage />} />
      <Route path="assess/history" element={<AssessHistoryPage />} />
```

- [ ] **Step 3: Add Sidebar nav item**

In `ui/src/components/Sidebar.tsx`, add the `Search` icon import (already imported on line 8). Then in the Governance section (after the Research nav item around line 145), add:

```typescript
          <SidebarNavItem to="/assess" label="Assess" icon={Search} />
```

- [ ] **Step 4: Typecheck**

```bash
pnpm -r typecheck
```

- [ ] **Step 5: Commit**

```bash
git add ui/src/App.tsx ui/src/components/Sidebar.tsx
git commit -m "feat(assess): add routes and sidebar nav for assessment"
```

---

## Task 11: Onboarding Integration — Discovery Step Research

**Files:**
- Modify: `ui/src/pages/OnboardingWizardPage.tsx`
- Modify: `ui/src/pages/SetupWizard.tsx`

- [ ] **Step 1: Add research button to OnboardingWizardPage Discovery step**

In `ui/src/pages/OnboardingWizardPage.tsx`, add an import for `assessApi`:

```typescript
import { assessApi } from "../api/assess";
```

In the Discovery step (Step 1), add a "Research URL" button below the textarea. When clicked, it calls `assessApi.research(companyId, url, companyName)` and auto-fills the textarea with the research summary + detected industry.

Add state:

```typescript
const [researching, setResearching] = useState(false);
```

Add handler:

```typescript
const handleResearch = async () => {
  if (!formData.companyInfo) return;
  setResearching(true);
  try {
    const result = await assessApi.research(companyId, formData.companyInfo, selectedCompany?.name ?? "");
    setFormData((prev) => ({
      ...prev,
      companyInfo: [
        prev.companyInfo,
        result.summary ? `\nSummary: ${result.summary}` : "",
        result.suggestedIndustry ? `\nIndustry: ${result.suggestedIndustry}` : "",
      ].join(""),
    }));
  } catch { /* ignore errors */ }
  setResearching(false);
};
```

Add button below the textarea:

```tsx
<button
  type="button"
  className="mt-2 text-sm text-accent hover:underline disabled:opacity-50"
  onClick={handleResearch}
  disabled={researching || !formData.companyInfo?.startsWith("http")}
>
  {researching ? "Researching..." : "Research this URL"}
</button>
```

- [ ] **Step 2: Add same research integration to SetupWizard**

Apply the same pattern to `ui/src/pages/SetupWizard.tsx` in the Step 1 company info section.

- [ ] **Step 3: Typecheck**

```bash
pnpm -r typecheck
```

- [ ] **Step 4: Commit**

```bash
git add ui/src/pages/OnboardingWizardPage.tsx ui/src/pages/SetupWizard.tsx
git commit -m "feat(assess): integrate URL research into onboarding Discovery step"
```

---

## Task 12: Shared Test Factories

**Files:**
- Create: `server/src/__tests__/helpers/factories.ts`
- Test: verify by importing in existing test

- [ ] **Step 1: Create factory file**

Create `server/src/__tests__/helpers/factories.ts`:

```typescript
/**
 * Shared test data builders.
 * Usage: buildCompany({ name: "Custom" }) — returns full object with defaults.
 */
import { randomUUID } from "node:crypto";

export function buildCompany(overrides?: Record<string, unknown>) {
  return {
    id: randomUUID(),
    name: "Test Corp",
    issuePrefix: "TC",
    description: "A test company",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

export function buildAgent(overrides?: Record<string, unknown>) {
  return {
    id: randomUUID(),
    companyId: "company-1",
    name: "Test Agent",
    role: "engineer",
    status: "idle",
    model: "claude-sonnet-4-20250514",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

export function buildIssue(overrides?: Record<string, unknown>) {
  return {
    id: randomUUID(),
    companyId: "company-1",
    title: "Test Issue",
    description: "A test issue",
    status: "open",
    priority: "medium",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

export function buildAssessmentInput(overrides?: Record<string, unknown>) {
  return {
    companyName: "Test Corp",
    industry: "Healthcare",
    industrySlug: "healthcare",
    employeeRange: "201-1000",
    revenueRange: "$50M-$200M",
    description: "A healthcare company",
    currentSystems: "Epic, Salesforce",
    automationLevel: "basic",
    challenges: "Manual processes",
    selectedFunctions: [] as string[],
    primaryGoal: "Both",
    targets: "",
    timeline: "3-6 months",
    budgetRange: "$100K-$250K",
    aiUsageLevel: "Individual tools",
    aiGovernance: "None",
    agentExperience: "Never tried",
    aiOwnership: "Nobody",
    ...overrides,
  };
}
```

- [ ] **Step 2: Verify it works by running existing assess tests**

```bash
cd server && pnpm vitest run src/__tests__/assess-retrieval.test.ts
```

- [ ] **Step 3: Commit**

```bash
git add server/src/__tests__/helpers/factories.ts
git commit -m "test: add shared test data factory builders"
```

---

## Task 13: Full Verification

**Files:** None (verification only)

- [ ] **Step 1: Run typecheck across all packages**

```bash
pnpm -r typecheck
```

Expected: PASS with no errors.

- [ ] **Step 2: Run all Vitest tests**

```bash
pnpm test:run
```

Expected: All tests pass (existing + new assess tests).

- [ ] **Step 3: Build**

```bash
pnpm build
```

Expected: Clean build.

- [ ] **Step 4: Fix any issues found**

If typecheck or tests fail, fix the specific errors. Common issues:
- Import paths needing `.js` extension for ESM
- Missing type exports
- Mock setup ordering

- [ ] **Step 5: Final commit if any fixes were needed**

```bash
git add -A
git commit -m "fix: resolve typecheck and test issues from assess integration"
```

---

## Task 14: Deploy to maxiaoer

**Files:**
- Modify: `.env.local` on maxiaoer (add `ASSESS_MINIMAX_API_KEY`)

- [ ] **Step 1: Push and deploy**

```bash
bash scripts/deploy-maxiaoer.sh --restart
```

- [ ] **Step 2: Add MiniMax key to maxiaoer .env.local**

```bash
ssh maxiaoer@192.168.86.45 'echo "ASSESS_MINIMAX_API_KEY=your-minimax-key-here" >> ~/conductor/workspaces/townhall/san-francisco-v1/.env.local'
```

Replace `your-minimax-key-here` with the actual MiniMax API key from the research app's environment.

- [ ] **Step 3: Restart server**

```bash
ssh maxiaoer@192.168.86.45 'export PATH="/opt/homebrew/bin:$PATH"; cd ~/conductor/workspaces/townhall/san-francisco-v1 && pkill -f "tsx" 2>/dev/null; sleep 1 && set -a; source .env.local; set +a && nohup pnpm dev --authenticated-private > /tmp/agentdash-dev.log 2>&1 &'
```

- [ ] **Step 4: Verify assess page loads**

Navigate to `http://192.168.86.45:3100/{prefix}/assess` in browser.
