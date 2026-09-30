import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import https from 'node:https';
import express from 'express';
import {and,eq} from 'drizzle-orm';
import {afterAll,beforeAll,expect,test} from 'vitest';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {discoverOAuthProtectedResourceMetadata,discoverOAuthMetadata,registerClient,startAuthorization,exchangeAuthorization,refreshAuthorization} from '@modelcontextprotocol/sdk/client/auth.js';
import {agents,authUsers,companies,companyMemberships,createDb,heartbeatRuns,issues,projectAccess,projects,startEmbeddedPostgresTestDatabase} from '@paperclipai/db';
import {createLocalAgentJwt} from '../../server/src/agent-auth-jwt.js';
import {createBetterAuthHandler,createBetterAuthInstance,resolveBetterAuthSession} from '../../server/src/auth/better-auth.js';
import {actorMiddleware} from '../../server/src/middleware/auth.js';
import {boardMutationGuard} from '../../server/src/middleware/board-mutation-guard.js';
import {errorHandler} from '../../server/src/middleware/error-handler.js';
import {oauthRoutes} from '../../server/src/routes/oauth.js';
import {mcpRoutes} from '../../server/src/routes/mcp.js';
import {issueRoutes} from '../../server/src/routes/issues.js';
import {projectRoutes} from '../../server/src/routes/projects.js';
import {agentRoutes} from '../../server/src/routes/agents.js';
import {activityRoutes} from '../../server/src/routes/activity.js';
import {assistantRoutes} from '../../server/src/routes/assistant.js';
import {companyRoutes} from '../../server/src/routes/companies.js';
import {accessRoutes} from '../../server/src/routes/access.js';
import {documentService} from '../../server/src/services/documents.js';

// Real authentication and OAuth protocol, simulated identity/data. Never a
// claim that the owner consented, a real connector is installed or GLM ran here.
if(process.env.ROSS_ISOLATED_AUTH_TEST!=='1'||!process.env.PAPERCLIP_HOME?.includes('ross-assistant-auth-')||process.env.ROSS_AUTH_CERT_DIR!==process.env.PAPERCLIP_HOME||process.env.NODE_TLS_REJECT_UNAUTHORIZED!==undefined||process.env.DATABASE_URL||process.env.RESEND_API_KEY||process.env.ZAI_API_KEY||process.env.GLM_API_KEY)throw Error('dedicated sanitized runner required');
let tempDb:Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>|undefined;
let db:ReturnType<typeof createDb>;
let server:https.Server|undefined,baseUrl='',resourceUri='';
let cookie='',userId='',companyId='',otherCompanyId='',projectId='',issueId='',otherIssueId='',hiddenIssueId='',leadId='',rossId='';
let reportRevision='',commitmentRevision='',checkRevision='',reviewRevision='',contextRevision='';
const originalFetch=globalThis.fetch;
const clients:Client[]=[];
const requestTrace:Array<{path:string;method:string;status:number}>=[];
const syntheticMarker='Isolated synthetic Ross fixture; no executed GLM work.';
const reviewAnswer=syntheticMarker+'\n'+('Preserve the evidence gap and ask the lead for a scoped next step. '.repeat(24))+'\nLiteral backslash: \\n; quote: "sourced".\r\nNo task closure.';

