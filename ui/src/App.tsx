import { WorkforceOnboarding } from "./pages/WorkforceOnboarding";
import { Navigate, Outlet, Route, Routes, useLocation, useParams } from "@/lib/router";
import { lazy, Suspense } from "react";
import { useQuery } from "@tanstack/react-query";
import { healthApi } from "./api/health";
import { queryKeys } from "./lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Layout } from "./components/Layout";
import { OnboardingWizard } from "./components/OnboardingWizard";
import { CloudAccessGate } from "./components/CloudAccessGate";
import { FirstRunStart } from "./components/FirstRunStart";
// The /dashboard route renders pages/Home (DashboardHome): Home blocks over the control-plane panels.
import { DashboardHome } from "./pages/Home";
import { ConnectAssistant } from "./pages/ConnectAssistant";
import { DashboardLive } from "./pages/DashboardLive";
import { Companies } from "./pages/Companies";
import { Agents } from "./pages/Agents";
import { AgentDetail } from "./pages/AgentDetail";
import { AgentCreatorStudio } from "./pages/AgentCreatorStudio";
import { Projects } from "./pages/Projects";
import { ProjectDetail } from "./pages/ProjectDetail";
import { ProjectWorkspaceDetail } from "./pages/ProjectWorkspaceDetail";
import { Workspaces } from "./pages/Workspaces";
import { Issues } from "./pages/Issues";
import { IssueDetail } from "./pages/IssueDetail";
import { IssueChatLongThreadPerf } from "./pages/IssueChatLongThreadPerf";
import { Routines } from "./pages/Routines";
import { RoutineDetail } from "./pages/RoutineDetail";
import { UserProfile } from "./pages/UserProfile";
import { ExecutionWorkspaceDetail } from "./pages/ExecutionWorkspaceDetail";
import { Goals } from "./pages/Goals";
import { GoalDetail } from "./pages/GoalDetail";
import { ApprovalDetail } from "./pages/ApprovalDetail";
import { Decisions } from "./pages/Decisions";
import { Costs } from "./pages/Costs";
import { Activity } from "./pages/Activity";
import { Shipped } from "./pages/Shipped";
import { CompanySettings } from "./pages/CompanySettings";
import { CompanyConnections } from "./pages/CompanyConnections";
import { CompanyModelKey } from "./pages/CompanyModelKey";
import { CompanyEnvironments } from "./pages/CompanyEnvironments";
import { CompanyAccess } from "./pages/CompanyAccess";
import { CompanyInvites } from "./pages/CompanyInvites";
import { CompanyHealth } from "./pages/CompanyHealth";
import { EvaluationOverviewPage } from "./pages/evaluation/EvaluationOverview";
import { EvaluationFounder } from "./pages/evaluation/EvaluationFounder";
import { EvaluationMilestone } from "./pages/evaluation/EvaluationMilestone";
import { InstanceErrors } from "./pages/InstanceErrors";
import { CompanySkills } from "./pages/CompanySkills";
import { CompanyExport } from "./pages/CompanyExport";
import { CompanyImport } from "./pages/CompanyImport";
import { DesignGuide } from "./pages/DesignGuide";
import { NoCompaniesStartPage, UnprefixedBoardRedirect } from "./components/UnprefixedBoardRedirect";
import { Guides } from "./pages/Guides";
import { Guide } from "./pages/Guide";
import { InstanceGeneralSettings } from "./pages/InstanceGeneralSettings";
import { InstanceAccess } from "./pages/InstanceAccess";
import { InstanceSettings } from "./pages/InstanceSettings";
import { InstanceAbout } from "./pages/InstanceAbout";
import { InstanceUpdates } from "./pages/InstanceUpdates";
import { InstanceChangelog } from "./pages/InstanceChangelog";
import { InstanceExperimentalSettings } from "./pages/InstanceExperimentalSettings";
import { ProfileSettings } from "./pages/ProfileSettings";
import { PluginManager } from "./pages/PluginManager";
import { PluginSettings } from "./pages/PluginSettings";
import { AdapterManager } from "./pages/AdapterManager";
import { PluginPage } from "./pages/PluginPage";
import { OrgChart } from "./pages/OrgChart";
import { NewAgent } from "./pages/NewAgent";
import BillingPage from "./pages/BillingPage";
import { AssessPage } from "./pages/AssessPage";
import { AssessHistoryPage } from "./pages/AssessHistoryPage";
import { AuthPage } from "./pages/Auth";
import { CompanyCreatePage } from "./pages/CompanyCreate";
import { FirstRunPage } from "./pages/FirstRun";
import { ForgotPasswordPage } from "./pages/ForgotPassword";
import { ResetPasswordPage } from "./pages/ResetPassword";
import { BoardClaimPage } from "./pages/BoardClaim";
import { CliAuthPage } from "./pages/CliAuth";
import { InviteLandingPage } from "./pages/InviteLanding";
import { ClaimPage } from "./pages/Claim";
import { TrialLandingPage } from "./pages/TrialLanding";
import { InvestorsPage } from "./pages/InvestorsPage";
import { PricingPage } from "./pages/PricingPage";
import { McpPage } from "./pages/McpPage";
import { TermsPage } from "./pages/TermsPage";
import { PrivacyPage } from "./pages/PrivacyPage";
import { SharedArtifactPage } from "./pages/SharedArtifact";
import { TrialClaimPage } from "./pages/TrialClaim";
import { JoinRequestQueue } from "./pages/JoinRequestQueue";
import { NotFoundPage } from "./pages/NotFound";
import { CoSAskPage, CoSEntryRoute } from "./pages/CoSConversation";
import { MemberOnboardingPage } from "./pages/MemberOnboarding";
import { ServerUnreachableOverlay } from "@/components/ServerUnreachableOverlay";
// AgentDash: marketing pages — render on cream/light surface, no CloudAccessGate.
import { Landing as MarketingLanding } from "./marketing/pages/Landing";
import { Demo as MarketingDemo } from "./marketing/pages/Demo";
import { Consulting as MarketingConsulting } from "./marketing/pages/Consulting";
import { About as MarketingAbout } from "./marketing/pages/About";
// AgentDash (SC-7, GH #768): the self-serve front door on www.
import { Start as MarketingStart } from "./marketing/pages/Start";
import { StartVerify as MarketingStartVerify } from "./marketing/pages/StartVerify";
import { StartProgress as MarketingStartProgress } from "./marketing/pages/StartProgress";
import { Find as MarketingFind } from "./marketing/pages/Find";
import { WwwOnlyRoute } from "./marketing/WwwOnlyRoute";
import { useCompany } from "./context/CompanyContext";
import { useDialogActions } from "./context/DialogContext";
import MyAgent from "./pages/MyAgent";
import { OAuthConsent } from "./pages/OAuthConsent";
import { NewVersionNotice } from "./components/NewVersionNotice";
import OverrideInbox from "./pages/OverrideInbox";
import { FIRST_COMPANY_PATH, shouldRedirectCompanylessRouteToOnboarding } from "./lib/onboarding-route";
import { legacyDecisionsRoutes } from "./lib/legacy-decisions-routes";
import { docsShadowRoutePaths } from "./lib/docs-nav";
import { legacySettingsRedirectTarget } from "./lib/settings-hub";

