import { useState } from 'react'

import { Dialog, DialogTrigger } from '@/components/ui/dialog'

import { useDisconnectAgentAccess } from '../../claude-access-query'
import { DisconnectDialog } from './disconnect-dialog'

/**
 * The connected card's action: switch agent access off for this account.
 *
 * Owns three things that belong together — the open state, the mutation, and
 * the "did it work" states — so the status row and the view stay pure, exactly
 * as `AllowAccessButton` (its mirror image, on the revoked row) does.
 *
 * Nothing here is destructive on its own: the press only opens the
 * confirmation. The dialog owns the copy that makes the choice informed; this
 * owns what happens after it.
 *
 * On success the mutation writes the server's new payload into the page's query
 * cache (see `useDisconnectAgentAccess`), so on the real page this component
 * unmounts with the connected card as the page re-renders `revoked` — with 2g's
 * re-allow control, which is the only way back. On a **refusal** the dialog
 * stays open with its own failure line, because a destructive action that
 * closes on a failed request tells the player it worked.
 */
export function DisconnectButton() {
  const [open, setOpen] = useState(false)
  const { mutate, isPending, isError, reset } = useDisconnectAgentAccess()

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        // A failure belongs to the attempt that produced it. Without this, a
        // player who is refused, closes, and opens the dialog again is greeted
        // by "we couldn't disconnect Claude" before pressing anything.
        if (!next) reset()
      }}
    >
      <DialogTrigger asChild>
        <button
          type="button"
          className="fmm-claude__action fmm-claude__action--danger"
        >
          Disconnect Claude
        </button>
      </DialogTrigger>
      <DisconnectDialog
        onConfirm={() => mutate(undefined, { onSuccess: () => setOpen(false) })}
        isPending={isPending}
        isError={isError}
      />
    </Dialog>
  )
}
