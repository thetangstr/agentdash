import { useCallback, useRef, useState } from "react";
import {
  ArrowRight,
  ArrowLeft,
  ChevronLeft,
  ClipboardList,
  Download,
  Loader2,
  MessageSquarePlus,
  Sparkles,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  assessApi,
  type ProjectAnswer,
  type ProjectClarifyQuestion,
  type ProjectClarifyResponse,
  type ProjectIntake,
} from "../../api/assess";
import { Button } from "../../marketing/components/Button";
import {
  WizardCard,
  StepHeading,
  Field,
  ResultsHeader,
  ReportPanel,
} from "./wizard-chrome";
import { toSlug } from "./data";

const MIN_ANSWERS_TO_GENERATE = 3;

const DEV_PREFILL: ProjectIntake = {
  projectName: "SharePoint cleanup project",
  oneLineGoal:
    "Clean up an aging SharePoint knowledge base with AI agents — drop stale docs, surface a source of truth.",
  description:
    "We have a SharePoint site that is very old and has a lot of stale documents that no longer provide any value. " +
    "At the same time, we're not sure exactly where the source of truth is for some of the business questions that " +
    "live across these SharePoint documents. We want a way to build a clean knowledge base from the documents " +
    "themselves AND retire the documents that no longer provide value. I want to know how to approach this with " +
    "AI and agents.",
  sponsor: "VP of Knowledge Management / IT Ops",
};

const EMPTY_INTAKE: ProjectIntake = {
  projectName: "",
  oneLineGoal: "",
  description: "",
  sponsor: "",
};

const INITIAL_INTAKE: ProjectIntake = import.meta.env.DEV ? DEV_PREFILL : EMPTY_INTAKE;

export interface ProjectWizardProps {
  companyId: string;
  companyName: string;
  onSwitchMode?: () => void;
  onCompleted?: () => void;
}

type Phase = "wizard" | "clarify" | "followup" | "review" | "results";

function computeClarity(answers: Record<string, string>, totalQuestions: number): number {
  if (totalQuestions === 0) return 0;
  let score = 0;
  for (const v of Object.values(answers)) {
    const len = v.trim().length;
    if (len >= 50) score += 1;
    else if (len >= 20) score += 0.7;
    else if (len > 0) score += 0.4;
  }
  return Math.round((score / totalQuestions) * 100);
}

