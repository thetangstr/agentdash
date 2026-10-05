import { resolveWorkforceTemplate, WORKFORCE_TEMPLATES } from '@paperclipai/shared';
export function WorkforceTemplatePreview({ templateId }: { templateId: string | null | undefined }) {
  const template = templateId ? resolveWorkforceTemplate(templateId) : null;
  if (!template) return null;
  return <div className="space-y-2 rounded-lg border bg-muted/30 p-3 text-sm">
    <p className="font-medium">{template.name} · version {template.version}</p>
    <p className="text-muted-foreground">{template.description}</p>
    <p>
      <strong>Skills:</strong> {template.skills.map(s => s.name).join(', ')}</p>
    <details>
      <summary className="cursor-pointer max-sm:py-3">What good work looks like</summary>
      <ul className="list-disc space-y-1 pl-5 pt-2">{template.qualityChecks.map(q => <li key={q}>{q}</li>)}</ul>
    </details>
    <p className="text-xs text-muted-foreground">The role sets the work. You set the model, budget and approvals separately.</p>
  </div>;
}
export function WorkforceRoleSelect({ value, onChange, disabled = false }: { value: string; onChange: (value: string) => void; disabled?: boolean }) {
  return <label className="block space-y-1 text-sm">
    <span>Workforce role</span>
    <select aria-label="Workforce role" className="w-full rounded-md border bg-background p-2" value={value} onChange={e => onChange(e.target.value)} disabled={disabled}>
      <option value="">Custom role</option>{WORKFORCE_TEMPLATES.map(t => <option key={t.id} value={t.id}>{t.name} · v{t.version}</option>)}
    </select>
  </label>;
}
