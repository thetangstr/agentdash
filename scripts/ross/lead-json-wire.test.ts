import {expect,test} from 'vitest';
import {upsertIssueDocumentSchema,addIssueCommentSchema} from '../../packages/shared/src/validators/issue.js';
import {encodeLeadJsonForApi} from './lead-acknowledgment.mjs';

test('typed commitment JSON survives the real document escaped-linebreak normalizer',()=>{
  const value={schemaVersion:1,provenance:'Original history\nActual run appended a record.',commitments:[{checkpoint:'First check\r\nSecond check'}]};
  const wire=encodeLeadJsonForApi(value);
  const body=upsertIssueDocumentSchema.parse({format:'markdown',body:wire,baseRevisionId:null}).body;
  expect(body).toBe(wire);
  expect(JSON.parse(body)).toEqual(value);
});

test('model acknowledgment content survives comment normalization without losing literal backslashes',()=>{
  const value={schemaVersion:1,decision:'challenged',reason:'Two lines\nQuoted "evidence", literal \\n and path C:\\new\\report.\rEnd',checkpoint:'No outcome proof; \\u000a is literal text.'};
  const wire=encodeLeadJsonForApi(value);
  const body=addIssueCommentSchema.parse({body:wire}).body;
  expect(body).toBe(wire);
  expect(JSON.parse(body)).toEqual(value);
});