beforeAll(async()=>{
 const certificateDir=process.env.ROSS_AUTH_CERT_DIR!;
 const keyPath=join(certificateDir,'key.pem'),certPath=join(certificateDir,'cert.pem');
 tempDb=await startEmbeddedPostgresTestDatabase('ross-assistant-auth-db-');db=createDb(tempDb.connectionString);
 const app=express();server=https.createServer({key:await readFile(keyPath),cert:await readFile(certPath)},app);
 await new Promise<void>(resolve=>server!.listen(0,'127.0.0.1',resolve));
 const address=server.address();if(!address||typeof address==='string')throw Error('owned loopback listener required');
 baseUrl=`https://127.0.0.1:${address.port}`;resourceUri=baseUrl+'/api/mcp/assistant';
 process.env.PAPERCLIP_PUBLIC_URL=baseUrl;
 // Only the generated test certificate is trusted. Fetches also stay on this
 // owned HTTPS listener; a system/public URL is never a fallback.
 globalThis.fetch=(async(input,init)=>{
  const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);
  if(!['127.0.0.1','localhost'].includes(url.hostname)||url.port!==String(address.port)||url.protocol!=='https:')throw Error('external fetch refused by isolated harness');
  const response=await originalFetch(input,{...init,signal:init?.signal??AbortSignal.timeout(10000)});
  requestTrace.push({path:url.pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi,':id'),method:init?.method??'GET',status:response.status});
  return response;
 }) as typeof fetch;
 const auth=createBetterAuthInstance(db,{authBaseUrlMode:'explicit',authPublicBaseUrl:baseUrl} as Parameters<typeof createBetterAuthInstance>[1],[baseUrl]);
 app.use(express.json());app.use(express.urlencoded({extended:true}));
 app.all('/api/auth/{*authPath}',createBetterAuthHandler(auth));
 app.use(actorMiddleware(db,{deploymentMode:'authenticated',resolveSession:req=>resolveBetterAuthSession(auth,req)}));
 const api=express.Router();api.use(boardMutationGuard());api.use(mcpRoutes());
 api.use(issueRoutes(db,{} as never));api.use(projectRoutes(db));api.use(agentRoutes(db));api.use(activityRoutes(db));api.use(assistantRoutes(db));api.use('/companies',companyRoutes(db));
 api.use(accessRoutes(db,{deploymentMode:'authenticated',deploymentExposure:'private',bindHost:'127.0.0.1',allowedHostnames:['127.0.0.1']}));
 // URL context only; all source and authorization routes above are real.
 api.get('/health',(_req,res)=>res.json({publicBaseUrl:baseUrl}));
 app.use('/api',api);app.use(oauthRoutes(db,{deploymentMode:'authenticated'}));app.use(errorHandler);
});

afterAll(async()=>{
 globalThis.fetch=originalFetch;
 try {
  for(const client of clients)await client.close().catch(()=>{});
  if(server){server.closeAllConnections();await new Promise<void>(resolve=>server!.close(()=>resolve()));}
  if(db)await db.$client.end({timeout:3});
 }finally {await tempDb?.cleanup();}
});

async function sessionRequest(path:string,body?:unknown,sessionCookie=cookie,origin=baseUrl){
 return fetch(baseUrl+path,{method:body===undefined?'GET':'POST',headers:{...(sessionCookie?{cookie:sessionCookie}:{}),origin,...(body!==undefined?{'content-type':'application/json'}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})});
}
async function connect(token:string){
 const client=new Client({name:'Ross isolated chosen-assistant test',version:'0.1.0'});clients.push(client);
 await client.connect(new StreamableHTTPClientTransport(new URL(resourceUri),{requestInit:{headers:{authorization:'Bearer '+token}}}));return client;
}
function envelope(result:Awaited<ReturnType<Client['callTool']>>){
 if(result.isError)throw Error('MCP tool failed in isolated acceptance; recent status-only trace: '+JSON.stringify(requestTrace.slice(-8)));
 const value=result.structuredContent as {status:string;data:Record<string,any>};
 expect(value).toBeDefined();return value;
}