export function ProjectWizard({ companyId, companyName, onSwitchMode, onCompleted }: ProjectWizardProps) {
  const [phase, setPhase] = useState<Phase>("wizard");
  const [intake, setIntake] = useState<ProjectIntake>(INITIAL_INTAKE);

  // Clarify state
  const [clarifyLoading, setClarifyLoading] = useState(false);
  const [clarifyError, setClarifyError] = useState("");
  const [clarify, setClarify] = useState<ProjectClarifyResponse | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [currentIndex, setCurrentIndex] = useState(0);
  const [additionalContext, setAdditionalContext] = useState("");

  // Follow-up state
  const [followUp, setFollowUp] = useState<ProjectClarifyResponse | null>(null);
  const [followUpLoading, setFollowUpLoading] = useState(false);
  const [followUpError, setFollowUpError] = useState("");
  const [followUpIndex, setFollowUpIndex] = useState(0);
  const [followUpAnswers, setFollowUpAnswers] = useState<Record<string, string>>({});

  // Report state
  const [output, setOutput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState("");
  const [docxLoading, setDocxLoading] = useState(false);
  const [docxError, setDocxError] = useState("");
  const abortRef = useRef<AbortController | null>(null);

  const queryClient = useQueryClient();

  const update = <K extends keyof ProjectIntake>(key: K, val: ProjectIntake[K]) =>
    setIntake((prev) => ({ ...prev, [key]: val }));

  const canAdvanceFromBasics = (): boolean =>
    Boolean(intake.projectName.trim() && intake.description.trim().length >= 30);

  const goToClarify = useCallback(async () => {
    setClarifyLoading(true);
    setClarifyError("");
    setClarify(null);
    setAnswers({});
    setCurrentIndex(0);
    setAdditionalContext("");
    setFollowUp(null);
    setFollowUpAnswers({});
    setPhase("clarify");
    try {
      const res = await assessApi.generateProjectClarify(companyId, intake);
      setClarify(res);
      const seed: Record<string, string> = {};
      res.questions.forEach((q) => { seed[q.id] = ""; });
      setAnswers(seed);
    } catch (err) {
      setClarifyError(err instanceof Error ? err.message : "Failed to generate questions");
    } finally {
      setClarifyLoading(false);
    }
  }, [companyId, intake]);

  const allQuestions = clarify?.questions ?? [];
  const answeredCount = Object.values(answers).filter((v) => v.trim().length > 0).length;
  const totalQ = allQuestions.length;
  const currentQ = allQuestions[currentIndex];
  const clarity = computeClarity(answers, totalQ);

  const goToReview = () => {
    setPhase("review");
  };

  const startFollowUp = useCallback(async () => {
    if (!clarify) return;
    setFollowUpLoading(true);
    setFollowUpError("");
    setFollowUp(null);
    setFollowUpIndex(0);
    setFollowUpAnswers({});
    setPhase("followup");

    const projectAnswers: ProjectAnswer[] = allQuestions.map((q) => ({
      questionId: q.id,
      text: answers[q.id] ?? "",
    }));

    try {
      const res = await assessApi.generateProjectFollowUp(companyId, {
        intake,
        answers: projectAnswers,
        rephrased: clarify.rephrased,
      });
      if (res.questions.length === 0) {
        setPhase("review");
        return;
      }
      setFollowUp(res);
      const seed: Record<string, string> = {};
      res.questions.forEach((q) => { seed[q.id] = ""; });
      setFollowUpAnswers(seed);
    } catch (err) {
      setFollowUpError(err instanceof Error ? err.message : "Failed to generate follow-up");
      setPhase("review");
    } finally {
      setFollowUpLoading(false);
    }
  }, [clarify, allQuestions, answers, companyId, intake]);

  const generate = useCallback(async () => {
    if (!clarify) return;
    setPhase("results");
    setOutput("");
    setError("");
    setDocxError("");
    setIsStreaming(true);
    abortRef.current = new AbortController();

    const projectAnswers: ProjectAnswer[] = allQuestions.map((q) => ({
      questionId: q.id,
      text: answers[q.id] ?? "",
    }));
    if (followUp) {
      for (const q of followUp.questions) {
        const text = followUpAnswers[q.id] ?? "";
        if (text.trim()) projectAnswers.push({ questionId: q.id, text });
      }
    }
    if (additionalContext.trim().length > 0) {
      projectAnswers.push({
        questionId: "additional-context",
        text: `Anything else: ${additionalContext.trim()}`,
      });
    }

    try {
      const stream = await assessApi.runProjectAssessment(
        companyId,
        { intake, answers: projectAnswers, rephrased: clarify.rephrased },
        abortRef.current.signal,
      );
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        setOutput((prev) => prev + decoder.decode(value, { stream: true }));
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        // user cancelled
      } else {
        setError(err instanceof Error ? err.message : "Network error");
      }
    } finally {
      setIsStreaming(false);
      abortRef.current = null;
      queryClient.invalidateQueries({ queryKey: ["assess", "projects", companyId] });
      onCompleted?.();
    }
  }, [clarify, allQuestions, answers, followUp, followUpAnswers, additionalContext, intake, companyId, queryClient, onCompleted]);

  const downloadDocx = useCallback(async () => {
    if (!output) return;
    setDocxLoading(true);
    setDocxError("");
    try {
      const { blob, filename } = await assessApi.downloadProjectDocx(companyId, {
        markdown: output,
        projectName: intake.projectName,
        companyName,
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setDocxError(err instanceof Error ? err.message : "Docx download failed");
    } finally {
      setDocxLoading(false);
    }
  }, [output, intake.projectName, companyName, companyId]);

  const handleReset = () => {
    setIntake(INITIAL_INTAKE);
    setPhase("wizard");
    setOutput("");
    setError("");
    setClarify(null);
    setAnswers({});
    setAdditionalContext("");
    setFollowUp(null);
    setFollowUpAnswers({});
    setCurrentIndex(0);
  };

  const slug = toSlug(intake.projectName || "project");

  // ── Render ──

  return (
    <>
      {/* ── Phase: Basics ── */}
      {phase === "wizard" && (
        <div style={{ marginTop: 48 }}>
          {onSwitchMode && (
            <div style={{ marginBottom: 16, textAlign: "right" }}>
              <Button variant="link" onClick={onSwitchMode}>
                <ChevronLeft size={14} strokeWidth={1.75} aria-hidden /> Back to mode select
              </Button>
            </div>
          )}
          <WizardCard>
            <Step1Project intake={intake} update={update} />
            <div className="mkt-assess__nav">
              <span />
              <Button onClick={goToClarify} disabled={!canAdvanceFromBasics()}>
                <ClipboardList size={14} strokeWidth={1.75} aria-hidden /> Continue to refine
              </Button>
            </div>
          </WizardCard>
        </div>
      )}

      {/* ── Phase: Clarify (one at a time) ── */}
      {phase === "clarify" && (
        <div style={{ marginTop: 48 }}>
          <WizardCard>
            <StepHeading
              title="A few questions to refine your recommendation"
              sub={`Our consultant tailored these to ${intake.projectName || "your project"}.`}
            />

            {clarifyLoading && (
              <div className="mkt-assess__loading" aria-live="polite">
                <Loader2 size={16} className="mkt-assess__spin" />
                <span>Drafting tailored questions for {intake.projectName || "your project"}…</span>
              </div>
            )}
            {clarifyError && <div className="mkt-assess__error">{clarifyError}</div>}

            {!clarifyLoading && !clarifyError && clarify && currentQ && (
              <>
                {clarify.rephrased && currentIndex === 0 && (
                  <div className="mkt-assess__clarify-rephrased">{clarify.rephrased}</div>
                )}

                {/* Progress bar */}
                <div className="mkt-assess__progress">
                  <div className="mkt-assess__progress-bar">
                    <div
                      className="mkt-assess__progress-fill"
                      style={{ width: `${((currentIndex + 1) / totalQ) * 100}%` }}
                    />
                  </div>
                  <span className="mkt-assess__progress-label">
                    Question {currentIndex + 1} of {totalQ}
                  </span>
                </div>

                <ClarifyQuestionCard
                  q={currentQ}
                  value={answers[currentQ.id] ?? ""}
                  onChange={(v) => setAnswers((prev) => ({ ...prev, [currentQ.id]: v }))}
                />

                <div className="mkt-assess__nav">
                  <Button
                    variant="link"
                    onClick={() => currentIndex > 0 ? setCurrentIndex(currentIndex - 1) : setPhase("wizard")}
                  >
                    <ArrowLeft size={14} strokeWidth={1.75} aria-hidden />
                    {currentIndex > 0 ? "Previous" : "Back to basics"}
                  </Button>
                  <Button
                    onClick={() => {
                      if (currentIndex < totalQ - 1) {
                        setCurrentIndex(currentIndex + 1);
                      } else {
                        goToReview();
                      }
                    }}
                  >
                    {currentIndex < totalQ - 1 ? (
                      <>Next <ArrowRight size={14} strokeWidth={1.75} aria-hidden /></>
                    ) : (
                      <>Review answers <ArrowRight size={14} strokeWidth={1.75} aria-hidden /></>
                    )}
                  </Button>
                </div>
              </>
            )}
          </WizardCard>
        </div>
      )}

      {/* ── Phase: Follow-up (one at a time) ── */}
      {phase === "followup" && (
        <div style={{ marginTop: 48 }}>
          <WizardCard>
            <StepHeading
              title="A few follow-up questions"
              sub="We noticed some gaps — these targeted questions will sharpen the recommendation."
            />

            {followUpLoading && (
              <div className="mkt-assess__loading" aria-live="polite">
                <Loader2 size={16} className="mkt-assess__spin" />
                <span>Analyzing gaps and generating follow-ups…</span>
              </div>
            )}
            {followUpError && <div className="mkt-assess__error">{followUpError}</div>}

            {!followUpLoading && followUp && followUp.questions[followUpIndex] && (
              <>
                <div className="mkt-assess__progress">
                  <div className="mkt-assess__progress-bar">
                    <div
                      className="mkt-assess__progress-fill"
                      style={{ width: `${((followUpIndex + 1) / followUp.questions.length) * 100}%` }}
                    />
                  </div>
                  <span className="mkt-assess__progress-label">
                    Follow-up {followUpIndex + 1} of {followUp.questions.length}
                  </span>
                </div>

                <ClarifyQuestionCard
                  q={followUp.questions[followUpIndex]}
                  value={followUpAnswers[followUp.questions[followUpIndex].id] ?? ""}
                  onChange={(v) => {
                    const qid = followUp.questions[followUpIndex].id;
                    setFollowUpAnswers((prev) => ({ ...prev, [qid]: v }));
                  }}
                />

                <div className="mkt-assess__nav">
                  <Button
                    variant="link"
                    onClick={() => followUpIndex > 0 ? setFollowUpIndex(followUpIndex - 1) : setPhase("review")}
                  >
                    <ArrowLeft size={14} strokeWidth={1.75} aria-hidden />
                    {followUpIndex > 0 ? "Previous" : "Back to review"}
                  </Button>
                  <Button
                    onClick={() => {
                      if (followUpIndex < followUp.questions.length - 1) {
                        setFollowUpIndex(followUpIndex + 1);
                      } else {
                        setPhase("review");
                      }
                    }}
                  >
                    {followUpIndex < followUp.questions.length - 1 ? (
                      <>Next <ArrowRight size={14} strokeWidth={1.75} aria-hidden /></>
                    ) : (
                      <>Done <ArrowRight size={14} strokeWidth={1.75} aria-hidden /></>
                    )}
                  </Button>
                </div>
              </>
            )}
          </WizardCard>
        </div>
      )}

      {/* ── Phase: Review (clarity scoring + generate) ── */}
      {phase === "review" && clarify && (
        <div style={{ marginTop: 48 }}>
          <WizardCard>
            <StepHeading
              title="Review your answers"
              sub="Check your responses, add anything we missed, then generate your assessment."
            />

            {/* Clarity meter */}
            <div className="mkt-assess__clarity">
              <div className="mkt-assess__clarity-bar">
                <div
                  className="mkt-assess__clarity-fill"
                  style={{
                    width: `${clarity}%`,
                    backgroundColor: clarity >= 70 ? "var(--mkt-accent)" : clarity >= 40 ? "#e6a817" : "#c44",
                  }}
                />
              </div>
              <span className="mkt-assess__clarity-label">
                Clarity: {clarity}% · {answeredCount} of {totalQ} answered
                {clarity < 40 && " · More detail will improve the recommendation"}
              </span>
            </div>

            {/* Compact answer summary */}
            <div className="mkt-assess__review-list">
              {allQuestions.map((q, i) => {
                const val = answers[q.id] ?? "";
                return (
                  <div key={q.id} className="mkt-assess__review-item" onClick={() => { setCurrentIndex(i); setPhase("clarify"); }}>
                    <div className="mkt-assess__review-q">{q.question}</div>
                    <div className={`mkt-assess__review-a ${val.trim() ? "" : "mkt-assess__review-a--empty"}`}>
                      {val.trim() || "— skipped —"}
                    </div>
                  </div>
                );
              })}

              {followUp && followUp.questions.length > 0 && (
                <>
                  <div style={{ marginTop: 16, fontWeight: 600, fontSize: 13, color: "var(--mkt-ink-soft)" }}>Follow-up answers</div>
                  {followUp.questions.map((q, i) => {
                    const val = followUpAnswers[q.id] ?? "";
                    return (
                      <div key={q.id} className="mkt-assess__review-item" onClick={() => { setFollowUpIndex(i); setPhase("followup"); }}>
                        <div className="mkt-assess__review-q">{q.question}</div>
                        <div className={`mkt-assess__review-a ${val.trim() ? "" : "mkt-assess__review-a--empty"}`}>
                          {val.trim() || "— skipped —"}
                        </div>
                      </div>
                    );
                  })}
                </>
              )}
            </div>

            {/* Catch-all */}
            <div className="mkt-assess__clarify-q" style={{ marginTop: 24 }}>
              <div className="mkt-assess__clarify-q-title">
                Anything else you'd like to share? (optional)
              </div>
              <div className="mkt-assess__clarify-q-hint">
                Systems you're using, constraints, what matters most — anything we didn't ask about.
              </div>
              <textarea
                className="mkt-assess__input"
                rows={3}
                value={additionalContext}
                onChange={(e) => setAdditionalContext(e.target.value)}
                placeholder="e.g. We're a Microsoft 365 / SharePoint shop. Compliance with HIPAA matters."
              />
            </div>

            <div className="mkt-assess__nav">
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <Button variant="link" onClick={() => { setCurrentIndex(0); setPhase("clarify"); }}>
                  <ArrowLeft size={14} strokeWidth={1.75} aria-hidden /> Edit answers
                </Button>
                {!followUp && (
                  <Button variant="ghost" onClick={startFollowUp} disabled={followUpLoading || answeredCount < MIN_ANSWERS_TO_GENERATE}>
                    <MessageSquarePlus size={14} strokeWidth={1.75} aria-hidden /> Get follow-up questions
                  </Button>
                )}
              </div>
              <Button onClick={generate} disabled={answeredCount < MIN_ANSWERS_TO_GENERATE}>
                <Sparkles size={14} strokeWidth={1.75} aria-hidden /> Generate project assessment
              </Button>
            </div>
          </WizardCard>
        </div>
      )}

      {/* ── Phase: Results ── */}
      {phase === "results" && (
        <div style={{ marginTop: 32 }}>
          <ResultsHeader
            eyebrow={isStreaming ? "Generating" : "Project assessment"}
            title={`${intake.projectName} — Project Assessment`}
            isStreaming={isStreaming}
            onReset={handleReset}
            onCancel={() => abortRef.current?.abort()}
            badges={[`slug:${slug}`].filter(Boolean)}
            extraActions={
              !isStreaming && output ? (
                <Button variant="ghost" onClick={downloadDocx} disabled={docxLoading}>
                  {docxLoading
                    ? <Loader2 size={14} className="mkt-assess__spin" />
                    : <Download size={14} strokeWidth={1.75} aria-hidden />}{" "}
                  Download .docx
                </Button>
              ) : undefined
            }
          />
          {docxError && <div className="mkt-assess__error">{docxError}</div>}
          <ReportPanel
            error={error}
            output={output}
            isStreaming={isStreaming}
            reportLabel={`Project assessment — ${intake.projectName}`}
            loadingLabel="Drafting your project assessment with the clarifying answers…"
          />
        </div>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/*  ClarifyQuestionCard — one question with chip options + textarea     */
/* ------------------------------------------------------------------ */

function ClarifyQuestionCard({
  q, value, onChange,
}: {
  q: ProjectClarifyQuestion;
  value: string;
  onChange: (v: string) => void;
}) {
  const hasOptions = q.options && q.options.length > 0;
  const selectedOption = hasOptions ? q.options.find((o) => o === value) : null;
  const isCustom = value.trim().length > 0 && !selectedOption;

  return (
    <div className="mkt-assess__clarify-q" style={{ minHeight: 180 }}>
      <div className="mkt-assess__clarify-q-title">{q.question}</div>
      {q.hint && <div className="mkt-assess__clarify-q-hint">{q.hint}</div>}

      {hasOptions && (
        <div className="mkt-assess__option-chips">
          {q.options.map((opt) => (
            <button
              key={opt}
              type="button"
              className={`mkt-assess__option-chip ${value === opt ? "mkt-assess__option-chip--selected" : ""}`}
              onClick={() => onChange(value === opt ? "" : opt)}
            >
              {opt}
            </button>
          ))}
        </div>
      )}

      <textarea
        className="mkt-assess__input"
        rows={2}
        value={isCustom || !hasOptions ? value : ""}
        onChange={(e) => onChange(e.target.value)}
        placeholder={hasOptions ? "Or type your own answer…" : "Your answer…"}
        style={hasOptions && !isCustom ? { opacity: 0.6 } : undefined}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Step 1: Project basics                                             */
/* ------------------------------------------------------------------ */

function Step1Project({ intake, update }: {
  intake: ProjectIntake;
  update: <K extends keyof ProjectIntake>(k: K, v: ProjectIntake[K]) => void;
}) {
  return (
    <div>
      <StepHeading title="Project basics" sub="One project. One agent. Sketch the shape — we'll ask the rest." />
      <div className="mkt-assess__grid-2">
        <Field
          label="Project name *"
          value={intake.projectName}
          onChange={(v) => update("projectName", v)}
          placeholder="e.g. SharePoint Onboarding Curator"
        />
        <Field
          label="Executive sponsor / owner role"
          value={intake.sponsor}
          onChange={(v) => update("sponsor", v)}
          placeholder="e.g. VP of HR Ops"
        />
      </div>

      <div style={{ marginTop: 16 }}>
        <Field
          label="One-line goal"
          value={intake.oneLineGoal}
          onChange={(v) => update("oneLineGoal", v)}
          placeholder="e.g. Pick the best 50 onboarding docs from 5,000 SharePoint files"
        />
      </div>

      <div style={{ marginTop: 16 }}>
        <Field
          label="Description (≥ 30 characters) *"
          value={intake.description}
          onChange={(v) => update("description", v)}
          placeholder="What does this project actually do? Who needs it? What does the agent need to read, decide, or produce?"
          multiline
          rows={5}
        />
        {intake.description.length > 0 && intake.description.length < 30 && (
          <div className="mkt-assess__count-line" style={{ color: "var(--mkt-ink-soft)" }}>
            {30 - intake.description.length} more characters required
          </div>
        )}
      </div>
    </div>
  );
}