// Public docs (/docs) load on demand: the nav, the search index and every page
// body stay out of the initial bundle.
// AgentDash: dev-only UX lab, lazy so its fixtures never reach the production bundle.
const RunTranscriptUxLab = import.meta.env.DEV
  ? lazy(() => import("./pages/RunTranscriptUxLab").then((module) => ({ default: module.RunTranscriptUxLab })))
  : null;
const Docs = lazy(() => import("./pages/Docs").then((module) => ({ default: module.Docs })));

// AgentDash: billing page wrapper — pulls companyId from context.
function BillingPageRoute() {
  const { selectedCompany } = useCompany();
  if (!selectedCompany) return <div className="p-8">Loading…</div>;
  return <BillingPage companyId={selectedCompany.id} />;
}

function boardRoutes() {
  return (
    <>
      <Route index element={<Navigate to="dashboard" replace />} />
      {/* AgentDash: UX-3 (#784) — the landing page, the same for every company. */}
      <Route path="dashboard" element={<DashboardHome />} />
      {/* AgentDash (GH #786): assistant connection instructions until Settings › Connections (#793) */}
      <Route path="connect-assistant" element={<ConnectAssistant />} />
      <Route path="dashboard/live" element={<DashboardLive />} />
      {/* AgentDash: Ask — the Chief of Staff conversation, inside the sidebar Layout. */}
      <Route path="cos" element={<CoSAskPage />} />
      <Route path="onboarding" element={<OnboardingRoutePage />} />
      <Route path="companies" element={<Companies />} />
      <Route path="company/settings" element={<CompanySettings />} />
      <Route path="company/settings/connections" element={<CompanyConnections />} />
      <Route path="company/settings/model-key" element={<CompanyModelKey />} />
      <Route path="company/settings/environments" element={<CompanyEnvironments />} />
      <Route path="company/settings/access" element={<CompanyAccess />} />
      <Route path="company/settings/invites" element={<CompanyInvites />} />
      <Route path="company/settings/health" element={<CompanyHealth />} />
      {/* O2: the local error sink, instance-admin only. Lives under the
          settings tree because the router treats the FIRST path segment as a
          company prefix — a top-level /instance/errors resolves to "no
          company named instance", which is exactly how the browser
          walkthrough found this. */}
      <Route path="company/settings/errors" element={<InstanceErrors />} />
      <Route path="company/export/*" element={<CompanyExport />} />
      <Route path="company/import" element={<CompanyImport />} />
      <Route path="skills/*" element={<CompanySkills />} />
      <Route path="settings" element={<LegacySettingsRedirect />} />
      <Route path="settings/*" element={<LegacySettingsRedirect />} />
      <Route path="plugins/:pluginId" element={<PluginPage />} />
      <Route path="billing" element={<BillingPageRoute />} />
      <Route path="org" element={<OrgChart />} />
      <Route path="workforce" element={<WorkforceOnboarding />} />
      <Route path="agents" element={<Navigate to="/agents/all" replace />} />
      <Route path="agents/all" element={<Agents />} />
      <Route path="agents/active" element={<Agents />} />
      <Route path="agents/paused" element={<Agents />} />
      <Route path="agents/error" element={<Agents />} />
      <Route path="agents/new" element={<NewAgent />} />
      <Route path="agents/new/studio" element={<AgentCreatorStudio />} />
      <Route path="agents/:agentId" element={<AgentDetail />} />
      <Route path="agents/:agentId/:tab" element={<AgentDetail />} />
      <Route path="agents/:agentId/runs/:runId" element={<AgentDetail />} />
      <Route path="projects" element={<Projects />} />
      <Route path="projects/:projectId" element={<ProjectDetail />} />
      <Route path="projects/:projectId/overview" element={<ProjectDetail />} />
      <Route path="projects/:projectId/issues" element={<ProjectDetail />} />
      <Route path="projects/:projectId/issues/:filter" element={<ProjectDetail />} />
      <Route path="projects/:projectId/workspaces/:workspaceId" element={<ProjectWorkspaceDetail />} />
      <Route path="projects/:projectId/workspaces" element={<ProjectDetail />} />
      <Route path="projects/:projectId/configuration" element={<ProjectDetail />} />
      <Route path="projects/:projectId/budget" element={<ProjectDetail />} />
      <Route path="workspaces" element={<Workspaces />} />
      <Route path="issues" element={<Issues />} />
      <Route path="issues/all" element={<Navigate to="/issues" replace />} />
      <Route path="issues/active" element={<Navigate to="/issues" replace />} />
      <Route path="issues/backlog" element={<Navigate to="/issues" replace />} />
      <Route path="issues/done" element={<Navigate to="/issues" replace />} />
      <Route path="issues/recent" element={<Navigate to="/issues" replace />} />
      <Route path="issues/:issueId" element={<IssueDetail />} />
      {import.meta.env.DEV ? (
        <Route path="tests/perf/long-thread" element={<IssueChatLongThreadPerf />} />
      ) : null}
      <Route path="routines" element={<Routines />} />
      <Route path="routines/:routineId" element={<RoutineDetail />} />
      <Route path="execution-workspaces/:workspaceId" element={<ExecutionWorkspaceDetail />} />
      <Route path="execution-workspaces/:workspaceId/configuration" element={<ExecutionWorkspaceDetail />} />
      <Route path="execution-workspaces/:workspaceId/runtime-logs" element={<ExecutionWorkspaceDetail />} />
      <Route path="execution-workspaces/:workspaceId/issues" element={<ExecutionWorkspaceDetail />} />
      <Route path="execution-workspaces/:workspaceId/routines" element={<ExecutionWorkspaceDetail />} />
      <Route path="goals" element={<Goals />} />
      <Route path="goals/:goalId" element={<GoalDetail />} />
      {/* AgentDash: UX-7 (GH #788) + one UX (doc/plans/2026-09-30-one-ux.md) —
          Decisions replaces Inbox and Approvals for every company. The old
          list URLs redirect so bookmarks keep working; the approval DETAIL
          route stays — a Decisions row opens it. */}
      <Route path="decisions" element={<Decisions />} />
      {legacyDecisionsRoutes()}
      <Route path="approvals/:approvalId" element={<ApprovalDetail />} />
      <Route path="costs" element={<Costs />} />
      <Route path="evaluation" element={<EvaluationOverviewPage />} />
      <Route path="evaluation/founder" element={<EvaluationFounder />} />
      <Route path="evaluation/:kind/:id" element={<EvaluationMilestone />} />
      <Route path="evaluation/:kind/:id/:tab" element={<EvaluationMilestone />} />
      <Route path="activity" element={<Activity />} />
      {/* AgentDash: UX-2 (#783) */}
      <Route path="shipped" element={<Shipped />} />
      <Route path="my-agent" element={<MyAgent />} />
      <Route path="guides" element={<Guides />} />
      <Route path="guides/:group/:slug" element={<Guide />} />
      {/* The guide is now a section on My Agent itself. The deep link is kept
          so existing bookmarks and the older release notes still land somewhere
          useful, but there is no second copy of the content to drift. */}
      <Route path="my-agent/connect-machine" element={<Navigate to="../my-agent" replace />} />
      <Route path="inbox/override" element={<OverrideInbox />} />
      <Route path="inbox/requests" element={<JoinRequestQueue />} />
      <Route path="u/:userSlug" element={<UserProfile />} />
      <Route path="design-guide" element={<DesignGuide />} />
      <Route path="instance/settings/adapters" element={<AdapterManager />} />
      <Route path=":pluginRoutePath" element={<PluginPage />} />
      <Route path="*" element={<NotFoundPage scope="board" />} />
    </>
  );
}

