// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompanyProvider, useCompany } from '@/context/CompanyContext';
import { DialogProvider, useDialogActions } from '@/context/DialogContext';
import { NewAgentDialog } from './NewAgentDialog';
let host: HTMLDivElement; let root: ReturnType<typeof createRoot>; let client: QueryClient; let requests: any[];
async function flush() { await act(async () => { await new Promise(r => setTimeout(r, 20)); }); }
function Controls() { const { openNewAgent } = useDialogActions(); const { setSelectedCompanyId } = useCompany(); return <><button onClick={openNewAgent}>Open hire</button><button onClick={() => setSelectedCompanyId('two')}>Switch company</button><NewAgentDialog/></>; }
beforeEach(() => {
 (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; localStorage.clear(); requests = []; host = document.createElement('div'); document.body.append(host); root = createRoot(host); client = new QueryClient({defaultOptions:{queries:{retry:false}}});
 vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
  const body = init?.body ? JSON.parse(init.body as string) : null; requests.push({url, body}); let data: any = [];
  if(url === '/api/companies')data=[{id:'one',issuePrefix:'ONE',name:'Acme',status:'active',productProfile:'default'},{id:'two',issuePrefix:'TWO',name:'Beta',status:'active',productProfile:'default'}];
  else if(url === '/api/health')data={status:'ok',hostedBox:true};
  else if(url.endsWith('/inbox'))data={id:'conversation',companyId:'one'};
  else if(url.endsWith('/messages'))data={id:'message'};
  return new Response(JSON.stringify(data),{status:200,headers:{'Content-Type':'application/json'}});
 }));
 act(()=>root.render(<QueryClientProvider client={client}><MemoryRouter><CompanyProvider><DialogProvider><Controls/></DialogProvider></CompanyProvider></MemoryRouter></QueryClientProvider>));
});
afterEach(()=>{act(()=>root.unmount());client.clear();host.remove();vi.unstubAllGlobals();});
async function click(text:string){await act(async()=>[...document.querySelectorAll('button')].find(b=>b.textContent?.trim()===text)!.click());await flush();}
async function selectRole(){const select=document.querySelector('select[aria-label="Workforce role"]')!;await act(async()=>{Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value')!.set!.call(select,'sales-support');select.dispatchEvent(new Event('change',{bubbles:true}));});}
it('uses the selected pinned role in the real hosted conversation HTTP payload',async()=>{await flush();await click('Open hire');await flush();await selectRole();expect(document.body.textContent).toContain('Sales support · version 1');await click('Ask your Chief of Staff');expect(requests.find(r=>r.url.endsWith('/messages'))?.body).toEqual({companyId:'one',body:'Please hire Sales support. Use workforceTemplateId: sales-support (pinned version 1).'});await click('Open hire');expect((document.querySelector('select[aria-label="Workforce role"]') as HTMLSelectElement).value).toBe('');});
it('resets role and typed hire instructions when the selected company changes',async()=>{await flush();await click('Open hire');await flush();await selectRole();await click('Switch company');expect((document.querySelector('select[aria-label="Workforce role"]') as HTMLSelectElement).value).toBe('');expect((document.querySelector('input[placeholder^="Role"]') as HTMLInputElement).value).toBe('');});
it('names the real hire dialog for assistive technology', async () => { await flush(); await click('Open hire'); const dialog = document.querySelector('[role="dialog"]')!; expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)?.textContent).toBe('Add a new agent'); });
