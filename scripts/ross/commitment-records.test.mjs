import {test} from 'node:test';
import assert from 'node:assert/strict';
const module = await import('./commitment-records.mjs').catch(e => { if(e.code!=='ERR_MODULE_NOT_FOUND')throw e; return {}; });
const parse = module.parseCommitmentDocument;
const id = '11111111-1111-4111-8111-111111111111';
const record = () => ({id:'refresh-report',title:'Refresh report',decision:'accepted',checkpoint:'Next review',recommendation:{issueId:id,commentId:id,runId:id},acknowledgment:{issueId:id,commentId:id},reportedDelivery:null,verification:{status:'not-performed'}});
const document = () => ({schemaVersion:1,provenance:'Supervised fixture',commitments:[record()]});
// Removing strict validation must fail these decoder boundary checks.
test('decodes explicit typed commitments without promoting them to verification', () => {
  assert.equal(typeof parse,'function','strict commitment decoder missing');
  const result=parse(JSON.stringify(document()));
  assert.equal(result.commitments[0].decision,'accepted');
  assert.equal(result.commitments[0].verification.status,'not-performed');
});
test('denies duplicate IDs and source-body authority claims', () => {
  assert.equal(typeof parse,'function');
  const d=document();d.commitments.push(record());assert.throws(()=>parse(JSON.stringify(d)),/duplicate/);
  for(const extra of [{authorId:id},{companyId:id},{verified:true},{permissions:['write']}]){
    const altered=document();Object.assign(altered.commitments[0],extra);assert.throws(()=>parse(JSON.stringify(altered)),/unknown/);
  }
});
test('denies malformed reference paths and purported closure', () => {
  assert.equal(typeof parse,'function');
  const d=document();d.commitments[0].recommendation.issueId='../agents/me';assert.throws(()=>parse(JSON.stringify(d)),/UUID/);
  const closed=document();closed.commitments[0].verification.status='verified';assert.throws(()=>parse(JSON.stringify(closed)),/verification/);
  const arbitrary=document();arbitrary.commitments[0].reportedDelivery={kind:'url',url:'https://example.invalid'};assert.throws(()=>parse(JSON.stringify(arbitrary)),/delivery|unknown/);
});
test('bounds record count and accepts only explicit ISO checkpoint deadlines', () => {
  assert.equal(typeof parse,'function');
  const d=document();d.commitments=Array.from({length:21},(_,i)=>({...record(),id:'c'+i}));assert.throws(()=>parse(JSON.stringify(d)),/limit/);
  const deadline=document();deadline.commitments[0].checkpointAt='2026-10-01T00:00:00.000Z';assert.equal(parse(JSON.stringify(deadline)).commitments[0].checkpointAt,'2026-10-01T00:00:00.000Z');
  deadline.commitments[0].checkpointAt='tomorrow';assert.throws(()=>parse(JSON.stringify(deadline)),/checkpoint/);
  assert.throws(()=>parse('{broken'),/JSON/);
});
