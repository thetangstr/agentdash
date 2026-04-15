// AgentDash: CRM Contacts list page
import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { crmApi } from "../api/crm";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EntityRow } from "../components/EntityRow";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { Users, Mail } from "lucide-react";

function contactName(c: { firstName: string | null; lastName: string | null; email: string | null }): string {
  const full = [c.firstName, c.lastName].filter(Boolean).join(" ");
  return full || c.email || "Unnamed contact";
}

export function CrmContacts() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([
      { label: "CRM" },
      { label: "Contacts" },
    ]);
  }, [setBreadcrumbs]);

  const { data: contacts, isLoading, error } = useQuery({
    queryKey: queryKeys.crm.contacts(selectedCompanyId!),
    queryFn: () => crmApi.listContacts(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={Users} message="Select a company to view contacts." />;
  }

  if (isLoading) return <PageSkeleton variant="list" />;
  if (error) return <p className="text-sm text-destructive">{error.message}</p>;

  if (!contacts || contacts.length === 0) {
    return (
      <div className="space-y-4">
        <h2 className="text-lg font-semibold">Contacts</h2>
        <EmptyState icon={Users} message="No contacts yet." />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Contacts</h2>
        <span className="text-xs text-muted-foreground">
          {contacts.length} contact{contacts.length !== 1 ? "s" : ""}
        </span>
      </div>
      <div className="border border-border">
        {contacts.map((contact) => (
          <EntityRow
            key={contact.id}
            title={contactName(contact)}
            subtitle={contact.title || undefined}
            to={`/crm/contacts/${contact.id}`}
            leading={
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-muted text-muted-foreground">
                <Users className="h-4 w-4" />
              </div>
            }
            trailing={
              <div className="flex items-center gap-3">
                {contact.email && (
                  <span className="hidden sm:flex items-center gap-1 text-xs text-muted-foreground">
                    <Mail className="h-3 w-3" />
                    {contact.email}
                  </span>
                )}
                {contact.phone && (
                  <span className="hidden md:inline text-xs text-muted-foreground">{contact.phone}</span>
                )}
              </div>
            }
          />
        ))}
      </div>
    </div>
  );
}