async function seed(){
 companyId=(await db.insert(companies).values({name:'Ross isolated company',issuePrefix:'RXT'}).returning())[0]!.id;
 otherCompanyId=(await db.insert(companies).values({name:'Second scoped company',issuePrefix:'RXO'}).returning())[0]!.id;
 const creatorId=randomUUID(),now=new Date();
 await db.insert(authUsers).values({id:creatorId,name:'Isolated project creator',email:'creator@ross.invalid',createdAt:now,updatedAt:now});
 await db.insert(companyMemberships).values([companyId,otherCompanyId].map(id=>({companyId:id,principalType:'user',principalId:userId,status:'active',membershipRole:'member'})));
 leadId=(await db.insert(agents).values({companyId,name:'Synthetic lead',role:'engineer',status:'paused',adapterType:'process',adapterConfig:{},runtimeConfig:{heartbeat:{enabled:false,wakeOnDemand:false}},autonomy:'autonomous',accountableUserId:userId}).returning())[0]!.id;
 rossId=(await db.insert(agents).values({companyId,name:'Synthetic Ross',role:'chief_of_staff',status:'paused',adapterType:'hermes_local',adapterConfig:{},runtimeConfig:{heartbeat:{enabled:false,wakeOnDemand:false}},autonomy:'autonomous',accountableUserId:userId}).returning())[0]!.id;
 projectId=(await db.insert(projects).values({companyId,name:'Restricted Ross pilot',status:'active',visibility:'restricted',createdByUserId:creatorId,leadAgentId:leadId}).returning())[0]!.id;
 const hiddenProjectId=(await db.insert(projects).values({companyId,name:'Hidden project',visibility:'restricted',createdByUserId:creatorId}).returning())[0]!.id;
 const otherProjectId=(await db.insert(projects).values({companyId:otherCompanyId,name:'Second company project',visibility:'company'}).returning())[0]!.id;
 issueId=(await db.insert(issues).values({companyId,projectId,title:'Synthetic Ross evidence',identifier:'RXT-18',issueNumber:18,status:'in_review',assigneeAgentId:rossId}).returning())[0]!.id;
 hiddenIssueId=(await db.insert(issues).values({companyId,projectId:hiddenProjectId,title:'Hidden source sentinel',identifier:'RXT-19',issueNumber:19}).returning())[0]!.id;
 otherIssueId=(await db.insert(issues).values({companyId:otherCompanyId,projectId:otherProjectId,title:'Second company source sentinel',identifier:'RXO-1',issueNumber:1}).returning())[0]!.id;
 await db.insert(projectAccess).values({projectId,principalType:'user',principalId:userId,grantedByUserId:creatorId});
 await db.insert(projectAccess).values({projectId,principalType:'agent',principalId:rossId,grantedByUserId:creatorId});
 const publish=async(key:string,body:string,operator=false)=>documentService(db).upsertIssueDocument({issueId,key,title:'Isolated source fixture',format:'markdown',body,baseRevisionId:null,createdByAgentId:operator?null:leadId,createdByUserId:operator?userId:null});
 reportRevision=(await publish('lead-report',syntheticMarker+' Lead reports open evidence review.')).document.latestRevisionId!;
 commitmentRevision=(await publish('ross-commitments',JSON.stringify({schemaVersion:1,provenance:syntheticMarker,commitments:[],untrustedClaim:'verified does not establish independent verification'}))).document.latestRevisionId!;
 checkRevision=(await publish('ross-outcome-checks',syntheticMarker+' Operator source-integrity check only.',true)).document.latestRevisionId!;
 contextRevision=(await publish('ross-context',syntheticMarker+' Operator architecture and goals; no permission authority.',true)).document.latestRevisionId!;
 // The fixture has a real test-only run row and signed run JWT. Its inference
 // receipt is deliberately synthetic; no GLM call or live agent is involved.
 const runId=(await db.insert(heartbeatRuns).values({companyId,agentId:rossId,status:'running',contextSnapshot:{issueId}}).returning())[0]!.id;
 await db.update(issues).set({status:'in_progress',checkoutRunId:runId,executionRunId:runId}).where(eq(issues.id,issueId));
 const token=createLocalAgentJwt(rossId,companyId,'hermes_local',runId);if(!token)throw Error('test-only signed run identity required');
 // The existing Ross pilot binding predates explicit roles; the CLI's
 // documented missing-role default must also reach publication successfully.
 const binding={apiUrl:baseUrl+'/api',companyId,projectId,agentId:rossId};
 const invocation={apiUrl:binding.apiUrl,scope:{companyId,projectId,agentId:rossId},runId,issueId,apiKey:token};
 const receipt={scope:invocation.scope,executionMode:'governed',runId,requestedModel:'glm-5.3-flash',endpoint:'https://api.z.ai/api/paas/v4',sessionId:'20260930_010000_fixture',answer:reviewAnswer,failure:null,usage:{modelRows:[{session_id:'20260930_010000_fixture',model:'glm-5.3-flash',billing_provider:'zai',billing_base_url:'https://api.z.ai/api/paas/v4',api_call_count:1}]}};
 const {createGovernedRequest}=await import('./governed-invocation.mjs');
 const {publishGovernedRossReview}=await import('./ross-review.mjs');
 const publication=await publishGovernedRossReview({binding,invocation,receipt,request:createGovernedRequest(invocation),workspace:process.env.PAPERCLIP_HOME!});
 reviewRevision=publication.revisionId;
 await db.update(heartbeatRuns).set({status:'succeeded',finishedAt:new Date()}).where(eq(heartbeatRuns.id,runId));
 await db.update(issues).set({status:'in_review',checkoutRunId:null,executionRunId:null}).where(eq(issues.id,issueId));
 await documentService(db).upsertIssueDocument({issueId:hiddenIssueId,key:'lead-report',format:'markdown',body:'Hidden source sentinel',baseRevisionId:null,createdByAgentId:leadId,createdByUserId:null});
 await documentService(db).upsertIssueDocument({issueId:otherIssueId,key:'lead-report',format:'markdown',body:'Second company source sentinel',baseRevisionId:null,createdByAgentId:null,createdByUserId:userId});
 // A Ross-specific key marks this as a Ross issue; get_work_item skips a bare lead-report.
 await documentService(db).upsertIssueDocument({issueId:otherIssueId,key:'ross-context',format:'markdown',body:'Second company Ross context',baseRevisionId:null,createdByAgentId:null,createdByUserId:userId});
}

