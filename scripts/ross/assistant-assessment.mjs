import {rossSourceTime} from './commitment-records.mjs';

// Bounded question→Ross-assessment primitive. It composes only existing
// governed surfaces: stored `ross-review` issue documents for reads and the
// canonical issue-comment accept/dispatch pipeline for requests. No dedicated
// assessment transport exists yet; wiring this contract to an MCP tool or
// route is a pending Codex/recovery integration step. A read NEVER posts, and
// a request NEVER invokes a model: inference begins only if native heartbeat
// admission (budget, quota, ownership, holds) admits a run.

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const requestKeyPattern=/^[a-z0-9][a-z0-9-]{7,63}$/;
const questionLimit=2000;
const commentScanLimit=200;
const freshMs=60*60*1000;
export const ASSESSMENT_REQUEST_MARKER='ross-assessment-request:';
const markerRe=/\[ross-assessment-request:([a-z0-9][a-z0-9-]{7,63})\]\n?/;

function boundedString(value,label,limit=200) {
  if(typeof value!=='string'||!value.trim()||value.length>limit)throw Error(`${label} required`);
}

function requestError(status) {
  const error=new Error('assessment transport denied');
  error.statusCode=status;
  return error;
}

function statusOf(error) {
  return error&&(typeof error.statusCode==='number'?error.statusCode:typeof error.status==='number'?error.status:null);
}

export function buildAssessmentCommentBody({question,requestKey}) {
  boundedString(question,'question',questionLimit);
  if(!requestKeyPattern.test(requestKey))throw Error('bounded requestKey required');
  const body=`[${ASSESSMENT_REQUEST_MARKER}${requestKey}]\n${question.trim()}`;
  if(body.length>questionLimit+90)throw Error('bounded question required');
  return body;
}

function parseMarker(comment) {
  const match=typeof comment?.body==='string'?comment.body.match(markerRe):null;
  return match?{requestKey:match[1],anchored:match.index===0,question:comment.body.slice(match.index+match[0].length).trim()}:null;
}

function freshnessOf(recordedAt,observedMs) {
  let timestamp;
  try {timestamp=rossSourceTime(recordedAt);}
  catch {return {state:'unknown',ageMinutes:null};}
  const minutes=(observedMs-timestamp)/60_000;
  return {state:minutes<0?'future':minutes*60_000>freshMs?'stale':'current',ageMinutes:Math.max(0,Math.floor(minutes))};
}

function reviewClaims(body) {
  try {
    const parsed=JSON.parse(body);
    if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed)) {
      const claims={};
      for(const key of ['answer','runId','sessionId','model','provider','outcomeVerification','schemaVersion','kind']) {
        if(typeof parsed[key]==='string'||typeof parsed[key]==='number')claims[key]=parsed[key];
      }
      return claims;
    }
  } catch { /* markdown/plain review bodies stay attributed text */ }
  return {answer:typeof body==='string'?body:null};
}

function projectReview(document) {
  const claims=reviewClaims(document.body);
  return {
    key:document.key,
    documentId:document.id,
    revisionId:document.latestRevisionId,
    revisionNumber:document.latestRevisionNumber,
    recordedAt:document.updatedAt,
    authorAgentId:document.updatedByAgentId,
    authorUserId:document.updatedByUserId,
    claims,
    sourceKind:'untrusted-source-content',
    bodyPresentation:'redacted-source-text',
  };
}

function assertIssue(issue,{companyId,projectId,issueId}) {
  if(!issue||issue.id!==issueId||issue.companyId!==companyId)throw requestError(404);
  if(projectId&&issue.projectId!==projectId)throw requestError(404);
  return issue;
}

// heartbeat.ts writes executionState.recoveryBudget.status='exhausted' when the
// task recovery budget is spent: comments still post, but an assistant-grant
// request cannot start a run (under #877 a run a board user starts directly
// still goes ahead in the interim; this primitive never does that). Remediation
// does not clear the marker: only an explicit named-human clear does (or, once
// it ships, a one-run named-human permit). Main has no permit yet, so an
// exhausted issue always refuses here.
function isRecoveryExhausted(issue) {
  return issue?.executionState?.recoveryBudget?.status==='exhausted';
}