// Every board path, mirrored under docs/ — see docs-nav.ts for why.
const DOCS_SHADOW_ROUTE_PATHS = docsShadowRoutePaths(boardRoutes());

// AgentDash (Lane F2): legacy /settings URLs open the workspace's settings,
// not the instance-admin page — see legacySettingsRedirectTarget.
function LegacySettingsRedirect() {
  const location = useLocation();
  const target = legacySettingsRedirectTarget(location.pathname);
  return <Navigate to={`${target}${location.search}${location.hash}`} replace />;
}

function OnboardingRoutePage() {
  const { companies, selectedCompany } = useCompany();
  // AgentDash (GH #786): the wizard is retired from the hosted path. A hosted
  // box sends /onboarding to the first run (or to naming the workspace).
  const { data: health } = useQuery({ queryKey: queryKeys.health, queryFn: () => healthApi.get(), retry: false });
  const { openOnboarding } = useDialogActions();
  const { companyPrefix } = useParams<{ companyPrefix?: string }>();
  // AgentDash (Scan 3, lane J): with any company, this page adds an agent to
  // one — it never offers to create a second company (that is New Company).
  const matchedCompany =
    (companyPrefix
      ? companies.find((company) => company.issuePrefix.toUpperCase() === companyPrefix.toUpperCase())
      : null) ??
    selectedCompany ??
    companies[0] ??
    null;

  if (health?.hostedBox) {
    return <Navigate to={companies.length > 0 ? "/setup" : "/company-create"} replace />;
  }

  const title = matchedCompany
    ? `Add another agent to ${matchedCompany.name}`
    : "Create your first company";
  const description = matchedCompany
    ? "Run onboarding again to add an agent and a starter task for this company."
    : "Get started by creating a company and your first agent.";

  return (
    <div className="mx-auto max-w-xl py-10">
      <div className="rounded-lg border border-border bg-card p-6">
        <h1 className="text-xl font-semibold">{title}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{description}</p>
        <div className="mt-4">
          <Button
            onClick={() =>
              matchedCompany
                ? openOnboarding({ initialStep: 2, companyId: matchedCompany.id })
                : openOnboarding()
            }
          >
            {matchedCompany ? "Add Agent" : "Start Onboarding"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function CompanyRootRedirect() {
  const { companies, selectedCompany, loading } = useCompany();
  const location = useLocation();

  if (loading) {
    return <div className="mx-auto max-w-xl py-10 text-sm text-muted-foreground">Loading...</div>;
  }

  const targetCompany = selectedCompany ?? companies[0] ?? null;
  if (!targetCompany) {
    if (
      shouldRedirectCompanylessRouteToOnboarding({
        pathname: location.pathname,
        hasCompanies: false,
      })
    ) {
      return <Navigate to={FIRST_COMPANY_PATH} replace />;
    }
    return <NoCompaniesStartPage />;
  }

  return <Navigate to={`/${targetCompany.issuePrefix}/dashboard`} replace />;
}

export function App() {
  return (
    <>
      {/* Tells a person when their tab is running an older build than the
          server is serving. Mounted here so it covers every route, including
          the public ones, and never reloads on its own -- see the component. */}
      <NewVersionNotice />
      <Routes>
        <Route path="auth" element={<AuthPage />} />
        <Route path="forgot-password" element={<ForgotPasswordPage />} />
        <Route path="reset-password" element={<ResetPasswordPage />} />
        <Route path="board-claim/:token" element={<BoardClaimPage />} />
        <Route path="cli-auth/:id" element={<CliAuthPage />} />
        <Route path="invite/:token" element={<InviteLandingPage />} />
        {/* AgentDash (#767): the one-time claim link of a hosted box — public, outside CloudAccessGate. */}
        <Route path="claim" element={<ClaimPage />} />
        {/* AgentDash (Test Drive): public no-signup trial — rendered outside
            CloudAccessGate, no Layout/sidebar, token is the only credential. */}
        <Route path="trial" element={<TrialLandingPage />} />
        {/* AgentDash: PUBLIC investor + partner brief (Google for Startups /
            investor outreach) — same public tier as /trial, no auth, no company
            context, owns its own scroll region. */}
        <Route path="investors" element={<InvestorsPage />} />
        {/* AgentDash: PUBLIC pricing page (Free / Pro / Team) — same public tier
            as /trial and /investors, no auth, no company context, owns its own
            h-screen overflow-y-auto scroll region. */}
        <Route path="pricing" element={<PricingPage />} />
        {/* AgentDash: PUBLIC MCP setup page — same public tier as /trial and
            /pricing, no auth, no company context. Renders on the marketing
            surface (MarketingShell), so it scrolls like / and /consulting. */}
        <Route path="mcp" element={<McpPage />} />
        {/* AgentDash: PUBLIC docs — same public tier as /mcp, no auth, no
            company context. Nav from docs/docs.json; see ui/src/lib/docs.ts.
            DOCS_SHADOW_ROUTE_PATHS mirrors every board path under docs/, so
            no :companyPrefix route outranks a /docs URL (ui/src/lib/docs-nav.ts).
            Not served on www.agentdash.cloud until vercel.json lets /docs
            through (doc/plans/2026-10-01-public-docs-section.md, PR 4). */}
        <Route path="docs" element={<Suspense fallback={null}><Docs /></Suspense>} />
        {DOCS_SHADOW_ROUTE_PATHS.map((path) => <Route key={path} path={path} element={<Suspense fallback={null}><Docs /></Suspense>} />)}
        <Route path="docs/*" element={<Suspense fallback={null}><Docs /></Suspense>} />
        {/* AgentDash: PUBLIC legal pages (Terms / Privacy) — same public tier as
            /trial, /pricing, and /investors, no auth, no company context, each
            owns its own h-screen overflow-y-auto scroll region. */}
        <Route path="terms" element={<TermsPage />} />
        <Route path="privacy" element={<PrivacyPage />} />
        {/* AgentDash (Test Drive, Slice 3): PUBLIC read-only shared artifact —
            same tier as /trial, no auth, no company context. */}
        <Route path="share/:shareToken" element={<SharedArtifactPage />} />
        <Route path="tests/perf/long-thread" element={<IssueChatLongThreadPerf />} />
        {/* AgentDash: dev-only run transcript UX lab (fixtures only, no API). */}
        {RunTranscriptUxLab ? (
          <Route path="tests/ux/run-transcripts" element={<Suspense fallback={null}><div className="min-h-screen bg-background p-6"><RunTranscriptUxLab /></div></Suspense>} />
        ) : null}
        {/* AgentDash: marketing routes — render outside CloudAccessGate so the
            cream/light surface isn't fighting the dashboard's html.dark theme.
            Landing redirects logged-in users to /companies on its own. */}
        <Route path="/" element={<MarketingLanding />} />
        <Route path="demo" element={<MarketingDemo />} />
        <Route path="consulting" element={<MarketingConsulting />} />
        <Route path="about" element={<MarketingAbout />} />
        {/* AgentDash (SC-7, GH #768): signup, magic-link landing, progress and returning users. */}
        {/* AgentDash: www-only (they call /api/cloud); a hosted box sends them to its own sign-in. */}
        <Route path="start" element={<WwwOnlyRoute><MarketingStart /></WwwOnlyRoute>} />
        <Route path="start/verify" element={<WwwOnlyRoute><MarketingStartVerify /></WwwOnlyRoute>} />
        <Route path="start/progress" element={<WwwOnlyRoute><MarketingStartProgress /></WwwOnlyRoute>} />
        <Route path="find" element={<WwwOnlyRoute><MarketingFind /></WwwOnlyRoute>} />
        <Route path="assess" element={<AssessPage />} />
        <Route path="assess/history" element={<AssessHistoryPage />} />

        <Route element={<CloudAccessGate />}>
          {/* AgentDash (Phase E): post-signup → /company-create.
              The user has no company yet, so this lives outside the
              :companyPrefix boardRoutes block. */}
          <Route path="company-create" element={<CompanyCreatePage />} />
          {/* AgentDash (Test Drive, Slice 4): post-signup claim handoff. Inside
              CloudAccessGate (auth required) but the gate special-cases this
              path so a brand-new, company-less account can reach it to bind the
              trial workspace. */}
          <Route path="trial/claim" element={<TrialClaimPage />} />
          {/* AgentDash: bare /cos — onboarding, emails and the claim hand-off
              link here. With a company it redirects to /:prefix/cos (Ask inside
              the sidebar Layout); a founder with no company yet gets the
              full-screen bootstrap conversation. */}
          <Route path="cos" element={<CoSEntryRoute />} />
          {/* AgentDash (GH #786): hosted first run — model key, GitHub, first issue */}
          <Route path="setup" element={<FirstRunPage />} />
          {/* AgentDash (GH #677): OAuth consent for assistant MCP clients.
              Inside the gate so CloudAccessGate handles sign-in and returns
              here via ?next= — this is a person-facing approval, not a public
              page, and it is company-agnostic so it lives outside
              :companyPrefix. */}
          <Route path="oauth/consent" element={<OAuthConsent />} />
          <Route path="onboarding" element={<OnboardingRoutePage />} />
          <Route path="member-onboarding" element={<MemberOnboardingPage />} />
          <Route path="instance" element={<Navigate to="/instance/settings/general" replace />} />
          <Route path="instance/settings" element={<Layout />}>
            <Route index element={<Navigate to="general" replace />} />
            <Route path="profile" element={<ProfileSettings />} />
            <Route path="general" element={<InstanceGeneralSettings />} />
            <Route path="access" element={<InstanceAccess />} />
            <Route path="heartbeats" element={<InstanceSettings />} />
            <Route path="experimental" element={<InstanceExperimentalSettings />} />
            <Route path="plugins" element={<PluginManager />} />
            <Route path="plugins/:pluginId" element={<PluginSettings />} />
            <Route path="adapters" element={<AdapterManager />} />
            <Route path="updates" element={<InstanceUpdates />} />
            <Route path="about" element={<InstanceAbout />} />
            <Route path="changelog" element={<InstanceChangelog />} />
          </Route>
          <Route path="companies" element={<UnprefixedBoardRedirect />} />
          <Route path="issues" element={<UnprefixedBoardRedirect />} />
          <Route path="issues/:issueId" element={<UnprefixedBoardRedirect />} />
          <Route path="routines" element={<UnprefixedBoardRedirect />} />
          <Route path="routines/:routineId" element={<UnprefixedBoardRedirect />} />
          <Route path="u/:userSlug" element={<UnprefixedBoardRedirect />} />
          <Route path="skills/*" element={<UnprefixedBoardRedirect />} />
          <Route path="settings" element={<LegacySettingsRedirect />} />
          <Route path="settings/*" element={<LegacySettingsRedirect />} />
          {/* Every board root also answers unprefixed, so a typed or bookmarked
              URL redirects to the selected company instead of being read as a
              company code. Without these, /dashboard looked for a company
              called DASHBOARD and said it could not find one. */}
          <Route path="my-agent" element={<UnprefixedBoardRedirect />} />
          <Route path="guides" element={<UnprefixedBoardRedirect />} />
          <Route path="guides/*" element={<UnprefixedBoardRedirect />} />
          <Route path="dashboard" element={<UnprefixedBoardRedirect />} />
          <Route path="dashboard/*" element={<UnprefixedBoardRedirect />} />
          <Route path="inbox" element={<UnprefixedBoardRedirect />} />
          <Route path="inbox/*" element={<UnprefixedBoardRedirect />} />
          <Route path="org" element={<UnprefixedBoardRedirect />} />
          <Route path="org/*" element={<UnprefixedBoardRedirect />} />
          <Route path="billing" element={<UnprefixedBoardRedirect />} />
          <Route path="billing/*" element={<UnprefixedBoardRedirect />} />
          <Route path="approvals" element={<UnprefixedBoardRedirect />} />
          <Route path="approvals/*" element={<UnprefixedBoardRedirect />} />
          <Route path="costs" element={<UnprefixedBoardRedirect />} />
          <Route path="costs/*" element={<UnprefixedBoardRedirect />} />
          <Route path="goals" element={<UnprefixedBoardRedirect />} />
          <Route path="goals/*" element={<UnprefixedBoardRedirect />} />
          <Route path="activity" element={<UnprefixedBoardRedirect />} />
          <Route path="activity/*" element={<UnprefixedBoardRedirect />} />
          <Route path="shipped" element={<UnprefixedBoardRedirect />} />
          <Route path="decisions" element={<UnprefixedBoardRedirect />} />
          <Route path="connect-assistant" element={<UnprefixedBoardRedirect />} />
          {/* AgentDash (Scan 4 lane M): board roots that had no unprefixed
              redirect; company-routes.test.ts now checks every one has. */}
          <Route path="plugins/:pluginId" element={<UnprefixedBoardRedirect />} />
          <Route path="evaluation" element={<UnprefixedBoardRedirect />} />
          <Route path="evaluation/*" element={<UnprefixedBoardRedirect />} />
          {/* Explicit, not a splat. React Router ranks a dynamic+static pair
              (":companyPrefix/settings") above a splat ("company/*"), so the
              wildcard lost and /company/settings was read as a company called
              COMPANY. Static segments outrank the dynamic prefix, so these
              must be spelled out. */}
          <Route path="company" element={<UnprefixedBoardRedirect />} />
          <Route path="company/settings" element={<UnprefixedBoardRedirect />} />
          <Route path="company/settings/connections" element={<UnprefixedBoardRedirect />} />
          <Route path="company/settings/model-key" element={<UnprefixedBoardRedirect />} />
          <Route path="company/settings/environments" element={<UnprefixedBoardRedirect />} />
          <Route path="company/settings/access" element={<UnprefixedBoardRedirect />} />
          <Route path="company/settings/invites" element={<UnprefixedBoardRedirect />} />
          <Route path="company/settings/health" element={<UnprefixedBoardRedirect />} />
          <Route path="company/export/*" element={<UnprefixedBoardRedirect />} />
          <Route path="company/import" element={<UnprefixedBoardRedirect />} />
          <Route path="design-guide" element={<UnprefixedBoardRedirect />} />
          <Route path="design-guide/*" element={<UnprefixedBoardRedirect />} />
          <Route path="workforce" element={<UnprefixedBoardRedirect />} />
          <Route path="agents" element={<UnprefixedBoardRedirect />} />
          <Route path="agents/new" element={<UnprefixedBoardRedirect />} />
          <Route path="agents/:agentId" element={<UnprefixedBoardRedirect />} />
          <Route path="agents/:agentId/:tab" element={<UnprefixedBoardRedirect />} />
          <Route path="agents/:agentId/runs/:runId" element={<UnprefixedBoardRedirect />} />
          <Route path="projects" element={<UnprefixedBoardRedirect />} />
          <Route path="projects/:projectId" element={<UnprefixedBoardRedirect />} />
          <Route path="projects/:projectId/overview" element={<UnprefixedBoardRedirect />} />
          <Route path="projects/:projectId/issues" element={<UnprefixedBoardRedirect />} />
          <Route path="projects/:projectId/issues/:filter" element={<UnprefixedBoardRedirect />} />
          <Route path="projects/:projectId/workspaces" element={<UnprefixedBoardRedirect />} />
          <Route path="projects/:projectId/workspaces/:workspaceId" element={<UnprefixedBoardRedirect />} />
          <Route path="projects/:projectId/configuration" element={<UnprefixedBoardRedirect />} />
          <Route path="workspaces" element={<UnprefixedBoardRedirect />} />
          <Route path="execution-workspaces/:workspaceId" element={<UnprefixedBoardRedirect />} />
          <Route path="execution-workspaces/:workspaceId/configuration" element={<UnprefixedBoardRedirect />} />
          <Route path="execution-workspaces/:workspaceId/runtime-logs" element={<UnprefixedBoardRedirect />} />
          <Route path="execution-workspaces/:workspaceId/issues" element={<UnprefixedBoardRedirect />} />
          <Route path="execution-workspaces/:workspaceId/routines" element={<UnprefixedBoardRedirect />} />
          <Route path=":companyPrefix" element={<Layout />}>
            {boardRoutes()}
          </Route>
          <Route path="*" element={<NotFoundPage scope="global" />} />
        </Route>
      </Routes>
      <OnboardingWizard />
      <ProductOnlyOverlay />
    </>
  );
}

// AgentDash: the public marketing surface does not depend on the API, so a
// server outage must not blur the homepage with the dashboard's
// "Connection Lost" overlay. Marketing routes render MarketingShell.
function isDocsPath(pathname: string): boolean {
  return pathname === "/docs" || pathname.startsWith("/docs/");
}
const MARKETING_PATHS = new Set(["/", "/demo", "/about", "/consulting", "/mcp", "/start", "/start/verify", "/start/progress", "/find"]);
function ProductOnlyOverlay() {
  const location = useLocation();
  const pathname = location.pathname.replace(/\/+$/, "") || "/";
  if (MARKETING_PATHS.has(pathname) || isDocsPath(pathname)) return null;
  return <ServerUnreachableOverlay />;
}
