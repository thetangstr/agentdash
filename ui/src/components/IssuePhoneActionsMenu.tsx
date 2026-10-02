// AgentDash: phone (< 640px) issue header overflow menu. On phones the
// "New sub-issue", "Upload attachment" and "New document" buttons collapse
// into this one ⋯ menu so the issue body starts with the title, the result
// and the description instead of a stack of buttons. Desktop is unchanged.
import { FilePlus, ListPlus, MoreHorizontal, Paperclip } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export function IssuePhoneActionsMenu({
  onNewSubIssue,
  onUploadAttachment,
  onNewDocument,
  uploadPending = false,
  newDocumentDisabled = false,
}: {
  onNewSubIssue: () => void;
  onUploadAttachment: () => void;
  onNewDocument: () => void;
  uploadPending?: boolean;
  /** True while the documents section is not mounted, so the item can never silently do nothing. */
  newDocumentDisabled?: boolean;
}) {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-11 sm:hidden"
          aria-label="Issue actions"
          title="Issue actions"
          data-testid="issue-phone-actions-trigger"
        >
          <MoreHorizontal className="h-5 w-5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56" data-testid="issue-phone-actions-menu">
        <DropdownMenuItem className="min-h-11" onSelect={onNewSubIssue}>
          <ListPlus />
          New sub-issue
        </DropdownMenuItem>
        <DropdownMenuItem className="min-h-11" disabled={uploadPending} onSelect={onUploadAttachment}>
          <Paperclip />
          {uploadPending ? "Uploading…" : "Upload attachment"}
        </DropdownMenuItem>
        <DropdownMenuItem className="min-h-11" disabled={newDocumentDisabled} onSelect={onNewDocument}>
          <FilePlus />
          New document
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