// `transport.request(path, body?, method?)` throws with statusCode/status on
// non-2xx, exactly like createGovernedRequest in governed-invocation.mjs.
export function createAssistantAssessment({transport,actor,companyId,projectId=null,now=()=>Date.now()}) {
  if(typeof transport?.request!=='function')throw Error('transport.request callable required');
  if(!uuid.test(actor?.userId??''))throw Error('named person userId required');
  if(!uuid.test(companyId))throw Error('bounded UUID companyId required');
  if(projectId!==null&&!uuid.test(projectId))throw Error('bounded UUID projectId required');
  const bound={companyId,projectId};

  async function readIssue(issueId) {
    const issue=await transport.request(`/issues/${encodeURIComponent(issueId)}`);
    return assertIssue(issue,{...bound,issueId});
  }

  async function readDocument(issueId,key) {
    try {
      const document=await transport.request(`/issues/${encodeURIComponent(issueId)}/documents/${encodeURIComponent(key)}`);
      if(!document||document.companyId!==companyId||document.issueId!==issueId||document.key!==key
        ||typeof document.body!=='string'||typeof document.latestRevisionId!=='string'||!document.latestRevisionId
        ||!Number.isInteger(document.latestRevisionNumber)||document.latestRevisionNumber<1)throw Error('scoped document required');
      rossSourceTime(document.updatedAt);
      return document;
    } catch (error) {
      if(statusOf(error)===404)return null;
      throw error;
    }
  }

  async function readStoredAssessment({issueId}) {
    if(!uuid.test(issueId))throw Error('bounded UUID issueId required');
    try {
      const issue=await readIssue(issueId);
      const recoveryExhausted=isRecoveryExhausted(issue);
      const advertised=(issue.documentSummaries??[]).some(summary=>summary.key==='ross-review');
      if(!advertised)return {status:'unavailable',reason:'no-stored-assessment',issueId,recoveryExhausted,observedAt:new Date(now()).toISOString()};
      const document=await readDocument(issueId,'ross-review');
      if(!document)return {status:'unavailable',reason:'no-stored-assessment',issueId,recoveryExhausted,observedAt:new Date(now()).toISOString()};
      // A ross-review answers only when authored by the issue's assigned agent;
      // a review by anyone else is present but unattributed, never an answer.
      if(!issue.assigneeAgentId||document.updatedByAgentId!==issue.assigneeAgentId) {
        return {status:'unattributed',reason:'review-author-not-assigned-agent',issueId,recoveryExhausted,
          expectedAuthorAgentId:issue.assigneeAgentId??null,
          review:projectReview(document),observedAt:new Date(now()).toISOString()};
      }
      const review=projectReview(document);
      const freshness=freshnessOf(document.updatedAt,now());
      return {
        status:freshness.state==='current'?'fresh':'stale',
        reason:freshness.state==='current'?null:`stored-assessment-${freshness.state}`,
        issueId,freshness,review,recoveryExhausted,
        observedAt:new Date(now()).toISOString(),
        businessOutcomeVerified:false,independentlyRechecked:false,
        qualification:'Stored ross-review is attributed source content. This read performs no model call, does not recheck its claims, and cannot grant capability.',
      };
    } catch (error) {
      const status=statusOf(error);
      if(status===401||status===403||status===404)return {status:'unavailable',reason:'source-unavailable',issueId,observedAt:new Date(now()).toISOString()};
      throw error;
    }
  }

  // A marker records this actor's request only when it opens the comment body
  // and the comment is attributed to the actor. Any other comment carrying the
  // same key — a mid-body quote or another author's marker — contests the key
  // and must fail closed: coalescing on it would suppress the person's request
  // and hand back a spoofed receipt.
  async function markedCommentState(issueId,requestKey) {
    const comments=await transport.request(`/issues/${encodeURIComponent(issueId)}/comments?limit=${commentScanLimit}`);
    const rows=Array.isArray(comments)?comments:[];
    let own=null,contested=false;
    for(const comment of rows) {
      const marked=parseMarker(comment);
      if(!marked||marked.requestKey!==requestKey)continue;
      if(marked.anchored&&comment.authorUserId===actor.userId){own={comment,question:marked.question};continue;}
      contested=true;
    }
    if(own)return {state:'own',...own};
    if(contested)return {state:'contested'};
    return null;
  }

  async function requestAssessment({issueId,question,requestKey}) {
    if(!uuid.test(issueId))throw Error('bounded UUID issueId required');
    const body=buildAssessmentCommentBody({question,requestKey});
    let issue;
    try {issue=await readIssue(issueId);}
    catch (error) {
      const status=statusOf(error);
      if(status===401||status===403)return {status:'denied',reason:'actor-not-permitted',requestKey,issueId};
      if(status===404)return {status:'unavailable',reason:'target-unavailable',requestKey,issueId};
      throw error;
    }
    if(!issue.assigneeAgentId)return {status:'unavailable',reason:'no-assigned-agent',requestKey,issueId};
    // An exhausted recovery budget suppresses an assistant-grant wake: reporting
    // 'requested' or 'pending' would fake work this request cannot start. Refuse before writing so
    // the requestKey stays usable after an explicit clear of the budget.
    if(isRecoveryExhausted(issue)) {
      return {status:'refused',reason:'recovery-exhausted',requestKey,issueId,
        detail:'task recovery budget exhausted; a comment would record but an assistant-grant request cannot start a run until a named human explicitly clears the budget'};
    }

    let prior;
    try {prior=await markedCommentState(issueId,requestKey);}
    catch (error) {
      const status=statusOf(error);
      if(status===401||status===403)return {status:'denied',reason:'actor-not-permitted',requestKey,issueId};
      if(status===404)return {status:'unavailable',reason:'target-unavailable',requestKey,issueId};
      throw error;
    }
    if(prior) {
      if(prior.state==='contested') {
        return {status:'conflict',reason:'request-key-contested-by-foreign-comment',requestKey,issueId};
      }
      if(prior.question===question.trim()) {
        return {status:'coalesced',reason:'identical-request-already-recorded',requestKey,issueId,
          receipt:{commentId:prior.comment.id,requestKey,issueId,companyId,reused:true},
          inference:{state:'delegated-to-native-run-gates',startedByThisCall:false}};
      }
      return {status:'conflict',reason:'request-key-carries-different-question',requestKey,issueId};
    }

    let comment;
    try {
      comment=await transport.request(`/issues/${encodeURIComponent(issueId)}/comments`,{body});
    } catch (error) {
      const status=statusOf(error);
      if(status===401||status===403)return {status:'denied',reason:'actor-not-permitted',requestKey,issueId};
      if(status===404)return {status:'unavailable',reason:'target-unavailable',requestKey,issueId};
      if(status===409||status===422)return {status:'refused',reason:'request-refused-by-policy',requestKey,issueId};
      // Acceptance may already have committed: never repost after an uncertain
      // write. Read the issue before retrying, matching IssueCommentAcceptanceUncertain.
      return {status:'uncertain',reason:'acceptance-uncertain-read-before-retry',requestKey,issueId};
    }
    // The receipt is the safety boundary: only an exact named-human author
    // proves attribution. Absent/null authorUserId is unverified, and a
    // comment record without an id cannot be a receipt at all.
    if(!comment||typeof comment.id!=='string') {
      return {status:'uncertain',reason:'accepted-response-lacked-comment-receipt',requestKey,issueId};
    }
    return {
      status:'requested',
      requestKey,issueId,
      receipt:{commentId:comment.id,requestKey,issueId,companyId,requestedAt:new Date(now()).toISOString()},
      attribution:{actorUserId:actor.userId,verified:comment.authorUserId===actor.userId},
      baselineRevisionId:(issue.documentSummaries??[]).find(summary=>summary.key==='ross-review')?.latestRevisionId??null,
      inference:{state:'delegated-to-native-run-gates',startedByThisCall:false,
        wake:'assignee-notified-through-issue-comment',
        guarantee:'a model call begins only if native heartbeat admission (budget, quota, ownership, holds) admits a run'},
    };
  }

  // A stored review answers a request only when it is both fresh AND newer
  // than the baseline captured at request time (different revision, or
  // recorded after requestedAt). Stale stays stale; nothing is re-claimed.
  async function assessmentStatus({issueId,baselineRevisionId=null,requestedAt=null}) {
    const stored=await readStoredAssessment({issueId});
    if(stored.status!=='fresh'&&stored.status!=='stale')return stored;
    if(stored.status!=='fresh')return stored;
    const revisionChanged=baselineRevisionId?stored.review.revisionId!==baselineRevisionId:false;
    const recordedAfter=requestedAt?Date.parse(stored.review.recordedAt)>=Date.parse(requestedAt):false;
    if(!baselineRevisionId&&!requestedAt)return {...stored,status:'answered',reason:null};
    if(revisionChanged||recordedAfter)return {...stored,status:'answered',reason:null};
    // An exhausted recovery budget means this request's wake cannot actuate: report refused
    // rather than a pending that can never resolve without an explicit clear.
    if(stored.recoveryExhausted) {
      return {...stored,status:'refused',reason:'recovery-exhausted',
        gate:{state:'recovery-budget-exhausted'}};
    }
    // Pending stays honest about why: surface the newest run row when the
    // transport can read it (e.g. a quota/hold-blocked claim shows stopReason).
    let lastRun=null;
    try {
      const runs=await transport.request(`/issues/${encodeURIComponent(issueId)}/runs?limit=3`);
      const row=Array.isArray(runs)?runs[0]:null;
      if(row)lastRun={status:row.status??null,stopReason:row.resultJson?.stopReason??null,livenessReason:row.livenessReason??null,at:row.finishedAt??row.startedAt??null};
    } catch { /* run history is optional diagnostic detail */ }
    return {...stored,status:'pending',reason:'assessment-not-yet-published',gate:{state:lastRun?'last-run-observed':'no-run-visible',lastRun}};
  }

  return {readStoredAssessment,requestAssessment,assessmentStatus};
}
