import { Trash2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

export interface ConfirmDeleteDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The kind of thing being deleted, e.g. "tournament" or "event". */
  kind: string
  /** The name of the specific entity, bolded in the body. */
  name: string | undefined
  onConfirm: () => void
}

/** Generic "are you sure?" delete confirmation, shared by the tournament list
 * and the event editor. */
export const ConfirmDeleteDialog = ({
  open,
  onOpenChange,
  kind,
  name,
  onConfirm,
}: ConfirmDeleteDialogProps) => {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>Delete {kind}?</DialogTitle>
          <DialogDescription>
            <span className="font-semibold text-[color:var(--fg-1)]">{name}</span>{' '}
            will be removed. This can't be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={onConfirm}>
            <Trash2 size={16} />
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