test('real signup/sign-in and PKCE consent expose scoped Ross sources, then deny revoked access',async()=>{
 const credentials={email:'chosen-assistant@ross.invalid',name:'Isolated consenting test user',password:randomUUID()+'-isolated'};
 const signup=await sessionRequest('/api/auth/sign-up/email',credentials,'');expect(signup.status).toBe(200);
 const signupBody=await signup.json();userId=signupBody.user?.id;expect(typeof userId==='string'&&!!userId).toBe(true);
 const signIn=await sessionRequest('/api/auth/sign-in/email',{email:credentials.email,password:credentials.password},'');expect(signIn.status).toBe(200);
 cookie=signIn.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');expect(cookie.length>0).toBe(true);
 const signed=await sessionRequest('/api/auth/get-session');expect(signed.status).toBe(200);expect((await signed.json()).user.id).toBe(userId);
 await seed();
 const metadata=await discoverOAuthProtectedResourceMetadata(resourceUri);expect(metadata.resource).toBe(resourceUri);
 const issuer=await discoverOAuthMetadata(baseUrl);expect(issuer?.token_endpoint).toBe(baseUrl+'/oauth/token');
 const info=await registerClient(baseUrl,{metadata:issuer as never,clientMetadata:{client_name:'Any chosen assistant (isolated protocol test)',redirect_uris:['http://127.0.0.1:54321/callback'],grant_types:['authorization_code','refresh_token'],response_types:['code'],token_endpoint_auth_method:'none'} as never});
 const authorization=await startAuthorization(baseUrl,{metadata:issuer as never,clientInformation:info,redirectUrl:'http://127.0.0.1:54321/callback',scope:'agentdash:read',resource:new URL(resourceUri)});
 expect(authorization.authorizationUrl.searchParams.get('code_challenge_method')).toBe('S256');
 const authorize=await fetch(authorization.authorizationUrl,{redirect:'manual'});expect(authorize.status).toBe(302);
 const requestId=new URL(authorize.headers.get('location')!,baseUrl).searchParams.get('request')!;
 const unsigned=await sessionRequest('/oauth/consent/'+requestId,undefined,'');expect(unsigned.status).toBe(401);
 const consent=await sessionRequest('/oauth/consent/'+requestId);expect(consent.status).toBe(200);
 const wrongOrigin=await sessionRequest('/oauth/consent/'+requestId+'/decision',{approved:true,companyId,scopes:['agentdash:read']},cookie,'https://untrusted.ross.invalid');expect(wrongOrigin.status).toBe(403);
 const approve=await sessionRequest('/oauth/consent/'+requestId+'/decision',{approved:true,companyId,scopes:['agentdash:read']});expect(approve.status).toBe(200);
 const code=new URL((await approve.json()).redirect).searchParams.get('code')!;
 const tokens=await exchangeAuthorization(baseUrl,{metadata:issuer as never,clientInformation:info,authorizationCode:code,codeVerifier:authorization.codeVerifier,redirectUri:'http://127.0.0.1:54321/callback',resource:new URL(resourceUri)});
 expect(typeof tokens.access_token==='string'&&tokens.access_token.length>0).toBe(true);
 expect(typeof tokens.refresh_token==='string'&&tokens.refresh_token.length>0).toBe(true);
 const client=await connect(tokens.access_token),tools=await client.listTools();
 expect(tools.tools.some(tool=>tool.name==='get_work_item')).toBe(true);expect(tools.tools.some(tool=>tool.name==='create_work_item')).toBe(false);
 // A genuine assistant token reaches the MCP boundary, never raw source or
 // consent endpoints that could expose unredacted data or mint another grant.
 for(const path of ['/api/issues/'+issueId,'/api/issues/'+issueId+'/documents/lead-report','/oauth/consent/'+requestId]){
  const forbidden=await fetch(baseUrl+path,{headers:{authorization:'Bearer '+tokens.access_token}});expect(forbidden.status).toBe(403);
 }
 const identity=envelope(await client.callTool({name:'whoami',arguments:{}}));expect(identity.status).toBe('ok');expect(identity.data.user.userId).toBe(userId);expect(identity.data.company.name).toBe('Ross isolated company');expect(identity.data.company.id).toBe(companyId);
 const result=envelope(await client.callTool({name:'get_work_item',arguments:{ref:issueId}}));expect(result.status).toBe('ok');
 const sources=result.data.rossEvidence;expect(sources.businessOutcomeVerified).toBe(false);expect(sources.independentlyRechecked).toBe(false);
 expect(sources.documents.map((doc:any)=>doc.key).sort()).toEqual(['lead-report','ross-commitments','ross-context','ross-outcome-checks','ross-review']);
 for(const [key,revision] of [['lead-report',reportRevision],['ross-commitments',commitmentRevision],['ross-outcome-checks',checkRevision],['ross-context',contextRevision]]){
  const source=sources.documents.find((doc:any)=>doc.key===key);expect(source.revisionId).toBe(revision);expect(source.sourceUrl.startsWith(baseUrl+'/api/issues/'+issueId+'/documents/')).toBe(true);expect(source.body).toContain(syntheticMarker);
 }
 expect(sources.documents.find((doc:any)=>doc.key==='lead-report').usableAsCurrentLeadReport).toBe(true);
 expect(sources.documents.find((doc:any)=>doc.key==='ross-outcome-checks').operatorAuthored).toBe(true);
 const context=sources.documents.find((doc:any)=>doc.key==='ross-context');
 expect(context.operatorAuthored).toBe(true);expect(context.authorUserId).toBe(userId);expect(context.authorAgentId).toBeNull();
 expect(context.sourceKind).toBe('untrusted-source-content');expect(context.usableAsCurrentLeadReport).toBe(false);
 const review=sources.documents.find((doc:any)=>doc.key==='ross-review');
 expect(review.revisionId).toBe(reviewRevision);expect(review.truncated).toBe(false);
 expect(JSON.parse(review.body).answer).toBe(reviewAnswer);
 expect(review.authorAgentId).toBe(rossId);expect(review.authorUserId).toBeNull();
 expect(review.sourceKind).toBe('untrusted-source-content');expect(review.usableAsCurrentLeadReport).toBe(false);
 for(const ref of [hiddenIssueId,otherIssueId]){
  const denied=envelope(await client.callTool({name:'get_work_item',arguments:{ref}}));expect(['refused','not_found']).toContain(denied.status);expect(JSON.stringify(denied)).not.toContain('source sentinel');expect(denied.data?.rossEvidence).toBeUndefined();
 }
 // A second independently consented grant for the same user/client does not
 // widen the first token. This is real OAuth on two synthetic company records.
 const secondAuthorization=await startAuthorization(baseUrl,{metadata:issuer as never,clientInformation:info,redirectUrl:'http://127.0.0.1:54321/callback',scope:'agentdash:read',resource:new URL(resourceUri)});
 expect(secondAuthorization.authorizationUrl.searchParams.get('code_challenge_method')).toBe('S256');
 const secondAuthorize=await fetch(secondAuthorization.authorizationUrl,{redirect:'manual'});expect(secondAuthorize.status).toBe(302);
 const secondRequest=new URL(secondAuthorize.headers.get('location')!,baseUrl).searchParams.get('request')!;
 const secondApprove=await sessionRequest('/oauth/consent/'+secondRequest+'/decision',{approved:true,companyId:otherCompanyId,scopes:['agentdash:read']});expect(secondApprove.status).toBe(200);
 const secondCode=new URL((await secondApprove.json()).redirect).searchParams.get('code')!;
 const secondTokens=await exchangeAuthorization(baseUrl,{metadata:issuer as never,clientInformation:info,authorizationCode:secondCode,codeVerifier:secondAuthorization.codeVerifier,redirectUri:'http://127.0.0.1:54321/callback',resource:new URL(resourceUri)});
 expect(secondTokens.access_token).not.toBe(tokens.access_token);
 const secondClient=await connect(secondTokens.access_token);
 const secondIdentity=envelope(await secondClient.callTool({name:'whoami',arguments:{}}));expect(secondIdentity.data.user.userId).toBe(userId);expect(secondIdentity.data.company.id).toBe(otherCompanyId);
 const reverseDenied=envelope(await secondClient.callTool({name:'get_work_item',arguments:{ref:issueId}}));expect(['refused','not_found']).toContain(reverseDenied.status);expect(reverseDenied.data?.rossEvidence).toBeUndefined();
 const secondSource=envelope(await secondClient.callTool({name:'get_work_item',arguments:{ref:otherIssueId}}));expect(secondSource.status).toBe('ok');expect(secondSource.data.rossEvidence.documents[0].body).toContain('Second company source sentinel');
 const {createAssistantPortfolioReader}=await import('./assistant-portfolio.mjs');
 const portfolio=createAssistantPortfolioReader({userId,connections:[{companyId,client},{companyId:otherCompanyId,client:secondClient}]});
 const collected=await portfolio.read([{companyId,refs:[issueId]},{companyId:otherCompanyId,refs:[otherIssueId]}]);
 expect(collected.businessOutcomeVerified).toBe(false);expect(collected.companies.map((entry:any)=>entry.companyId)).toEqual([companyId,otherCompanyId]);
 const firstCollected=collected.companies[0];expect(firstCollected.status).toBe('available');expect(JSON.parse(firstCollected.sources[0].data.rossEvidence.documents.find((doc:any)=>doc.key==='ross-review').body).answer).toBe(reviewAnswer);
 expect(collected.companies[1].status).toBe('available');expect(JSON.stringify(collected.companies[1].sources)).toContain('Second company source sentinel');expect(JSON.stringify(collected.companies[0].sources)).not.toContain('Second company source sentinel');
 const secondGrants=await sessionRequest('/api/companies/'+otherCompanyId+'/me/assistant-grants');expect(secondGrants.status).toBe(200);const secondGrant=(await secondGrants.json()).grants[0];expect(typeof secondGrant.id).toBe('string');
 await db.delete(projectAccess).where(and(eq(projectAccess.projectId,projectId),eq(projectAccess.principalType,'user'),eq(projectAccess.principalId,userId)));
 const accessRemoved=envelope(await client.callTool({name:'get_work_item',arguments:{ref:issueId}}));expect(['refused','not_found']).toContain(accessRemoved.status);expect(accessRemoved.data?.rossEvidence).toBeUndefined();
 const grantsResponse=await sessionRequest('/api/companies/'+companyId+'/me/assistant-grants');expect(grantsResponse.status).toBe(200);
 const grants=(await grantsResponse.json()).grants;const grant=grants[0];expect(typeof grant?.id==='string').toBe(true);
 const revoke=await sessionRequest('/api/companies/'+companyId+'/me/assistant-grants/'+grant.id+'/revoke',{});expect(revoke.status).toBe(200);expect((await revoke.json()).revoked).toBe(true);
 const rejected=await fetch(resourceUri,{method:'POST',headers:{authorization:'Bearer '+tokens.access_token,'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})});expect(rejected.status).toBe(401);
 await expect(refreshAuthorization(baseUrl,{metadata:issuer as never,clientInformation:info,refreshToken:tokens.refresh_token!,resource:new URL(resourceUri)})).rejects.toMatchObject({errorCode:'invalid_grant'});
 const afterRevocation=await portfolio.read([{companyId,refs:[issueId]},{companyId:otherCompanyId,refs:[otherIssueId]}]);
 expect(afterRevocation.companies[0]).toEqual({companyId,status:'unavailable',reason:'company-source-unavailable'});
 expect(afterRevocation.companies[1].status).toBe('available');expect(JSON.stringify(afterRevocation.companies[1].sources)).toContain('Second company source sentinel');
 expect(JSON.stringify(afterRevocation.companies[0])).not.toContain(syntheticMarker);
 const stillConnected=envelope(await secondClient.callTool({name:'whoami',arguments:{}}));expect(stillConnected.status).toBe('ok');expect(stillConnected.data.company.id).toBe(otherCompanyId);
 const secondStillActive=await sessionRequest('/api/companies/'+otherCompanyId+'/me/assistant-grants');expect((await secondStillActive.json()).grants.some((g:any)=>g.id===secondGrant.id)).toBe(true);
});
